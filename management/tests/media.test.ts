import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { authenticate } from "../src/auth.ts";
import { ApiError } from "../src/errors.ts";
import { localDatabase } from "../src/local-database.ts";
import { RecordStore } from "../src/store.ts";
import { sha256 as hashToken } from "../src/security.ts";
import { assertPublicAddress, MAX_MEDIA_BYTES, publishMedia, registerMedia, validateImportUrl, validateMedia } from "../src/media.ts";
import { getPrivateObject, listPrivateObjects, putPrivateObject, readLimited } from "../src/storage.ts";
import type { AppEnv, Media, R2Like, Services, Session } from "../src/types.ts";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
const svg = (text: string) => new TextEncoder().encode(text);
let directory: string;
before(async () => { directory = await mkdtemp(join(tmpdir(), "nocticur-media-test-")); });
after(async () => { await rm(directory, { recursive: true, force: true }); });

class Bucket implements R2Like {
  values = new Map<string, { bytes: Uint8Array; type: string }>();
  async put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream, options?: unknown) {
    const settings = options as { onlyIf?: { etagDoesNotMatch?: string }; httpMetadata?: { contentType?: string } };
    if (settings.onlyIf?.etagDoesNotMatch === "*" && this.values.has(key)) return null;
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice() : await readLimited(value as ReadableStream<Uint8Array>, MAX_MEDIA_BYTES);
    this.values.set(key, { bytes, type: settings.httpMetadata?.contentType || "application/octet-stream" });
    return { key };
  }
  async get(key: string) {
    const value = this.values.get(key);
    return value ? { body: new Blob([value.bytes.slice().buffer]).stream(), arrayBuffer: async () => value.bytes.slice().buffer, httpMetadata: { contentType: value.type } } : null;
  }
  async delete(key: string) { this.values.delete(key); }
  async list(options?: unknown) {
    const { prefix = "" } = (options || {}) as { prefix?: string };
    return { objects: [...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, size: value.bytes.length })), truncated: false };
  }
}
async function setup(name: string) {
  const database = await localDatabase(join(directory, name + ".sqlite"));
  const store = new RecordStore(database); await store.migrate();
  const privateBucket = new Bucket(); const publicBucket = new Bucket();
  const services: Services = { store, env: { PLATFORM: "cloudflare", ENVIRONMENT: "development", ADMIN_ORIGIN: "https://admin.test", MEDIA_ORIGIN: "https://media.test", PRIVATE_MEDIA: privateBucket, PUBLIC_MEDIA: publicBucket, MEDIA_IMPORT_HOSTS: "images.test" }, fetcher: fetch, now: Date.now };
  const app = new Hono<AppEnv>();
  app.onError((error, c) => error instanceof ApiError ? c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status as 400) : c.json({ error: { code: "INTERNAL", message: error.message } }, 500));
  app.use("/api/*", async (c, next) => { c.set("services", services); await next(); });
  app.use("/api/*", async (c, next) => { return authenticate(c, next); });
  registerMedia(app);
  const session: Session = { user: { id: 1, login: "test-admin" }, csrf: "test-csrf", expiresAt: Date.now() + 60_000 };
  await store.create("session", await hashToken("session-one"), session);
  await store.create("session", await hashToken("session-two"), { ...session, user: { id: 2, login: "other-test-admin" } });
  const headers = { Cookie: "mgmt-session=session-one", "X-CSRF-Token": session.csrf, Origin: "https://admin.test" };
  return { app, services, store, headers, privateBucket, publicBucket, close: async () => database.close?.() };
}
function uploadBody() {
  const form = new FormData();
  form.set("file", new File([png.slice().buffer], "original.png", { type: "image/png" }));
  form.set("alt", "An accessible description"); form.set("caption", "A visible caption");
  return form;
}
function isCode(code: string) { return (error: unknown) => error instanceof ApiError && error.code === code; }

test("image MIME types must match bytes and payloads stay bounded", () => {
  assert.equal(validateMedia(png, "image/png").extension, "png");
  assert.throws(() => validateMedia(png, "image/jpeg"), isCode("MEDIA_TYPE_MISMATCH"));
  assert.throws(() => validateMedia(new Uint8Array(), "image/png"), isCode("EMPTY_FILE"));
  assert.throws(() => validateMedia(new Uint8Array(MAX_MEDIA_BYTES + 1), "image/png"), isCode("FILE_TOO_LARGE"));
  assert.throws(() => validateMedia(svg("<html><script>alert(1)</script></html>"), "text/html"), isCode("UNSUPPORTED_MEDIA"));
});

