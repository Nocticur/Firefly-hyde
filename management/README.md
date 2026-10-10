# Firefly-hyde 管理服务

这是独立于 Astro 静态博客的 Hono API。生产部署使用 Cloudflare Worker、
D1、私有与公开 R2 桶、Queues 和 Cron。管理 UI 位于 `ui/`，通过同域
`/api/*` 调用 API；博客只代理 `/api/public/*`。不启用前台 SSR 或 `CF_WORKERS`。

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm --filter @firefly/management-ui dev
pnpm typecheck
pnpm test
```

Node 开发服务只在 development 使用 `.local/management.sqlite` 和私有开发媒体
目录，并自动导入 `baseline.json`。`.local/development-key` 是本地临时登录密钥，
不写入日志或仓库。`POST /api/auth/development` 的 `{secret}` 只在 local/development
启用。生产没有 SQLite、内存或磁盘回退；缺少 D1、R2 等绑定返回明确错误。

生产安装、资源绑定、固定 GitHub OAuth 回调和域名切换见
[Cloudflare 部署说明](docs/cloudflare.md)。所需变量名见 `.env.example`。
资源 ID 和凭据需要在平台配置后验证；本地测试不创建服务、不提交 Git、不发布网站。

数据库迁移通过 `pnpm db:migrate --local` 或配置真实数据库后
`pnpm db:migrate --remote` 执行。首次基线导入只写管理记录、历史、设置和导航，
不改 Git 文件。生产管理员登录后可调用 `POST /api/maintenance/import-baseline`，
或给本地 `baseline:import` CLI 注入短期 `MANAGEMENT_SESSION_COOKIE` 与
`MANAGEMENT_CSRF_TOKEN`。Cookie/CSRF 不保存在本文或源码中。

接口文档由 `GET /api/openapi.json` 提供。管理接口需要会话，写操作需要
`X-CSRF-Token`；版本冲突返回 409。文章保存保留原始 YAML、注释、HTML 与 MDX。
固定 slug 使用原始中文或英文文本，不能预先进行百分号 URL 编码；创建、保存、
历史恢复、发布及构建共享相同校验，拒绝编码点段、分隔符及控制字符。
新草稿和新媒体始终私有。发布冻结版本，通过 GitHub App 原子提交 `main` 后，
核对生产 Worker 版本、目标 Git SHA 与生产域名 release manifest 才标记成功。
结果未知的提交先核验 nonce 和已准备的 SHA，不重新创建提交。
构建失败从本仓库目标 SHA 的 GitHub Check 获取，必须明确配置实际 Check 名称
与数字 App ID，GitHub App 需 `checks:read` 权限；排队、运行中、缺少 Check 或
旧 SHA 都继续等待。成功 Check 仍须通过生产三重核验，不能单独宣布已上线。

公开评论使用纯文本、Turnstile、持久限流和稳定文章 ID；公开响应隐藏邮箱。
友链审核与通知 outbox 同事务保存，批准邮件等待生产上线核验；Resend 重试使用
固定通知键。首次尝试账本在发信前持久保存，与已发送回执一起在恢复旧备份时
保留。未知邮件超过 23 小时安全窗口停止重发，须核查实际投递结果。

维护任务支持备份、只读验证备份、恢复、更新检查、完整重建索引与缓存清理。
`check-updates` 比较实际主题上游 `Seasir-Hyde/Firefly-hyde` 的 `main`、
`package.json` 版本及新增提交，无须上游创建 Release。已集成的主题基线为
`a42b775bbec11b0dd81cc596a1a60e0c39bc8aa4`，仅在人工审查并合入上游后更新
`src/updates.ts` 中的基线 SHA。后台则将正在运行的服务版本与
`GITHUB_REPOSITORY` / `GITHUB_BRANCH` 的 `management/package.json` 比较，
后台每次发布应维护语义版本。查询只读、不自动升级、不覆盖本地修改，也不新增
必填环境变量。失败组件明确显示未核验，保留其他组件结果，任务可重试。
`restore` 的 payload 必须是 `{backupId, confirm: "RESTORE_PRIVATE_DATA"}`。
恢复先核验备份 SHA256、私有媒体清单及引用字节，再创建安全备份，撤销旧会话并
恢复稳定 ID、历史和未完成任务；恢复和发布原子争用同一持久站点锁，当前发布
必须先结束。崩溃恢复先递增过期租约 fencing，旧执行不能覆盖新状态。备份保存私有记录和媒体
清单；R2 媒体对象自身须另外保留，缺失或字节不符时禁止恢复。

`rebuild-index` 创建完整发布任务，只有生产部署核验成功才算索引重建完成。
清缓存需要 Cloudflare zone 的 purge-cache 权限。所有动态 API、私有资源、草稿
和发布清单均不缓存。Cloudflare 有活跃任务每分钟核验，空闲每十五分钟检查，
并在北京时间每日午夜备份窗口内通过持久每日键避免重复备份。
