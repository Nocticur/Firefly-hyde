import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { createBlogDeployArgs } from "./blog-deployment.ts";
import { minifyHtmlInlineScripts } from "./inline-script-minifier.ts";

test("code-copy attributes containing script markup and DEL are preserved", () => {
	const example =
		'<button data-code="<script>\u007fconst example = 1;\u007f</script>">Copy</button>';
	const result = minifyHtmlInlineScripts(
		`${example}<script nonce="a>b">\n function sharedName() { return 42; } \n globalThis.answer = sharedName(); \n</script>`,
		"dist/posts/categories/index.html",
	);
	assert.ok(result.html.startsWith(example));
	assert.equal(result.minifiedScripts, 1);
	assert.ok(result.html.includes('<script nonce="a>b">'));
	const body = result.html.slice(
		result.html.indexOf('<script nonce="a>b">') + '<script nonce="a>b">'.length,
		-"</script>".length,
	);
	const context = vm.createContext({});
	vm.runInContext(body, context);
	assert.equal(context.answer, 42);
	assert.equal(vm.runInContext("sharedName()", context), 42);
});

test("JSON, import maps, external scripts and HTML comments are left intact", () => {
	const html = [
		'<script type="application/ld+json"> { "text": "  preserve me  " } </script>',
		'<script type="importmap"> { "imports": {} } </script>',
		'<script src="/external.js">  const untouched = true;  </script>',
		"<!-- <script>\u007finvalid example</script> -->",
	].join("\n");
	assert.equal(minifyHtmlInlineScripts(html, "page.html").html, html);
});

test("multiple real scripts keep their shared global names and Unicode content", () => {
	const result = minifyHtmlInlineScripts(
		'<main>中文</main><script> function globalFunction() { return "原文"; } </script><script> globalThis.value = globalFunction(); </script>',
		"page.html",
	);
	const context = vm.createContext({});
	for (const body of result.html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
		vm.runInContext(body[1], context);
	}
	assert.equal(context.value, "原文");
	assert.ok(result.html.startsWith("<main>中文</main>"));
	assert.equal(result.minifiedScripts, 2);
});

test("valid module scripts retain top-level await and exported values", async () => {
	const result = minifyHtmlInlineScripts(
		'<script type="module"> export const value = await Promise.resolve("模块原文"); </script>',
		"module.html",
	);
	const body = result.html.slice(
		'<script type="module">'.length,
		-"</script>".length,
	);
	const module = await import(
		`data:text/javascript,${encodeURIComponent(body)}`
	);
	assert.equal(module.value, "模块原文");
	assert.equal(result.minifiedScripts, 1);
});

test("invalid executable JavaScript fails the build instead of being silently skipped", () => {
	assert.throws(
		() =>
			minifyHtmlInlineScripts(
				"<script>\u007fnotJavaScript</script>",
				"broken.html",
			),
		/Invalid inline JavaScript in broken\.html/,
	);
});

test("deployment rejects dirty, stale and shortened release SHAs", () => {
	const sha = "a".repeat(40);
	assert.throws(
		() => createBlogDeployArgs({ gitSha: sha, dirty: true }, sha),
		/clean release manifest/,
	);
	assert.throws(
		() => createBlogDeployArgs({ gitSha: "b".repeat(40), dirty: false }, sha),
		/matching the source commit/,
	);
	assert.throws(
		() => createBlogDeployArgs({ gitSha: sha, dirty: false }, sha.slice(0, 7)),
		/40-character/,
	);
	assert.throws(
		() => createBlogDeployArgs(null, sha),
		/release manifest is invalid/,
	);
	assert.deepEqual(createBlogDeployArgs({ gitSha: sha, dirty: false }, sha), [
		"deploy",
		"--env",
		"",
		"--tag",
		sha,
	]);
	assert.deepEqual(
		createBlogDeployArgs({ gitSha: sha, dirty: false }, sha, {
			withAdmin: true,
			dryRun: true,
		}),
		["deploy", "--env", "production", "--tag", sha, "--dry-run"],
	);
});
