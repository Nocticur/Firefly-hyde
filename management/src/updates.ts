import { compare, valid } from "semver";
import { z } from "zod";
import themePackage from "../../package.json";
import managementPackage from "../package.json";
import { ApiError, required } from "./errors.ts";
import type { Services } from "./types.ts";

// GitHub's fork metadata and merge base identify the theme actually integrated
// here. Advance this SHA only after reviewing and merging upstream changes.
export const themeUpstream = {
	repository: "Seasir-Hyde/Firefly-hyde",
	branch: "main",
	baselineSha: "a42b775bbec11b0dd81cc596a1a60e0c39bc8aa4",
} as const;

export type UpdateStatus = "up-to-date" | "update-available" | "ahead" | "diverged" | "unavailable";
export interface ComponentUpdate {
	component: "theme" | "management";
	name: string;
	repository: string;
	branch: string;
	currentVersion: string;
	status: UpdateStatus;
	latestVersion?: string;
	latestSha?: string;
	versionStatus?: "up-to-date" | "update-available" | "ahead";
	baselineSha?: string;
	commitsAhead?: number;
	commitsBehind?: number;
	compareUrl?: string;
	message?: string;
}
export interface UpdateCheck {
	schemaVersion: 1;
	checkedAt: string;
	automaticUpgrade: false;
	complete: boolean;
	components: ComponentUpdate[];
}

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const branchResponse = z.object({ commit: z.object({ sha }) });
const fileResponse = z.object({
	encoding: z.literal("base64"),
	content: z.string().max(256_000),
});
const packageResponse = z.object({ version: z.string().max(100) });
const comparisonResponse = z.object({
	status: z.enum(["ahead", "behind", "diverged", "identical"]),
	ahead_by: z.number().int().nonnegative(),
	behind_by: z.number().int().nonnegative(),
});

async function githubJson(services: Services, path: string): Promise<unknown> {
	const response = await services.fetcher(`https://api.github.com${path}`, {
		headers: { Accept: "application/vnd.github+json", "User-Agent": "Nocticur-Management" },
		signal: AbortSignal.timeout(15_000),
		redirect: "error",
	});
	if (!response.ok) throw new ApiError(502, "UPDATE_CHECK_FAILED", `GitHub version lookup returned HTTP ${response.status}`);
	return response.json();
}

function repositoryPath(repository: string): string {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
		throw new ApiError(503, "UPDATE_SOURCE_INVALID", "Configure a GitHub owner/repository for version checks");
	}
	return `/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
}

async function inspectComponent(
	services: Services,
	component: ComponentUpdate,
	packagePath: string,
): Promise<ComponentUpdate> {
	try {
		const repo = repositoryPath(component.repository);
		const head = branchResponse.parse(await githubJson(services, `${repo}/branches/${encodeURIComponent(component.branch)}`)).commit.sha;
		// Fetch the manifest at the observed immutable SHA, avoiding branch races.
		const file = fileResponse.parse(await githubJson(services, `${repo}/contents/${packagePath}?ref=${head}`));
		const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, "")), (character) => character.charCodeAt(0));
		const latestVersion = packageResponse.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))).version;
		const current = valid(component.currentVersion), latest = valid(latestVersion);
		if (!current || !latest) throw new ApiError(502, "UPDATE_VERSION_INVALID", "Version manifest does not contain a valid semantic version");
		const difference = compare(latest, current);
		const versionStatus = difference > 0 ? "update-available" : difference < 0 ? "ahead" : "up-to-date";
		const result: ComponentUpdate = { ...component, latestVersion, latestSha: head, versionStatus, status: versionStatus };
		if (component.baselineSha) {
			const comparison = comparisonResponse.parse(await githubJson(services, `${repo}/compare/${component.baselineSha}...${head}?per_page=1`));
			result.commitsAhead = comparison.ahead_by;
			result.commitsBehind = comparison.behind_by;
			result.compareUrl = `https://github.com/${component.repository}/compare/${component.baselineSha}...${head}`;
			result.status = comparison.status === "diverged" ? "diverged" : comparison.ahead_by > 0 || difference > 0 ? "update-available" : comparison.behind_by > 0 || difference < 0 ? "ahead" : "up-to-date";
		}
		return result;
	} catch (error) {
		return { ...component, status: "unavailable", message: error instanceof ApiError ? error.message : "Version comparison could not be verified; retry after checking the upstream service" };
	}
}

export async function checkUpdates(services: Services): Promise<UpdateCheck> {
	const components = await Promise.all([
		inspectComponent(services, {
			component: "theme", name: "Firefly-hyde 主题", ...themeUpstream,
			currentVersion: themePackage.version, status: "unavailable",
		}, "package.json"),
		inspectComponent(services, {
			component: "management", name: "Nocticur 管理后台",
			repository: String(required(services.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY")),
			branch: String(services.env.GITHUB_BRANCH ?? "main"),
			currentVersion: managementPackage.version, status: "unavailable",
		}, "management/package.json"),
	]);
	return {
		schemaVersion: 1, checkedAt: new Date(services.now()).toISOString(), automaticUpgrade: false,
		complete: components.every((component) => component.status !== "unavailable"), components,
	};
}
