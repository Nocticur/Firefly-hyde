// 内联脚本压缩构建后脚本
// Astro 只压缩打包后的 script，is:inline 一律原样输出（连注释和缩进都在）。
// 这里在 astro build 之后扫一遍 dist/ 的 HTML，把内联 JS 过一遍 esbuild。

import fs from "node:fs/promises";
import { glob } from "glob";
import { minifyHtmlInlineScripts } from "./inline-script-minifier";
import { resolveSiteRoot } from "./site-root";

// Cloudflare Pages 上产物在 dist/client，本地在 dist，统一对准真实根目录
const DIST_DIR = resolveSiteRoot();

async function main() {
	console.log("🗜 Minifying inline scripts in dist/...");

	const htmlFiles = await glob(`${DIST_DIR}/**/*.html`);
	let savedBytes = 0;
	let touchedFiles = 0;
	let scriptCount = 0;

	for (const file of htmlFiles) {
		const html = await fs.readFile(file, "utf-8");
		const result = minifyHtmlInlineScripts(html, file);
		if (result.html !== html) {
			await fs.writeFile(file, result.html);
			scriptCount += result.minifiedScripts;
			savedBytes += result.savedBytes;
			touchedFiles++;
		}
	}

	const savedKiB = (savedBytes / 1024).toFixed(1);
	console.log(
		`✨ Minified ${scriptCount} inline scripts in ${touchedFiles}/${htmlFiles.length} HTML files, saved ${savedKiB} KiB`,
	);
}

main().catch((err) => {
	console.error("❌ Inline script minification failed:", err);
	process.exit(1);
});
