import { transformSync } from "esbuild";
import { fromHtml } from "hast-util-from-html";
import { visit } from "unist-util-visit";

const JS_TYPES = new Set([
	"",
	"text/javascript",
	"application/javascript",
	"module",
]);

export interface InlineScriptResult {
	html: string;
	minifiedScripts: number;
	savedBytes: number;
}

/** Replace actual script bodies without reserializing HTML or code examples. */
export function minifyHtmlInlineScripts(
	html: string,
	file: string,
): InlineScriptResult {
	const edits: { start: number; end: number; code: string }[] = [];
	visit(fromHtml(html), "element", (node) => {
		if (node.tagName !== "script" || "src" in node.properties) return;
		const type = String(node.properties.type ?? "")
			.trim()
			.toLowerCase();
		if (!JS_TYPES.has(type)) return;
		const body = node.children[0];
		if (body?.type !== "text" || !body.value.trim()) return;
		const start = body.position?.start.offset;
		const end = body.position?.end.offset;
		if (start === undefined || end === undefined) {
			throw new Error(`Cannot locate an inline script in ${file}`);
		}
		const original = html.slice(start, end);
		let code: string;
		try {
			code = transformSync(original, {
				loader: "js",
				sourcefile: file,
				// Module scripts may legitimately use top-level await.
				target: type === "module" ? "es2022" : "es2018",
				minifyWhitespace: true,
				minifySyntax: true,
				// Inline scripts share globals with other scripts on the page.
				minifyIdentifiers: false,
			}).code;
		} catch (error) {
			throw new Error(`Invalid inline JavaScript in ${file}`, { cause: error });
		}
		if (code !== original && !/<\/script/i.test(code)) {
			edits.push({ start, end, code });
		}
	});

	let output = html;
	// Original parser offsets remain valid when applying edits from right to left.
	for (const edit of edits.sort((a, b) => b.start - a.start)) {
		output = output.slice(0, edit.start) + edit.code + output.slice(edit.end);
	}
	return {
		html: output,
		minifiedScripts: edits.length,
		savedBytes: Buffer.byteLength(html) - Buffer.byteLength(output),
	};
}
