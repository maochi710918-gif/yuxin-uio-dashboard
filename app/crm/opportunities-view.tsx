"use client";
// API payloads from /api/crm/* are rendered as loosely typed records; the server is the source of truth for their shape.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { apiGet, apiPost, fmtMoney, fmtNumber } from "./api";
import { StaffPicker, TaskQuickForm } from "./customer-360";
import { Async, Badge, CodeLink, Drawer, Empty, Field, Pager, Panel, StatusBadge, runAction, useApi, useNotice } from "./ui";

export function Funnel({ owner, type, origin }: { owner?: string; type?: string; origin?: string }) {
  const state = useApi(() => apiGet<any>("/api/crm/opportunities", { view: "funnel", owner, type, origin }), [owner, type, origin]);
  return <Async state={state}>{(d) => {
    const top = Math.max(1, d.stages[0]?.reached ?? 0);
    return <div className="crm-funnel">
      {d.stages[0]?.reached ? d.stages.map((stage: any, index: number) => <div key={stage.stage} className="crm-funnel-row"><span>{stage.stage}</span><i><b style={{ width: `${Math.max(2, stage.reached / top * 100)}%` }} /></i><strong>{fmtNumber(stage.reached)}</strong><small>{index ? `${(stage.reached / Math.max(1, d.stages[index - 1].reached) * 100).toFixed(0)}% 承接` : "曾到達各階段的商機數"}</small></div>) : <Empty label="尚無商機" hint="由客戶 360、售後轉介或自動化規則建立" />}
      <p className="crm-muted">成交營收：{d.revenue.amount === null ? "尚無連結交易" : `${fmtMoney(d.revenue.amount)}（${d.revenue.deals} 筆交易）`}｜{d.revenue.rule}</p>
      {d.lost.length > 0 && <div className="c360-tags">{d.lost.map((row: any) => <Badge key={row.lost_reason ?? "未填"} tone="muted">未成交：{row.lost_reason ?? "未填"} {row.n}</Badge>)}</div>}
    </div>;
  }}</Async>;
}

export function OpportunitiesView({ onOpenCustomer, scope }: { onOpenCustomer: (code: string) => void; scope?: { owner?: string; origin?: string; handover?: string } }) {
  const [filter, setFilter] = useState<{ stage?: string; type?: string; q?: string; overdue?: boolean; origin?: string; handover?: string }>({ ...scope });
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<string | null>(null);
  const list = useApi(() => apiGet<any>("/api/crm/opportunities", { ...filter, overdue: filter.overdue ? 1 : undefined, owner: scope?.owner, page, pageSize: 20 }), [JSON.stringify(filter), page, scope?.owner]);
  return <div className="crm-stack">
    <Panel title="商機漏斗" eyebrow="分派 → 已聯絡 → 有效回覆 → 預約 → 到店／試乘 → 報價 → 成交"><Funnel owner={scope?.owner} type={filter.type} origin={filter.origin} /></Panel>
    <Panel title="商機" eyebrow="同一客戶可有多筆不同需求的商機" actions={<>
      <select value={filter.type ?? ""} onChange={(event) => { setFilter({ ...filter, type: event.target.value || undefined }); setPage(1); }} aria-label="類型"><option value="">全部類型</option>{["新車", "換購", "增購", "保險", "售後服務"].map((item) => <option key={item}>{item}</option>)}</select>
      <select value={filter.stage ?? ""} onChange={(event) => { setFilter({ ...filter, stage: event.target.value || undefined }); setPage(1); }} aria-label="階段"><option value="">全部階段</option>{["分派", "已聯絡", "有效回覆", "預約", "到店試乘", "報價", "成交", "未成交"].map((item) => <option key={item}>{item}</option>)}</select>
      <select value={filter.handover ?? ""} onChange={(event) => { setFilter({ ...filter, handover: event.target.value || undefined }); setPage(1); }} aria-label="接手"><option value="">接手狀態</option><option>待接手</option><option>已接手</option><option>已退回</option></select>
      <label className="crm-check"><input type="checkbox" checked={Boolean(filter.overdue)} onChange={(event) => { setFilter({ ...filter, overdue: event.target.checked }); setPage(1); }} />逾期</label>
      <input value={filter.q ?? ""} onChange={(event) => { setFilter({ ...filter, q: event.target.value }); setPage(1); }} placeholder="商機／客戶／車輛編碼" />
    </>}>
      <Async state={list}>{(d) => d.rows.length ? <>
        <table className="crm-table"><thead><tr><th>商機編碼</th><th>客戶／車輛</th><th>類型</th><th>來源</th><th>需求／產品</th><th>階段</th><th>負責</th><th>接手</th><th>下一步</th><th>結案</th></tr></thead>
          <tbody>{d.rows.map((row: any) => <tr key={row.opp_code} className={row.overdue ? "is-overdue" : ""}><td><CodeLink code={row.opp_code} onOpen={setDetail} /></td><td><CodeLink code={row.customer_code} onOpen={onOpenCustomer} /><small className="crm-sub">{row.vehicle_code ?? "—"}</small></td><td>{row.opp_type}</td><td>{row.origin}{row.referral_from_unit && <small className="crm-sub">自 {row.referral_from_unit}／{row.referral_by_staff ?? "—"}</small>}</td><td className="crm-wrap">{row.need ?? "—"}<small className="crm-sub">{row.product ?? ""} {row.budget_band ?? ""}</small></td><td><StatusBadge status={row.stage} /></td><td>{row.owner_name ?? row.owner_staff_code ?? <Badge tone="warn">未指派</Badge>}</td><td><StatusBadge status={row.handover_status} /></td><td className="crm-wrap">{row.next_step ?? "—"}<small className="crm-sub">{row.next_due_date ?? ""}{row.overdue ? "・逾期" : ""}</small></td><td>{row.won_txn_code ? <>{row.won_txn_code}<small className="crm-sub">{fmtMoney(row.won_amount)}</small></> : row.lost_reason ?? "—"}</td></tr>)}</tbody></table>
        <Pager page={page} pageSize={20} total={d.total} onPage={setPage} />
      </> : <Empty label="沒有符合的商機" />}</Async>
    </Panel>
    <Drawer open={Boolean(detail)} title={<>商機 <span className="crm-muted">｜{detail}</span></>} onClose={() => setDetail(null)}>{detail && <OpportunityDetail code={detail} onChanged={list.reload} onOpenCustomer={onOpenCustomer} />}</Drawer>
  </div>;
}

