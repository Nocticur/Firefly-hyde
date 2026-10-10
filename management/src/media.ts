import type { Hono } from "hono";
import { z } from "zod";
import { ApiError, required } from "./errors.ts";
import { deletePrivateObject, getPrivateObject, getPublicObject, putPrivateObject, putPublicObject, readLimited } from "./storage.ts";
import type { AppEnv, Media, Services, Stored } from "./types.ts";

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/x-icon": "ico", "image/svg+xml": "svg" };
const text = z.string().max(4000).default("");
const patchSchema = z.object({ version: z.number().int().positive(), alt: text, caption: text });
const importSchema = z.object({ url: z.string().url().max(2048), alt: text, caption: text });
function checked<T>(result: z.ZodSafeParseResult<T>): T {
  if (!result.success) throw new ApiError(400, "INVALID_INPUT", "Invalid media metadata", result.error.flatten());
  return result.data;
}
function canonicalType(value: string): string {
  const type = value.split(";")[0].trim().toLowerCase();
  return type === "image/vnd.microsoft.icon" ? "image/x-icon" : type;
}
function extensionFor(contentType: string): string {
  const extension = TYPES[canonicalType(contentType)];
  if (!extension) throw new ApiError(415, "UNSUPPORTED_MEDIA", "Only PNG, JPEG, GIF, WebP, AVIF, ICO and safe SVG images are supported");
  return extension;
}
function safeFilename(value: string): string {
  const filename = value.split(/[\\/]/).at(-1) || "image";
  if (/[\u0000-\u001f\u007f]/.test(filename)) throw new ApiError(400, "INVALID_INPUT", "Invalid media filename");
  return filename.slice(0, 240);
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}

