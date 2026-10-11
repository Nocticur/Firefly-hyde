# Nocticur / Firefly-hyde 的 Cloudflare 部署与管理

本次只实施 `Nocticur/Firefly-hyde`，发布分支为 `main`。博客是 Astro 静态站点，使用已接入 Workers Builds 的 `firefly-hyde` Worker；React 管理界面与 Hono API 由独立的 `nocticur-firefly-hyde-admin` Worker 托管。目标域名分别为 `blog.mourn.top`、`admin.mourn.top`，公开媒体为 `media.mourn.top`。仓库配置和本地验收不表示管理生产资源已创建或域名已切换。

## 资料与文章基线

只读来源是 `Nocticur/blog@c075ac36c1313dc6ee47f7690c1a360aaa087da8`。仅迁入约定身份资料、原 PNG 头像及两篇文章；不补写空摘要或正文。原 14 篇非草稿示例文章及其大小写 slug、MDX、HTML、YAML、相对图片保留，迁入后为 **16 条管理记录、16 篇公开文章**。

两个新增网址固定为 `/posts/cloudflare优选/`、`/posts/软件分享/`。头像 SHA256 为 `3a7ed7bac3634bb05876966b415600c9f3862be08e1df09b10142cb0c622b01f`，默认 favicon 使用原 PNG；六个上传图标位只在管理员明确替换时改变。

`src/constants/article-ids.json` 记录稳定文章 ID、源码路径和 slug；改标题、文件名或网址不重新生成 ID。`management/baseline.json` 是私有的首次导入材料，不能复制进博客或管理界面的静态输出。首次导入只建立管理记录，重复导入不会覆盖数据或触发发布。

## 开发、构建与验收

