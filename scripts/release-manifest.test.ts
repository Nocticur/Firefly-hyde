import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const first = {
	id: "00000000-0000-5000-a000-000000000001",
	path: "src/content/posts/public.md",
	slug: "中文/Case",
};
const second = {
	id: "00000000-0000-5000-a000-000000000002",
	path: "src/content/posts/private.mdx",
	slug: "private",
};
const publicRaw =
	"---\ntitle: Public\nslug: 中文/Case\ndraft: false\n---\nPublic text.\n";
const privateRaw =
	"---\ntitle: Secret\ndraft: true\n---\nprivate-marker-not-for-publication\n";

async function fixture(
	run: (directory: string) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(
		path.join(tmpdir(), "release-manifest-test-"),
	);
	try {
		await mkdir(path.join(directory, "src/constants"), { recursive: true });
		await mkdir(path.join(directory, "src/content/posts"), { recursive: true });
		await mkdir(path.join(directory, "cache"));
		await writeFile(path.join(directory, first.path), publicRaw);
		await writeFile(path.join(directory, second.path), privateRaw);
		await writeFile(
			path.join(directory, "src/constants/article-ids.json"),
			JSON.stringify({
				repository: "Nocticur/Test",
				articles: [first, second],
			}),
		);
		await writeFile(
			path.join(directory, "src/constants/managed-settings.json"),
			"{}",
		);
		await writeFile(
			path.join(directory, "cache/nocticur-release-source.json"),
			JSON.stringify({ gitSha: "a".repeat(40), dirty: true }),
		);
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function build(directory: string): void {
	execFileSync(
		process.execPath,
		[
			path.join(root, "node_modules/tsx/dist/cli.mjs"),
			path.join(root, "scripts/generate-release-manifest.ts"),
		],
		{ cwd: directory, stdio: "pipe" },
	);
}

test("release manifest retains case and stable identity, hashes bytes, and omits every draft field", async () => {
	await fixture(async (directory) => {
		build(directory);
		const text = await readFile(
			path.join(directory, "dist/release-manifest.json"),
			"utf8",
		);
		const manifest = JSON.parse(text);
		assert.equal(manifest.gitSha, "a".repeat(40));
		assert.equal(manifest.dirty, true);
		assert.equal(manifest.repository, "Nocticur/Test");
		assert.deepEqual(manifest.articles, [
			{
				id: first.id,
				slug: first.slug,
				url: "/posts/中文/Case/",
				sha256: createHash("sha256").update(publicRaw).digest("hex"),
			},
		]);
		const identities = await readFile(
			path.join(directory, "dist/article-ids.json"),
			"utf8",
		);
		assert.equal((text + identities).includes(second.id), false);
		assert.equal((text + identities).includes("private-marker"), false);
		assert.equal((text + identities).includes("src/content"), false);
	});
});

test("unregistered articles and duplicate identities fail the complete build", async () => {
	await fixture(async (directory) => {
		await writeFile(
			path.join(directory, "src/content/posts/unregistered.md"),
			publicRaw,
		);
		assert.throws(() => build(directory), /stable identity/);
	});
	await fixture(async (directory) => {
		await writeFile(
			path.join(directory, "src/constants/article-ids.json"),
			JSON.stringify({
				repository: "Nocticur/Test",
				articles: [first, { ...second, id: first.id }],
			}),
		);
		assert.throws(() => build(directory), /duplicate article ID/);
	});
});

test("changed slugs and invalid captured commits prevent a false publication manifest", async () => {
	await fixture(async (directory) => {
		await writeFile(
			path.join(directory, first.path),
			publicRaw.replace("中文/Case", "changed"),
		);
		assert.throws(() => build(directory), /changed slug/);
	});
	await fixture(async (directory) => {
		await writeFile(
			path.join(directory, "cache/nocticur-release-source.json"),
			JSON.stringify({ gitSha: "main", dirty: false }),
		);
		assert.throws(() => build(directory), /captured Git SHA/);
	});
});

test("encoded path traversal and control characters cannot enter a public manifest", async () => {
	for (const slug of [
		"%2e%2e/admin",
		"%2E%2E/api",
		"valid%2falias",
		"part/%252e%252e/admin",
		"bad\u007f",
	]) {
		await fixture(async (directory) => {
			await writeFile(
				path.join(directory, "src/constants/article-ids.json"),
				JSON.stringify({
					repository: "Nocticur/Test",
					articles: [{ ...first, slug }, second],
				}),
			);
			await writeFile(
				path.join(directory, first.path),
				publicRaw.replace("中文/Case", slug),
			);
			assert.throws(() => build(directory), /literal article slug/, slug);
		});
	}
});
