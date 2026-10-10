import type { Hono } from "hono";
import { z } from "zod";
import { publicationFiles, publishArticleRaw } from "./content.ts";
import { ApiError } from "./errors.ts";
import { assertPublishingConfiguration, dispatchPublicationTask, githubClient, verifyProduction } from "./integrations.ts";
import { publishMedia } from "./media.ts";
import { sha256 } from "./security.ts";
import type { Change } from "./store.ts";
import type { AppEnv, Article, Friend, History, Media, NavigationItem, Publication, Services, SiteLock, Stored, Task } from "./types.ts";

type FrozenPublication = Publication & {
	expectedFiles: Record<string, string | null>;
	conflict?: unknown;
	settingsSelected?: boolean;
	navigationSelected?: boolean;
	mediaReady?: boolean;
	predecessorId?: string;
	inheritedIds?: string[];
};
export type PublicationInput = {
	articleIds: string[];
	expectedVersions: Record<string, number>;
	settingsVersion?: number;
	navigationVersion?: number;
};
const terminal = (status: string) => ["succeeded", "failed", "conflict"].includes(status);
const timestamp = (services: Services) => new Date(services.now()).toISOString();
const taskId = (id: string) => `publication:${id}`;
type ExecutionLease = { key: string; owner: string; fence: number };

async function leaseGuard(services: Services, execution?: ExecutionLease): Promise<Change[]> {
	if (!execution) return [];
	const lease = await services.store.assertLease(execution.key, execution.owner, execution.fence);
	return [{ kind: "lease", id: execution.key, expectedVersion: lease.version, checkOnly: true }];
}

