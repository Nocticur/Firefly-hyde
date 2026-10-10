# Nocticur 管理界面

独立 React / Vite / TypeScript / TipTap 应用，运行于管理 Worker 的静态资源部分。所有请求使用同域 `/api/*`，浏览器不保存 GitHub token 或会话凭据；`GET /api/me` 返回的 CSRF 值只留在内存，写操作发送 `X-CSRF-Token`。

在 `management` 独立 workspace 安装依赖后：

```sh
pnpm --dir management/ui dev
pnpm --dir management/ui type-check
pnpm --dir management/ui test
pnpm --dir management/ui build
```

开发服务器默认代理至 `http://127.0.0.1:8787`。用 `MANAGEMENT_API_TARGET` 可以选择隔离的本地 API，不影响生产管理域名。构建产物为 `management/ui/dist`，生产部署路径和 API 路由由上级管理 Worker 配置提供。

源码编辑默认打开，未编辑文章不自动序列化。可视模式仅接受安全子集；MDX、HTML、Wiki 链接、引用链接、复杂原始表格、数学源码等保留在源码模式。元数据只替换明确字段的 YAML 范围，保留未知字段、注释、BOM 和换行样式。新可视稿可以插入公式、Mermaid、表格等内容；复杂表格的合并、宽度和代码区块采用 HTML 保存，回到源码后保持保护。

保存草稿与发布是两个操作。历史恢复在存在未保存内容时禁用；409 冲突保留当前编辑并展示远端差异。私有媒体使用 `media:<id>` 引用，由发布任务在冻结后转换成不可变公开地址。设置、导航及六个图标位也必须显式发布。

认证后的工作空间在首次打开和返回可见时核查已有发布任务；有活跃任务时每分钟核查，空闲时每十五分钟读取一次。此控制器只调用已有任务的 `reconcile`，按任务 ID 去重，不创建新的发布。构建检查通过与生产核验完成分别显示。

`scripts/browser-smoke.mjs` 是真实 Chromium + 本地 API 验收，需要先启动独立 API 和 Vite，并配置一致的 `ADMIN_ORIGIN`。默认测试目标为 UI 5178 / API 8790，数据库和媒体目录必须位于 `/tmp`。`scripts/seed-smoke.ts` 只向隔离 smoke 数据库创建评论和友链测试记录，不模拟 API 响应，也不会写入仓库文章。验收结果明确区分本地开发会话与需要外部配置的 GitHub OAuth、Cloudflare、Resend 和生产发布。
