import { useEffect, useState } from "react";
import { api, key, type ApiClient, type Publication } from "./api";
const terminal = new Set(["completed", "succeeded", "failed", "cancelled", "conflict"]);
const inflight = new Map<string, Promise<unknown>>();
export function activePublications(items: Publication[]) { return items.filter(item => !terminal.has(item.status)); }
export async function reconcileExistingPublications(items: Publication[], client: ApiClient = api) {
	return Promise.allSettled(activePublications(items).map(item => {
		let promise = inflight.get(item.id);
		if (!promise) { promise = client.post(`/publications/${key(item.id)}/reconcile`).finally(() => inflight.delete(item.id)); inflight.set(item.id, promise); }
		return promise;
	}));
}
// One controller per authenticated workspace. A read-only list discovers existing
// jobs; reconciliation resumes their durable state, never creates a publication.
export function usePublicationReconciliation() {
	const [error, setError] = useState<unknown>();
	useEffect(() => {
		let disposed = false; let busy = false; let wakePending = false; let timer: ReturnType<typeof setTimeout> | undefined;
		const run = async () => {
			if (busy || disposed) return;
			busy = true; clearTimeout(timer); let active = false;
			try {
				const list = await api.get<{ items: Publication[] }>("/publications"); if (disposed) return;
				active = activePublications(list.items).length > 0;
				const results = await reconcileExistingPublications(list.items); if (disposed) return;
				await api.post("/maintenance/reconcile"); if (disposed) return;
				const failed = results.find(result => result.status === "rejected"); setError(failed?.status === "rejected" ? failed.reason : undefined);
				if (active) window.dispatchEvent(new Event("publication-reconciled"));
			} catch (reason) { if (!disposed) setError(reason); }
			finally { busy = false; if (!disposed) { timer = setTimeout(() => void run(), wakePending ? 0 : active ? 60_000 : 15 * 60_000); wakePending = false; } }
		};
		const visible = () => { if (document.visibilityState === "visible") void run(); };
		const wake = () => { clearTimeout(timer); if(busy)wakePending = true; else void run(); };
		document.addEventListener("visibilitychange", visible); void run();
		window.addEventListener("management-publication-created",wake);
		return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("management-publication-created",wake); };
	}, []);
	return error;
}