function OpportunityDetail({ code, onChanged, onOpenCustomer }: { code: string; onChanged: () => void; onOpenCustomer: (code: string) => void }) {
  const state = useApi(() => apiGet<any>("/api/crm/opportunities", { view: "detail", code }), [code]);
  const notice = useNotice();
  const [mode, setMode] = useState<string | null>(null);
  const [value, setValue] = useState({ stage: "已聯絡", reason: "", owner_staff_code: "", won_txn_code: "", next_step: "", next_due_date: "" });
  const change = (payload: Record<string, unknown>, text: string) => runAction(() => apiPost("/api/crm/opportunities", { ...payload, change: payload.action, action: "change", opp_code: code }), notice, text).then((ok) => { if (ok) { state.reload(); onChanged(); setMode(null); } });
  return <Async state={state}>{(d) => {
    const o = d.opportunity;
    const closed = o.stage === "成交" || o.stage === "未成交";
    return <div className="crm-stack">
      {notice.element}
      <dl className="crm-dl">{[["客戶", <CodeLink key="c" code={o.customer_code} onOpen={onOpenCustomer} />], ["車輛", o.vehicle_code], ["類型／來源", `${o.opp_type}／${o.origin}`], ["需求", o.need], ["意向產品", o.product], ["預算區間", o.budget_band], ["預計決策", o.expected_decision_date], ["階段", <StatusBadge key="s" status={o.stage} />], ["負責", `${o.owner_staff_code ?? "未指派"}／${o.owner_unit_code ?? "—"}`], ["接手", o.handover_status], ["轉介", o.referral_from_unit ? `${o.referral_from_unit}／${o.referral_by_staff ?? "—"}：${o.referral_need ?? ""}` : "—"], ["下一步", `${o.next_step ?? "—"} ${o.next_due_date ?? ""}`], ["結案", o.won_txn_code ? `成交 ${o.won_txn_code}（${fmtMoney(o.won_amount)}，${o.won_date}）` : o.lost_reason ? `未成交：${o.lost_reason}` : "—"]].map(([label, item]) => <div key={label as string}><dt>{label}</dt><dd>{item || "—"}</dd></div>)}</dl>
      {!closed && <div className="crm-bulk">
        {o.handover_status === "待接手" && <button className="crm-btn crm-btn-primary" onClick={() => change({ action: "accept" }, "已接手")}>接手</button>}
        {o.origin === "售後轉介" && <button className="crm-btn" onClick={() => setMode("return")}>退回</button>}
        <button className="crm-btn" onClick={() => setMode("reassign")}>轉派</button>
        <button className="crm-btn" onClick={() => setMode("stage")}>更新階段</button>
        <button className="crm-btn" onClick={() => setMode("update")}>下一步</button>
        <button className="crm-btn" onClick={() => setMode("task")}>安排任務</button>
        <button className="crm-btn crm-btn-primary" onClick={() => setMode("won")}>成交結案</button>
        <button className="crm-btn crm-btn-danger" onClick={() => setMode("lost")}>未成交結案</button>
      </div>}
      {mode === "return" && <div className="crm-form"><Field label="退回原因"><input value={value.reason} onChange={(event) => setValue({ ...value, reason: event.target.value })} /></Field><div className="crm-form-actions"><button className="crm-btn" onClick={() => change({ action: "return", reason: value.reason }, "已退回轉介人")}>確認退回</button></div></div>}
      {mode === "reassign" && <div className="crm-form"><Field label="轉派給"><StaffPicker value={value.owner_staff_code} onChange={(staff) => setValue({ ...value, owner_staff_code: staff })} /></Field><Field label="原因"><input value={value.reason} onChange={(event) => setValue({ ...value, reason: event.target.value })} /></Field><div className="crm-form-actions"><button className="crm-btn" onClick={() => change({ action: "reassign", owner_staff_code: value.owner_staff_code, reason: value.reason }, "已轉派，等待接手")}>確認轉派</button></div></div>}
      {mode === "stage" && <div className="crm-form"><Field label="階段"><select value={value.stage} onChange={(event) => setValue({ ...value, stage: event.target.value })}>{["分派", "已聯絡", "有效回覆", "預約", "到店試乘", "報價"].map((item) => <option key={item}>{item}</option>)}</select></Field><Field label="說明"><input value={value.reason} onChange={(event) => setValue({ ...value, reason: event.target.value })} /></Field><div className="crm-form-actions"><button className="crm-btn" onClick={() => change({ action: "stage", stage: value.stage, reason: value.reason }, "已更新階段")}>更新</button></div></div>}
      {mode === "update" && <div className="crm-form"><Field label="下一步"><input value={value.next_step} onChange={(event) => setValue({ ...value, next_step: event.target.value })} /></Field><Field label="期限"><input type="date" value={value.next_due_date} onChange={(event) => setValue({ ...value, next_due_date: event.target.value })} /></Field><div className="crm-form-actions"><button className="crm-btn" onClick={() => change({ action: "update", next_step: value.next_step, next_due_date: value.next_due_date }, "已更新")}>儲存</button></div></div>}
      {mode === "won" && <div className="crm-form"><Field label="成交交易編碼" hint="必須是平台已匯入的實際訂單／交易編碼；營收以該交易金額認列"><input value={value.won_txn_code} onChange={(event) => setValue({ ...value, won_txn_code: event.target.value.trim() })} /></Field><div className="crm-form-actions"><button className="crm-btn crm-btn-primary" onClick={() => change({ action: "close_won", won_txn_code: value.won_txn_code }, "已成交結案")}>確認成交</button></div></div>}
      {mode === "lost" && <div className="crm-form"><Field label="未成交原因"><select value={value.reason} onChange={(event) => setValue({ ...value, reason: event.target.value })}><option value="">選擇</option>{["價格", "已在他牌購車", "需求取消", "時程延後", "無法聯絡", "拒收", "其他"].map((item) => <option key={item}>{item}</option>)}</select></Field><div className="crm-form-actions"><button className="crm-btn crm-btn-danger" disabled={!value.reason} onClick={() => change({ action: "close_lost", reason: value.reason }, "已結案（未成交）")}>確認</button></div></div>}
      {mode === "task" && <TaskQuickForm customer={o.customer_code} vehicles={o.vehicle_code ? [o.vehicle_code] : []} opp={o.opp_code} onDone={(text) => { notice.show("good", text); setMode(null); state.reload(); }} onError={(text) => notice.show("bad", text)} />}
      <h3>歷次異動</h3><ol className="c360-timeline">{d.events.map((event: any) => <li key={event.event_id}><time>{event.at.slice(0, 16).replace("T", " ")}</time><Badge>{event.event_type}</Badge><span>{event.from_value ?? ""} → {event.to_value ?? ""}</span><small>{event.note}｜{event.actor}</small></li>)}</ol>
      <h3>相關任務</h3>{d.tasks.length ? <ul className="c360-list">{d.tasks.map((task: any) => <li key={task.task_code}><span className="crm-code is-static">{task.task_code}</span><StatusBadge status={task.status} /><span>{task.task_type}｜{task.due_date}</span><small>{task.result ?? ""}</small></li>)}</ul> : <span className="crm-muted">無</span>}
    </div>;
  }}</Async>;
}
