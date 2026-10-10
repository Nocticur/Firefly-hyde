import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionContext } from "hono";
import { createManagementWorker } from "../src/worker.ts";
import type { Bindings, Services } from "../src/types.ts";

function context() {
  const work: Promise<unknown>[] = [];
  const execution: ExecutionContext = { waitUntil: promise => { work.push(promise); }, passThroughOnException() {}, props: {} };
  return { execution, done: () => Promise.all(work) };
}
function services(active = false): Services {
  return { store: { all: async (kind: string) => kind === "publication" && active ? [{ value: { status: "building" } }] : [] } } as unknown as Services;
}
const production: Bindings = { PLATFORM: "cloudflare", ENVIRONMENT: "production" };

test("management API errors stay JSON and never fall through to the SPA", async () => {
  let assetsCalls = 0;
  const worker = createManagementWorker({ fetchApi: async () => Response.json({ error: "NOT_FOUND" }, { status: 404 }) });
  const env: Bindings = { ASSETS: { fetch: async () => { assetsCalls++; return new Response("SPA"); } } };
  const response = await worker.fetch(new Request("https://admin.mourn.top/api/unknown"), env, context().execution);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "NOT_FOUND" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Cloudflare-CDN-Cache-Control"), "no-store");
  assert.equal(assetsCalls, 0);
  const ui = await worker.fetch(new Request("https://admin.mourn.top/articles/one"), env, context().execution);
  assert.equal(await ui.text(), "SPA");
  assert.equal(assetsCalls, 1);
});

test("preview scheduled and queue events cannot start production jobs", async () => {
  const worker = createManagementWorker({ servicesResolver: async () => { assert.fail("preview loaded production storage"); } });
  const ctx = context();
  worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 9, 16, 0) }, { ENVIRONMENT: "preview" }, ctx.execution);
  await ctx.done();
  let acked = 0;
  await worker.queue({ messages: [{ body: {}, ack: () => { acked++; }, retry: () => { assert.fail("preview retried a production job"); } }] }, { ENVIRONMENT: "preview" });
  assert.equal(acked, 1);
});

test("idle checks run every fifteen minutes while active publications run each minute", async () => {
  let active = false;
  let published = 0;
  const worker = createManagementWorker({ servicesResolver: async () => services(active), publish: async () => { published++; }, maintain: async () => {} });
  for (const [minute, isActive, expected] of [[1, false, 0], [15, false, 1], [16, true, 2]] as const) {
    active = isActive;
    const ctx = context();
    worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 9, 7, minute) }, production, ctx.execution);
    await ctx.done();
    assert.equal(published, expected);
  }
});

test("the Shanghai midnight window requests a durable daily backup", async () => {
  const backup: boolean[] = [];
  const worker = createManagementWorker({ servicesResolver: async () => services(), publish: async () => {}, maintain: async (_services, options) => { backup.push(Boolean(options?.backup)); } });
  for (const hour of [15, 16, 17]) {
    const ctx = context();
    worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 9, hour, 0) }, production, ctx.execution);
    await ctx.done();
  }
  assert.deepEqual(backup, [false, true, false]);
});

test("queue deliveries acknowledge durable work and retry failed processing", async () => {
  let fails = false;
  let acked = 0;
  let retried = 0;
  const worker = createManagementWorker({ servicesResolver: async () => services(), publish: async () => { if (fails) throw new Error("temporary failure"); }, maintain: async () => {} });
  const message = { body: { publicationId: "durable-task-id" }, ack: () => { acked++; }, retry: (options?: { delaySeconds?: number }) => { assert.equal(options?.delaySeconds, 60); retried++; } };
  await worker.queue({ messages: [message] }, production);
  assert.equal(acked, 1);
  fails = true;
  await worker.queue({ messages: [message] }, production);
  assert.equal(acked, 1);
  assert.equal(retried, 1);
});
