import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

interface ArticleIdentity {
	id: string;
	path: string;
	slug: string;
}

interface ReleasedArticle {
	id: string;
	slug: string;
	url: string;
	sha256: string;
}

async function main(): Promise<void> {
	const registry = JSON.parse(
		await fs.readFile("src/constants/article-ids.json", "utf8"),
	) as { repository: string; articles: ArticleIdentity[] };
	const source = JSON.parse(
		await fs.readFile("cache/nocticur-release-source.json", "utf8"),
	) as { gitSha: string; dirty: boolean };
	if (!/^[a-f0-9]{40}$/.test(source.gitSha))
		throw new Error("Invalid captured Git SHA");
	const postPaths = new Set<string>();
	async function visit(directory: string): Promise<void> {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const filename = path.join(directory, entry.name);
			if (entry.isDirectory()) await visit(filename);
			else if (entry.isFile() && /\.mdx?$/.test(filename))
				postPaths.add(filename.split(path.sep).join("/"));
		}
	}
	await visit("src/content/posts");
	const ids = new Set<string>();
	const slugs = new Set<string>();
	const registeredPaths = new Set<string>();
	const articles: ReleasedArticle[] = [];
	for (const identity of registry.articles) {
		if (!/^[a-f0-9-]{36}$/.test(identity.id) || ids.has(identity.id))
			throw new Error("Invalid or duplicate article ID");
		if (
			!identity.slug ||
			/[?#\\\\]/.test(identity.slug) ||
			identity.slug
				.split("/")
				.some((part) => !part || part === "." || part === "..") ||
			slugs.has(identity.slug)
		)
			throw new Error("Invalid or duplicate article slug");
		if (registeredPaths.has(identity.path) || !postPaths.has(identity.path))
			throw new Error("Duplicate or missing article identity path");
		ids.add(identity.id);
		slugs.add(identity.slug);
		registeredPaths.add(identity.path);
		const sourcePath = path.resolve(identity.path);
		const postsRoot = `${path.resolve("src/content/posts")}${path.sep}`;
		if (!sourcePath.startsWith(postsRoot))
			throw new Error("Article identity path escapes the posts directory");
		const raw = await fs.readFile(sourcePath, "utf8");
		const data = matter(raw).data;
		if (data.draft === true) continue;
		const declaredSlug = String(data.slug || identity.slug).replace(
			/^\/+|\/+$/g,
			"",
		);
		if (declaredSlug !== identity.slug)
			throw new Error(
				`Update the identity registry for changed slug: ${identity.path}`,
			);
		articles.push({
			id: identity.id,
			slug: identity.slug,
			url: `/posts/${identity.slug}/`,
			sha256: createHash("sha256").update(raw).digest("hex"),
		});
	}
	if (postPaths.size !== registeredPaths.size)
		throw new Error(
			"Every article, including drafts, must have a stable identity before building",
		);
	articles.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const contentHash = createHash("sha256")
		.update(
			JSON.stringify(
				articles.map(({ id, slug, sha256 }) => ({ id, slug, sha256 })),
			),
		)
		.digest("hex");
	const manifest = {
		schemaVersion: 1,
		repository: registry.repository,
		gitSha: source.gitSha,
		dirty: source.dirty,
		contentHash,
		articles,
	};
	await fs.mkdir("dist", { recursive: true });
	await fs.writeFile(
		"dist/release-manifest.json",
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	await fs.writeFile(
		"dist/article-ids.json",
		`${JSON.stringify({ schemaVersion: 1, articles: articles.map(({ id, slug, url }) => ({ id, slug, url })) }, null, 2)}\n`,
	);
	const settings = JSON.parse(
		await fs.readFile("src/constants/managed-settings.json", "utf8"),
	) as { title?: string; icons?: Record<string, string> };
	const icons = [192, 512]
		.filter((size) => settings.icons?.[`web-app-manifest-${size}x${size}.png`])
		.map((size) => ({
			src: settings.icons![`web-app-manifest-${size}x${size}.png`],
			sizes: `${size}x${size}`,
			type: "image/png",
		}));
	if (icons.length)
		await fs.writeFile(
			"dist/site.webmanifest",
			`${JSON.stringify({ name: settings.title || "Nocticur的博客", start_url: "/", display: "standalone", icons }, null, 2)}\n`,
		);
	console.log(
		`[Release] ${articles.length} public articles; Git ${manifest.gitSha}; dirty=${manifest.dirty}`,
	);
}

await main();
