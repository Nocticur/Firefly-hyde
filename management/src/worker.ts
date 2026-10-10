import type { ExecutionContext } from "hono";
import { app } from "./app.ts";
import { createServices } from "./runtime.ts";
import { runDueTasks } from "./publishing.ts";
import { runMaintenance } from "./maintenance.ts";
import type { Bindings, Publication, Services, Task } from "./types.ts";

type ExecutionContextLike = ExecutionContext;
interface ScheduledEventLike { scheduledTime: number }
interface QueueMessageLike {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}
interface QueueBatchLike { messages: QueueMessageLike[] }

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function activeTasks(services: Services): Promise<boolean> {
  const [publications, outbox, tasks] = await Promise.all([
    services.store.all<Publication>("publication"),
    services.store.all<{ status?: string }>("outbox"),
    services.store.all<Task>("task"),
  ]);
  return publications.some(row => !["succeeded", "failed", "conflict"].includes(row.value.status)) ||
    outbox.some(row => ["pending", "running", "unknown"].includes(row.value.status ?? "")) ||
    tasks.some(row => ["pending", "running", "unknown"].includes(row.value.status));
}

interface WorkerDependencies {
  fetchApi(request: Request, env: Bindings, context: ExecutionContextLike): Promise<Response> | Response;
  servicesResolver(env: Bindings): Promise<Services>;
  publish(services: Services): Promise<unknown>;
  maintain(services: Services, options?: { backup?: boolean }): Promise<unknown>;
}

export function createManagementWorker(overrides: Partial<WorkerDependencies> = {}) {
  const dependencies: WorkerDependencies = {
    fetchApi: (request, env, context) => app.fetch(request, env, context),
    servicesResolver: createServices,
    publish: runDueTasks,
    maintain: runMaintenance,
    ...overrides,
  };

  async function scheduledWork(event: ScheduledEventLike, env: Bindings): Promise<void> {
    // Preview environments never execute production publication, email or backup jobs.
    if (env.ENVIRONMENT !== "production") return;
    const services = await dependencies.servicesResolver(env);
    const active = await activeTasks(services);
    const quarterHour = Math.floor(event.scheduledTime / 60_000) % 15 === 0;
    if (!active && !quarterHour) return;
    await dependencies.publish(services);
    // Midnight in Asia/Shanghai is UTC 16:00. A one-hour window permits retries;
    // maintenance persists the daily backup key, so repeated triggers are safe.
    const dailyBackupWindow = new Date(event.scheduledTime).getUTCHours() === 16;
    await dependencies.maintain(services, { backup: dailyBackupWindow });
  }

  return {
    async fetch(request: Request, env: Bindings, context: ExecutionContextLike): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        // API failures and 404s stay JSON responses; they never fall through to the SPA.
        return noStore(await dependencies.fetchApi(request, env, context));
      }
      if (!env.ASSETS) return noStore(Response.json({ error: "admin_assets_unavailable" }, { status: 503 }));
      return env.ASSETS.fetch(request);
    },
    scheduled(event: ScheduledEventLike, env: Bindings, context: ExecutionContextLike): void {
      context.waitUntil(scheduledWork(event, env));
    },
    async queue(batch: QueueBatchLike, env: Bindings): Promise<void> {
      if (env.ENVIRONMENT !== "production") {
        for (const message of batch.messages) message.ack();
        return;
      }
      try {
        const services = await dependencies.servicesResolver(env);
        // Durable records, leases and fences decide what to run. Queue delivery is
        // a wake-up signal; duplicate messages cannot create duplicate publications.
        await dependencies.publish(services);
        await dependencies.maintain(services);
        for (const message of batch.messages) message.ack();
      } catch {
        for (const message of batch.messages) message.retry({ delaySeconds: 60 });
      }
    },
  };

}

export default createManagementWorker();
