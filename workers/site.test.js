import assert from "node:assert/strict";
import { test } from "node:test";
import site, { createSiteWorker } from "./site.js";

const origin = "https://blog.mourn.top";
const request = (path, init) => new Request(`${origin}${path}`, init);
const env = { ASSETS: { fetch: async () => new Response("asset") } };

test("new administration index and assets are served with strict security headers", async () => {
	for (const path of ["/admin/", "/admin/index.html", "/admin/assets/app.js"]) {
		const response = await site.fetch(request(path), env);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "asset");
		assert.equal(response.headers.get("Cache-Control"), "no-store");
		assert.equal(response.headers.get("X-Frame-Options"), "DENY");
		assert.ok(
			response.headers
				.get("Content-Security-Policy")
				.includes("script-src 'self'"),
		);
	}
	const redirect = await site.fetch(
		request("/admin?next=https://evil.example"),
		env,
	);
	assert.equal(redirect.status, 302);
	assert.equal(new URL(redirect.headers.get("Location")).origin, origin);
	assert.equal(new URL(redirect.headers.get("Location")).pathname, "/admin/");
	assert.equal(
		(await site.fetch(request("/admin/", { method: "POST" }), env)).status,
		405,
	);
});
test("legacy admin pages, functions and encoded traversal remain retired", async () => {
	const forbidden = {
		ASSETS: { fetch: () => assert.fail("legacy assets reached") },
	};
	for (const path of [
		"/adminmn/",
		"/admin/old-login.html",
		"/cloud-functions/api/posts/",
		"/edge-functions/",
		"/%61dminmn/",
		"/api/a%2f..%2f..%2fadminmn/",
		"/admin/assets/%2f..%2f..%2f..%2fadminmn/index.html",
	]) {
		assert.equal(
			(await site.fetch(request(path), forbidden)).status,
			410,
			path,
		);
	}
});
test("management API errors stay JSON without falling into public assets", async () => {
	const forbidden = {
		...env,
		PLATFORM: "cloudflare",
		ASSETS: { fetch: () => assert.fail("API fell into static output") },
	};
	const response = await site.fetch(request("/api/me"), forbidden);
	assert.equal(response.status, 503);
	assert.equal((await response.json()).error.code, "CONFIG_REQUIRED");
	assert.equal(response.headers.get("Cache-Control"), "no-store");
});
test("generated public JSON stays read-only and article redirects still work", async () => {
	for (const path of ["/api/dynamic.json", "/api/allPostMeta.json"]) {
		assert.equal(await (await site.fetch(request(path), env)).text(), "asset");
		assert.equal(
			(await site.fetch(request(path, { method: "POST" }), env)).status,
			405,
		);
	}
	const response = await site.fetch(
		request("/blog/%E4%B8%AD%E6%96%87/?page=1"),
		env,
	);
	assert.equal(response.status, 301);
	assert.equal(
		response.headers.get("Location"),
		`${origin}/posts/%E4%B8%AD%E6%96%87/?page=1`,
	);
});
test("public requests strip credentials and private media keeps its sandbox policy", async () => {
	const worker = createSiteWorker({
		fetch: async (forwarded) => {
			assert.equal(forwarded.headers.get("Cookie"), null);
			assert.equal(forwarded.headers.get("Authorization"), null);
			assert.equal(await forwarded.text(), '{"text":"test"}');
			return new Response("bytes", {
				headers: { "Content-Security-Policy": "default-src 'none'; sandbox" },
			});
		},
	});
	const response = await worker.fetch(
		request("/api/public/comments", {
			method: "POST",
			headers: { Cookie: "private", Authorization: "private" },
			body: '{"text":"test"}',
		}),
		env,
	);
	assert.equal(
		response.headers.get("Content-Security-Policy"),
		"default-src 'none'; sandbox",
	);
});
