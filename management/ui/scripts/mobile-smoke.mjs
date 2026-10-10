import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = createRequire(import.meta.url)("playwright");
const origin = process.env.SMOKE_UI_ORIGIN ?? "http://127.0.0.1:5178";
const output = process.env.SMOKE_OUTPUT ?? "/workspace/.deployment-plan/management-ui-smoke";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const checks = []; const page = await context.newPage(); const errors = [];
page.on("pageerror", error => errors.push(error.message));
const closed = () => page.waitForFunction(() => { const drawer = document.querySelector(".sidebar:not(.open)"); return drawer && drawer.getBoundingClientRect().right <= 0.5; });
const open = async () => { await page.getByRole("button", { name: "展开菜单" }).click(); await page.waitForFunction(() => { const drawer = document.querySelector(".sidebar.open"); const rect = drawer?.getBoundingClientRect(); return rect && Math.abs(rect.left) < .5 && rect.right <= innerWidth; }); };
try {
	const response = await context.request.post(`${origin}/api/auth/development`, { headers: { Origin: origin }, data: { secret: process.env.SMOKE_DEV_AUTH_SECRET ?? "ui-smoke-test-only" } }); assert.equal(response.status(), 200);
	await page.goto(`${origin}/#dashboard`); await page.getByRole("heading", { name: "仪表盘", exact: true }).waitFor(); await closed();
	await page.screenshot({ path: `${output}/dashboard-mobile-closed.png`, fullPage: true }); checks.push("closed drawer has settled fully outside the viewport");
	await open(); const brand = await page.locator(".brand").boundingBox(); assert.ok(brand && brand.x >= 0 && brand.x + brand.width <= 190); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await page.screenshot({ path: `${output}/dashboard-mobile-open.png` }); await page.screenshot({ path: `${output}/dashboard-mobile.png` }); checks.push("open drawer and brand fit completely in the viewport without horizontal overflow");
	const drawer = page.locator(".sidebar"); const canScroll = await drawer.evaluate(element => element.scrollHeight > element.clientHeight);
	if (canScroll) { await drawer.hover(); await page.mouse.wheel(0, 600); await page.waitForFunction(() => document.querySelector(".sidebar").scrollTop > 0); }
	const bottom = await page.locator(".sidebar-bottom").boundingBox(); assert.ok(bottom && bottom.y + bottom.height <= 844); await page.screenshot({ path: `${output}/dashboard-mobile-scrolled.png` }); checks.push("drawer content scrolls when necessary and bottom links stay inside its viewport");
	await page.getByRole("button", { name: "收起菜单", exact: true }).click(); await closed(); checks.push("explicit drawer close button restores the dashboard");
	await open(); await page.getByRole("button", { name: "关闭菜单遮罩", exact: true }).click({ position: { x: 300, y: 300 } }); await closed(); checks.push("clicking the outside backdrop closes the drawer");
	await open(); await page.locator('.sidebar a[href="#articles"]').click(); await page.getByRole("heading", { name: "文章", exact: true }).waitFor(); await closed(); checks.push("mobile navigation changes the page and closes the drawer");
	assert.deepEqual(errors, []); checks.push("no browser exceptions during opening, closing, scrolling, and navigation");
	await writeFile(`${output}/mobile-result.json`, JSON.stringify({ passed: checks.length, checks, browserErrors: errors, viewport: { width: 390, height: 844 } }, null, 2)); console.log(JSON.stringify({ passed: checks.length, output }));
} finally { await browser.close(); }
