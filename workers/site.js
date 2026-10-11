import blog, { retiredPath } from "./blog.js";
import management from "../management/src/worker.ts";

const STATIC_API_PATHS = new Set([
	"/api/dynamic.json",
	"/api/allPostMeta.json",
]);

function adminHeaders(response) {
	const headers = new Headers(response.headers);
	for (const name of [
		"Cache-Control",
		"CDN-Cache-Control",
		"Cloudflare-CDN-Cache-Control",
	]) {
		headers.set(name, "no-store");
	}
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Referrer-Policy", "same-origin");
	headers.set("X-Frame-Options", "DENY");
	if (!headers.has("Content-Security-Policy"))
		headers.set(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
		);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** Upstream-style /admin/ UI, using the Cloudflare management API and storage. */
export function createSiteWorker(admin = management, staticBlog = blog) {
	return {
		async fetch(request, env, context) {
			const url = new URL(request.url);
			if (retiredPath(url.pathname, true))
				return staticBlog.fetch(request, env, context);
			if (
				url.pathname === "/admin" ||
				url.pathname === "/admin/" ||
				url.pathname === "/admin/index.html" ||
				url.pathname.startsWith("/admin/assets/")
			) {
				if (request.method !== "GET" && request.method !== "HEAD") {
					return adminHeaders(
						Response.json({ error: "method_not_allowed" }, { status: 405 }),
					);
				}
				if (url.pathname === "/admin") {
					url.pathname = "/admin/";
					return adminHeaders(
						new Response(null, {
							status: 302,
							headers: { Location: url.href },
						}),
					);
				}
				// Hash routes share the single index. Other /admin/* paths stay retired.
				return adminHeaders(await env.ASSETS.fetch(request));
			}
			if (
				url.pathname === "/api" ||
				(url.pathname.startsWith("/api/") &&
					!STATIC_API_PATHS.has(url.pathname))
			) {
				// Public interaction handlers never need an administration credential.
				if (url.pathname.startsWith("/api/public/")) {
					const headers = new Headers(request.headers);
					headers.delete("cookie");
					headers.delete("authorization");
					request = new Request(request, { headers });
				}
				return adminHeaders(await admin.fetch(request, env, context));
			}
			return staticBlog.fetch(request, env, context);
		},
		scheduled: (...args) => admin.scheduled(...args),
		queue: (...args) => admin.queue(...args),
	};
}

export default createSiteWorker();
