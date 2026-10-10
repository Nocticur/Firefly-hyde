import { afterEach, expect, it, vi } from "vitest";
import { ApiClient, type Publication } from "./api";
import { reconcileExistingPublications } from "./reconciliation";
afterEach(() => vi.unstubAllGlobals());
it("opening the workspace reconciles only existing active tasks, with CSRF and duplicate suppression", async () => {
	let complete!: (value: Response) => void;
	const request = vi.fn((_path: string, _options: RequestInit) => new Promise<Response>(resolve => { complete = resolve; })); vi.stubGlobal("fetch", request);
	const client = new ApiClient(); client.setCsrf("session-csrf");
	const items = [{ id: "existing/task", status: "unknown" }, { id: "finished", status: "succeeded" }] as Publication[];
	const first = reconcileExistingPublications(items, client); const duplicate = reconcileExistingPublications(items, client);
	expect(request).toHaveBeenCalledTimes(1);
	expect(request.mock.calls[0]).toEqual(["/api/publications/existing%2Ftask/reconcile", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "X-CSRF-Token": "session-csrf" }), credentials: "same-origin" })]);
	complete(new Response("{}")); await Promise.all([first, duplicate]);
	expect(request.mock.calls.some(([path]) => path === "/api/publications")).toBe(false);
});
