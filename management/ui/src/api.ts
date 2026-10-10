export interface User { id: string | number; login: string; avatarUrl?: string }
export interface Article { id: string; raw: string; path: string; slug: string; title: string; version: number; draft: boolean; updatedAt: string; publishedVersion?: number }
export interface HistoryEntry { id: string; version: number; raw: string; path: string; slug: string; draft: boolean; createdAt: string; reason: string }
export interface NavigationItem { id: string; name: string; url?: string; icon?: string; order?: number; children?: NavigationItem[] }
export interface MediaItem { id: string; version: number; filename: string; contentType: string; size: number; alt: string; caption: string; status: "pending" | "private" | "published"; url?: string; createdAt: string }
export interface CommentItem { id: string; version: number; articleId: string; parentId?: string; name: string; text: string; email?: string; deleted: boolean; banned: boolean; createdAt: string }
export interface FriendItem { id: string; version: number; name: string; url: string; avatar?: string; description?: string; email?: string; status: "pending" | "approved" | "rejected"; reason?: string; group: string; order: number; live: boolean; notificationStatus: string; createdAt: string }
export interface Publication { id: string; status: string; articleIds: string[]; targetSha?: string; productionSha?: string; providerVersion?: string; error?: string; createdAt: string; build?: { status: "waiting" | "failed" | "succeeded"; reason: string; repository: string; targetSha: string; checkName: string; appId: number; checkRunId?: number; checkStatus?: string; conclusion?: string | null } }
export interface Task { id: string; version: number; type: string; status: string; createdAt: string; updatedAt: string; error?: string; publicationId?: string; result?: unknown; payload?: { result?: unknown } }
export class ApiError extends Error {
	constructor(public status: number, public code: string, message: string, public details?: { current?: Article | unknown; [key: string]: unknown }) { super(message); }
}
export class ApiClient {
	private csrf = "";
	setCsrf(value: string) { this.csrf = value; }
	csrfHeaders() { return { "X-CSRF-Token": this.csrf }; }
	async request<T>(path: string, options: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
		const method = options.method ?? "GET";
		const headers: Record<string, string> = { Accept: "application/json" };
		if (method !== "GET" && method !== "HEAD") { if (!this.csrf) throw new ApiError(403, "csrf_missing", "会话已失效，请重新登录后再保存。"); headers["X-CSRF-Token"] = this.csrf; }
		if (options.body !== undefined) headers["Content-Type"] = "application/json";
		const response = await fetch(`/api${path}`, { method, headers, credentials: "same-origin", cache: "no-store", body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)), signal: options.signal });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) throw new ApiError(response.status, payload.error?.code ?? "http_error", payload.error?.message ?? `请求失败（${response.status}）`, payload.error?.details ?? payload.details);
		return payload as T;
	}
	get<T>(path: string) { return this.request<T>(path); }
	post<T>(path: string, body: unknown = {}) { return this.request<T>(path, { method: "POST", body }); }
	put<T>(path: string, body: unknown) { return this.request<T>(path, { method: "PUT", body }); }
	patch<T>(path: string, body: unknown) { return this.request<T>(path, { method: "PATCH", body }); }
	upload<T>(path: string, form: FormData) { return this.request<T>(path, { method: "POST", form }); }
}
export const api = new ApiClient();
export const key = encodeURIComponent;
export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
