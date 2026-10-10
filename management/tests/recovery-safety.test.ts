import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { localDatabase } from "../src/local-database.ts";
import { createBackup, restoreBackup, runMaintenance } from "../src/maintenance.ts";
import { sha256 } from "../src/security.ts";
import { readLimited } from "../src/storage.ts";
import { RecordStore } from "../src/store.ts";
import type { Media, R2Like, Services, Task } from "../src/types.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

class PrivateBucket implements R2Like {
	objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
	backupPause?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
	async put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream, options?: unknown) {
		if (key.startsWith("backups/") && this.backupPause) {
			const pause = this.backupPause;
			this.backupPause = undefined;
			pause.entered.resolve();
			await pause.release.promise;
		}
		const metadata = options as { onlyIf?: { etagDoesNotMatch?: string }; httpMetadata?: { contentType?: string } } | undefined;
		if (metadata?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
		const bytes = value instanceof ArrayBuffer ? new Uint8Array(value).slice() : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice() : await readLimited(value as ReadableStream<Uint8Array>, 64 * 1024 * 1024);
		this.objects.set(key, { bytes, contentType: metadata?.httpMetadata?.contentType ?? "application/octet-stream" });
		return { key };
	}
	async get(key: string) {
		const object = this.objects.get(key);
		return object ? { body: new Blob([object.bytes.slice().buffer]).stream(), arrayBuffer: async () => object.bytes.slice().buffer, httpMetadata: { contentType: object.contentType } } : null;
	}
	async delete(key: string) { this.objects.delete(key); }
	async list(options?: unknown) {
		const prefix = (options as { prefix?: string } | undefined)?.prefix ?? "";
		return { objects: [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key, object]) => ({ key, size: object.bytes.byteLength })), truncated: false };
	}
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "management-recovery-safety-"));
	const database = await localDatabase(join(directory, "records.sqlite"));
	let now = Date.parse("2026-10-09T00:00:00Z");
	const store = new RecordStore(database, () => now);
	await store.migrate();
	const privateBucket = new PrivateBucket();
	const services: Services = {
		store, now: () => now, fetcher: async () => { throw new Error("Unexpected external request"); },
		env: { PLATFORM: "cloudflare", ENVIRONMENT: "production", PRIVATE_MEDIA: privateBucket, PUBLIC_MEDIA: new PrivateBucket(), BLOG_ORIGIN: "https://blog.example.test", MEDIA_ORIGIN: "https://media.example.test", RESEND_API_KEY: "test-resend-key", MAIL_FROM: "test@example.test" },
	};
	return { services, store, privateBucket, advance: (milliseconds: number) => { now += milliseconds; }, close: async () => { await database.close?.(); await rm(directory, { recursive: true, force: true }); } };
}

type TestOutbox = { id: string; notificationKey: string; friendId: string; type: string; recipient: string; reason: string; status: string; attempts: number; createdAt: string; updatedAt: string; firstAttemptAt?: number; error?: string };

