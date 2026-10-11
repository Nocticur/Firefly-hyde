# Nocticur Cloudflare 免费后台部署

本方案替换原来的独立管理 Worker 部署步骤。仅发布 `Nocticur/Firefly-hyde/main`，复用现有 `firefly-hyde` Worker：博客位于 `https://blog.mourn.top/`，后台位于 `https://blog.mourn.top/admin/`。后台入口参考 Seasir-Hyde/Firefly-hyde 上游的同域 `/admin/`、React 与 Hash 路由，服务端适配 Cloudflare，使用服务端密码会话。上游的 EdgeOne/CNB 函数不能直接部署到 Workers。

## 构建与部署命令

Cloudflare Settings → Builds：

| 设置 | 值 |
| --- | --- |
| Git 仓库 | `Nocticur/Firefly-hyde` |
| 生产分支 | `main` |
| 根目录 | `/` |
| 构建命令 | `pnpm run build` |
| 部署命令 | `npx wrangler deploy` |

现有两个命令可保留，完整构建已自动用冻结锁文件安装 management 依赖、构建界面并拷贝到 `dist/admin/`。无需 `BUILD_ADMIN`，也不要设置 `CF_WORKERS` 开启 Astro SSR。Pagefind 排除后台，完整流水线仍生成发布清单。

要启用后台的“发布到生产”核验，建议把部署命令改为 `pnpm deploy:blog`。该命令校验 checkout、`WORKERS_CI_COMMIT_SHA`、干净源码和 release manifest，然后把完整 Git SHA 作为 Worker tag；不更换 Worker。裸 `npx wrangler deploy` 可部署及登录，但不保证设置这个 tag，后台不会把缺少生产版本证据的发布误判成功。`pnpm deploy:blog --dry-run` 仅打包。旧 `--with-admin` 参数仍兼容，同域方案已不需要它。

## 零付费边界

使用 Cloudflare Workers **Free**、D1 免费额度和 GitHub。不开通 Workers Paid、R2、Queues、Resend 或其他付费服务。`FREE_PLAN=1` 固定选择 D1 对象存储，`MAIL_MODE=disabled` 禁用邮件；配置不含 R2、Queue 或独立管理 Worker 绑定。不会更改其他项目或账号套餐。

免费额度不等于无限量。官方当前说明：Workers 动态请求每天 100,000 次、每次 10 ms CPU；D1 每天读 500 万行、写 100,000 行，总免费存储 5 GB。Free 额度耗尽时请求或查询失败，等待每日额度恢复；此方案不会自动升级付费套餐。如果现有账号已是 Paid，该账号账单仍按其套餐结算，需使用 Free 账号以满足零付费要求。

应用另设媒体与备份总量 20 MiB，单张图片 256 KiB，单份备份 1 MiB；达到限制会明确拒绝写入。大图应先在自己设备压缩。密码、GitHub token、Cloudflare token 均不进入静态产物或备份。

## 先配置免费的 D1

在同一 Cloudflare 账号创建本项目专用 D1，例如 `nocticur-firefly-hyde-free`。把实际绑定写入根 `wrangler.jsonc` 的 `d1_databases`，不能编造 ID，也不能复用其他项目数据库：

```json
{
  "binding": "DB",
  "database_name": "nocticur-firefly-hyde-free",
  "database_id": "填写刚创建的真实 D1 ID",
  "migrations_dir": "management/migrations"
}
```

`DB` 是资源绑定，不是字符串环境变量。仅在控制台临时添加绑定却不保存到仓库，后续 Wrangler 部署可能移除它。配置好后运行 `npx wrangler d1 migrations apply DB --remote`，再部署。API 也会幂等建立所需表；数据库缺失时只返回 503，不回退到内存或本地文件。博客静态页面及登录页仍可部署。

## Cloudflare Secrets 与变量

在 **firefly-hyde → Settings → Variables and Secrets** 填写；不要把真实值放进 Git 或聊天。Secrets 属于 Worker 运行时，不只是 Builds 的构建变量。

| 名称 | 是否必需 | 指向什么 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 登录必需，Secret | 你设置的后台原始密码，3–10 字符；服务端自动哈希，无需手动加密 |
| `IP_HASH_SECRET` | 登录必需，Secret | 独立随机字符串，用于限流标识及会话密码指纹，至少 32 字符；不能与短密码相同 |
| `GITHUB_PUBLISH_TOKEN` | 在线发布必需，Secret | 仅授权 `Nocticur/Firefly-hyde` 的 fine-grained GitHub token；Contents 写入、Checks 读取、Metadata 读取 |
| `CLOUDFLARE_ACCOUNT_ID` | 发布核验必需，变量 | 部署 `firefly-hyde` 的 Cloudflare 账号 ID |
| `CLOUDFLARE_API_TOKEN` | 发布核验必需，Secret | 读取此账号 Worker 当前部署和版本；本机创建 D1 时需另具 D1 编辑权限 |
| `TURNSTILE_SITE_KEY` | 开启评论/友链申请时，变量 | 免费 Turnstile widget site key，允许 `blog.mourn.top` |
| `TURNSTILE_SECRET_KEY` | 开启评论/友链申请时，Secret | 同一个 Turnstile widget 的服务端验证密钥 |
| `MEDIA_IMPORT_HOSTS` | 可选，变量 | 允许导入图片的精确 HTTPS 主机名，逗号分隔，不支持通配、重定向或私网 |