async function publicMediaRaw(services: Services, raw: string) {
	// Only explicit editor media references are promoted. Authenticated download
	// URLs and temporary Blob URLs are never embedded in published source.
	if (/\/api\/media\/[^\s)"']+\/content|https:\/\/[^\s/]+\.private\.blob\.vercel-storage\.com/i.test(raw)) throw new ApiError(400, "PRIVATE_MEDIA_REFERENCE", "Replace private download URLs with an explicit media reference before publication");
	const references = [...new Set([...raw.matchAll(/media:([a-zA-Z0-9-]+)/g)].map(match => match[1]))];
	for (const id of references) {
		const media = await publishMedia(services, id);
		if (!media.url) throw new ApiError(409, "MEDIA_NOT_READY", "A frozen media reference has no immutable public URL");
		raw = raw.replaceAll(`media:${id}`, media.url);
	}
	return raw;
}

async function existingPublicMediaRaw(services: Services, raw: string) {
	for (const id of [...new Set([...raw.matchAll(/media:([a-zA-Z0-9-]+)/g)].map(match => match[1]))]) {
		const media = await services.store.get<Media>("media", id);
		if (!media || media.value.status !== "published" || !media.value.url) throw new ApiError(409, "PUBLISHED_MEDIA_MISSING", "An immutable published media reference cannot be reconstructed");
		raw = raw.replaceAll(`media:${id}`, media.value.url);
	}
	return raw;
}

async function publicMediaSettings(services: Services, values: Record<string, unknown>) {
	const output = structuredClone(values);
	for (const key of ["avatar", "homeCover", "defaultCover", "background"]) if (typeof output[key] === "string") output[key] = await publicMediaRaw(services, output[key] as string);
	if (output.icons && typeof output.icons === "object") {
		const icons = output.icons as Record<string, unknown>;
		for (const key of Object.keys(icons)) if (typeof icons[key] === "string") icons[key] = await publicMediaRaw(services, icons[key] as string);
	}
	return output;
}

export async function freezePublication(services: Services, input: PublicationInput) {
	assertPublishingConfiguration(services);
	const siteLock = await services.store.get<SiteLock>("publish-lock", "site");
	if (siteLock?.value.mode === "restore") throw new ApiError(409, "MAINTENANCE_ACTIVE", "Private data restoration is in progress; freeze a publication after it finishes");
	if (new Set(input.articleIds).size !== input.articleIds.length) throw new ApiError(400, "DUPLICATE_ARTICLE", "Select each article once");
	const articles = await services.store.all<Article>("article");
	const queueTail = await services.store.get<{ publicationId: string }>("publication-queue", "tail");
	const previous = queueTail ? await services.store.get<FrozenPublication>("publication", queueTail.value.publicationId) : null;
	const predecessor = previous && !terminal(previous.value.status) ? previous : null;
	const selected = new Set(input.articleIds);
	for (const id of selected) {
		const row = articles.find(article => article.id === id);
		if (!row) throw new ApiError(404, "ARTICLE_NOT_FOUND", "A selected article no longer exists", { id });
		if (input.expectedVersions[id] !== row.version) throw new ApiError(409, "VERSION_CONFLICT", "A selected draft changed before it could be frozen", { id, currentVersion: row.version });
	}
	const snapshot: FrozenPublication["snapshot"] = [];
	const expectedFiles: FrozenPublication["expectedFiles"] = {};
	const inheritedIds: string[] = [];
	for (const row of articles) {
		const current = row.value;
		const inherited = predecessor?.value.snapshot.find(article => article.id === current.id);
		let article: Article;
		let version: number;
		if (selected.has(current.id)) {
			article = { ...structuredClone(current), draft: false, raw: publishArticleRaw(current) };
			if (/\/api\/media\/[^\s)"']+\/content|https:\/\/[^\s/]+\.private\.blob\.vercel-storage\.com/i.test(article.raw)) throw new ApiError(400, "PRIVATE_MEDIA_REFERENCE", "Use explicit media IDs instead of private download URLs");
			version = row.version;
			// A renamed path must be new, while the previous source is removed under
			// its own expected hash. Imported drafts are already repository files.
			if (inherited || current.publishedVersion) {
				const previousPath = inherited?.path ?? current.publishedPath ?? current.path;
				expectedFiles[previousPath] = inherited?.sha256 ?? current.publishedHash ?? null;
				if (previousPath !== current.path) expectedFiles[current.path] = null;
			} else {
				const original = await services.store.get<History>("history", `${current.id}:1`);
				expectedFiles[current.path] = original?.value.reason === "import" && original.value.path === current.path ? await sha256(original.value.raw) : null;
			}
		} else if (inherited) {
			article = structuredClone(inherited);
			version = inherited.version;
			expectedFiles[article.path] = inherited.sha256;
			inheritedIds.push(article.id);
		} else if (current.publishedVersion) {
			const history = await services.store.get<History>("history", `${current.id}:${current.publishedVersion}`);
			if (!history) throw new ApiError(409, "PUBLISHED_HISTORY_MISSING", "A public article is missing its published source history", { id: current.id });
			article = { ...structuredClone(history.value), draft: false, slug: current.publishedSlug ?? history.value.slug, path: current.publishedPath ?? history.value.path };
			// The first baseline import retains all original YAML bytes, including
			// implicit slugs. Later histories contain the private editor source.
			if (await sha256(article.raw) !== current.publishedHash) article.raw = await existingPublicMediaRaw(services, publishArticleRaw(article));
			if (await sha256(article.raw) !== current.publishedHash) throw new ApiError(409, "PUBLISHED_SOURCE_MISMATCH", "Published source cannot be reconstructed from its immutable history", { id: current.id });
			version = current.publishedVersion;
			expectedFiles[article.path] = current.publishedHash ?? null;
		} else continue;
		snapshot.push({ ...article, version, sha256: await sha256(article.raw) });
	}
	if (new Set(snapshot.map(article => article.slug)).size !== snapshot.length || new Set(snapshot.map(article => article.path)).size !== snapshot.length) throw new ApiError(409, "PUBLICATION_COLLISION", "Frozen public paths or slugs overlap");
	const settingsDraft = await services.store.get<{ values: Record<string, unknown> }>("settings", "site");
	const navigationDraft = await services.store.get<{ items: NavigationItem[] }>("navigation", "main");
	const publishedSettings = await services.store.get<{ values: Record<string, unknown>; version?: number }>("published-settings", "site");
	const publishedNavigation = await services.store.get<{ items: NavigationItem[]; version?: number }>("published-navigation", "main");
	if (input.settingsVersion !== undefined && settingsDraft?.version !== input.settingsVersion) throw new ApiError(409, "SETTINGS_CONFLICT", "Settings changed before they could be frozen");
	if (input.navigationVersion !== undefined && navigationDraft?.version !== input.navigationVersion) throw new ApiError(409, "NAVIGATION_CONFLICT", "Navigation changed before it could be frozen");
	const settings = input.settingsVersion !== undefined && settingsDraft ? { values: structuredClone(settingsDraft.value.values), version: settingsDraft.version } : predecessor?.value.settings ? structuredClone(predecessor.value.settings) : publishedSettings ? { values: structuredClone(publishedSettings.value.values), version: publishedSettings.value.version ?? publishedSettings.version } : undefined;
	const navigation = input.navigationVersion !== undefined && navigationDraft ? { items: structuredClone(navigationDraft.value.items), version: navigationDraft.version } : predecessor?.value.navigation ? structuredClone(predecessor.value.navigation) : publishedNavigation ? { items: structuredClone(publishedNavigation.value.items), version: publishedNavigation.value.version ?? publishedNavigation.version } : undefined;
	const friendRows = (await services.store.all<Friend>("friend")).filter(row => row.value.status === "approved");
	const friends = friendRows.map(row => structuredClone(row.value));
	const id = crypto.randomUUID();
	const now = timestamp(services);
	const manifest = snapshot.map(({ id, slug, sha256 }) => ({ id, slug, sha256 })).sort((a, b) => a.id.localeCompare(b.id));
	const publication: FrozenPublication = { id, articleIds: [...input.articleIds], snapshot, settings, navigation, friends, expectedFiles, inheritedIds, predecessorId: predecessor?.id, settingsSelected: input.settingsVersion !== undefined, navigationSelected: input.navigationVersion !== undefined, repository: String(services.env.GITHUB_REPOSITORY), status: "pending", createdAt: now, updatedAt: now, commitNonce: crypto.randomUUID(), attempts: 0, contentHash: await sha256(JSON.stringify(manifest)) };
	const task: Task = { id: taskId(id), type: "publication", publicationId: id, status: "pending", payload: { publicationId: id }, createdAt: now, updatedAt: now, attempts: 0, nextRunAt: services.now() };
	const guards: Change[] = [{ kind: "publish-lock", id: "site", expectedVersion: siteLock?.version ?? null, checkOnly: true }, ...articles.filter(row => selected.has(row.id) || row.value.publishedVersion || inheritedIds.includes(row.id)).map(row => ({ kind: "article", id: row.id, expectedVersion: row.version, checkOnly: true }))];
	if (predecessor) guards.push({ kind: "publication", id: predecessor.id, expectedVersion: predecessor.version, checkOnly: true });
	if (input.settingsVersion !== undefined && settingsDraft) guards.push({ kind: "settings", id: "site", expectedVersion: settingsDraft.version, checkOnly: true });
	if (input.navigationVersion !== undefined && navigationDraft) guards.push({ kind: "navigation", id: "main", expectedVersion: navigationDraft.version, checkOnly: true });
	if (input.settingsVersion === undefined && publishedSettings) guards.push({ kind: "published-settings", id: "site", expectedVersion: publishedSettings.version, checkOnly: true });
	if (input.navigationVersion === undefined && publishedNavigation) guards.push({ kind: "published-navigation", id: "main", expectedVersion: publishedNavigation.version, checkOnly: true });
	for (const friend of friendRows) guards.push({ kind: "friend", id: friend.id, expectedVersion: friend.version, checkOnly: true });
	await services.store.atomic([...guards, { kind: "publication-queue", id: "tail", expectedVersion: queueTail?.version ?? null, value: { publicationId: id } }, { kind: "publication", id, expectedVersion: null, value: publication }, { kind: "task", id: task.id, expectedVersion: null, value: task }]);
	try { await dispatchPublicationTask(services, id); }
	catch (error) {
		// Dispatch is an at-least-once wake-up. Its failure never removes the
		// durable task; Queue/Cron/backoffice reconciliation can resume it.
		const pending = await services.store.get<Task>("task", task.id);
		if (pending) await services.store.update("task", task.id, pending.version, { ...pending.value, error: error instanceof ApiError ? error.message : "Durable transport could not be reached" });
	}
	return { ...publication, taskId: task.id };
}

async function updatePublication(services: Services, id: string, patch: Partial<FrozenPublication>, execution?: ExecutionLease) {
	const row = await services.store.get<FrozenPublication>("publication", id);
	if (!row) throw new ApiError(404, "PUBLICATION_NOT_FOUND", "Publication not found");
	await services.store.atomic([...await leaseGuard(services, execution), { kind: "publication", id, expectedVersion: row.version, value: { ...row.value, ...patch, updatedAt: timestamp(services) } }]);
	return (await services.store.get<FrozenPublication>("publication", id))!;
}

async function updateTask(services: Services, id: string, patch: Partial<Task>, execution?: ExecutionLease) {
	const row = await services.store.get<Task>("task", taskId(id));
	if (row) await services.store.atomic([...await leaseGuard(services, execution), { kind: "task", id: row.id, expectedVersion: row.version, value: { ...row.value, ...patch, updatedAt: timestamp(services) } }]);
}

async function claimPublicationLock(services: Services, id: string) {
	const lock = await services.store.get<SiteLock>("publish-lock", "site");
	if (lock?.value.mode === "restore") throw new ApiError(409, "PUBLICATION_BUSY", "Private data restoration owns the durable site lock", { restoreId: lock.value.restoreId });
	if (lock && lock.value.publicationId === id) return;
	if (lock) {
		const previous = await services.store.get<Publication>("publication", lock.value.publicationId);
		if (previous && terminal(previous.value.status)) await services.store.atomic([{ kind: "publish-lock", id: "site", expectedVersion: lock.version, remove: true }]);
		else throw new ApiError(409, "PUBLICATION_BUSY", "An earlier publication has not reached a conclusive production result", { publicationId: lock.value.publicationId });
	}
	// Restoration competes for this same absent row in its own CAS transaction.
	// Exactly one side can acquire the gate before backup I/O or a Git mutation.
	await services.store.create("publish-lock", "site", { mode: "publication", publicationId: id } satisfies SiteLock);
}

async function releasePublicationLock(services: Services, id: string) {
	const lock = await services.store.get<SiteLock>("publish-lock", "site");
	if (lock && lock.value.mode !== "restore" && lock.value.publicationId === id) await services.store.atomic([{ kind: "publish-lock", id: "site", expectedVersion: lock.version, remove: true }]);
}

async function completePublication(services: Services, row: Stored<FrozenPublication>, productionSha: string, providerVersion: string, execution: ExecutionLease) {
	const publication = row.value;
	const changes: Change[] = [];
	for (const id of publication.articleIds) {
		const current = await services.store.get<Article>("article", id);
		const snapshot = publication.snapshot.find(article => article.id === id);
		if (current && snapshot) {
			const value = { ...current.value, publishedVersion: snapshot.version, publishedSlug: snapshot.slug, publishedPath: snapshot.path, publishedHash: snapshot.sha256 };
			changes.push({ kind: "article", id, expectedVersion: current.version, value });
			changes.push({ kind: "history", id: `${id}:${current.version + 1}`, expectedVersion: null, value: { ...value, version: current.version + 1, reason: "publish", createdAt: timestamp(services) } });
		}
	}
	for (const [kind, id, value] of [
		["published-settings", "site", publication.settings ? { ...publication.settings, publicationId: publication.id } : null],
		["published-navigation", "main", publication.navigation ? { ...publication.navigation, publicationId: publication.id } : null],
	] as const) if (value) {
		const old = await services.store.get(kind, id);
		changes.push({ kind, id, expectedVersion: old?.version ?? null, value });
	}
	const live = await services.store.all<Friend>("public-friend");
	for (const old of live) if (!publication.friends.some(friend => friend.id === old.id)) changes.push({ kind: "public-friend", id: old.id, expectedVersion: old.version, remove: true });
	for (const friend of publication.friends) {
		const old = live.find(item => item.id === friend.id);
		changes.push({ kind: "public-friend", id: friend.id, expectedVersion: old?.version ?? null, value: { ...friend, live: true } });
		const current = await services.store.get<Friend>("friend", friend.id);
		// An approval edited or rejected after freezing remains a private change.
		if (current?.value.status === "approved" && ["name", "url", "avatar", "description", "group", "order", "email"].every(key => current.value[key as keyof Friend] === friend[key as keyof Friend])) {
			changes.push({ kind: "friend", id: friend.id, expectedVersion: current.version, value: { ...current.value, live: true } });
			for (const outbox of await services.store.all<Record<string, unknown>>("outbox")) if (outbox.value.friendId === friend.id && outbox.value.type === "friend-approved" && outbox.value.status === "waiting") changes.push({ kind: "outbox", id: outbox.id, expectedVersion: outbox.version, value: { ...outbox.value, status: "pending", publicationId: publication.id, productionSha } });
		}
	}
	const task = await services.store.get<Task>("task", taskId(publication.id));
	if (task) changes.push({ kind: "task", id: task.id, expectedVersion: task.version, value: { ...task.value, status: "succeeded", error: undefined, updatedAt: timestamp(services) } });
	changes.push({ kind: "publication", id: publication.id, expectedVersion: row.version, value: { ...publication, status: "succeeded", productionSha, providerVersion, error: undefined, updatedAt: timestamp(services) } });
	const lock = await services.store.get<SiteLock>("publish-lock", "site");
	if (!lock || lock.value.mode === "restore" || lock.value.publicationId !== publication.id) throw new ApiError(409, "PUBLICATION_LOCK_LOST", "Publication no longer owns the durable site lock");
	changes.push({ kind: "publish-lock", id: "site", expectedVersion: lock.version, remove: true });
	await services.store.atomic([...await leaseGuard(services, execution), ...changes]);
}

async function recoverRegistry(services: Services, publication: FrozenPublication, git: Awaited<ReturnType<typeof githubClient>>) {
	const raw = await git.file("src/constants/article-ids.json", publication.baseSha!);
	let registry: Array<{ id: string; path: string; slug: string }>;
	if (raw === null) {
		const baseline = await services.store.get<{ registry?: Array<{ id: string; path: string; slug: string }> }>("baseline", "initial");
		registry = baseline?.value.registry ?? [];
	} else {
		let parsed: any;
		try { parsed = JSON.parse(raw); } catch { throw new ApiError(409, "REGISTRY_INVALID", "The repository article registry is invalid JSON"); }
		if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.articles)) throw new ApiError(409, "REGISTRY_INVALID", "The repository article registry has an unsupported schema");
		registry = parsed.articles;
		if (registry.some(item => !item || typeof item.id !== "string" || typeof item.path !== "string" || typeof item.slug !== "string") || new Set(registry.map(item => item.id)).size !== registry.length) throw new ApiError(409, "REGISTRY_INVALID", "The article registry contains invalid or duplicate IDs");
	}
	// Preserve the complete original registry, including imported draft examples
	// and aliases. Unselected new private drafts are absent from this map.
	return registry;
}

