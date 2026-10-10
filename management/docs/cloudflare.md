# Cloudflare 管理 Worker

完整资源、凭据、发布核验和回滚步骤见 [Cloudflare 部署说明](../../docs/nocticur-deployment.md)。

管理入口为 `src/worker.ts`，Hono `/api/*` 优先，非 API 使用 `ui/dist` 的 SPA 回退。默认开发、preview、production 配置相互隔离；真实生产 D1 ID 尚需加入 `env.production.d1_databases`，缺少 DB 时 API 返回错误，不使用本地数据库。

`wrangler deploy --dry-run --env production` 仅验证打包，不创建资源、不部署。生产发布需要真实 D1/R2/Queues、安全凭据及完整平台验收；不能将 dry-run 成功当作上线完成。预览没有生产 Cron/Queue 消费者，Worker 在非 production 环境也拒绝运行生产定时/队列任务。

管理员固定为 Nocticur；GitHub 官方用户接口已验证其数字 ID 为 `285582250`，生产与预览 vars 使用该非秘密 ID。OAuth、GitHub App 等凭据仍通过安全设置配置，真实生产 D1 ID 缺失时不得宣称生产就绪。
