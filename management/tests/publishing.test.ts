import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { importBaseline } from "../src/content.ts";
import { freezePublication, processPublication } from "../src/publishing.ts";
import { verifyProduction } from "../src/integrations.ts";
import { localDatabase } from "../src/local-database.ts";
import { RecordStore } from "../src/store.ts";
import { sha256 } from "../src/security.ts";
import type { Article, History, Publication, Services } from "../src/types.ts";

test("Cloudflare publishing protects frozen source and reconciles duplicate and uncertain deliveries", async (t) => {
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const appKey = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const baseSha = "a".repeat(40), targetSha = "b".repeat(40);
const text = (title: string, body: string, draft = false) => `---\ntitle: ${title}\npublished: 2026-10-09\n# keep this unknown YAML comment\ncustom: retained\n${draft ? "draft: true\n" : ""}---\n${body}\n`;
const originalA = text("one", "first body"), originalB = text("two", "second body"), originalDraft = text("draft", "sample private body", true);
const source = new Map([
	["src/content/posts/one.md", originalA],
	["src/content/posts/two.md", originalB],
	["src/content/posts/draft.md", originalDraft],
	["src/constants/article-ids.json", JSON.stringify({ schemaVersion: 1, articles: [{ id: "one", path: "src/content/posts/one.md", slug: "one" }, { id: "two", path: "src/content/posts/two.md", slug: "two" }, { id: "draft", path: "src/content/posts/draft.md", slug: "draft" }] })],
]);
let head = baseSha, commitCount = 0, patchCount = 0, failPatch = true, ready = false, fetchCount = 0, installationCount = 0;
let prepared: any, preparedSha = targetSha, preparedFiles = new Map<string, string | null>();
let clock = Date.now();
let beforeRequest: ((path: string) => Promise<void>) | undefined;
const blobs = new Map<string, string>();
const hashBlob = (raw: string) => createHash("sha1").update(raw).digest("hex");
const json = (value: unknown) => Response.json(value);
const db = await localDatabase(":memory:");
const store = new RecordStore(db, () => clock);
await store.migrate();
const env = {
	ENVIRONMENT: "production" as const, PLATFORM: "cloudflare" as const,
	GITHUB_APP_ID: "123", GITHUB_APP_INSTALLATION_ID: "456", GITHUB_APP_PRIVATE_KEY: appKey,
	GITHUB_REPOSITORY: "Nocticur/Test", GITHUB_BRANCH: "main", BLOG_ORIGIN: "https://blog.example.test/",
	GITHUB_BUILD_CHECK_NAME: "Cloudflare test build", GITHUB_BUILD_CHECK_APP_ID: "123",
	CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "test-credential", BLOG_WORKER_NAME: "test-blog",
	TASKS: { async send() {} },
};
let publicationId = "";
let dirty = false, wrongWorker = false, weighted = false, badInventory = false, missingTag = false;
const fetcher: typeof fetch = async (input, init) => {
	fetchCount++;
	const url = new URL(String(input)), path = url.pathname;
	await beforeRequest?.(path);
	const body = init?.body ? JSON.parse(String(init.body)) : null;
	if (path === "/app/installations/456/access_tokens") { installationCount++; return json({ token: "test-installation-credential" }); }
	if (path.endsWith("/git/ref/heads/main")) return json({ object: { sha: head } });
	if (/\/git\/commits\/[a-f0-9]{40}$/.test(path)) return json({ tree: { sha: "base-tree" } });
	if (path.endsWith("/git/trees/base-tree")) {
		for (const [name, raw] of source) blobs.set(hashBlob(raw), raw);
		return json({ truncated: false, tree: [...source].map(([path, raw]) => ({ path, mode: "100644", type: "blob", sha: hashBlob(raw) })) });
	}
	if (path.includes("/git/blobs/") && init?.method !== "POST") return json({ encoding: "base64", content: Buffer.from(blobs.get(path.split("/").at(-1)!)!).toString("base64") });
	if (path.endsWith("/git/blobs") && init?.method === "POST") {
		const sha = hashBlob(body.content); blobs.set(sha, body.content); return json({ sha });
	}
	if (path.endsWith("/git/trees") && init?.method === "POST") {
		preparedFiles = new Map(body.tree.map((entry: any) => [entry.path, entry.sha === null ? null : blobs.get(entry.sha)]));
		return json({ sha: "new-tree" });
	}
	if (path.endsWith("/git/commits") && init?.method === "POST") { commitCount++; prepared = body; preparedSha = String.fromCharCode(97 + commitCount).repeat(40); return json({ sha: preparedSha }); }
	if (path.endsWith("/commits")) return json(head !== baseSha ? [{ sha: head, commit: { message: prepared.message } }] : []);
	if (path.endsWith("/check-runs")) {
		const sha = path.split("/").at(-2);
		return json({ total_count: 1, check_runs: [{ id: 1, name: "Cloudflare test build", app: { id: 123 }, head_sha: sha, check_suite: { head_sha: sha }, status: "completed", conclusion: "success" }] });
	}
	if (path.endsWith("/git/refs/heads/main") && init?.method === "PATCH") {
		patchCount++;
		const pub = await store.get<Publication>("publication", publicationId);
		assert.equal(pub!.value.targetSha, body.sha, "prepared SHA must be durable before the PATCH");
		assert.equal(body.force, false);
		head = body.sha;
		for (const [path, content] of preparedFiles) content === null ? source.delete(path) : source.set(path, content);
		if (failPatch) { failPatch = false; throw new Error("simulated lost PATCH response"); }
		return json({ object: { sha: head } });
	}
	if (path.endsWith("/deployments")) return json({ success: true, result: { deployments: [{ created_on: "2026-10-09", versions: weighted ? [{ version_id: "worker-version", percentage: 50 }, { version_id: "older-version", percentage: 50 }] : [{ version_id: "worker-version", percentage: 100 }] }] } });
	if (path.endsWith("/versions/worker-version")) return json({ result: { metadata: { created_on: "2026-10-09" }, annotations: { "workers/tag": missingTag ? "" : ready ? head : baseSha } } });
	if (path === "/release-manifest.json") {
		const pub = (await store.get<Publication>("publication", publicationId))!.value;
		return json({ schemaVersion: 1, gitSha: pub.targetSha, dirty, repository: "Nocticur/Test", workerVersion: wrongWorker ? "different-worker-version" : "worker-version", contentHash: pub.contentHash, articles: pub.snapshot.map(({ id, slug, sha256 }) => ({ id, slug: badInventory ? slug + "-corrupt" : slug, sha256 })) });
	}
	throw new Error(`Unexpected mocked request: ${url.origin}${path}`);
};
const services: Services = { store, env, fetcher, now: () => clock };
await importBaseline(services, { repository: "Nocticur/Test", branch: "main", articles: [
	{ id: "one", path: "src/content/posts/one.md", slug: "one", raw: originalA },
	{ id: "two", path: "src/content/posts/two.md", slug: "two", raw: originalB },
	{ id: "draft", path: "src/content/posts/draft.md", slug: "draft", raw: originalDraft, draft: true },
], settings: { title: "baseline title" }, navigation: [] });
async function edit(id: string, raw: string) {
	const row = (await store.get<Article>("article", id))!;
	const value = { ...row.value, raw, updatedAt: new Date().toISOString() };
	await store.atomic([{ kind: "article", id, expectedVersion: row.version, value }, { kind: "history", id: `${id}:${row.version + 1}`, expectedVersion: null, value: { ...value, version: row.version + 1, reason: "save", createdAt: value.updatedAt } satisfies History }]);
}
await edit("one", text("one", "selected new body"));
await edit("two", text("two", "UNSELECTED PRIVATE CHANGE"));
const unpublished: Article = { id: "private", path: "src/content/posts/private.md", slug: "private", title: "private", raw: text("private", "SECRET DRAFT", true), draft: true, redirects: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
await store.create("article", unpublished.id, unpublished);
await store.create("history", "private:1", { ...unpublished, reason: "create", version: 1 });
const selected = (await store.get<Article>("article", "one"))!;
const frozen = await freezePublication(services, { articleIds: ["one"], expectedVersions: { one: selected.version } });
publicationId = frozen.id;
assert.equal(frozen.snapshot.length, 2);
assert.equal(frozen.snapshot.find(article => article.id === "two")!.raw, originalB, "unselected article must use the published baseline");
assert.equal(frozen.settings!.values.title, "baseline title");
assert.ok(!frozen.snapshot.some(article => ["draft", "private"].includes(article.id)));
assert.equal(frozen.snapshot.find(article => article.id === "one")!.sha256, await sha256(frozen.snapshot.find(article => article.id === "one")!.raw));
const nextArticle = (await store.get<Article>("article", "two"))!;
const queued = await freezePublication(services, { articleIds: ["two"], expectedVersions: { two: nextArticle.version } });
assert.equal(queued.snapshot.find(article => article.id === "one")!.raw, frozen.snapshot.find(article => article.id === "one")!.raw, "a queued publication inherits the preceding frozen public source");
assert.equal((await processPublication(services, queued.id)).status, "pending");
assert.equal(commitCount, 0, "a queued publication cannot run before its predecessor");
await edit("one", text("one", "EDIT AFTER FREEZE"));
const deliveries = await Promise.all([processPublication(services, publicationId), processPublication(services, publicationId)]);
assert.equal(commitCount, 1, "concurrent duplicate deliveries must prepare only one commit");
assert.equal(patchCount, 1, "concurrent deliveries must mutate the branch once");
assert.equal((await store.get<Publication>("publication", publicationId))!.value.status, "unknown");
assert.ok(await store.get("publish-lock", "site"), "unknown outcomes keep the durable global lock");
ready = true;
const beforeReconcileTokens = installationCount;
const finished = await processPublication(services, publicationId);
assert.equal(finished.status, "succeeded");
assert.equal(installationCount - beforeReconcileTokens, 1, "production verification must reuse the processing GitHub client");
assert.equal(finished.build?.status, "succeeded");
assert.equal(finished.build?.targetSha, finished.targetSha);
assert.equal(finished.build?.checkRunId, 1);
assert.equal(finished.build?.checkName, env.GITHUB_BUILD_CHECK_NAME);
assert.equal(finished.build?.appId, Number(env.GITHUB_BUILD_CHECK_APP_ID));
assert.equal(commitCount, 1, "nonce reconciliation must not issue a duplicate commit");
assert.equal(patchCount, 1, "a resolved PATCH response must not repeat the mutation");
assert.equal((await store.get<Article>("article", "one"))!.value.raw, text("one", "EDIT AFTER FREEZE"), "publication must preserve editing after freezing");
assert.equal((await store.get<Article>("article", "one"))!.value.publishedVersion, selected.version);
assert.equal(source.get("src/content/posts/two.md"), originalB);
assert.equal(source.get("src/content/posts/draft.md"), originalDraft);
assert.ok(!source.has("src/content/posts/private.md"));
const registry = JSON.parse(source.get("src/constants/article-ids.json")!);
assert.ok(registry.articles.some((entry: any) => entry.id === "draft"), "the imported draft registry entry must survive");
assert.ok(!registry.articles.some((entry: any) => entry.id === "private"), "a new private draft must not leak into the public registry");
assert.equal(await store.get("publish-lock", "site"), null);
await processPublication(services, publicationId);
assert.equal(commitCount, 1);
const beforePreview = fetchCount;
await assert.rejects(freezePublication({ ...services, env: { ...env, ENVIRONMENT: "preview" } }, { articleIds: [], expectedVersions: {} }), (error: any) => error.code === "PRODUCTION_REQUIRED");
assert.equal(fetchCount, beforePreview, "preview must not exercise publication credentials");
await assert.rejects(freezePublication({ ...services, env: { ...env, GITHUB_APP_PRIVATE_KEY: undefined } }, { articleIds: [], expectedVersions: {} }), (error: any) => error.code === "CONFIG_REQUIRED");
await assert.rejects(freezePublication({ ...services, env: { ...env, CLOUDFLARE_API_TOKEN: undefined } }, { articleIds: [], expectedVersions: {} }), (error: any) => error.code === "CONFIG_REQUIRED");

await t.test("a complete 100 percent Worker switch is required", async () => {
 weighted = true;
 assert.equal((await verifyProduction(services, targetSha, finished.contentHash!)).verified, false);
 weighted = false;
});
await t.test("the current Worker version must carry the exact target Git tag", async () => {
 ready = false;
 assert.equal((await verifyProduction(services, targetSha, finished.contentHash!)).verified, false);
 ready = true; missingTag = true;
 await assert.rejects(verifyProduction(services, targetSha, finished.contentHash!), (error: any) => error.code === "WORKER_GIT_TAG_REQUIRED");
 missingTag = false;
});
await t.test("a dirty production build cannot be accepted", async () => {
 dirty = true;
 assert.equal((await verifyProduction(services, targetSha, finished.contentHash!)).verified, false);
 dirty = false;
});
await t.test("the public domain must serve the provider current Worker version", async () => {
 wrongWorker = true;
 assert.equal((await verifyProduction(services, targetSha, finished.contentHash!)).verified, false);
 wrongWorker = false;
});
await t.test("the actual public article inventory is rehashed", async () => {
 badInventory = true;
 assert.equal((await verifyProduction(services, targetSha, finished.contentHash!)).verified, false);
 badInventory = false;
 assert.equal((await verifyProduction(services, targetSha, finished.contentHash!)).verified, true);
});
await t.test("continuous publications preserve the previous result and later private edits", async () => {
 publicationId = queued.id;
 const second = await processPublication(services, queued.id);
 assert.equal(second.status, "succeeded");
 assert.equal(commitCount, 2);
 assert.equal(patchCount, 2);
 assert.equal(source.get("src/content/posts/one.md"), frozen.snapshot.find(article => article.id === "one")!.raw);
 assert.equal((await store.get<Article>("article", "one"))!.value.raw, text("one", "EDIT AFTER FREEZE"));
 assert.ok(source.get("src/content/posts/two.md")!.includes("UNSELECTED PRIVATE CHANGE"));
 assert.equal((await store.get<Article>("article", "two"))!.value.publishedVersion, nextArticle.version);
});
await t.test("external source conflicts prevent overwrite and fail dependent snapshots", async () => {
 const article = (await store.get<Article>("article", "one"))!;
 const conflicting = await freezePublication(services, { articleIds: ["one"], expectedVersions: { one: article.version } });
 const other = (await store.get<Article>("article", "two"))!;
 const dependent = await freezePublication(services, { articleIds: ["two"], expectedVersions: { two: other.version } });
 publicationId = conflicting.id;
 source.set("src/content/posts/one.md", text("one", "EXTERNAL GIT EDIT"));
 head = "f".repeat(40);
 const rejected = await processPublication(services, conflicting.id);
 assert.equal(rejected.status, "conflict");
 assert.equal(commitCount, 2);
 assert.equal(patchCount, 2);
 assert.ok(source.get("src/content/posts/one.md")!.includes("EXTERNAL GIT EDIT"));
 assert.equal(await store.get("publish-lock", "site"), null);
 assert.equal((await processPublication(services, dependent.id)).status, "failed");
 assert.equal(commitCount, 2);
});
await t.test("freeze transaction detects a writer racing after preliminary version checks", async () => {
 const article = (await store.get<Article>("article", "one"))!;
 const count = (await store.all("publication")).length;
 const atomic = store.atomic.bind(store);
 let injected = false;
 store.atomic = async changes => {
  if (!injected && changes.some(change => change.kind === "publication" && change.expectedVersion === null)) {
   injected = true;
   await atomic([{ kind: "article", id: article.id, expectedVersion: article.version, value: { ...article.value, title: "Concurrent draft title" } }]);
  }
  return atomic(changes);
 };
 try {
  await assert.rejects(freezePublication(services, { articleIds: ["one"], expectedVersions: { one: article.version } }), (error: any) => error.code === "VERSION_CONFLICT");
  assert.equal((await store.all("publication")).length, count);
 } finally { store.atomic = atomic; }
});
let resumedId = "";
await t.test("an expired processor cannot write after a newer lease takes over", async () => {
 source.set("src/content/posts/one.md", frozen.snapshot.find(article => article.id === "one")!.raw);
 const publication = await freezePublication(services, { articleIds: [], expectedVersions: {} });
 resumedId = publication.id;
 publicationId = resumedId;
 let replacement: Awaited<ReturnType<RecordStore["acquireLease"]>> | undefined;
 beforeRequest = async path => {
  if (path !== "/app/installations/456/access_tokens") return;
  beforeRequest = undefined;
  clock += 300_001;
  replacement = await store.acquireLease(`publication-step:${resumedId}`, "replacement-owner", 300_000);
 };
 const observed = await processPublication(services, resumedId);
 assert.equal(observed.status, "pending", "the expired processor must not regress the durable state to unknown");
 assert.equal(observed.targetSha, undefined);
 assert.equal(commitCount, 2, "an expired processor cannot prepare or update Git");
 assert.ok(replacement);
 await store.releaseLease(`publication-step:${resumedId}`, "replacement-owner", replacement!.value.fence);
});
await t.test("the success transaction rejects a fence change and reconciles without another commit", async () => {
 const atomic = store.atomic.bind(store);
 let replacement: Awaited<ReturnType<RecordStore["acquireLease"]>> | undefined;
 let injected = false;
 store.atomic = async changes => {
  if (!injected && changes.some(change => change.kind === "publication" && (change.value as Publication | undefined)?.status === "succeeded")) {
   injected = true;
   clock += 300_001;
   replacement = await store.acquireLease(`publication-step:${resumedId}`, "success-race-owner", 300_000);
  }
  return atomic(changes);
 };
 try {
  const observed = await processPublication(services, resumedId);
  assert.equal(observed.status, "building", "a stale success transaction must not mark production verified");
  assert.equal((await store.get<{ status: string }>("task", `publication:${resumedId}`))!.value.status, "running");
  assert.ok(await store.get("publish-lock", "site"), "the incomplete success keeps the durable global lock");
  assert.equal(commitCount, 3);
  assert.equal(patchCount, 3);
 } finally { store.atomic = atomic; }
 assert.ok(replacement);
 await store.releaseLease(`publication-step:${resumedId}`, "success-race-owner", replacement!.value.fence);
 assert.equal((await processPublication(services, resumedId)).status, "succeeded");
 assert.equal(commitCount, 3, "reconciliation verifies the existing commit instead of replaying it");
 assert.equal(patchCount, 3);
 assert.equal(await store.get("publish-lock", "site"), null);
});
await t.test("restoration holds the same atomic gate before a publisher can reach Git", async () => {
 const publication = await freezePublication(services, { articleIds: [], expectedVersions: {} });
 const gate = await store.create("publish-lock", "site", { mode: "restore", restoreId: "safety-backup", owner: "restore-owner", leaseFence: 1 });
 const before = fetchCount;
 const observed = await processPublication(services, publication.id);
 assert.equal(observed.status, "pending");
 assert.equal(fetchCount, before, "restoration must block every external publication request");
 assert.equal((await store.get<{ mode: string }>("publish-lock", "site"))!.value.mode, "restore", "publisher must preserve the restoration gate");
 await assert.rejects(freezePublication(services, { articleIds: [], expectedVersions: {} }), (error: any) => error.code === "MAINTENANCE_ACTIVE");
 await store.atomic([{ kind: "publish-lock", id: "site", expectedVersion: gate.version, remove: true }]);
 const atomic = store.atomic.bind(store);
 let injected = false;
 store.atomic = async changes => {
  if (!injected && changes.some(change => change.kind === "publish-lock" && !change.checkOnly && (change.value as { mode?: string } | undefined)?.mode === "publication")) {
   injected = true;
   await atomic([{ kind: "publish-lock", id: "site", expectedVersion: null, value: { mode: "restore", restoreId: "claim-race", owner: "restore-owner", leaseFence: 2 } }]);
  }
  return atomic(changes);
 };
 try {
  assert.equal((await processPublication(services, publication.id)).status, "pending");
  assert.equal(fetchCount, before, "a restoration winning the null-row CAS prevents the publication side effect");
  assert.equal((await store.get<{ mode: string }>("publish-lock", "site"))!.value.mode, "restore");
 } finally { store.atomic = atomic; }
 const current = (await store.get("publish-lock", "site"))!;
 await store.atomic([{ kind: "publish-lock", id: "site", expectedVersion: current.version, remove: true }]);
});
await t.test("restoration racing a freeze rolls back the new durable publication and task", async () => {
 const atomic = store.atomic.bind(store);
 const publicationCount = (await store.all("publication")).length;
 const taskCount = (await store.all("task")).length;
 let injected = false;
 store.atomic = async changes => {
  if (!injected && changes.some(change => change.kind === "publication" && change.expectedVersion === null)) {
   injected = true;
   await atomic([{ kind: "publish-lock", id: "site", expectedVersion: null, value: { mode: "restore", restoreId: "freeze-race", owner: "restore-owner", leaseFence: 3 } }]);
  }
  return atomic(changes);
 };
 try {
  await assert.rejects(freezePublication(services, { articleIds: [], expectedVersions: {} }), (error: any) => error.code === "VERSION_CONFLICT");
  assert.equal((await store.all("publication")).length, publicationCount);
  assert.equal((await store.all("task")).length, taskCount);
 } finally { store.atomic = atomic; }
 const current = (await store.get("publish-lock", "site"))!;
 await store.atomic([{ kind: "publish-lock", id: "site", expectedVersion: current.version, remove: true }]);
});
await db.close?.();
});
