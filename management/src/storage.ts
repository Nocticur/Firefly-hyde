import { ApiError, required } from "./errors.ts";
import type { R2Like, Services } from "./types.ts";

export type StorageProvider = "r2" | "local";
export type StorageObjectInfo = { key: string; size?: number; contentType?: string; provider: StorageProvider };
export type StorageObject = StorageObjectInfo & { body: ReadableStream<Uint8Array> };
type Visibility = "private" | "public";

export function assertStorageKey(key: string): void {
  if (!key || key.length > 512 || key.split("/").some(part => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part === "." || part === "..") || key.endsWith(".metadata.json")) {
    throw new ApiError(400, "INVALID_STORAGE_KEY", "Invalid object storage key");
  }
}
function provider(services: Services): StorageProvider {
  const env = services.env;
  if (env.PLATFORM === "cloudflare") return "r2";
  const nodeEnv = env.NODE_ENV ?? (typeof process !== "undefined" ? process.env.NODE_ENV : undefined);
  if (env.PLATFORM === "local" && env.ENVIRONMENT === "development" && nodeEnv === "development") return "local";
  throw new ApiError(503, "CONFIG_REQUIRED", "Configure the platform's private and public media stores; local storage is development-only");
}
function bucket(services: Services, visibility: Visibility): R2Like {
  if (services.env.PRIVATE_MEDIA && services.env.PRIVATE_MEDIA === services.env.PUBLIC_MEDIA) throw new ApiError(503, "CONFIG_REQUIRED", "Private and public media require separate R2 buckets");
  return required(visibility === "private" ? services.env.PRIVATE_MEDIA : services.env.PUBLIC_MEDIA, visibility === "private" ? "PRIVATE_MEDIA" : "PUBLIC_MEDIA");
}
async function local() {
  // Computed import keeps Node filesystem code out of the Worker bundle.
  const modulePath = "./local-storage.ts";
  return import(/* @vite-ignore */ modulePath) as Promise<typeof import("./local-storage.ts")>;
}
function localRoot(services: Services): string { return services.env.LOCAL_MEDIA_PATH || ".dev-state/media"; }
function publicOrigin(services: Services): URL {
  const origin = new URL(required(services.env.MEDIA_ORIGIN, "MEDIA_ORIGIN"));
  if (origin.username || origin.password || origin.search || origin.hash) throw new ApiError(503, "CONFIG_REQUIRED", "MEDIA_ORIGIN must not contain credentials or query parameters");
  if (origin.protocol !== "https:" && !(services.env.ENVIRONMENT === "development" && origin.protocol === "http:")) throw new ApiError(503, "CONFIG_REQUIRED", "MEDIA_ORIGIN must use HTTPS");
  return origin;
}
async function putObject(services: Services, visibility: Visibility, key: string, bytes: Uint8Array, contentType: string, overwrite: boolean): Promise<{ key: string; provider: StorageProvider; url?: string }> {
  assertStorageKey(key);
  const kind = provider(services);
  if (kind === "r2") {
    const target = bucket(services, visibility);
    const url = visibility === "public" ? new URL(key, ensureSlash(publicOrigin(services))).href : undefined;
    const result = await target.put(key, bytes, {
      httpMetadata: { contentType, cacheControl: visibility === "public" ? "public, max-age=31536000, immutable" : "private, no-store" },
      ...(overwrite ? {} : { onlyIf: { etagDoesNotMatch: "*" } }),
    });
    if (result === null) throw new ApiError(409, "OBJECT_EXISTS", "The immutable object already exists");
    return { key, provider: kind, ...(url ? { url } : {}) };
  }
  const url = visibility === "public" ? new URL(key, ensureSlash(publicOrigin(services))).href : undefined;
  await (await local()).localPut(localRoot(services), visibility, key, bytes, contentType, overwrite);
  return { key, provider: kind, ...(url ? { url } : {}) };
}
function ensureSlash(url: URL): string { return url.href.replace(/\/*$/, "/"); }
async function getObject(services: Services, visibility: Visibility, key: string): Promise<StorageObject | null> {
  assertStorageKey(key);
  const kind = provider(services);
  if (kind === "r2") {
    const result = await bucket(services, visibility).get(key);
    return result ? { key, provider: kind, body: result.body as ReadableStream<Uint8Array>, contentType: result.httpMetadata?.contentType } : null;
  }
  return (await local()).localGet(localRoot(services), visibility, key);
}
export function putPrivateObject(services: Services, key: string, bytes: Uint8Array, contentType = "application/octet-stream", overwrite = false) { return putObject(services, "private", key, bytes, contentType, overwrite); }
export function getPrivateObject(services: Services, key: string) { return getObject(services, "private", key); }
export function putPublicObject(services: Services, key: string, bytes: Uint8Array, contentType: string) { return putObject(services, "public", key, bytes, contentType, false); }
export function getPublicObject(services: Services, key: string) { return getObject(services, "public", key); }
export async function deletePrivateObject(services: Services, key: string): Promise<void> {
  assertStorageKey(key);
  const kind = provider(services);
  if (kind === "r2") return bucket(services, "private").delete(key);
  return (await local()).localDelete(localRoot(services), "private", key);
}
export async function listPrivateObjects(services: Services, prefix = ""): Promise<StorageObjectInfo[]> {
  if (prefix && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(prefix)) throw new ApiError(400, "INVALID_STORAGE_KEY", "Invalid object prefix");
  const kind = provider(services);
  if (kind === "local") return (await local()).localList(localRoot(services), "private", prefix);
  const items: StorageObjectInfo[] = [];
  let cursor: string | undefined;
  {
    do {
      const page = await bucket(services, "private").list({ prefix, cursor, limit: 1000 }) as { objects: { key: string; size: number }[]; truncated: boolean; cursor?: string };
      items.push(...page.objects.map(item => ({ key: item.key, size: item.size, provider: kind })));
      cursor = page.truncated ? page.cursor : undefined;
      if (page.truncated && !cursor) throw new ApiError(502, "STORAGE_LIST_FAILED", "R2 returned an incomplete object page");
    } while (cursor);
  }
  return items;
}
export async function readLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new ApiError(413, "FILE_TOO_LARGE", `The object exceeds ${maxBytes} bytes`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