使用 Node.js 24.19.0、pnpm 11.22.0。博客运行：

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm check
pnpm type-check
pnpm test:release
pnpm test:build-processing
node --test workers/blog.test.js
pnpm build
```

完整构建包含主题生成脚本、Astro、资源后处理、Pagefind 和发布清单，不能以单独 `astro build` 代替。博客固定为静态输出，环境中不设置 `CF_WORKERS` 或 `BUILD_ADMIN`；不使用遗留 `.edgeone` 产物，也不装配旧后台。

`management/` 是独立 pnpm workspace，其 API 与 UI 分别验收：

```bash
cd management
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --dir ui type-check
pnpm --dir ui test
pnpm --dir ui build
pnpm exec wrangler deploy --dry-run --env production
```

最后一条只验证 Worker 能打包。生产 D1 绑定尚未填写时，dry-run 的缺少 `DB` 警告是实际未完成项，不能据此宣称生产 API 已可用。

## Worker 路由与旧服务隔离

博客 `wrangler.jsonc` 的 `ASSETS` 指向完整 `dist`。默认部署不声明尚未创建的 `ADMIN` 服务绑定，博客静态页面和搜索可独立上线；此时 `/api/public/*` 返回不可缓存的 503，评论/友链等后台接口尚不可用，不会伪造成功或转发到其他服务。

创建并验收管理生产 Worker 后，使用 `pnpm deploy:blog --with-admin`，启用同一 `firefly-hyde` Worker 的 `env.production.services`。该显式配置保留 `ADMIN` 绑定及 `VERSION` 元数据；不要在管理 Worker 不存在时启用，否则 Cloudflare 返回 10143。只有 `/api/public/*` 转发到管理服务，保留方法、正文及 Origin，剥离 Cookie 和 Authorization。既有静态 `/api/allPostMeta.json`、`/api/dynamic.json` 等仍由 ASSETS 只读提供，其他管理 API 不会借博客代理。

管理 Worker 先处理 `/api/*`，包括鉴权失败及未知 API 的 JSON 错误；只有非 API 路径进入 `ui/dist` 的 SPA 回退。API、发布清单及私有预览禁缓存。博客 `/release-manifest.json` 注入平台 `VERSION.id`；本地缺少此绑定时为 `null`，不猜测生产版本。

`/blog/*` 永久跳转到 `/posts/*`，保留 slug 大小写、URL 编码及查询参数。管理员发布的网址修改写入 `managed-redirects.json`，博客 Worker 将旧文章网址永久跳转到新网址。未发布的编辑不会改变公开重定向。

`/adminmn`、`/admin`、旧 Cloud/Edge Functions 及 `.edgeone` 路径返回 410。旧后台源码保留备份，静态页面不序列化 token 或密码哈希，旧 Cloud Functions 提前返回 410，旧 Git 写入函数无法执行。CNB/EdgeOne 的部署、Git 同步及消息流水线停用，友链探测只允许手动诊断且不会 commit/push。原作者 Twikoo、Gist、Umami、收款入口关闭；旧说说、笔记、动态代码和内容保留，但由配置门控排除出公开数据。

停用仓库配置不等于撤销平台中已存在的旧服务。生产切换前还需在原平台停止构建触发器，并撤销旧写入凭据。

## 需要配置的 Cloudflare 资源

`management/wrangler.jsonc` 区分 development、preview、production。生产 Worker 名为 `nocticur-firefly-hyde-admin`；预览使用独立名称、独立 D1/R2，不持有生产发布或正式邮件权限，且不启动生产 Cron/Queue 任务。生产 Worker 的自动 Preview URLs 关闭。

| 绑定 | 生产资源 | 用途 |
| --- | --- | --- |
| `DB` | D1，建议名称 `nocticur-admin-production` | 私有编辑、历史、会话、互动、任务、发布锁 |
| `PRIVATE_MEDIA` | R2 `nocticur-admin-private-production` | 私有草稿资源及备份 |
| `PUBLIC_MEDIA` | R2 `nocticur-admin-public-production` | 发布后不可变媒体 |
| `TASKS` | Queue `nocticur-admin-tasks-production` | 持久任务唤醒 |
| 死信队列 | `nocticur-admin-tasks-failed-production` | 达到重试上限后的诊断与人工处理 |
| `ASSETS` | `management/ui/dist` | 管理 SPA |

配置未虚构生产 D1 ID。创建实际 D1 后，将 Cloudflare 返回的真实配置加入 `env.production.d1_databases`，包含 `binding: "DB"`、实际 `database_id`、`database_name` 和 `migrations_dir: "migrations"`。开发和预览的 ID 必须与生产隔离，不能复制生产 ID 作为预览 ID。

仅在资源创建已获授权后，按上述名称创建 D1、两个 R2、主队列和死信队列，填写真实 D1 绑定，再运行 `wrangler d1 migrations apply DB --remote --env production`。完成管理登录后，以该管理会话和 CSRF 请求头调用 `POST /api/maintenance/import-baseline`，正文为私有的 `management/baseline.json`，建立 16 条基线。也可将登录会话与 CSRF 安全注入 `MANAGEMENT_SESSION_COOKIE`、`MANAGEMENT_CSRF_TOKEN`，设置 `ADMIN_ORIGIN` 后运行 `pnpm baseline:import`；脚本调用同一受保护 HTTP 接口，不从 Node 环境变量伪造 D1 对象。导入校验目标仓库、分支、稳定 ID、路径、slug 和原文；再次导入返回已导入状态，不重复发布。

## 变量、凭据及平台设置

生产变量：`PLATFORM=cloudflare`、`ENVIRONMENT=production`、`ADMIN_ORIGIN=https://admin.mourn.top`、`BLOG_ORIGIN=https://blog.mourn.top`、`MEDIA_ORIGIN=https://media.mourn.top`、`GITHUB_REPOSITORY=Nocticur/Firefly-hyde`、`GITHUB_BRANCH=main`、`BLOG_WORKER_NAME=firefly-hyde`。管理员固定绑定已从 GitHub 公开用户接口验证的 Nocticur 数字 ID：`ADMIN_GITHUB_USER_ID=285582250`。

平台安全设置还需提供 GitHub OAuth 客户端 ID/密钥、GitHub App ID/安装 ID/私钥、Cloudflare 账号 ID及可查询博客生产版本的 API token、Turnstile site key/secret、`IP_HASH_SECRET`、Resend API key 和已验证的 `MAIL_FROM`。OAuth 回调固定为 `https://admin.mourn.top/api/auth/github/callback`。凭据值不写入 Git、静态产物或聊天；已有 Git 读取认证不等同于后台所需的 GitHub App 发布授权。

云编辑环境与生产 Worker 的配置分别管理。当前云环境的 Wrangler 明确报告未认证，D1、R2 和 Queue 尚未远端盘点。环境草稿已声明 `CLOUDFLARE_API_TOKEN`，限定 HTTPS 目的地 `api.cloudflare.com`；在环境设置中安全填写，保存并发布后重新检查认证。用户提供的生产构建日志已确认现有博客 Worker 为 `firefly-hyde`，并确认该次部署找不到管理 Worker；真实数据库、桶、队列及域名绑定仍需认证核验。代理占位凭据只通过指定 HTTPS 目的地使用，不提取或复制到生产配置；生产 Worker 的 secrets 仍需在 Cloudflare 安全设置中独立配置。

GitHub App 仅安装到目标仓库，权限为 Contents 写入、Checks 只读及 GitHub 默认 Metadata 读取。生产还必须配置非秘密变量 `GITHUB_BUILD_CHECK_NAME` 和 `GITHUB_BUILD_CHECK_APP_ID`：从目标仓库真实 Workers Builds 集成的 GitHub Check 记录读取精确 `name` 及数字 `app.id`，不猜名称/ID，不复用旧部署通道的 Check。可用已配置的仓库读取授权查询官方 `GET /repos/Nocticur/Firefly-hyde/commits/<完整目标SHA>/check-runs`；名称与 App ID 尚未确认时后台不具备生产发布就绪条件。GitHub App 安装令牌按仓库限制并请求 `checks:read`，管理 UI 不持有此令牌。

真实 GitHub Check 及生产日志确认现有集成为官方 `cloudflare-workers-and-pages`，App ID 为 `85455`，Check 名为 `Workers Builds: firefly-hyde`。本配置复用该博客 Worker，后台生产应设置 `GITHUB_BUILD_CHECK_NAME=Workers Builds: firefly-hyde`、`GITHUB_BUILD_CHECK_APP_ID=85455`、`BLOG_WORKER_NAME=firefly-hyde`。若以后更换 Worker 或构建集成，必须重新核对这三项；不能用任意成功的 GitHub Actions 替代官方部署 Check。

用户提供的日志中，部署请求指向账号 `ac487e9ee99d9e32a54e72026bae4871` 下的 `firefly-hyde`。它证明这次部署的目标，仍需认证核验账号归属、实际资源和域名；没有根据日志虚构 D1 ID 或自动创建管理资源。

R2 公开桶的媒体域名在实际配置完成后接到 `media.mourn.top`；私有桶不绑定公开读取域名。生产、预览和开发的数据、媒体及凭据分别配置。

博客 Workers Builds 连接 `main`，安装使用冻结锁文件，构建使用完整 `pnpm build`。在 Cloudflare 的 Settings → Builds 将 Deploy command 设置为下列命令，替换日志中的 `npx wrangler deploy`，确保完整 Git SHA 写入 Worker tag：

```bash
pnpm deploy:blog
```

部署脚本使用已安装的 Wrangler，并校验 `WORKERS_CI_COMMIT_SHA`（本地使用 HEAD）、当前 checkout 和 release manifest 的完整 SHA 一致，源码与 manifest 均为干净状态，再传入 `--tag`。不接受短 SHA、固定示例、不同 checkout 或过期产物。`pnpm deploy:blog --dry-run` 只打包，不部署。

管理 Worker 的 DB、R2、Queues 和 Secrets 配置完成，独立构建 UI 并以 `--env production` 部署、验收后，再把博客 Deploy command 改为 `pnpm deploy:blog --with-admin`，恢复真实后台互动服务。该命令仍部署同一个 `firefly-hyde`，不会创建另一个后缀 Worker。接入后后续自动构建也必须保留 `--with-admin`，以免移除该服务绑定。

## 发布、任务和备份

私有保存 → 冻结快照 → GitHub App 原子提交 `main` → 完整构建 → 当前生产版本与生产域名清单一致，才算发布成功。发布等待期间继续编辑不会改变冻结快照。未知提交结果先按唯一提交标识核查，禁止盲目重复提交；并发任务由 D1 发布锁、短事务及持久租约协调，不跨构建等待占用数据库会话。

清单包含源码 SHA、`dirty`、稳定文章 ID、每篇原文哈希和总内容哈希。后台同时核对 Cloudflare 当前部署是 100% 单版本、Worker Versions API 返回的顶层 `annotations["workers/tag"]` 等于目标完整 Git SHA、域名清单的 `workerVersion/gitSha/contentHash` 与冻结内容一致。脏构建、加权版本、旧清单或构建成功但域名未切换都不能成功。

构建状态取自本仓库目标完整 SHA 的 GitHub Checks API，仅采纳名称、App ID、`head_sha` 全部匹配的最新 Check；若提供 Check Suite SHA，也必须匹配。已完成失败、超时、取消或需人工操作才标记构建失败；排队、运行中、缺失、旧 SHA 或其它 App 的失败不影响本任务。最新成功 Check 仍须通过上述 Cloudflare 与域名核验。后台保存所采纳的 Check Run ID、状态、结论和目标 SHA，便于核查。旧生产版本未切换本身属于等待状态，不能代替失败证据。

生产 Cron 每分钟触发；有活跃发布、任务或未确认邮件时按分钟处理，空闲时每十五分钟核验。Queues 使用数据库既有任务作为依据，重复投递不会重新创建发布；失败投递延迟重试，达到上限进入死信队列。北京时间 00:00–00:59 的窗口触发日备份，日期键存入 D1，重复触发与失败重试保持幂等。打开后台再次核验任务。

草稿媒体存入私有 R2，读取需要鉴权；明确发布后复制成公开不可变版本，公开文章不得引用私有临时 URL。评论只接收纯文本，公开响应隐藏邮箱，验证 Turnstile 并限流，删除保留回复关系。友链通过邮件等待真实生产上线；拒绝邮件等待结果落库，发送记录及 Resend 幂等键处理重试。

发信前将首次尝试时间写入独立持久账本，恢复旧备份保留首次尝试账本和投递回执。即使供应商接受邮件后响应丢失，恢复旧待发记录也不能重置幂等窗口；超过 23 小时停止自动重发，先核查真实邮件结果。私有恢复与发布原子争用同一站点锁，恢复的安全备份 I/O 期间不允许发布进入；替换记录同事务校验恢复锁与执行租约，崩溃后先 fence 过期执行，再释放锁。

## 真实生产验收与回滚

在实际 Cloudflare 资源和凭据配置后，验证 GitHub 登录/CSRF、16 条基线、私有草稿及媒体匿名拒绝、源码/YAML/MDX 往返、连续发布、外部冲突、未知提交核查、构建失败、生产域名清单核验、评论管理、友链邮件重试，以及 D1/R2 备份恢复。本地测试及 dry-run 不能替代这些验收。

每天保存私有记录及媒体清单，升级前额外备份。先在隔离 D1/R2 上验证恢复后的文章 ID、历史、媒体引用和未完成任务；生产恢复前核查已发送邮件及未知发布，避免重放已完成副作用。

内容回滚使用 Git revert 后完整重建，并重新核验生产清单。Worker 代码版本回滚、D1 数据恢复和 R2 资源恢复分别操作。迁移前 Git bundle、源码压缩包和 SHA256 校验报告保存在 `/workspace/.deployment-plan/backups/`。

仓库修复、GitHub 构建和本地 dry-run 分别记录验证结果，不能替代生产验收。博客独立部署不要求先创建后台；后台上线仍需真实 D1 ID、已创建的 R2/Queues、已配置凭据及实际平台验收。若修复后仍需重建旧 Worker，范围仅限已核验归属的 `firefly-hyde`，先记录它的路由、域名、构建设置和当前版本；保留其他项目，以及 D1、R2、Queues 等关联资源。
