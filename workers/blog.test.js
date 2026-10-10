import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { createBlogWorker } from "./blog.js";
import { onRequest as retiredLogin } from "../admin/cloud-functions/api/auth/login.js";

const origin = "https://blog.mourn.top";
const request = (path, init) => new Request(`${origin}${path}`, init);

function bindings(overrides = {}) {
	return {
		VERSION: { id: "worker-version-from-platform" },
		ASSETS: { fetch: async () => new Response("static") },
		ADMIN: { fetch: async () => Response.json({ ok: true }) },
		...overrides,
	};
}

function assertNoStore(response) {
	for (const header of ["Cache-Control", "CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"]) {
		assert.equal(response.headers.get(header), "no-store");
	}
}

test("retired administration paths cannot reach assets or the management Worker", async () => {
	const unexpected = { fetch: () => { assert.fail("retired path reached a binding"); } };
	const env = bindings({ ASSETS: unexpected, ADMIN: unexpected });
	for (const path of [
		"/adminmn/", "/adminmn/moments/", "/admin/", "/ADMINMN/INDEX.HTML",
		"/%61dminmn/", "/%2561dminmn/", "/%2Fadminmn/", "/%2Fadminmn%2Fmoments/", "/cloud-functions/api/posts/",
		"/edge-functions/api/auth/logout", "/.edgeone/", "/api/a%2f..%2f..%2fadminmn/",
	]) {
		const response = await worker.fetch(request(path), env);
		assert.equal(response.status, 410, path);
		assertNoStore(response);
	}
});

test("legacy article redirects retain slug spelling, URL escapes and query parameters", async () => {
	for (const path of ["/blog/AbC/", "/blog/%E8%BD%AF%E4%BB%B6%E5%88%86%E4%BA%AB/?A=1", "/blog/one?old=1"]) {
		const response = await worker.fetch(request(path), bindings());
		assert.equal(response.status, 301);
		assert.equal(response.headers.get("Location"), `${origin}${path.replace("/blog/", "/posts/")}`);
	}
});

test("public requests preserve method, body and Origin while stripping administration credentials", async () => {
	let count = 0;
	const env = bindings({ ADMIN: { fetch: async (forwarded) => {
		count++;
		assert.equal(forwarded.url, "https://admin.mourn.top/api/public/comments?articleId=one");
		assert.equal(forwarded.headers.get("cookie"), null);
		assert.equal(forwarded.headers.get("authorization"), null);
		assert.equal(forwarded.headers.get("origin"), origin);
		assert.equal(forwarded.redirect, "manual");
		if (forwarded.method === "POST") assert.equal(await forwarded.text(), '{"text":"hello"}');
		return Response.json({ ok: true }, { headers: { "Cache-Control": "public, max-age=900" } });
	} } });
	for (const method of ["GET", "POST"]) {
		const response = await worker.fetch(request("/api/public/comments?articleId=one", {
			method,
			headers: { cookie: "session=private", authorization: "Bearer private", origin },
			...(method === "POST" ? { body: '{"text":"hello"}' } : {}),
		}), env);
		assert.equal(response.status, 200);
		assertNoStore(response);
	}
	assert.equal(count, 2);
});

test("static API output remains read-only and private API requests never use ADMIN", async () => {
	let count = 0;
	const env = bindings({
		ASSETS: { fetch: async () => { count++; return new Response("static JSON"); } },
		ADMIN: { fetch: () => { assert.fail("private API was proxied"); } },
	});
	const response = await worker.fetch(request("/api/dynamic.json"), env);
	assert.equal(await response.text(), "static JSON");
	assertNoStore(response);
	assert.equal((await worker.fetch(request("/api/posts", { method: "POST" }), env)).status, 405);
	assert.equal(count, 1);
});

test("release manifest uses the actual platform Worker version and disables caching", async () => {
	const env = bindings({ ASSETS: { fetch: async () => Response.json({
		gitSha: "git-sha-from-build", contentHash: "content-hash-from-build", workerVersion: "stale",
	}) } });
	const response = await worker.fetch(request("/release-manifest.json"), env);
	assert.deepEqual(await response.json(), {
		gitSha: "git-sha-from-build", contentHash: "content-hash-from-build", workerVersion: "worker-version-from-platform",
	});
	assertNoStore(response);
	const local = await worker.fetch(request("/release-manifest.json"), { ...env, VERSION: undefined });
	assert.equal((await local.json()).workerVersion, null);
	const head = await worker.fetch(request("/release-manifest.json", { method: "HEAD" }), env);
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	assertNoStore(head);
});

test("invalid manifests and unavailable public backends fail without caching", async () => {
	const invalid = await worker.fetch(request("/release-manifest.json"), bindings({ ASSETS: { fetch: async () => new Response("invalid JSON") } }));
	assert.equal(invalid.status, 502);
	assertNoStore(invalid);
	const missing = await worker.fetch(request("/api/public/comments"), bindings({ ADMIN: undefined }));
	assert.equal(missing.status, 503);
	assertNoStore(missing);
	const failed = await worker.fetch(request("/api/public/comments"), bindings({ ADMIN: { fetch: async () => { throw new Error("unavailable"); } } }));
	assert.equal(failed.status, 502);
	assertNoStore(failed);
});

test("ordinary static pages retain asset caching and old login cannot issue a session", async () => {
	const response = await worker.fetch(request("/posts/AbC/"), bindings({ ASSETS: { fetch: async () => new Response("static", { headers: { "Cache-Control": "max-age=3600" } }) } }));
	assert.equal(response.headers.get("Cache-Control"), "max-age=3600");
	const login = await retiredLogin({ request: request("/api/auth/login", { method: "POST", body: "invalid" }), env: {} });
	assert.equal(login.status, 410);
	assert.equal(login.headers.get("Set-Cookie"), null);
});


test("published slug redirects preserve case, Chinese slugs and query strings", async () => {
	const renamed = createBlogWorker({
		"/posts/OldName/": "/posts/NewName/",
		"/posts/旧名字/": "/posts/新名字/",
		"/posts/invalid/": "https://external.example/posts/private/",
	});
	for (const [source, target] of [
		["/posts/OldName/?ref=old", "/posts/NewName/?ref=old"],
		["/posts/OldName?ref=old", "/posts/NewName/?ref=old"],
		["/posts/%E6%97%A7%E5%90%8D%E5%AD%97/?ref=old", "/posts/%E6%96%B0%E5%90%8D%E5%AD%97/?ref=old"],
	]) {
		const response = await renamed.fetch(request(source), bindings());
		assert.equal(response.status, 301);
		assert.equal(response.headers.get("Location"), `${origin}${target}`);
	}
	assert.equal((await renamed.fetch(request("/posts/invalid/"), bindings())).status, 200);
});
