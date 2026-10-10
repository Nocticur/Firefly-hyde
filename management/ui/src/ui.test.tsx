// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WritingEditor } from "./editor/WritingEditor";
import { LosslessTable } from "./editor/WritingEditor";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { moveItem, normalizeNavigation, recognizeIcon } from "./settings";
import { Publications } from "./tasks";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("source editing protections and navigation", () => {
	it("opening existing content does not invoke onChange", () => { const onChange = vi.fn(); const raw = "---\n# 保留注释\nunknown: {x: 1}\n---\n<Demo />"; render(<WritingEditor raw={raw} filename="existing.mdx" onChange={onChange}/>); expect((screen.getByLabelText("文章源码") as HTMLTextAreaElement).value).toBe(raw); expect((screen.getByText("可视编辑") as HTMLButtonElement).disabled).toBe(true); expect(onChange).not.toHaveBeenCalled(); });
	it("source edit emits only the actual user change", () => { const onChange = vi.fn(); render(<WritingEditor raw="# Old" filename="x.md" onChange={onChange}/>); fireEvent.change(screen.getByLabelText("文章源码"), { target: { value: "# New\n\nunknown <HTML>" } }); expect(onChange).toHaveBeenLastCalledWith("# New\n\nunknown <HTML>"); });
	it("recognizes all required icon filenames including directory packages", () => { expect(recognizeIcon("package/FAVICON.SVG")).toBe("favicon.svg"); expect(recognizeIcon("apple-touch-icon.png")).toBe("apple-touch-icon.png"); expect(recognizeIcon("other.png")).toBeUndefined(); });
	it("import rejects executable navigation URLs", () => { expect(() => normalizeNavigation([{ name: "evil", url: "javascript:alert(1)" }])).toThrow(); });
	it("reordering preserves IDs and nested contents", () => { const items = [{ id: "stable-a", children: ["child"] }, { id: "stable-b" }]; expect(moveItem(items, 0, 1)).toEqual([items[1], items[0]]); expect(moveItem(items, 0, -1)).toBe(items); });
	it("preserves a code block's language and content inside an advanced table", () => { const editor = new Editor({ extensions: [StarterKit, LosslessTable, TableRow, TableHeader, TableCell, Markdown], content: { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [{ type: "codeBlock", attrs: { language: "typescript" }, content: [{ type: "text", text: "const accepted: boolean = true;" }] }] }] }] }] } }); const saved = editor.getMarkdown(); expect(saved).toContain('class="language-typescript"'); expect(saved).toContain("const accepted: boolean = true;"); expect(saved).toContain("<table"); editor.destroy(); });
	it("serializes merged table cells without losing their colspan", () => { const editor = new Editor({ extensions: [StarterKit, LosslessTable, TableRow, TableHeader, TableCell, Markdown], content: { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 2, rowspan: 1 }, content: [{ type: "paragraph", content: [{ type: "text", text: "merged" }] }] }] }] }] } }); const saved = editor.getMarkdown(); expect(saved).toContain('colspan="2"'); expect(saved).toContain("merged"); editor.destroy(); });
	it("keeps production pending when the build check has succeeded", async () => { vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ items: [{ id: "test-build-fixture", status: "building", articleIds: [], targetSha: "abc123", createdAt: "2026-10-09T00:00:00Z", build: { status: "succeeded", reason: "Build check passed; production evidence is pending", repository: "Nocticur/Firefly-hyde", targetSha: "abc123", checkName: "Workers Builds", appId: 1, checkRunId: 123, conclusion: "success" } }] }))); render(<Publications/>); expect(await screen.findByText("构建检查通过")).toBeTruthy(); expect(screen.getByText("正在构建")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "test-build-f" })); expect(await screen.findAllByText("尚未核验")).toHaveLength(2); expect(screen.getByRole("link", { name: "查看 GitHub 构建检查 ↗" }).getAttribute("href")).toBe("https://github.com/Nocticur/Firefly-hyde/runs/123"); });
});
