# Nocticur 博客与管理后台验证记录

本地验证日期：2026-10-10（Asia/Shanghai）。部署结构和配置步骤见 [nocticur-deployment.md](./nocticur-deployment.md)。

| 检查 | 本地结果 |
| --- | --- |
| Astro check / TypeScript | 331 文件，0 errors、0 warnings、19 hints；type-check 通过 |
| Biome | 0 errors；保留 6 warnings，工作流与仓库 CLI 均为 2.5.12 |
| 完整静态构建 | 通过，包含资源后处理、Pagefind 和发布清单 |
| 发布清单测试 | 3/3 通过，包含稳定 ID、原文字节哈希、草稿字段排除和错误配置拒绝 |
| 管理 API | typecheck 通过，54/54 测试通过 |
| 管理 UI | type-check、构建通过，31/31 测试通过 |
| 管理界面真实浏览器 | 本地 API 下 43 项基线及 7 项移动专项通过 |
| 博客 Worker 路由 | 8/8 通过，包含公开接口边界、旧入口关闭及永久跳转 |
| 原生 workerd / D1 / R2 | 10 项通过，包含完整进程停止后的 D1 持久性和私有媒体字节读取 |
| 管理与博客 Worker 打包 | dry-run 通过；管理生产模板缺少真实 DB 的警告保留 |
| Pagefind 与实际搜索界面 | 8 种查询、导航栏及搜索页实际输入、中文结果点击和 canonical 通过 |
| 页面切换生命周期 | 10 个真实导航状态通过；问候组件只有一个 60 秒计时器和一个监听器，浏览器脚本异常 0 |

完整标题 `cloudflare优选` 和 `cloudflare 优选` 将目标文章排在首位；`cloudflare`、`优选`、`软件分享` 及原有项目查询可命中。可搜索标题补词不改变显示标题、正文或摘要。

公开基线为 16 篇，Pagefind 共 20 页。构建副本中加入第 17 篇真实草稿后，公开 HTML、RSS、Atom、sitemap、搜索索引、发布清单和公开 ID 均排除该草稿；正式源码没有新增测试草稿。原 14 篇文章全文、Front-matter 和 slug 保留；两篇迁入正文与只读来源一致。原 PNG 的 SHA256 为 `3a7ed7bac3634bb05876966b415600c9f3862be08e1df09b10142cb0c622b01f`，源码、公开副本及构建输出相同。

390px 移动端无横向溢出，旧个人服务请求为 0。前台浏览器验证拦截了外部 HTTPS，因此外部图床、音乐和天气仍需实际服务验证。GitHub OAuth、真实 Cloudflare 版本/域名切换及 Resend 投递也需在平台配置完成后验收。

本记录表示本地检查通过；远端 CI 和生产部署以对应 Git SHA 的真实平台结果为准。生产资源 ID 与凭据在平台安全配置，源码不包含运行数据库、开发密钥、私有媒体或构建产物。
