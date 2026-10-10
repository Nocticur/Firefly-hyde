import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";

const gitSha =
	process.env.SOURCE_GIT_SHA ||
	process.env.VERCEL_GIT_COMMIT_SHA ||
	process.env.CF_BUILD_COMMIT_SHA ||
	execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(gitSha))
	throw new Error("A complete Git SHA is required before building");
const dirty =
	process.env.SOURCE_GIT_DIRTY !== undefined
		? process.env.SOURCE_GIT_DIRTY === "true"
		: execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
				encoding: "utf8",
			}).trim().length > 0;
await fs.mkdir("cache", { recursive: true });
await fs.writeFile(
	"cache/nocticur-release-source.json",
	`${JSON.stringify({ gitSha, dirty })}\n`,
);
