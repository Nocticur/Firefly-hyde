import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, message } from "./api";
export function useResource<T>(fetcher: () => Promise<T>, dependencies: unknown[] = []) {
	const [data, setData] = useState<T>(); const [error, setError] = useState<unknown>(); const [loading, setLoading] = useState(true);
	const refresh = useCallback(async () => { setLoading(true); setError(undefined); try { setData(await fetcher()); } catch (e) { setError(e); } finally { setLoading(false); } }, dependencies);
	useEffect(() => { void refresh(); }, [refresh]);
	return { data, setData, error, loading, refresh };
}
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) { if (!error) return null; return <div className="notice danger" role="alert"><strong>{error instanceof ApiError && error.status === 503 ? "服务尚未配置" : "操作未完成"}</strong><span>{message(error)}</span>{retry && <button onClick={retry}>重试读取</button>}</div>; }
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
export function Tag({ children, tone = "" }: { children: ReactNode; tone?: string }) { return <span className={`tag ${tone}`}>{children}</span>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
	useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === "Escape") close(); }; document.addEventListener("keydown", listener); return () => document.removeEventListener("keydown", listener); }, [close]);
	return <div className="modal-backdrop" onClick={close}><section className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}><div className="row between"><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={close}>×</button></div>{children}</section></div>;
}
export function Time({ value }: { value?: string }) { return <time dateTime={value}>{value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—"}</time>; }
export function CodeValue({ value }: { value?: string }) { return <code title={value}>{value ? value.slice(0, 12) : "未核验"}</code>; }
export function PageTitle({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) { return <header className="page-title"><div><h1>{title}</h1><p>{description}</p></div><div className="row">{actions}</div></header>; }
export function useAction() { const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(); const [success, setSuccess] = useState(""); const run = async (action: () => Promise<unknown>, text = "操作已保存") => { setBusy(true); setError(undefined); setSuccess(""); try { await action(); setSuccess(text); return true; } catch (e) { setError(e); return false; } finally { setBusy(false); } }; return { busy, error, success, run, clear: () => { setError(undefined); setSuccess(""); } }; }
export function ActionStatus({ action }: { action: ReturnType<typeof useAction> }) { return <><ErrorBox error={action.error}/>{action.success && <div className="notice success" role="status">{action.success}</div>}</>; }
