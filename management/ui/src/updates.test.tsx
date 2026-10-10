// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UpdateResult } from "./updates";

afterEach(cleanup);

it("shows current and upstream versions plus new commits without suggesting an automatic upgrade", () => {
	render(<UpdateResult value={{ schemaVersion: 1, checkedAt: "2026-10-11T00:00:00Z", complete: true, components: [
		{ component: "theme", name: "Firefly-hyde 主题", repository: "Seasir-Hyde/Firefly-hyde", currentVersion: "6.16.8", latestVersion: "6.16.8", status: "update-available", commitsAhead: 4, compareUrl: "https://github.com/Seasir-Hyde/Firefly-hyde/compare/old...new" },
		{ component: "management", name: "Nocticur 管理后台", repository: "Nocticur/Firefly-hyde", currentVersion: "1.0.1", latestVersion: "1.0.2", status: "update-available" },
	] }}/>);
	expect(screen.getByText("上游新增 4 个提交")).toBeTruthy();
	expect(screen.getByText("1.0.1")).toBeTruthy();
	expect(screen.getByText("1.0.2")).toBeTruthy();
	expect(screen.getByRole("link", { name: "查看提交差异 ↗" }).getAttribute("href")).toContain("https://github.com/Seasir-Hyde/");
});

it("unverified versions stay visibly unknown and unsafe comparison links are omitted", () => {
	render(<UpdateResult value={{ schemaVersion: 1, checkedAt: "2026-10-11T00:00:00Z", complete: false, components: [
		{ component: "theme", name: "Firefly-hyde 主题", repository: "Seasir-Hyde/Firefly-hyde", currentVersion: "6.16.8", status: "unavailable", message: "GitHub version lookup returned HTTP 429", compareUrl: "javascript:alert(1)" },
	] }}/>);
	expect(screen.getByText("未能核验")).toBeTruthy();
	expect(screen.getByText("尚未核验")).toBeTruthy();
	expect(screen.getByText(/HTTP 429/)).toBeTruthy();
	expect(screen.queryByRole("link")).toBeNull();
});

it("historical task results remain readable", () => {
	render(<UpdateResult value={{ latestRelease: null, message: "Repository has no tagged release" }}/>);
	expect(screen.getByText(/Repository has no tagged release/)).toBeTruthy();
});
