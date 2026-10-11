import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createBlogDeployArgs } from "./blog-deployment";

try {
	const root = fileURLToPath(new URL("../", import.meta.url));
	const options = process.argv.slice(2);
	if (
		options.some((value) => value !== "--with-admin" && value !== "--dry-run")
	) {
		throw new Error(
			"Supported blog deployment options: --with-admin, --dry-run",
		);
	}
	const head = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const expectedSha = process.env.WORKERS_CI_COMMIT_SHA ?? head;
	if (expectedSha !== head)
		throw new Error("Workers Builds SHA does not match this checkout");
	try {
		execFileSync("git", ["diff", "--quiet", "HEAD"], {
			cwd: root,
			stdio: "ignore",
		});
	} catch {
		throw new Error(
			"Commit tracked source changes and rebuild before deploying the blog",
		);
	}
	const manifest = JSON.parse(
		readFileSync(
			new URL("../dist/release-manifest.json", import.meta.url),
			"utf8",
		),
	);
	const args = createBlogDeployArgs(manifest, expectedSha, {
		withAdmin: options.includes("--with-admin"),
		dryRun: options.includes("--dry-run"),
	});
	const cli = fileURLToPath(
		new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
	);
	const result = spawnSync(process.execPath, [cli, ...args], {
		cwd: root,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exit(result.status ?? 1);
} catch (error) {
	console.error("Blog deployment failed:", error);
	process.exit(1);
}
