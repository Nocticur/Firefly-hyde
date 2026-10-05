// 把 edgeone.json 复制进构建产物根目录。
//
// 为什么需要这一步：
// CI 用 `npx edgeone pages deploy ./dist` 直接上传 dist 目录，而 edgeone.json
// 位于项目根目录，不在 dist 内 —— 于是平台上从未读到过这份配置，headers / caches
// 全部静默失效（首页退回 max-age=0 + must-revalidate，导致每次请求都回源校验，
// TTFB 长期在 1.9s 左右）。
//
// 官方文档明确：direct upload 方式支持 edgeone.json，只需把它放在上传根目录，
// 且仅支持 redirects / rewrites / headers / caches 四个字段。
// 因此本步骤紧跟 astro build 之后执行，保证 dist/edgeone.json 存在。
//
// 注意：只复制文件，不改动内容。配置语义以项目根目录的 edgeone.json 为准。

import fs from "node:fs";
import path from "node:path";
import { resolveSiteRoot } from "./site-root";

const siteRoot = resolveSiteRoot();
const source = path.resolve("edgeone.json");
const target = path.join(siteRoot, "edgeone.json");

if (!fs.existsSync(source)) {
	console.error(
		`[copy-edgeone-config] 未找到 ${source}，跳过。边缘缓存与响应头配置将不会生效。`,
	);
	process.exit(1);
}

if (!fs.existsSync(siteRoot)) {
	console.error(`[copy-edgeone-config] 构建产物目录不存在：${siteRoot}`);
	process.exit(1);
}

fs.copyFileSync(source, target);
console.log(`[copy-edgeone-config] 已复制 edgeone.json → ${target}`);
