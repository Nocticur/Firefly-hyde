/** Slugs are literal text, never already URL-encoded; encode them at the URL boundary. */
export function normalizeArticleSlug(value: string): string {
	const slug = value.replace(/^\/+|\/+$/g, "").normalize("NFC");
	if (
		!slug ||
		slug.length > 200 ||
		/[%\\?#\p{Cc}]/u.test(slug) ||
		slug.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new Error(
			"Use a literal article slug without URL encoding, traversal or control characters",
		);
	}
	return slug;
}