export async function processPublication(services: Services, id: string): Promise<FrozenPublication> {
	let row = await services.store.get<FrozenPublication>("publication", id);
	if (!row) throw new ApiError(404, "PUBLICATION_NOT_FOUND", "Publication not found");
	if (terminal(row.value.status)) { await releasePublicationLock(services, id); return row.value; }
	assertPublishingConfiguration(services);
	const owner = `${id}:${crypto.randomUUID()}`;
	let lease: Awaited<ReturnType<Services["store"]["acquireLease"]>>;
	try { lease = await services.store.acquireLease(`publication-step:${id}`, owner, 300_000); }
	catch (error) { if (error instanceof ApiError && error.status === 409) return (await services.store.get<FrozenPublication>("publication", id))!.value; throw error; }
	const execution = { key: `publication-step:${id}`, owner, fence: lease.value.fence };
	const save = (patch: Partial<FrozenPublication>) => updatePublication(services, id, patch, execution);
	const saveTask = (patch: Partial<Task>) => updateTask(services, id, patch, execution);
	try {
		if (row.value.predecessorId) {
			const predecessor = await services.store.get<FrozenPublication>("publication", row.value.predecessorId);
			if (!predecessor || ["failed", "conflict"].includes(predecessor.value.status)) {
				row = await save({ status: "failed", error: "The preceding publication failed; freeze a new snapshot after resolving it" });
				await saveTask({ status: "failed", error: row.value.error });
				return row.value;
			}
			if (predecessor.value.status !== "succeeded") {
				await saveTask({ status: "pending", nextRunAt: services.now() + 60_000, error: "Waiting for the preceding frozen publication" });
				return row.value;
			}
			if (!row.value.mediaReady && !row.value.targetSha) {
				const expectedFiles = { ...row.value.expectedFiles };
				const snapshot = row.value.snapshot.map(article => {
					const previousArticle = predecessor.value.snapshot.find(previous => previous.id === article.id);
					if (previousArticle) {
						expectedFiles[previousArticle.path] = previousArticle.sha256;
						if (previousArticle.path !== article.path) expectedFiles[article.path] = null;
					}
					return row!.value.inheritedIds?.includes(article.id) && previousArticle ? structuredClone(previousArticle) : article;
				});
				row = await save({ snapshot, expectedFiles, settings: row.value.settingsSelected ? row.value.settings : predecessor.value.settings, navigation: row.value.navigationSelected ? row.value.navigation : predecessor.value.navigation });
			}
		}
		try { await claimPublicationLock(services, id); }
		catch (error) {
			if (error instanceof ApiError && error.status === 409) { await saveTask({ status: "pending", nextRunAt: services.now() + 60_000, error: error.message }); return row.value; }
			throw error;
		}
		const task = await services.store.get<Task>("task", taskId(id));
		await saveTask({ status: "running", attempts: (task?.value.attempts ?? 0) + 1, fence: lease.value.fence });
		row = await save({ attempts: row.value.attempts + 1, leaseFence: lease.value.fence });
		let publication = row.value;
		if (!publication.mediaReady && !publication.targetSha) {
			const selected = new Set(publication.articleIds);
			const snapshot: Publication["snapshot"] = [];
			for (const article of publication.snapshot) {
				const raw = selected.has(article.id) ? await publicMediaRaw(services, article.raw) : article.raw;
				snapshot.push({ ...article, raw, sha256: await sha256(raw) });
			}
			const settings = publication.settings && publication.settingsSelected ? { ...publication.settings, values: await publicMediaSettings(services, publication.settings.values) } : publication.settings;
			await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence);
			const manifest = snapshot.map(({ id, slug, sha256 }) => ({ id, slug, sha256 })).sort((a, b) => a.id.localeCompare(b.id));
			row = await save({ snapshot, settings, contentHash: await sha256(JSON.stringify(manifest)), mediaReady: true });
			publication = row.value;
		}
		const git = await githubClient(services);
		await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence);
		if (!publication.baseSha) {
			const baseSha = await git.head();
			await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence);
			row = await save({ baseSha, status: "committing" });
		}
		publication = row.value;
		if (publication.status === "unknown" || publication.status === "committing") {
			const found = await git.findNonce(publication.commitNonce);
			await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence);
			if (found) {
				if (publication.targetSha && found !== publication.targetSha) throw new ApiError(409, "NONCE_CONFLICT", "The publication nonce resolves to a different commit");
				row = await save({ targetSha: found, status: "building", error: undefined });
			} else if (publication.targetSha) {
				// The prepared SHA was saved before PATCH. Reusing exactly that SHA
				// resolves a lost update without creating another commit.
				await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence);
				await git.updateRef(publication.baseSha!, publication.targetSha);
				await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence);
				row = await save({ status: "building", error: undefined });
			}
		}
		publication = row.value;
		if (!publication.targetSha) {
			const registry = await recoverRegistry(services, publication, git);
			await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence);
			row = await save({ registry, status: "committing" });
			publication = row.value;
			const files = publicationFiles(publication).map(file => ({ ...file, expectedHash: publication.expectedFiles[file.path] }));
			await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence);
			await git.atomicCommit({ baseSha: publication.baseSha!, files, nonce: publication.commitNonce, createdAt: publication.createdAt, onPrepared: async targetSha => {
				await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence);
				row = await save({ targetSha });
			} });
			await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence);
			row = await save({ status: "building", error: undefined });
		}
		publication = row.value;
		await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence);
		const evidence = await verifyProduction(services, publication.targetSha!, publication.contentHash!, git);
		await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence);
		row = await save({ build: evidence.build });
		if (evidence.verified) {
			await completePublication(services, row, evidence.productionSha!, evidence.providerVersion!, execution);
		} else if (evidence.status === "failed") {
			await save({ status: "failed", productionSha: evidence.productionSha, providerVersion: evidence.providerVersion, error: evidence.reason });
			await saveTask({ status: "failed", error: evidence.reason });
			await releasePublicationLock(services, id);
		} else {
			await save({ status: "building", productionSha: evidence.productionSha, providerVersion: evidence.providerVersion, error: evidence.reason });
			await saveTask({ status: "pending", nextRunAt: services.now() + 60_000, error: evidence.reason });
		}
	} catch (error) {
		if (error instanceof ApiError && ["LEASE_EXPIRED", "VERSION_CONFLICT"].includes(error.code)) return (await services.store.get<FrozenPublication>("publication", id))!.value;
		try { await services.store.assertLease(`publication-step:${id}`, owner, lease.value.fence); }
		catch (leaseError) { if (leaseError instanceof ApiError && leaseError.code === "LEASE_EXPIRED") return (await services.store.get<FrozenPublication>("publication", id))!.value; throw leaseError; }
		const current = (await services.store.get<FrozenPublication>("publication", id))!;
		if (terminal(current.value.status)) return current.value;
		const conflict = error instanceof ApiError && error.status === 409;
		// An uncertain write retains the durable publication lock. Reconcile
		// checks the nonce and prepared SHA before any further branch mutation.
		const status = conflict ? "conflict" : current.value.targetSha && current.value.status === "building" ? "building" : "unknown";
		const message = error instanceof ApiError ? error.message : "Publication processing failed before a conclusive result";
		await save({ status, error: message, ...(conflict ? { conflict: (error as ApiError).details } : {}) });
		await saveTask({ status: conflict ? "failed" : "unknown", error: message, nextRunAt: services.now() + 60_000 });
		if (conflict) await releasePublicationLock(services, id);
	} finally {
		await services.store.releaseLease(`publication-step:${id}`, owner, lease.value.fence);
	}
	return (await services.store.get<FrozenPublication>("publication", id))!.value;
}