test("Cloudflare publication fails closed without separate R2 bindings and a public origin", async () => {
  const state = await setup("r2-configuration");
  try {
    const uploaded = await state.app.request("https://admin.test/api/media/upload", { method: "POST", headers: state.headers, body: uploadBody() });
    assert.equal(uploaded.status, 201);
    const { media } = await uploaded.json() as { media: Media };
    state.services.env.PUBLIC_MEDIA = undefined;
    await assert.rejects(() => publishMedia(state.services, media.id), isCode("CONFIG_REQUIRED"));
    assert.equal((await state.store.get<Media>("media", media.id))!.value.status, "private");
    assert.equal(state.publicBucket.values.size, 0);
    state.services.env.PUBLIC_MEDIA = state.privateBucket;
    await assert.rejects(() => publishMedia(state.services, media.id), isCode("CONFIG_REQUIRED"));
    state.services.env.PUBLIC_MEDIA = state.publicBucket;
    state.services.env.MEDIA_ORIGIN = undefined;
    await assert.rejects(() => publishMedia(state.services, media.id), isCode("CONFIG_REQUIRED"));
    assert.equal(state.publicBucket.values.size, 0);
    state.services.env.MEDIA_ORIGIN = "https://media.test";
    assert.equal((await publishMedia(state.services, media.id)).status, "published");
    assert.equal(state.publicBucket.values.size, 1);
  } finally { await state.close(); }
});
test("safe SVG keeps its bytes and active/external XML is rejected", () => {
  const safe = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><defs><linearGradient id="a"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path fill="url(#a)" d="M0 0h16v16z"/><title>Safe icon</title></svg>');
  assert.deepEqual(validateMedia(safe, "image/svg+xml").bytes, safe);
  for (const unsafe of [
    '<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"/>',
    '<svg><foreignObject><iframe/></foreignObject></svg>', '<svg style="background:url(https://bad.test)"/>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>', '<?xml version="1.0"?><svg/>',
    '<svg><use href="https://bad.test/x.svg#y"/></svg>', '<svg><use href="&#106;avascript:alert(1)"/></svg>',
    '<svg><path fill="url(https://bad.test/x)"/></svg>', '<svg><path fill="u\\72l(https://bad.test/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/1999/xhtml"/>', '<svg><path id="x" id="y"/></svg>', '<svg/><script/>',
  ]) assert.throws(() => validateMedia(svg(unsafe), "image/svg+xml"), isCode("UNSAFE_SVG"), unsafe);
});
test("external import requires exact allowlisted HTTPS hosts", () => {
  assert.equal(validateImportUrl("https://images.test/a.png#fragment", "images.test").href, "https://images.test/a.png");
  for (const unsafe of ["http://images.test/a", "https://images.test.evil.test/a", "https://u:p@images.test/a", "https://images.test:8443/a", "https://images.test./a", "https://localhost/a", "https://127.0.0.1/a", "https://2130706433/a"]) assert.throws(() => validateImportUrl(unsafe, "images.test,localhost,127.0.0.1"));
  assert.throws(() => validateImportUrl("https://images.test/a", ""), isCode("CONFIG_REQUIRED"));
});
test("DNS checks reject private, loopback, mapped and special IP ranges", () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "10.1.1.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.88.99.1", "198.18.0.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2001:2::1", "2002:7f00:1::", "3fff::1"]) assert.throws(() => assertPublicAddress(address), isCode("UNSAFE_IMPORT_URL"), address);
  assert.doesNotThrow(() => assertPublicAddress("8.8.8.8"));
  assert.doesNotThrow(() => assertPublicAddress("2606:4700:4700::1111"));
});
test("upload and private reads require authentication and CSRF; publication is explicit", async () => {
  const state = await setup("authenticated");
  try {
    assert.equal((await state.app.request("https://admin.test/api/media/upload", { method: "POST", body: uploadBody() })).status, 401);
    assert.equal((await state.app.request("https://admin.test/api/media/upload", { method: "POST", headers: { Cookie: state.headers.Cookie }, body: uploadBody() })).status, 403);
    const response = await state.app.request("https://admin.test/api/media/upload", { method: "POST", headers: state.headers, body: uploadBody() });
    assert.equal(response.status, 201);
    const { media } = await response.json() as { media: Media & { version: number } };
    assert.equal(media.status, "private"); assert.equal(media.url, undefined);
    assert.equal(media.alt, "An accessible description"); assert.equal(media.caption, "A visible caption");
    assert.equal(state.privateBucket.values.size, 1); assert.equal(state.publicBucket.values.size, 0);
    assert.equal((await state.app.request(`https://admin.test/api/media/${media.id}/content`)).status, 401);
    assert.equal((await state.app.request(`https://admin.test/api/media/${media.id}/content`, { headers: { Cookie: "mgmt-session=session-two" } })).status, 404);
    const content = await state.app.request(`https://admin.test/api/media/${media.id}/content`, { headers: state.headers });
    assert.deepEqual(new Uint8Array(await content.arrayBuffer()), png);
    assert.equal(content.headers.get("Cache-Control"), "private, no-store"); assert.equal(content.headers.get("X-Content-Type-Options"), "nosniff");
    const first = await publishMedia(state.services, media.id);
    assert.match(first.url!, /^https:\/\/media\.test\/published\/[0-9a-f]{64}\.png$/);
    assert.equal(state.publicBucket.values.size, 1);
    const second = await publishMedia(state.services, media.id);
    assert.equal(first.url, second.url); assert.equal(state.publicBucket.values.size, 1);
    const patch = (version: number) => state.app.request(`https://admin.test/api/media/${media.id}`, { method: "PATCH", headers: { ...state.headers, "Content-Type": "application/json" }, body: JSON.stringify({ version, alt: "New description", caption: "Separate caption" }) });
    assert.equal((await patch(media.version)).status, 409); // Publishing advanced the stored version.
    const latest = await state.store.get<Media>("media", media.id);
    assert.equal((await patch(latest!.version)).status, 200);
    assert.equal((await patch(latest!.version)).status, 409);
  } finally { await state.close(); }
});
test("media imports reject DNS private addresses and redirects before saving", async () => {
  const state = await setup("imports");
  try {
    let imageRequests = 0;
    state.services.fetcher = (async input => {
      const url = new URL(String(input));
      if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: [{ type: 1, data: "10.0.0.1" }] });
      imageRequests++; return new Response(png.slice().buffer, { headers: { "Content-Type": "image/png" } });
    }) as typeof fetch;
    const request = () => state.app.request("https://admin.test/api/media/import", { method: "POST", headers: { ...state.headers, "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://images.test/a.png", alt: "", caption: "" }) });
    assert.equal((await request()).status, 400); assert.equal(imageRequests, 0);
    state.services.fetcher = (async input => String(input).includes("cloudflare-dns.com") ? Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] }) : new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/private" } })) as typeof fetch;
    assert.equal((await request()).status, 400); assert.equal(state.privateBucket.values.size, 0);
    state.services.fetcher = (async input => String(input).includes("cloudflare-dns.com") ? Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] }) : new Response(png.slice().buffer, { headers: { "Content-Type": "image/png" } })) as typeof fetch;
    assert.equal((await request()).status, 201); assert.equal(state.privateBucket.values.size, 1); assert.equal(state.publicBucket.values.size, 0);
  } finally { await state.close(); }
});
test("local development media survives a reopened database and filesystem adapter", async () => {
  const state = await setup("local-restart");
  const localEnv = { PLATFORM: "local" as const, ENVIRONMENT: "development" as const, NODE_ENV: "development", LOCAL_MEDIA_PATH: join(directory, "objects"), ADMIN_ORIGIN: "https://admin.test" };
  state.services.env = localEnv;
  let originalClosed = false;
  try {
    await putPrivateObject(state.services, "backup/one.json", new TextEncoder().encode('{"stable":true}'), "application/json");
    const object = await getPrivateObject({ ...state.services, env: { ...localEnv } }, "backup/one.json");
    assert.equal(new TextDecoder().decode(await readLimited(object!.body, 100)), '{"stable":true}');
    assert.deepEqual((await listPrivateObjects(state.services)).map(item => item.key), ["backup/one.json"]);
    for (const env of [{ PLATFORM: "local", ENVIRONMENT: "production", NODE_ENV: "development" }, { PLATFORM: "local", ENVIRONMENT: "development", NODE_ENV: "production" }, { PLATFORM: "cloudflare", ENVIRONMENT: "production" }]) {
      await assert.rejects(() => putPrivateObject({ ...state.services, env: env as Services["env"] }, "media/one.png", png, "image/png"), isCode("CONFIG_REQUIRED"));
    }
    await assert.rejects(() => getPrivateObject(state.services, "../escape"), isCode("INVALID_STORAGE_KEY"));
    const uploaded = await state.app.request("https://admin.test/api/media/upload", { method: "POST", headers: state.headers, body: uploadBody() });
    assert.equal(uploaded.status, 201);
    const { media } = await uploaded.json() as { media: Media };
    await state.close(); originalClosed = true;
    const reopened = await localDatabase(join(directory, "local-restart.sqlite"));
    try {
      const reopenedStore = new RecordStore(reopened);
      const record = await reopenedStore.get<Media>("media", media.id);
      assert.equal(record!.value.id, media.id); assert.equal(record!.value.status, "private");
      const privateObject = await getPrivateObject({ ...state.services, store: reopenedStore }, record!.value.key);
      assert.deepEqual(await readLimited(privateObject!.body, MAX_MEDIA_BYTES), png);
    } finally { await reopened.close?.(); }
  } finally { if (!originalClosed) await state.close(); }
});
