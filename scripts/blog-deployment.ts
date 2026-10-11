export interface BlogDeploymentOptions {
	withAdmin?: boolean;
	dryRun?: boolean;
}

/** Tag only the clean build for the exact source commit being deployed. */
export function createBlogDeployArgs(
	manifest: unknown,
	expectedSha: string,
	options: BlogDeploymentOptions = {},
): string[] {
	if (!/^[a-f0-9]{40}$/.test(expectedSha)) {
		throw new Error("Blog deployment requires a complete 40-character Git SHA");
	}
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		throw new Error(
			"Build the complete blog before deployment: release manifest is invalid",
		);
	}
	const source = manifest as { gitSha?: unknown; dirty?: unknown };
	if (source.gitSha !== expectedSha || source.dirty !== false) {
		throw new Error(
			"Blog deployment requires a clean release manifest matching the source commit",
		);
	}
	return [
		"deploy",
		"--env",
		options.withAdmin ? "production" : "",
		"--tag",
		expectedSha,
		...(options.dryRun ? ["--dry-run"] : []),
	];
}
