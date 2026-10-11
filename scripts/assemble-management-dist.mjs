import { execFileSync } from "node:child_process";
import { cp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const management = fileURLToPath(new URL("../management/", import.meta.url));
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run the complete build with pnpm run build");
const run = (args, env = process.env) =>
	execFileSync(process.execPath, [pnpm, ...args], {
		cwd: management,
		env,
		stdio: "inherit",
	});

// The root and management projects have separate locks. Never rewrite either during builds.
run(["install", "--frozen-lockfile", "--prod=false"]);
run(["--filter", "@firefly/management-ui", "build"], {
	...process.env,
	MANAGEMENT_UI_BASE: "/admin/",
});
const html = await readFile(
	new URL("../management/ui/dist/index.html", import.meta.url),
	"utf8",
);
if (
	!html.includes("/admin/assets/") ||
	!html.includes("data-pagefind-ignore")
) {
	throw new Error(
		"The management build must use /admin/ and stay outside the public search index",
	);
}
await rm(`${root}dist/admin`, { recursive: true, force: true });
await cp(`${management}ui/dist`, `${root}dist/admin`, { recursive: true });
console.log(
	"[management] Built the Cloudflare administration UI at /admin/ (legacy EdgeOne functions excluded)",
);
