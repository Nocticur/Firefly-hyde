// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Login } from "./Login";
import { ApiError } from "./api";
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("sends the password only to the same-origin login API and continues after cookie authentication",async()=>{
	const onLogin=vi.fn(async()=>{}),fetcher=vi.fn(async()=>Response.json({ok:true}));vi.stubGlobal("fetch",fetcher);
	render(<Login error={new ApiError(401,"UNAUTHENTICATED","Login required")} retry={async()=>{}} onLogin={onLogin}/>);
	const input=screen.getByLabelText("管理密码");expect(input.getAttribute("type")).toBe("password");fireEvent.click(screen.getByRole("button",{name:"显示密码"}));expect(input.getAttribute("type")).toBe("text");fireEvent.click(screen.getByRole("button",{name:"隐藏密码"}));
	fireEvent.change(input,{target:{value:"testPw2026"}});fireEvent.submit(input.closest("form")!);await waitFor(()=>expect(onLogin).toHaveBeenCalledOnce());
	expect(fetcher).toHaveBeenCalledWith("/api/auth/password",expect.objectContaining({credentials:"same-origin",cache:"no-store",body:JSON.stringify({password:"testPw2026"})}));expect((input as HTMLInputElement).value).toBe("");expect(screen.queryByRole("alert")).toBeNull();
});
it("allows a 3 character original password and exposes the same 3 to 10 character limits",async()=>{
	const onLogin=vi.fn(async()=>{}),fetcher=vi.fn(async()=>Response.json({ok:true}));vi.stubGlobal("fetch",fetcher);render(<Login retry={async()=>{}} onLogin={onLogin}/>);
	const input=screen.getByLabelText("管理密码") as HTMLInputElement;expect(input.minLength).toBe(3);expect(input.maxLength).toBe(10);
	fireEvent.change(input,{target:{value:"007"}});fireEvent.submit(input.closest("form")!);await waitFor(()=>expect(onLogin).toHaveBeenCalledOnce());
	expect(fetcher).toHaveBeenCalledWith("/api/auth/password",expect.objectContaining({body:JSON.stringify({password:"007"})}));
});
it("a wrong password stays on the login form with a clear error",async()=>{
	const onLogin=vi.fn(async()=>{});vi.stubGlobal("fetch",async()=>Response.json({error:{code:"LOGIN_FAILED",message:"密码不正确，请重试"}},{status:401}));render(<Login retry={async()=>{}} onLogin={onLogin}/>);
	const input=screen.getByLabelText("管理密码");fireEvent.change(input,{target:{value:"wrongPass"}});fireEvent.submit(input.closest("form")!);expect((await screen.findByRole("alert")).textContent).toContain("密码不正确");expect(onLogin).not.toHaveBeenCalled();
});
it("missing backend configuration disables entry and offers retry",()=>{
	render(<Login error={new ApiError(503,"CONFIG_REQUIRED","DB missing")} retry={async()=>{}} onLogin={async()=>{}}/>);expect(screen.getByRole("alert").textContent).toContain("管理服务暂不可用");expect((screen.getByRole("button",{name:"进入后台"}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole("button",{name:"重新连接"})).toBeTruthy();
});
