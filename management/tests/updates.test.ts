import assert from "node:assert/strict";
import { test } from "node:test";
import { checkUpdates, themeUpstream } from "../src/updates.ts";
import type { Services } from "../src/types.ts";

function fixture(options: {
	themeVersion?: string;
	managementVersion?: string;
	comparison?: "ahead" | "behind" | "diverged" | "identical";
	themeFailure?: number;
} = {}) {
	const requests: string[] = [];
	const themeSha = "b".repeat(40), managementSha = "c".repeat(40);
	const services: Services = {
		store: {} as Services["store"], now: () => Date.parse("2026-10-11T00:00:00Z"),
		env: { GITHUB_REPOSITORY: "Nocticur/Firefly-hyde", GITHUB_BRANCH: "main" },
		fetcher: async (input, init) => {
			const url = new URL(String(input));
			assert.equal(url.origin, "https://api.github.com");
			assert.equal(init?.method ?? "GET", "GET", "version checks must not write or upgrade");
			assert.equal(init?.redirect, "error");
			requests.push(url.pathname);
			const theme = url.pathname.includes(`/repos/${themeUpstream.repository}/`);
			if (theme && options.themeFailure) return new Response("provider-private-error-body", { status: options.themeFailure });
			if (url.pathname.includes("/branches/")) return Response.json({ commit: { sha: theme ? themeSha : managementSha } });
			if (url.pathname.includes("/contents/")) {
				assert.equal(url.searchParams.get("ref"), theme ? themeSha : managementSha, "manifest must use the observed immutable SHA");
				const version = theme ? options.themeVersion ?? "6.16.8" : options.managementVersion ?? "1.0.1";
				return Response.json({ encoding: "base64", content: Buffer.from(JSON.stringify({ version })).toString("base64") });
			}
			if (url.pathname.includes("/compare/")) {
				assert(url.pathname.includes(themeUpstream.baselineSha));
				const status = options.comparison ?? "ahead";
				return Response.json({ status, ahead_by: ["ahead", "diverged"].includes(status) ? 4 : 0, behind_by: ["behind", "diverged"].includes(status) ? 2 : 0 });
			}
			throw new Error("Unexpected version-check request");
		},
	};
	return { services, requests };
}

test("upstream checks detect new theme commits without a release or version bump and newer management versions", async () => {
	const f = fixture({ managementVersion: "1.0.2" });
	const result = await checkUpdates(f.services);
	assert.equal(result.automaticUpgrade, false);
	assert.equal(result.complete, true);
	assert.equal(result.components[0].repository, "Seasir-Hyde/Firefly-hyde");
	assert.equal(result.components[0].status, "update-available");
	assert.equal(result.components[0].versionStatus, "up-to-date");
	assert.equal(result.components[0].commitsAhead, 4);
	assert.equal(result.components[1].currentVersion, "1.0.1");
	assert.equal(result.components[1].latestVersion, "1.0.2");
	assert.equal(result.components[1].status, "update-available");
	assert.equal(f.requests.length, 5);
	assert(!f.requests.some((url) => url.includes("/releases/")));
});

test("identical theme ancestry and equal management versions are explicitly current", async () => {
	const f = fixture({ comparison: "identical" });
	const result = await checkUpdates(f.services);
	assert(result.components.every((component) => component.status === "up-to-date"));
	assert.equal(result.components[0].commitsAhead, 0);
});

test("semantic versions compare numerically and preserve prerelease ordering", async () => {
	let result = await checkUpdates(fixture({ managementVersion: "1.0.10-rc.1" }).services);
	assert.equal(result.components[1].status, "update-available");
	result = await checkUpdates(fixture({ managementVersion: "1.0.1-rc.1" }).services);
	assert.equal(result.components[1].status, "ahead");
});

test("diverged theme histories require review even when package versions agree", async () => {
	const result = await checkUpdates(fixture({ comparison: "diverged" }).services);
	assert.equal(result.components[0].status, "diverged");
	assert.equal(result.components[0].commitsAhead, 4);
	assert.equal(result.components[0].commitsBehind, 2);
});

test("unavailable upstreams do not report current and retain independently verified backend results", async () => {
	const result = await checkUpdates(fixture({ themeFailure: 429 }).services);
	assert.equal(result.complete, false);
	assert.equal(result.components[0].status, "unavailable");
	assert.match(result.components[0].message!, /HTTP 429/);
	assert.equal(result.components[1].status, "up-to-date");
	assert(!JSON.stringify(result).includes("provider-private-error-body"));
});

test("malformed upstream versions and repository names fail closed", async () => {
	const f = fixture({ themeVersion: "latest<script>" });
	f.services.env.GITHUB_REPOSITORY = "https://attacker.test/owner/repository";
	const result = await checkUpdates(f.services);
	assert.equal(result.complete, false);
	assert(result.components.every((component) => component.status === "unavailable"));
	assert(f.requests.every((path) => path.startsWith(`/repos/${themeUpstream.repository}/`)));
});
