// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderMomentsMarkdown } from "../../../src/utils/moments-markdown";

it("public feed text cannot inject tags or break out of a link attribute", () => {
	const container = document.createElement("div");
	container.innerHTML = renderMomentsMarkdown('<img src=x onerror="alert(1)"> https://example.test/"onmouseover="alert(1)');
	expect(container.querySelector("img, script, [onerror], [onmouseover]")).toBeNull();
	expect(container.querySelector("a")?.getAttribute("href")).toBe('https://example.test/"onmouseover="alert(1)');
	expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
});

it("public feed links and simple formatting remain readable without executable schemes", () => {
	const container = document.createElement("div");
	container.innerHTML = renderMomentsMarkdown("**标题**\n*正文* https://example.test/post javascript:alert(1)");
	expect(container.querySelector("strong")?.textContent).toBe("标题");
	expect(container.querySelector("em")?.textContent).toBe("正文");
	expect(container.querySelector("br")).not.toBeNull();
	expect(container.querySelectorAll("a")).toHaveLength(1);
	expect(container.querySelector("a")?.getAttribute("rel")).toBe("noopener");
});