// SVGs use a static element/attribute allowlist. Active content, external resources,
// XML declarations and entities are rejected rather than rewritten ambiguously.
export function sanitizeSvg(bytes: Uint8Array): Uint8Array {
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(); }
  catch { throw new ApiError(415, "UNSAFE_SVG", "SVG must contain valid UTF-8"); }
  const elements = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "title", "desc", "clipPath", "mask", "pattern", "symbol", "use", "text", "tspan"]);
  const attributes = new Set(["xmlns", "xmlns:xlink", "id", "class", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "transform", "gradientTransform", "gradientUnits", "offset", "stop-color", "stop-opacity", "spreadMethod", "preserveAspectRatio", "clip-path", "clip-rule", "mask", "maskUnits", "patternUnits", "patternTransform", "patternContentUnits", "href", "xlink:href", "font-size", "font-family", "font-weight", "text-anchor", "dominant-baseline", "dx", "dy", "role", "aria-label", "aria-hidden", "focusable"]);
  if (!source.startsWith("<svg") || /<!|<\?|\u0000/.test(source)) throw new ApiError(415, "UNSAFE_SVG", "SVG declarations and active XML are not supported");
  const stack: string[] = [];
  const tag = /<[^>]*>/g;
  let previous = 0;
  let closedRoot = false;
  for (const match of source.matchAll(tag)) {
    const index = match.index!;
    const outside = source.slice(previous, index);
    if (outside.includes("<") || (stack.length === 0 && outside.trim())) throw new ApiError(415, "UNSAFE_SVG", "Malformed SVG document");
    previous = index + match[0].length;
    const parts = /^<(\/)?([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)>$/.exec(match[0]);
    if (!parts || !elements.has(parts[2]) || closedRoot) throw new ApiError(415, "UNSAFE_SVG", "Unsupported SVG element");
    const [, closing, name, rawAttributes, selfClosing] = parts;
    if (closing) {
      if (rawAttributes.trim() || selfClosing || stack.pop() !== name) throw new ApiError(415, "UNSAFE_SVG", "Malformed SVG nesting");
      if (stack.length === 0) closedRoot = true;
      continue;
    }
    if (stack.length === 0 && name !== "svg") throw new ApiError(415, "UNSAFE_SVG", "SVG requires one root element");
    const seen = new Set<string>();
    const attribute = /\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("[^"]*"|'[^']*')/g;
    let consumed = 0;
    for (const item of rawAttributes.matchAll(attribute)) {
      if (rawAttributes.slice(consumed, item.index).trim()) throw new ApiError(415, "UNSAFE_SVG", "Malformed SVG attribute");
      consumed = item.index! + item[0].length;
      const attrName = item[1];
      const value = item[2].slice(1, -1);
      if (!attributes.has(attrName) || seen.has(attrName) || value.includes("<") || /[\\\u0000-\u001f]/.test(value)) throw new ApiError(415, "UNSAFE_SVG", "Unsupported SVG attribute");
      seen.add(attrName);
      if (attrName === "xmlns" && value !== "http://www.w3.org/2000/svg") throw new ApiError(415, "UNSAFE_SVG", "Invalid SVG namespace");
      if (attrName === "xmlns:xlink" && value !== "http://www.w3.org/1999/xlink") throw new ApiError(415, "UNSAFE_SVG", "Invalid XLink namespace");
      if (["href", "xlink:href"].includes(attrName) && !/^#[A-Za-z0-9_.:-]+$/.test(value)) throw new ApiError(415, "UNSAFE_SVG", "SVG links must reference a local shape");
      if (["clip-path", "mask"].includes(attrName) && !/^(none|url\(#[A-Za-z0-9_.:-]+\))$/.test(value)) throw new ApiError(415, "UNSAFE_SVG", "SVG references must stay in the image");
      if (["fill", "stroke", "stop-color"].includes(attrName) && !/^(none|currentColor|transparent|#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d.,%+\-\s]+\)|hsla?\([\d.,%+\-\s]+\)|url\(#[A-Za-z0-9_.:-]+\))$/i.test(value)) throw new ApiError(415, "UNSAFE_SVG", "Unsafe SVG paint value");
      if (/(?:javascript|data|https?):/i.test(value) && !["xmlns", "xmlns:xlink"].includes(attrName)) throw new ApiError(415, "UNSAFE_SVG", "External SVG resources are not allowed");
    }
    if (rawAttributes.slice(consumed).trim()) throw new ApiError(415, "UNSAFE_SVG", "Malformed SVG attributes");
    if (!selfClosing) stack.push(name);
    else if (stack.length === 0) closedRoot = true;
  }
  if (!closedRoot || stack.length || source.slice(previous).trim()) throw new ApiError(415, "UNSAFE_SVG", "Incomplete SVG document");
  return bytes;
}
export function validateMedia(bytes: Uint8Array, value: string): { bytes: Uint8Array; contentType: string; extension: string } {
  if (!bytes.byteLength) throw new ApiError(400, "EMPTY_FILE", "The image is empty");
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new ApiError(413, "FILE_TOO_LARGE", "Images must not exceed 10 MiB");
  const contentType = canonicalType(value);
  const extension = extensionFor(contentType);
  const starts = (signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  const matches = contentType === "image/png" ? starts([137, 80, 78, 71, 13, 10, 26, 10])
    : contentType === "image/jpeg" ? starts([255, 216, 255])
    : contentType === "image/gif" ? ["GIF87a", "GIF89a"].includes(ascii(0, 6))
    : contentType === "image/webp" ? ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP"
    : contentType === "image/avif" ? ascii(4, 8) === "ftyp" && /avif|avis/.test(ascii(8, Math.min(bytes.length, 40)))
    : contentType === "image/x-icon" ? starts([0, 0, 1, 0]) && bytes.length >= 6 && ((bytes[4] | (bytes[5] << 8)) > 0)
    : contentType === "image/svg+xml";
  if (!matches) throw new ApiError(415, "MEDIA_TYPE_MISMATCH", "The file does not match its declared image type");
  return { bytes: contentType === "image/svg+xml" ? sanitizeSvg(bytes) : bytes, contentType, extension };
}

export function assertPublicAddress(address: string): void {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.includes(":")) {
    if (normalized.includes(".") || !/^[0-9a-f:]+$/.test(normalized) || normalized.split("::").length > 2) throw new ApiError(400, "UNSAFE_IMPORT_URL", "Non-public IP addresses cannot be imported");
    const halves = normalized.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) throw new ApiError(400, "UNSAFE_IMPORT_URL", "Invalid IP address");
    const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right];
    if (groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) throw new ApiError(400, "UNSAFE_IMPORT_URL", "Invalid IP address");
    const values = groups.map(group => parseInt(group, 16));
    if (values[0] < 0x2000 || values[0] >= 0x4000 || values[0] === 0x2002 || values[0] === 0x3fff || (values[0] === 0x2001 && (values[1] < 0x200 || values[1] === 0xdb8))) throw new ApiError(400, "UNSAFE_IMPORT_URL", "Non-public IP addresses cannot be imported");
    return;
  }
  const parts = normalized.split(".");
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || +part > 255)) throw new ApiError(400, "UNSAFE_IMPORT_URL", "Invalid IP address");
  const [a, b, c] = parts.map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) throw new ApiError(400, "UNSAFE_IMPORT_URL", "Non-public IP addresses cannot be imported");
}
export function validateImportUrl(value: string, allowHosts: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, "UNSAFE_IMPORT_URL", "Invalid media URL"); }
  const allowed = allowHosts.split(/[\s,]+/).filter(Boolean).map(host => host.toLowerCase());
  if (!allowed.length) throw new ApiError(503, "CONFIG_REQUIRED", "MEDIA_IMPORT_HOSTS must explicitly allow trusted media hosts");
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || host.endsWith(".") || !allowed.includes(host) || !/^[a-z0-9.-]+$/.test(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new ApiError(400, "UNSAFE_IMPORT_URL", "Only HTTPS URLs on explicitly allowed public hosts can be imported");
  if (/^[\d.]+$/.test(host)) assertPublicAddress(host);
  url.hash = "";
  return url;
}
async function assertPublicDns(services: Services, host: string): Promise<void> {
  if (/^[\d.]+$/.test(host)) { assertPublicAddress(host); return; }
  const responses = await Promise.all(["A", "AAAA"].map(async type => {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", host); url.searchParams.set("type", type);
    const response = await services.fetcher(url, { headers: { Accept: "application/dns-json" }, redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new ApiError(502, "DNS_LOOKUP_FAILED", "Could not verify the import host's public DNS addresses");
    const raw = await readLimited(response.body, 64 * 1024);
    const result = JSON.parse(new TextDecoder().decode(raw)) as { Status?: number; Answer?: { type: number; data: string }[] };
    if (result.Status !== 0) throw new ApiError(502, "DNS_LOOKUP_FAILED", "The import host has no usable public DNS answer");
    return (result.Answer ?? []).filter(answer => answer.type === 1 || answer.type === 28).map(answer => answer.data);
  }));
  const addresses = responses.flat();
  if (!addresses.length) throw new ApiError(400, "UNSAFE_IMPORT_URL", "The import host has no public addresses");
  addresses.forEach(assertPublicAddress);
}
function mediaView(record: Stored<Media>) {
  const { owner: _owner, key: _key, ...media } = record.value;
  return { ...media, version: record.version };
}
async function ownedMedia(services: Services, id: string, owner: number): Promise<Stored<Media>> {
  const record = await services.store.get<Media>("media", id);
  if (!record || record.value.owner !== owner) throw new ApiError(404, "MEDIA_NOT_FOUND", "Media does not exist");
  return record;
}
async function savePrivate(services: Services, owner: number, filename: string, bytes: Uint8Array, contentType: string, alt: string, caption: string): Promise<Stored<Media>> {
  const validated = validateMedia(bytes, contentType);
  const id = crypto.randomUUID();
  const key = `media/${owner}/${id}.${validated.extension}`;
  const object = await putPrivateObject(services, key, validated.bytes, validated.contentType);
  const value: Media = { id, key, filename: safeFilename(filename), size: validated.bytes.length, contentType: validated.contentType, alt, caption, owner, status: "private", createdAt: new Date(services.now()).toISOString(), provider: object.provider, sha256: await sha256(validated.bytes) };
  try { return await services.store.create("media", id, value); }
  catch (error) { await deletePrivateObject(services, key).catch(() => {}); throw error; }
}
export async function publishMedia(services: Services, mediaId: string): Promise<Media> {
  const record = await services.store.get<Media>("media", mediaId);
  if (!record || record.value.status === "pending") throw new ApiError(409, "MEDIA_NOT_READY", "Publication references incomplete media");
  if (record.value.status === "published" && record.value.url) return record.value;
  const object = await getPrivateObject(services, record.value.key);
  if (!object) throw new ApiError(409, "MEDIA_NOT_FOUND", "Publication's private media is missing");
  const validated = validateMedia(await readLimited(object.body, MAX_MEDIA_BYTES), record.value.contentType);
  const hash = await sha256(validated.bytes);
  if (hash !== record.value.sha256) throw new ApiError(409, "MEDIA_CHANGED", "Media changed after it was accepted");
  const publicKey = `published/${hash}.${validated.extension}`;
  let url: string | undefined;
  try { url = (await putPublicObject(services, publicKey, validated.bytes, validated.contentType)).url; }
  catch (error) {
    // Immutable keys are shared by identical content; verify before reusing one.
    const existing = await getPublicObject(services, publicKey);
    if (!existing || await sha256(await readLimited(existing.body, MAX_MEDIA_BYTES)) !== hash) throw error;
    url = new URL(publicKey, required(services.env.MEDIA_ORIGIN, "MEDIA_ORIGIN").replace(/\/*$/, "/")).href;
  }
  const updated = await services.store.update<Media>("media", mediaId, record.version, { ...record.value, status: "published", url: required(url, "Public media URL"), sha256: hash });
  return updated.value;
}

export function registerMedia(app: Hono<AppEnv>): void {
  app.get("/api/media", async c => {
    const records = await c.get("services").store.all<Media>("media");
    return c.json({ items: records.filter(record => record.value.owner === c.get("session").user.id).map(mediaView) });
  });
  app.post("/api/media/upload", async c => {
    // Limit multipart bytes before parsing; the browser's declared size is untrusted.
    const bytes = await readLimited(c.req.raw.body, MAX_MEDIA_BYTES + 64 * 1024);
    const form = await new Response(bytes.slice().buffer, { headers: { "Content-Type": c.req.header("Content-Type") || "" } }).formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "INVALID_INPUT", "A file is required");
    const alt = checked(text.safeParse(form.get("alt") || ""));
    const caption = checked(text.safeParse(form.get("caption") || ""));
    const record = await savePrivate(c.get("services"), c.get("session").user.id, file.name, new Uint8Array(await file.arrayBuffer()), file.type, alt, caption);
    return c.json({ media: mediaView(record) }, 201);
  });
  app.post("/api/media/import", async c => {
    const body = checked(importSchema.safeParse(await c.req.json()));
    const services = c.get("services");
    const url = validateImportUrl(body.url, services.env.MEDIA_IMPORT_HOSTS || "");
    await assertPublicDns(services, url.hostname);
    const response = await services.fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { Accept: Object.keys(TYPES).join(", ") } });
    if (response.status >= 300 && response.status < 400) throw new ApiError(400, "IMPORT_REDIRECT_REJECTED", "Redirects are not accepted for media imports");
    if (!response.ok) throw new ApiError(502, "IMPORT_FAILED", `The allowed media host returned HTTP ${response.status}`);
    const length = response.headers.get("Content-Length");
    if (length && Number(length) > MAX_MEDIA_BYTES) { await response.body?.cancel(); throw new ApiError(413, "FILE_TOO_LARGE", "The imported image exceeds 10 MiB"); }
    const contentType = canonicalType(response.headers.get("Content-Type") || "");
    extensionFor(contentType);
    const bytes = await readLimited(response.body, MAX_MEDIA_BYTES);
    const filename = safeFilename(decodeURIComponent(url.pathname.split("/").at(-1) || `image.${TYPES[contentType]}`));
    const record = await savePrivate(services, c.get("session").user.id, filename, bytes, contentType, body.alt, body.caption);
    return c.json({ media: mediaView(record) }, 201);
  });
  app.patch("/api/media/:id", async c => {
    const body = checked(patchSchema.safeParse(await c.req.json()));
    const services = c.get("services");
    const record = await ownedMedia(services, c.req.param("id"), c.get("session").user.id);
    const updated = await services.store.update("media", record.id, body.version, { ...record.value, alt: body.alt, caption: body.caption });
    return c.json({ media: mediaView(updated) });
  });
  app.get("/api/media/:id/content", async c => {
    const services = c.get("services");
    const record = await ownedMedia(services, c.req.param("id"), c.get("session").user.id);
    if (record.value.status === "pending") throw new ApiError(409, "UPLOAD_PENDING", "The private upload has not been verified yet");
    const object = await getPrivateObject(services, record.value.key);
    if (!object) throw new ApiError(404, "MEDIA_NOT_FOUND", "The private image is missing");
    return new Response(object.body, { headers: { "Content-Type": record.value.contentType, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(record.value.filename)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
  });
}
