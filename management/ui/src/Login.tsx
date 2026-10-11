import { useState, type FormEvent } from "react";
import { ApiError, message } from "./api";
import "./login.css";

export function Login({ error, retry, onLogin }: { error?: unknown; retry: () => Promise<void>; onLogin: () => Promise<void> }) {
	const [password, setPassword] = useState("");
	const [visible, setVisible] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<unknown>();
	const [dark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
	const unavailable = !!error && !(error instanceof ApiError && error.status === 401);
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (busy || unavailable) return;
		setBusy(true); setFailure(undefined);
		try {
			const response = await fetch("/api/auth/password", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ password }) });
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new ApiError(response.status, result.error?.code ?? "LOGIN_FAILED", result.error?.message ?? "登录暂未完成，请稍后重试");
			setPassword("");
			await onLogin();
		} catch (error) { setFailure(error); }
		finally { setBusy(false); }
	}
	return <main className="admin-login" data-theme={dark ? "dark" : "light"}>
		<header className="login-top"><a className="login-home" href="/"><img src="/assets/images/logo-nocticur.png" alt=""/><span>Nocticur</span></a><button className="login-theme" aria-label="切换日夜主题" onClick={() => setDark(!dark)}>{dark ? "☀" : "☾"}</button></header>
		<div className="login-scene"><div className="login-orbit orbit-one"/><div className="login-orbit orbit-two"/><section className="login-surface" aria-labelledby="login-title">
			<div className="login-story"><span className="login-kicker">NOCTICUR · PRIVATE SPACE</span><div className="login-emblem"><img src="/assets/images/logo-nocticur.png" alt="Nocticur 的头像"/></div><p className="login-poem">向夜驰行<br/>不问喧嚣</p><span className="login-story-note">让文字、想法和回忆<br/>在这里安静生长。</span><span className="login-star star-one">✦</span><span className="login-star star-two">✧</span></div>
			<div className="login-form-panel"><span className="login-lock" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg></span><span className="login-kicker">WELCOME BACK</span><h1 id="login-title">后台管理</h1><p className="login-description">输入管理密码，继续你的创作。</p>
				{unavailable && <div className="login-alert" role="alert"><strong>管理服务暂不可用</strong><span>请完成后台配置后重试。</span><button type="button" onClick={() => void retry()}>重新连接</button></div>}
				<form onSubmit={event => void submit(event)}><label htmlFor="admin-password">管理密码</label><div className="login-password"><input id="admin-password" name="password" type={visible ? "text" : "password"} value={password} onChange={event => { setPassword(event.target.value); setFailure(undefined); }} autoComplete="current-password" minLength={12} maxLength={256} required disabled={busy || unavailable} placeholder="请输入管理密码"/><button type="button" aria-label={visible ? "隐藏密码" : "显示密码"} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? "隐藏" : "显示"}</button></div>
					{failure !== undefined && <p className="login-error" role="alert">{message(failure)}</p>}
					<button className="login-submit" type="submit" disabled={!password || busy || unavailable}>{busy ? "正在验证…" : "进入后台"}<span aria-hidden="true">→</span></button>
				</form><div className="login-divider"/><a className="login-back" href="/">← 回到博客</a><p className="login-private">只有正确的密码，才能进入这片私人空间。</p>
			</div>
		</section></div><footer className="login-footer">身沉暮色，心赴归途 <span>✦</span> Nocticur</footer>
	</main>;
}