非秘密默认值已写入 `wrangler.jsonc`：`AUTH_MODE=password`、`FREE_PLAN=1`、`MAIL_MODE=disabled`、`PLATFORM=cloudflare`、`ENVIRONMENT=production`、`ADMIN_ORIGIN=https://blog.mourn.top`、`ADMIN_PATH=/admin/`、`BLOG_ORIGIN=https://blog.mourn.top`、`MEDIA_ORIGIN=https://blog.mourn.top/api/public/media/`、`ADMIN_GITHUB_USER_ID=285582250`、`GITHUB_REPOSITORY=Nocticur/Firefly-hyde`、`GITHUB_BRANCH=main`、`BLOG_WORKER_NAME=firefly-hyde`、`GITHUB_BUILD_CHECK_NAME=Workers Builds: firefly-hyde`、`GITHUB_BUILD_CHECK_APP_ID=85455`。

无需 GitHub OAuth client ID/secret、JWT_SECRET、CNB_TOKEN、EdgeOne token、R2/Queue 绑定、Resend API key 或 MAIL_FROM。GitHub App 授权作为兼容选项保留；配置 `GITHUB_PUBLISH_TOKEN` 后不需要 App ID/安装 ID/私钥。登录不依赖 GitHub OAuth。

## 登录、初始化与维护

点击博客导航栏“后台管理”。在 `ADMIN_PASSWORD` Secret 填写 3–10 字符原始密码，无需自行加密或填写哈希值。密码经 HTTPS 同域 POST 发送，Worker 使用独立 `IP_HASH_SECRET` 自动计算 HMAC-SHA256 指纹，进行恒定时间比对；数据库会话只保存指纹，接口、静态产物和备份不返回环境变量密码。Cloudflare Secret 的静态加密由平台管理；普通文本环境变量不代替 Secret。短密码应优先使用 10 位随机字母、数字和符号组合。

正确后使用 HttpOnly/Secure/SameSite Cookie；写操作继续验证 CSRF。单个 IP 每 15 分钟最多 5 次验证，全站最多 60 次；修改密码或独立密钥会使旧会话失效。没有正确密码的请求不能读取文章、草稿、媒体、备份或管理接口。旧 `/adminmn`、EdgeOne/Cloud Functions、非新界面的 `/admin/*` 路径仍停用。

首次登录后到“维护与备份”点击“导入本站内容”，幂等导入 16 篇原文、设置和导航，不发布、不覆盖已有编辑。后台原文、未知 YAML 字段、MDX、稳定文章 ID 与网址的保护仍保留。

免费模式通过已登录后台的受保护核验请求处理已有发布和维护任务，不依赖队列。创建维护任务会立即尝试处理；关闭后台后，未完成任务保留，重新打开继续核验。默认不占用 Cron 配额；确需无人值守时可在确认该账号 Free Cron 配额后为此 Worker 单独配置定时触发，不能调整其他项目。

整个 zone 的“清缓存”任务已停用，避免影响其他项目；无需填写 `CLOUDFLARE_ZONE_ID` 或授予 Cache Purge 权限。本地 Node 开发入口只监听回环地址，默认不自动维护；只有显式设置本地变量 `LOCAL_MAINTENANCE_AUTORUN=1` 才轮询。它不继承生产发布、Cloudflare 或邮件凭据。

在“维护与备份”下载 JSON 备份并保存到自己的设备，确认后可删除旧备份释放空间。JSON 含私有记录与媒体清单；要在数据库整体损坏时恢复图片字节，须同时通过 D1 控制台导出整个数据库。同一数据库中的备份不是独立灾备。

## GitHub 集成红字

截图“获取 GitHub 用户或组织详细信息时出错”属于 Cloudflare 读取 GitHub 集成资料的提示。它不能独自证明构建失败；目标提交 `74585b70aa66ce63bea6c7f9d1d672f25e450919` 的官方 Workers Builds Check 已成功，部署版本为 `a7c01a03-4620-47e0-ba8f-cc117a43f47f`。具体是控制台暂时错误、授权变更还是 GitHub API 故障，需要 Cloudflare/GitHub 授权状态进一步确认。

如果新提交仍有成功的官方 Check，先刷新控制台或重新登录。若最新构建实际报 GitHub 仓库访问失败，只检查 Cloudflare Workers and Pages GitHub App 对 **Nocticur/Firefly-hyde** 的仓库授权及该 Worker 连接；不要卸载整个 App、修改其他仓库授权或删除其他项目。不会因这条提示自动删除成功部署的 Worker。

## 验证与历史记录

提交前验证：`pnpm check`、`pnpm type-check`、`pnpm test:site`、`node --test workers/blog.test.js`、发布清单和构建处理测试、management 的类型/安全测试、管理 UI 测试、完整构建及 Wrangler dry-run。桌面与手机验证密码错误、正确登录、匿名拒绝、退出、导入和备份。

后台发布仍核对完整 Git SHA、官方 Cloudflare Check 名称与 App ID、生产 Worker 版本、Worker tag、域名清单与冻结原文哈希。构建成功不替代实际生产版本核验。当前实例未获得 Cloudflare API 认证时，不能宣称真实 D1 已创建、Secrets 已填写或生产密码登录已验收。

旧独立 Worker/R2/Queue/OAuth/邮件部署记录仅作历史参考：[旧方案](legacy-deployment/nocticur-separate-worker-plan.md)。历史文件的付费服务或变量清单不适用于本次免费同域方案。

密码哈希、凭据扫描、权限、后台进程、数据外发、修复和验证边界见 [本次安全检查](security-review.md)。
