import { useEffect, useState } from "react";
import { api, type User } from "./api";
import { ErrorBox, useResource } from "./shared";
import { usePublicationReconciliation } from "./reconciliation";
import { Dashboard, Maintenance, Publications } from "./tasks";
import { Articles } from "./articles";
import { MediaLibrary } from "./media";
import { Settings, Navigation, Icons } from "./settings";
import { Comments, Friends } from "./interactions";
type Page = "dashboard" | "articles" | "media" | "settings" | "navigation" | "icons" | "comments" | "friends" | "publications" | "maintenance";
const pages: { id: Page; name: string; icon: string; group: string }[] = [
	{ id: "dashboard", name: "仪表盘", icon: "◈", group: "工作台" }, { id: "articles", name: "文章", icon: "▤", group: "内容" }, { id: "media", name: "媒体库", icon: "▧", group: "内容" }, { id: "comments", name: "评论", icon: "◇", group: "互动" }, { id: "friends", name: "友链", icon: "↗", group: "互动" }, { id: "settings", name: "站点设置", icon: "⚙", group: "站点" }, { id: "navigation", name: "导航", icon: "☷", group: "站点" }, { id: "icons", name: "图标", icon: "◉", group: "站点" }, { id: "publications", name: "发布记录", icon: "↑", group: "维护" }, { id: "maintenance", name: "维护与备份", icon: "↻", group: "维护" },
];
function readPage(): Page { const name = location.hash.slice(1).split("?")[0]; return pages.some(page => page.id === name) ? name as Page : "dashboard"; }
export function App() {
	const [page, setPage] = useState<Page>(readPage); const [mobile, setMobile] = useState(false);
	const session = useResource(async () => { const result = await api.get<{ user: User; csrf: string }>("/me"); api.setCsrf(result.csrf); return result; });
	useEffect(() => { const change = () => { setPage(readPage()); setMobile(false); }; window.addEventListener("hashchange", change); return () => window.removeEventListener("hashchange", change); }, []);
	if (session.loading && !session.data) return <div className="login-page"><div className="brand-mark">N</div><h1>正在验证管理会话</h1><p>连接同域管理 API…</p></div>;
	if (!session.data?.user) return <main className="login-page"><div className="login-card"><div className="brand-mark">N</div><p className="eyebrow">NOCTICUR / MANAGEMENT</p><h1>让想法有处安放。</h1><p>文章、媒体和站点的私有工作台。</p><ErrorBox error={session.error} retry={() => void session.refresh()}/><a className="button primary" href="/api/auth/github">使用 GitHub 登录</a><small>仅绑定的 GitHub 数字用户 ID 可进入。会话凭据由安全 Cookie 管理。</small></div></main>;
	const user = session.data.user;
	return <AuthenticatedWorkspace user={user} page={page} mobile={mobile} setMobile={setMobile}/>;
}
function AuthenticatedWorkspace({ user, page, mobile, setMobile }: { user: User; page: Page; mobile: boolean; setMobile: (value: boolean) => void }) {
	const reconciliationError = usePublicationReconciliation();
	return <div className="app-shell">{mobile && <button className="mobile-backdrop" aria-label="关闭菜单遮罩" onClick={() => setMobile(false)}/>}<aside className={`sidebar ${mobile ? "open" : ""}`}><button className="mobile-close quiet" aria-label="收起菜单" onClick={() => setMobile(false)}>×</button><a className="brand" href="#dashboard"><span className="brand-mark small">N</span><span>Nocticur<small>内容管理</small></span></a><nav aria-label="主导航">{pages.map((item, index) => <div key={item.id}>{index === 0 || pages[index - 1].group !== item.group ? <span className="nav-group">{item.group}</span> : null}<a href={`#${item.id}`} className={page === item.id ? "active" : ""}><span aria-hidden="true">{item.icon}</span>{item.name}</a></div>)}</nav><div className="sidebar-bottom"><a href="https://blog.mourn.top/" target="_blank" rel="noreferrer">访问博客 ↗</a><small>单站点 · 私有编辑</small></div></aside><div className="main-shell"><header className="topbar"><button className="mobile-menu" aria-label="展开菜单" onClick={() => setMobile(!mobile)}>☰</button><span className="breadcrumb">工作空间 / <strong>{pages.find(item => item.id === page)?.name}</strong></span><div className="row"><span className="session-dot"/><span>{user.login}</span><button className="quiet" onClick={async () => { await api.post("/auth/logout"); api.setCsrf(""); location.reload(); }}>退出</button></div></header><main className="page-content"><ErrorBox error={reconciliationError}/>{page === "dashboard" && <Dashboard/>}{page === "articles" && <Articles/>}{page === "media" && <MediaLibrary/>}{page === "settings" && <Settings/>}{page === "navigation" && <Navigation/>}{page === "icons" && <Icons/>}{page === "comments" && <Comments/>}{page === "friends" && <Friends/>}{page === "publications" && <Publications/>}{page === "maintenance" && <Maintenance/>}</main><footer className="workspace-footer">Nocticur 内容工作台 <span>Asia/Shanghai · 草稿与生产版本独立</span></footer></div></div>;
}
