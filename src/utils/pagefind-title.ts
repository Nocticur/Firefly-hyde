/**
 * Keep natural titles searchable while supplying explicit Han boundaries for
 * mixed titles. Pagefind's Chinese indexer and the browser's Intl.Segmenter can
 * disagree (for example, 优选 versus 优 / 选). Searchable metadata adds the
 * alternative without changing the displayed title, body, or excerpts.
 */
export function getPagefindTitleTokens(title: string): string | undefined {
	if (!/\p{Script=Han}/u.test(title) || !/\p{Script=Latin}/u.test(title)) {
		return undefined;
	}
	const segmented = title
		.replace(/\p{Script=Han}/gu, " $& ")
		.replace(/\s+/gu, " ")
		.trim();
	return `${title} ${segmented}`;
}