test("restoring an older pending outbox cannot restart an uncertain email after Resend's idempotency window", { timeout: 10_000 }, async () => {
	const state = await fixture();
	try {
		const key = "friend:recovery:rejected", createdAt = new Date(state.services.now()).toISOString();
		const item: TestOutbox = { id: key, notificationKey: key, friendId: "recovery", type: "friend-rejected", recipient: "visitor@example.test", reason: "A reason", status: "pending", attempts: 0, createdAt, updatedAt: createdAt };
		await state.store.create("outbox", key, item);
		const backup = await createBackup(state.services);
		let deliveries = 0;
		let persistedBeforeRequest: number | undefined;
		state.services.fetcher = async (url, init) => {
			assert.equal(String(url), "https://api.resend.com/emails");
			assert.equal(new Headers(init?.headers).get("Idempotency-Key"), key);
			deliveries++;
			persistedBeforeRequest = (await state.store.get<{ firstAttemptAt: number }>("mail-attempt", key))?.value.firstAttemptAt;
			// The provider accepted the email, but its response never reached the Worker.
			throw new Error("Response lost after email acceptance");
		};
		const firstAttemptAt = state.services.now();
		await runMaintenance(state.services);
		assert.equal(deliveries, 1);
		assert.equal((await state.store.get<TestOutbox>("outbox", key))?.value.status, "unknown");
		assert.equal(persistedBeforeRequest, firstAttemptAt, "the earliest attempt must be durable before the provider can accept mail");
		assert.equal(await state.store.get("notify-receipt", key), null, "a lost response must not invent a successful receipt");
		state.advance(25 * 60 * 60 * 1000);
		await restoreBackup(state.services, backup.id, "RESTORE_PRIVATE_DATA");
		assert.equal((await state.store.get<TestOutbox>("outbox", key))?.value.status, "pending");
		assert.equal((await state.store.get<{ firstAttemptAt: number }>("mail-attempt", key))?.value.firstAttemptAt, firstAttemptAt, "a database restore must preserve the earliest external attempt");
		await runMaintenance(state.services);
		const restored = await state.store.get<TestOutbox>("outbox", key);
		assert.equal(deliveries, 1, "the expired provider key must never be used for another uncertain delivery");
		assert.equal(restored?.value.status, "failed");
		assert.match(restored?.value.error ?? "", /idempotency window expired/i);
	} finally { await state.close(); }
});

test("the restore gate excludes publication throughout safety-backup I/O and restores private media and unfinished tasks", { timeout: 10_000 }, async () => {
	const state = await fixture();
	const entered = deferred(), release = deferred();
	let restoration: ReturnType<typeof restoreBackup> | undefined;
	try {
		const bytes = new TextEncoder().encode("private bytes that must remain available");
		const digest = await sha256(bytes.slice().buffer);
		const media: Media = { id: "private-media", owner: 1, key: "media/1/private.png", filename: "private.png", contentType: "image/png", size: bytes.byteLength, sha256: digest, status: "private", provider: "r2", alt: "Exact alt", caption: "Exact caption", createdAt: new Date(state.services.now()).toISOString() };
		await state.privateBucket.put(media.key, bytes);
		await state.store.create("media", media.id, media);
		const task: Task = { id: "unfinished-publication", publicationId: "frozen-publication", type: "publication", status: "unknown", attempts: 1, payload: { publicationId: "frozen-publication" }, createdAt: media.createdAt, updatedAt: media.createdAt };
		await state.store.create("task", task.id, task);
		const backup = await createBackup(state.services);
		const current = (await state.store.get<Task>("task", task.id))!;
		await state.store.update("task", task.id, current.version, { ...task, status: "failed", attempts: 2 });
		state.privateBucket.backupPause = { entered, release };
		restoration = restoreBackup(state.services, backup.id, "RESTORE_PRIVATE_DATA");
		await entered.promise;
		const gate = await state.store.get<{ mode: string; restoreId: string }>("publish-lock", "site");
		assert.equal(gate?.value.mode, "restore", "the shared gate must be claimed before any backup storage await");
		assert.equal(gate?.value.restoreId, backup.id);
		await assert.rejects(() => state.store.create("publish-lock", "site", { publicationId: "concurrent-publication" }), (error: unknown) => error instanceof ApiError && error.code === "VERSION_CONFLICT");
		release.resolve();
		const result = await restoration;
		assert.equal(result.mediaVerified, 1);
		assert.equal(await state.store.get("publish-lock", "site"), null, "restore must release its own gate only after replacement finishes");
		assert.deepEqual((await state.store.get<Task>("task", task.id))?.value, task);
		assert.deepEqual((await state.store.get<Media>("media", media.id))?.value, media);
		assert.deepEqual(await readLimited((await state.privateBucket.get(media.key))!.body, 1024), bytes);
		await state.store.create("publish-lock", "site", { publicationId: "after-restore" });
		assert.equal((await state.store.get<{ publicationId: string }>("publish-lock", "site"))?.value.publicationId, "after-restore");
	} finally {
		release.resolve();
		await restoration?.catch(() => {});
		await state.close();
	}
});