export async function runDueTasks(services: Services) {
	if (services.env.ENVIRONMENT !== "production") return { processed: 0 };
	const tasks = (await services.store.all<Task>("task")).filter(row => row.value.type === "publication" && !["succeeded", "failed"].includes(row.value.status) && (row.value.nextRunAt ?? 0) <= services.now()).sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt));
	let processed = 0;
	for (const task of tasks.slice(0, 10)) {
		const id = task.value.publicationId ?? String(task.value.payload.publicationId);
		try { await processPublication(services, id); processed++; }
		catch (error) { await updateTask(services, id, { status: "pending", error: error instanceof ApiError ? error.message : "Task execution failed", nextRunAt: services.now() + 60_000 }); }
	}
	return { processed };
}

export const createPublication = freezePublication;
export const reconcilePublication = processPublication;
export const processPublicationTasks = runDueTasks;

export function registerPublishing(app: Hono<AppEnv>) {
	app.get("/api/publications", async c => c.json({ items: (await c.get("services").store.all<FrozenPublication>("publication")).map(row => ({ ...row.value, version: row.version })) }));
	app.post("/api/publications", async c => {
		const input = z.object({ articleIds: z.array(z.string().min(1)).max(500), expectedVersions: z.record(z.string(), z.number().int().positive()), settingsVersion: z.number().int().positive().optional(), navigationVersion: z.number().int().positive().optional() }).strict().parse(await c.req.json());
		return c.json(await freezePublication(c.get("services"), input), 202);
	});
	app.get("/api/publications/:id", async c => {
		const row = await c.get("services").store.get<FrozenPublication>("publication", c.req.param("id"));
		if (!row) throw new ApiError(404, "PUBLICATION_NOT_FOUND", "Publication not found");
		return c.json({ ...row.value, version: row.version });
	});
	app.post("/api/publications/:id/reconcile", async c => c.json(await processPublication(c.get("services"), c.req.param("id"))));
}
