import { isMap, parseDocument, stringify } from "yaml";
export interface RawParts { frontmatter: string; body: string; prefix: string; newline: string }
export function splitRaw(raw: string): RawParts {
	const match = raw.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
	if (!match) return { frontmatter: "", body: raw, prefix: "", newline: raw.includes("\r\n") ? "\r\n" : "\n" };
	return { frontmatter: match[2], body: raw.slice(match[0].length), prefix: match[0], newline: match[1].endsWith("\r\n") ? "\r\n" : "\n" };
}
export function visualSafety(raw: string, filename: string): { safe: boolean; reason?: string } {
	const { body } = splitRaw(raw);
	if (/\.mdx$/i.test(filename)) return { safe: false, reason: "MDX 保留源码中的组件、表达式和导入，不进行可视往返。" };
	const text = body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
	const unsafe = [
		[/\[\[[^\]]+\]\]/, "Wiki 链接"],
		[/^\s*>\s*\[![^\]]+\]/m, "主题提示框"],
		[/<\/?[A-Za-z!][\s\S]*?>/, "HTML 或组件片段"],
		[/^\s*(?:import|export)\s/m, "模块导入或导出"],
		[/\{[^\n]*\}/, "模板表达式或属性语法"],
		[/^\s*(?:::|\[\^[^\]]+\]:|\[[^\]]+\]:|\*\[[^\]]+\]:)/m, "自定义块、脚注或引用定义"],
		[/!?(?:\[[^\]]+\])\[[^\]]*\]/, "引用链接"],
		[/\[\^[^\]]+\]/, "脚注"],
		[/^\s*\$\$|(?<!\\)\$[^$\n]+\$/m, "现有数学源码（请使用源码模式，或在新可视稿中插入公式）"],
		[/^\s*\|.*\|\s*$/m, "现有 Markdown 表格（保留对齐与原始格式，使用源码编辑）"],
		[/^\s*\d+\)\s/m, "非标准有序列表标记"],
	] as const;
	for (const [pattern, reason] of unsafe) if (pattern.test(text)) return { safe: false, reason: `检测到${reason}，已锁定源码模式以保留原始内容。` };
	return { safe: true };
}
export interface Metadata { title: string; description: string; published: string; category: string; tags: string[]; image: string; pinned: boolean; comments: boolean }
export function readMetadata(raw: string): Metadata {
	const document = parseDocument(splitRaw(raw).frontmatter); const object = document.toJS() ?? {};
	return { title: String(object.title ?? ""), description: String(object.description ?? ""), published: String(object.published ?? ""), category: String(object.category ?? ""), tags: Array.isArray(object.tags) ? object.tags.map(String) : [], image: String(object.image ?? ""), pinned: Boolean(object.pinned), comments: object.comments !== false && object.comment !== false };
}
export function patchMetadata(raw: string, changes: Partial<Metadata>): string {
	const parts = splitRaw(raw); const document = parseDocument(parts.frontmatter, { keepSourceTokens: true });
	if (document.errors.length) throw new Error("Front-matter YAML 无法安全解析，请在源码模式修正后再编辑元数据。");
	if (document.contents && !isMap(document.contents)) throw new Error("Front-matter 必须为 YAML 映射，请在源码中修正。");
	const replacements: { start: number; end: number; value: string }[] = []; const additions: string[] = [];
	const currentValues = document.toJS() ?? {};
	for (const [field, value] of Object.entries(changes)) {
		const name = field === "comments" && !("comments" in currentValues) && "comment" in currentValues ? "comment" : field;
		if (JSON.stringify(currentValues[name]) === JSON.stringify(value)) continue;
		const pair = isMap(document.contents) ? document.contents.items.find(item => String(item.key) === name) : undefined;
		const range = pair?.value && typeof pair.value === "object" && "range" in pair.value ? pair.value.range : undefined;
		if (range) {
			const current = parts.frontmatter.slice(range[0], range[1]);
			let replacement = (Array.isArray(value) ? stringify(value, { collectionStyle: "flow", lineWidth: 0 }) : stringify({ [name]: value }, { lineWidth: 0 }).slice(name.length + 1).replace(/^ /, "")).replace(/\n$/, "").replace(/\n/g, parts.newline);
			const headerComment = current.match(/^[>|][0-9+-]*([ \t]+#[^\r\n]*)/);
			if (headerComment) { const newlineAt = replacement.indexOf(parts.newline); replacement = newlineAt < 0 ? replacement + headerComment[1] : replacement.slice(0, newlineAt) + headerComment[1] + replacement.slice(newlineAt); }
			if (/\r?\n$/.test(current)) replacement += parts.newline;
			replacements.push({ start: range[0], end: range[1], value: replacement });
		} else if (pair?.key && typeof pair.key === "object" && "range" in pair.key && pair.key.range) {
			const colon = parts.frontmatter.indexOf(":", pair.key.range[1]);
			if (colon < 0) throw new Error(`无法安全编辑 ${name}，请使用源码模式。`);
			replacements.push({ start: colon + 1, end: colon + 1, value: ` ${stringify(value).trimEnd()}` });
		} else additions.push(stringify({ [name]: value }, { lineWidth: 0 }).trimEnd().replace(/\n/g, parts.newline));
	}
	if (!replacements.length && !additions.length) return raw;
	let yaml = parts.frontmatter;
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) yaml = yaml.slice(0, replacement.start) + replacement.value + yaml.slice(replacement.end);
	if (additions.length) yaml += `${yaml ? parts.newline : ""}${additions.join(parts.newline)}`;
	if (!parts.prefix) return `---${parts.newline}${yaml}${parts.newline}---${parts.newline}${parts.body}`;
	const start = parts.prefix.indexOf(parts.frontmatter, parts.prefix.indexOf("\n") + 1);
	return parts.prefix.slice(0, start) + yaml + parts.prefix.slice(start + parts.frontmatter.length) + parts.body;
}
export function lineDiff(before: string, after: string): { before: string; after: string; changed: boolean }[] {
	const left = before.split("\n"), right = after.split("\n");
	return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => ({ before: left[index] ?? "", after: right[index] ?? "", changed: left[index] !== right[index] }));
}
