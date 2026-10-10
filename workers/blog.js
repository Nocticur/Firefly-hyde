import managedRedirects from "../src/constants/managed-redirects.json" with { type: "json" };

/**
 * Static blog gateway. The Astro build remains static (CF_WORKERS is unset).
 * Only public interaction requests reach the separate administration Worker.
 */
const RETIRED_PATHS = ["/adminmn", "/admin", "/cloud-functions", "/edge-functions", "/.edgeone"];

function retiredPath(pathname) {
	let decoded = pathname;
	try {
		// Asset routing decodes URL paths. Apply the same check before delegating.
		for (let i = 0; i < 2; i++) {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		}
	} catch {
		return true;
	}
	decoded = new URL(`https://blog.mourn.top${decoded.replaceAll("\\", "/").replace(/\/+/g, "/")}`).pathname.toLowerCase();
	return RETIRED_PATHS.some((path) => decoded === path || decoded.startsWith(`${path}/`));
}

function noStore(response) {
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store");
	headers.set("CDN-Cache-Control", "no-store");
	headers.set("Cloudflare-CDN-Cache-Control", "no-store");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function error(status, message) {
	return noStore(Response.json({ error: message }, { status }));
}

function isUncached(pathname) {
	return pathname === "/api" || pathname.startsWith("/api/") ||
		pathname === "/release-manifest.json" ||
		pathname === "/publication-manifest.json" ||
		pathname.startsWith("/preview/");
}

export function createBlogWorker(redirects = managedRedirects) {
	return {
		async fetch(request, env) {
			const url = new URL(request.url);
			if (retiredPath(url.pathname)) return error(410, "legacy_service_retired");

			if (url.pathname === "/blog" || url.pathname.startsWith("/blog/")) {
				// Preserve the original slug spelling, escapes, trailing slash and query.
				url.pathname = `/posts${url.pathname.slice("/blog".length)}`;
				return new Response(null, { status: 301, headers: { Location: url.href } });
			}

			if (url.pathname.startsWith("/posts/")) {
				let decoded = url.pathname;
				try { decoded = decodeURIComponent(decoded); } catch { /* Unmapped invalid escapes use ASSETS. */ }
				const destination = redirects[url.pathname] ?? redirects[decoded] ??
					redirects[`${url.pathname}/`] ?? redirects[`${decoded}/`];
				if (typeof destination === "string" && destination.startsWith("/posts/")) {
					const target = new URL(destination, url.origin);
					if (target.origin === url.origin && target.pathname !== url.pathname) {
						target.search = url.search;
						return new Response(null, { status: 301, headers: { Location: target.href } });
					}
				}
			}

			if (url.pathname.startsWith("/api/public/")) {
				if (!env.ADMIN) return error(503, "public_api_unavailable");
				const target = new URL(`${url.pathname}${url.search}`, "https://admin.mourn.top");
				const headers = new Headers(request.headers);
				// The blog cannot forward an administration session or bearer credential.
				headers.delete("cookie");
				headers.delete("authorization");
				try {
					const response = await env.ADMIN.fetch(new Request(new Request(target, request), {
						headers,
						redirect: "manual",
					}));
					return noStore(response);
				} catch {
					return error(502, "public_api_unavailable");
				}
			}

			// Existing generated JSON endpoints remain static and read-only.
			if (request.method !== "GET" && request.method !== "HEAD") {
				return error(405, "method_not_allowed");
			}
			const assetRequest = url.pathname === "/release-manifest.json" && request.method === "HEAD"
				? new Request(request, { method: "GET" })
				: request;
			const response = await env.ASSETS.fetch(assetRequest);
			if (url.pathname === "/release-manifest.json" && response.status === 200) {
				try {
					const manifest = await response.json();
					if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
						return error(502, "release_manifest_unavailable");
					}
					const released = noStore(Response.json({ ...manifest, workerVersion: env.VERSION?.id ?? null }));
					return request.method === "HEAD"
						? new Response(null, { status: released.status, headers: released.headers })
						: released;
				} catch {
					return error(502, "release_manifest_unavailable");
				}
			}
			return isUncached(url.pathname) ? noStore(response) : response;
		},
	};

}

export default createBlogWorker();
