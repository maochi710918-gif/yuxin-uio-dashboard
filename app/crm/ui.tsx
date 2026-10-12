"use client";
// API payloads from /api/crm/* are rendered as loosely typed records; the server is the source of truth for their shape.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Database, LoaderCircle, PlugZap, RefreshCw, X } from "lucide-react";
import { ApiError } from "./api";

/** Loads data with loading / error / retry state; `deps` change triggers a reload. */
export function useApi<T>(loader: () => Promise<T>, deps: unknown[]) {
  // Loading is derived: a request is in flight while the settled key differs from the requested key.
  const [tick, setTick] = useState(0);
  const key = `${JSON.stringify(deps)}#${tick}`;
  const [settled, setSettled] = useState<{ key: string; data: T | null; error: Error | null }>({ key: "", data: null, error: null });
  const loaderRef = useRef(loader);
  useEffect(() => { loaderRef.current = loader; });
  useEffect(() => {
    let current = true;
    loaderRef.current().then((value) => { if (current) setSettled({ key, data: value, error: null }); })
      .catch((err: Error) => { if (current) setSettled((previous) => ({ key, data: previous.data, error: err })); });
    return () => { current = false; };
  }, [key]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  const setData = useCallback((data: T | null) => setSettled((previous) => ({ ...previous, data })), []);
  const loading = settled.key !== key;
  return { data: settled.data, error: loading ? null : settled.error, loading, reload, setData };
}

export function Panel({ title, eyebrow, actions, children, className = "" }: { title?: React.ReactNode; eyebrow?: string; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`crm-panel ${className}`}>
    {(title || actions) && <header className="crm-panel-head"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}{title && <h2>{title}</h2>}</div>{actions && <div className="crm-panel-actions">{actions}</div>}</header>}
    {children}
  </section>;
}

export function Loading({ label = "載入中…" }: { label?: string }) {
  return <div className="crm-state"><LoaderCircle className="animate-spin" /><span>{label}</span></div>;
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const signIn = error instanceof ApiError && error.status === 401;
  return <div className="crm-state crm-state-error" role="alert"><AlertTriangle /><span>{error.message}</span>
    {signIn ? <a className="crm-btn" href={`/signin-with-chatgpt?return_to=${encodeURIComponent(typeof window === "undefined" ? "/" : window.location.pathname + window.location.search)}`}>登入</a> : onRetry && <button className="crm-btn" onClick={onRetry}><RefreshCw />重試</button>}
  </div>;
}

export function Empty({ label = "沒有資料", hint }: { label?: string; hint?: string }) {
  return <div className="crm-state"><Database /><span>{label}</span>{hint && <small>{hint}</small>}</div>;
}

/** Shown wherever a source has not been imported yet — never a fake number. */
export function NotConnected({ what, template, onImport }: { what: string; template?: string; onImport?: () => void }) {
  return <div className="crm-not-connected"><PlugZap /><div><strong>{what}：尚未串接</strong><span>此區塊已建立，匯入{template ? `「${template}」` : "對應資料"}後自動顯示。{onImport && <button className="crm-link" onClick={onImport}>前往資料匯入</button>}</span></div></div>;
}

export function Async<T>({ state, children, empty }: { state: { data: T | null; error: Error | null; loading: boolean; reload: () => void }; children: (data: T) => React.ReactNode; empty?: (data: T) => boolean }) {
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (state.loading && !state.data) return <Loading />;
  if (!state.data) return <Empty />;
  if (empty?.(state.data)) return <Empty />;
  return <div className={state.loading ? "crm-refreshing" : ""}>{children(state.data)}</div>;
}

export function Stat({ label, value, sub, tone = "default", onClick, title }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "default" | "good" | "warn" | "bad" | "info"; onClick?: () => void; title?: string }) {
  const Tag = onClick ? "button" : "div";
  return <Tag className={`crm-stat crm-tone-${tone} ${onClick ? "is-clickable" : ""}`} onClick={onClick} title={title}><span>{label}</span><strong>{value}</strong>{sub && <small>{sub}</small>}</Tag>;
}

export function Badge({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "good" | "warn" | "bad" | "info" | "muted" }) {
  return <span className={`crm-badge crm-tone-${tone}`}>{children}</span>;
}

const statusTone: Record<string, "default" | "good" | "warn" | "bad" | "info" | "muted"> = { 待處理: "warn", 待匯出: "info", 已匯出: "default", 待回傳: "warn", 已完成: "good", 已取消: "muted", 成交: "good", 未成交: "muted", 待接手: "warn", 已接手: "good", 已退回: "bad" };
export function StatusBadge({ status }: { status: string | null | undefined }) {
  return <Badge tone={statusTone[status ?? ""] ?? "default"}>{status ?? "—"}</Badge>;
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="crm-pager"><span>共 {new Intl.NumberFormat("zh-TW").format(total)} 筆｜第 {page}／{pages} 頁</span><div><button className="crm-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft />上一頁</button><button className="crm-btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一頁<ChevronRight /></button></div></div>;
}

export function Drawer({ open, title, onClose, children, wide }: { open: boolean; title: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="crm-drawer-backdrop" onClick={onClose}><aside className={`crm-drawer ${wide ? "is-wide" : ""}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
    <header><h2>{title}</h2><button className="crm-icon-btn" onClick={onClose} aria-label="關閉"><X /></button></header>
    <div className="crm-drawer-body">{children}</div>
  </aside></div>;
}

export function CodeLink({ code, onOpen }: { code: string | null | undefined; onOpen?: (code: string) => void }) {
  if (!code) return <span className="crm-muted">—</span>;
  return onOpen ? <button className="crm-code" onClick={() => onOpen(code)}>{code}</button> : <span className="crm-code is-static">{code}</span>;
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="crm-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

/** Inline result / error message for actions. */
export function useNotice() {
  const [notice, setNotice] = useState<{ tone: "good" | "bad" | "info"; text: string } | null>(null);
  const show = (tone: "good" | "bad" | "info", text: string) => { setNotice({ tone, text }); window.setTimeout(() => setNotice((current) => (current?.text === text ? null : current)), 8000); };
  const element = notice ? <div className={`crm-notice crm-tone-${notice.tone}`} role="status">{notice.text}</div> : null;
  return { show, element };
}

export async function runAction(action: () => Promise<unknown>, notice: ReturnType<typeof useNotice>, success: string | ((result: any) => string)) {
  try {
    const result = await action();
    notice.show("good", typeof success === "function" ? success(result) : success);
    return result;
  } catch (error) {
    notice.show("bad", error instanceof Error ? error.message : "操作失敗");
    return null;
  }
}
