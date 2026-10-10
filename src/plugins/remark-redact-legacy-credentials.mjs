import { visit } from "unist-util-visit";

/** Keep archived Markdown intact while omitting reusable credentials from publication. */
export function remarkRedactLegacyCredentials() {
	return (tree) => {
		visit(tree, "code", (node) => {
			node.value = node.value.replace(
				/(\badminPasswordHash\s*:\s*)(["'])([a-f0-9]{64})\2/gi,
				(_, prefix, quote) => `${prefix}${quote}[已移除]${quote}`,
			);
		});
	};
}
