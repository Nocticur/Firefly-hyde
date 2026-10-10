import articleIds from "@/constants/article-ids.json";

export function getArticleThreadId(
	filePath: string | undefined,
	slug: string,
): string | undefined {
	const normalizedPath = filePath
		?.replace(/\\/g, "/")
		.replace(/^.*?(?=src\/content\/)/, "");
	const normalizedSlug = slug.replace(/^\/+|\/+$/g, "");
	return (
		articleIds.articles.find((article) => article.path === normalizedPath)
			?.id ??
		articleIds.articles.find((article) => article.slug === normalizedSlug)?.id
	);
}
