import type { RecordStore } from "./store.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Stored<T> = { id: string; version: number; value: T; updatedAt: string };
export type Article = {
  id: string; path: string; slug: string; title: string; raw: string; draft: boolean;
  createdAt: string; updatedAt: string; publishedVersion?: number; publishedSlug?: string;
  publishedHash?: string; publishedPath?: string; redirects: string[];
};
export type History = Omit<Article, "publishedVersion" | "publishedHash"> & {
  version: number; reason: "import" | "create" | "save" | "restore" | "publish"; createdAt: string;
};
export type Session = { user: { id: number; login: string }; csrf: string; expiresAt: number };
export type Media = {
  id: string; filename: string; contentType: string; size: number; alt: string; caption: string;
  owner: number; key: string; status: "pending" | "private" | "published";
  sha256?: string; url?: string; createdAt: string; provider: "r2" | "local";
};
export type Comment = {
  id: string; articleId: string; parentId: string | null; name: string; text: string;
  email: string; authorKey: string; deleted: boolean; createdAt: string; updatedAt: string;
};
export type Friend = {
  id: string; name: string; url: string; avatar: string; description: string; email: string;
  status: "pending" | "approved" | "rejected"; reason: string; group: string; order: number;
  live: boolean; notificationStatus: "waiting" | "sent" | "failed"; createdAt: string; message?: string;
};
export type Task = {
  id: string; type: string; status: "pending" | "running" | "succeeded" | "failed" | "unknown";
  payload: Record<string, unknown>; createdAt: string; updatedAt: string; attempts: number;
  error?: string; publicationId?: string; fence?: number; nextRunAt?: number;
};
export type SiteLock = {mode?:"publication";publicationId:string} | {mode:"restore";restoreId:string;owner:string;leaseFence:number};
export type MailAttempt = {notificationKey:string;firstAttemptAt:number;createdAt:string};
export type BuildCheckEvidence={status:"waiting"|"failed"|"succeeded";reason:string;repository:string;targetSha:string;checkName:string;appId:number;checkRunId?:number;checkStatus?:string;conclusion?:string|null};
export type Publication = {
  id: string; status: "pending" | "committing" | "unknown" | "building" | "succeeded" | "failed" | "conflict";
  articleIds: string[]; snapshot: Array<Article & { version: number; sha256: string }>;
  settings?: { values: Record<string, unknown>; version: number };
  navigation?: { items: NavigationItem[]; version: number };
  friends: Friend[]; baseSha?: string; targetSha?: string; productionSha?: string;
  providerVersion?: string; contentHash?: string; error?: string; createdAt: string; updatedAt: string;
  commitNonce: string; leaseFence?: number; attempts: number;
  repository?: string; registry?: Array<{id:string;path:string;slug:string}>;
  build?:BuildCheckEvidence;
};
export type NavigationItem = { id: string; name: string; url?: string; icon?: string; order?: number; external?: boolean; children?: NavigationItem[] };
export interface SqlStatement { sql: string; params?: unknown[] }
export interface SqlResult { rows: Record<string, unknown>[]; changes: number }
export interface Database {
  query(statement: SqlStatement): Promise<SqlResult>;
  batch(statements: SqlStatement[]): Promise<SqlResult[]>;
  close?(): Promise<void>;
}
export interface R2Like {
  put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream, options?: unknown): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
  list(options?: unknown): Promise<unknown>;
}
export type Bindings = {
  ENVIRONMENT?: "development" | "preview" | "production";
  PLATFORM?: "cloudflare" | "local";
  ADMIN_ORIGIN?: string; BLOG_ORIGIN?: string; MEDIA_ORIGIN?: string;
  ADMIN_GITHUB_USER_ID?: string; GITHUB_OAUTH_CLIENT_ID?: string; GITHUB_OAUTH_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string; GITHUB_APP_INSTALLATION_ID?: string; GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_REPOSITORY?: string; GITHUB_BRANCH?: string;
  GITHUB_BUILD_CHECK_NAME?: string; GITHUB_BUILD_CHECK_APP_ID?: string;
  DB?: unknown; PRIVATE_MEDIA?: R2Like; PUBLIC_MEDIA?: R2Like;
  TASKS?: { send(message: unknown, options?: unknown): Promise<void> };
  ASSETS?: { fetch(request: Request): Promise<Response> };
  TURNSTILE_SECRET_KEY?: string; TURNSTILE_SITE_KEY?: string; IP_HASH_SECRET?: string;
  RESEND_API_KEY?: string; MAIL_FROM?: string;
  CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string; BLOG_WORKER_NAME?: string;
  DEV_AUTH_SECRET?: string; LOCAL_DB_PATH?: string; LOCAL_MEDIA_PATH?: string;
  BACKUP_PREFIX?: string; MEDIA_IMPORT_HOSTS?: string;
  [key: string]: unknown;
};
export type Services = { store: RecordStore; env: Bindings; fetcher: typeof fetch; now: () => number };
export type AppEnv = { Bindings: Bindings; Variables: { services: Services; session: Session } };
