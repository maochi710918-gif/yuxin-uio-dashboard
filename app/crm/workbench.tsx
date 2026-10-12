"use client";
// API payloads from /api/crm/* are rendered as loosely typed records; the server is the source of truth for their shape.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { Download, Plus, Search, Share2 } from "lucide-react";
import { apiGet, apiPost, download, fmtNumber } from "./api";
import { CustomerLookup, OppQuickForm, StaffPicker, TaskQuickForm } from "./customer-360";
import { Funnel } from "./opportunities-view";
import { TodayWork } from "./tasks-view";
import { Async, Badge, CodeLink, Empty, Field, Pager, Panel, StatusBadge, runAction, useApi, useNotice } from "./ui";

type Actor = { role: string; staffCode: string | null; displayName: string; roleLabel: string };

export function SalesWorkbench({ actor, onOpenCustomer, onOpenTasks }: { actor: Actor; onOpenCustomer: (code: string) => void; onOpenTasks: () => void }) {
  // 主管可檢視任一業代的工作台；業代本人只看得到自己的（後端依登入身分限制）。
  const [owner, setOwner] = useState(actor.role === "sales" ? actor.staffCode ?? "" : "");
  const [quick, setQuick] = useState<"opp" | "task" | "referral" | null>(null);
  const [quickCustomer, setQuickCustomer] = useState("");
  const notice = useNotice();
  const ownerParam = owner || undefined;
  return <div className="crm-stack">
    <Panel title={`銷售顧問工作台${owner ? `｜${owner}` : ""}`} eyebrow={actor.role === "sales" ? `${actor.displayName}（${actor.roleLabel}）` : "主管檢視：選擇業代查看其工作台"} actions={actor.role !== "sales" && <span className="crm-inline"><StaffPicker role="sales" value={owner} onChange={setOwner} /></span>}>
      <TodayWork onFilter={onOpenTasks} />
      <div className="wb-quick">
        <CustomerLookup onOpen={onOpenCustomer} />
        <div className="crm-inline"><input value={quickCustomer} onChange={(event) => setQuickCustomer(event.target.value.trim().toUpperCase())} placeholder="客戶編碼" aria-label="快速操作客戶編碼" />
          <button className="crm-btn" disabled={!quickCustomer} onClick={() => setQuick(quick === "opp" ? null : "opp")}><Plus />建立商機</button>
          <button className="crm-btn" disabled={!quickCustomer} onClick={() => setQuick(quick === "task" ? null : "task")}><Plus />安排任務</button>
          <button className="crm-btn" disabled={!quickCustomer} onClick={() => setQuick(quick === "referral" ? null : "referral")}><Share2 />售後轉介</button>
          <button className="crm-btn crm-btn-primary" onClick={() => runAction(() => apiPost<any>("/api/crm/tasks", { action: "export" }), notice, (r) => `已匯出 ${r.tasks} 筆（${r.export_code}）`).then((r: any) => r && download("/api/crm/tasks", { view: "download", export: r.export_code }))}><Download />下載待匯出名單</button>
          <button className="crm-btn" onClick={onOpenTasks}>匯入結果</button>
        </div>
      </div>
      {notice.element}
      {quick === "opp" && <OppQuickForm customer={quickCustomer} vehicles={[]} onDone={(text) => { notice.show("good", text); setQuick(null); }} onError={(text) => notice.show("bad", text)} />}
      {quick === "referral" && <OppQuickForm referral customer={quickCustomer} vehicles={[]} onDone={(text) => { notice.show("good", text); setQuick(null); }} onError={(text) => notice.show("bad", text)} />}
      {quick === "task" && <TaskQuickForm customer={quickCustomer} vehicles={[]} onDone={(text) => { notice.show("good", text); setQuick(null); }} onError={(text) => notice.show("bad", text)} />}
    </Panel>
    <PriorityList owner={ownerParam} onOpenCustomer={onOpenCustomer} />
    <div className="crm-two">
      <UpgradeLeads onOpenCustomer={onOpenCustomer} owner={ownerParam} />
      <Panel title="商機漏斗" eyebrow="以自己負責的商機計算"><Funnel owner={ownerParam} /></Panel>
    </div>
    <Referrals owner={ownerParam} onOpenCustomer={onOpenCustomer} />
  </div>;
}

function PriorityList({ owner, onOpenCustomer }: { owner?: string; onOpenCustomer: (code: string) => void }) {
  const [page, setPage] = useState(1);
  const state = useApi(() => apiGet<{ total: number; rows: any[] }>("/api/crm/tasks", { status: "待處理,待匯出,已匯出,待回傳", owner, page, pageSize: 15 }), [owner, page]);
  return <Panel title="優先行動名單" eyebrow="依逾期、優先順序與期限排序；畫面只顯示編碼，聯絡請下載後於地端比對">
    <Async state={state}>{(d) => d.rows.length ? <>
      <table className="crm-table"><thead><tr><th>客戶編碼</th><th>車輛編碼</th><th>入選原因</th><th>商機</th><th>建議行動</th><th>期限</th><th>負責人</th><th>狀態</th></tr></thead>
        <tbody>{d.rows.map((row) => <tr key={row.task_code} className={row.overdue ? "is-overdue" : ""}><td><CodeLink code={row.customer_code} onOpen={onOpenCustomer} /></td><td>{row.vehicle_code ?? "—"}</td><td className="crm-wrap">{row.reason}</td><td>{row.opp_code ?? "—"}</td><td className="crm-wrap">{row.recommended_action}</td><td>{row.due_date}{row.overdue ? <Badge tone="bad">逾期</Badge> : null}</td><td>{row.owner_name ?? row.owner_staff_code ?? "未指派"}</td><td><StatusBadge status={row.status} /></td></tr>)}</tbody></table>
      <Pager page={page} pageSize={15} total={d.total} onPage={setPage} />
    </> : <Empty label="目前沒有待辦任務" hint="主管可從「客群」建立任務，或啟用自動化規則" />}</Async>
  </Panel>;
}

function UpgradeLeads({ owner, onOpenCustomer }: { owner?: string; onOpenCustomer: (code: string) => void }) {
  const [page, setPage] = useState(1);
  const state = useApi(() => apiPost<any>("/api/crm/segments", { action: "members", definition: { op: "AND", items: [{ op: "OR", items: [{ field: "replacement_score", op: "gte", value: 50 }, { field: "owned_vehicles", op: "gte", value: 2 }, { field: "open_referrals", op: "gte", value: 1 }] }, ...(owner ? [{ field: "sales_code", op: "eq", value: owner }] : [])] }, page, pageSize: 10 }), [owner, page]);
  return <Panel title="換購／增購機會" eyebrow="線索與資料依據；需確認實際需求後才建立商機">
    <Async state={state}>{(d) => d.rows.length ? <>
      <ul className="wb-leads">{d.rows.map((row: any) => <li key={`${row.customer_code}${row.vehicle_code}`}>
        <div><CodeLink code={row.customer_code} onOpen={onOpenCustomer} /><span>{row.vehicle_code}｜{row.model_series ?? "—"}</span><Badge tone="info">{row.replacement_score_level}</Badge></div>
        <small>依據：{["age_7", "age_5", "km_100k", "warranty_out", "repair_spend", "test_drive"].filter((key) => row[`replacement_score__${key}`] === 1).map((key) => ({ age_7: "車齡 ≥ 7 年", age_5: "車齡 5–7 年", km_100k: "實際里程 ≥ 10 萬", warranty_out: "已過保固", repair_spend: "近一年維修 ≥ 3 萬", test_drive: "近期試乘／報價" } as Record<string, string>)[key]).join("、") || "持有多車或有轉介"}</small>
        <small>更新日期：{d.asOf}｜待確認：實際換車需求、預算與時程</small>
      </li>)}</ul>
      <Pager page={page} pageSize={10} total={d.total} onPage={setPage} />
    </> : <Empty label="目前沒有換購／增購線索" />}</Async>
  </Panel>;
}

function Referrals({ owner, onOpenCustomer }: { owner?: string; onOpenCustomer: (code: string) => void }) {
  const state = useApi(() => apiGet<any>("/api/crm/opportunities", { origin: "售後轉介", owner, pageSize: 20 }), [owner]);
  const notice = useNotice();
  return <Panel title="售後轉介" eyebrow="建立 → 接手 → 地端聯絡 → 預約／到店 → 成交或結案">
    {notice.element}
    <Async state={state}>{(d) => d.rows.length ? <table className="crm-table"><thead><tr><th>商機</th><th>客戶</th><th>來源廠／轉介人員</th><th>需求</th><th>接手人</th><th>處理期限</th><th>狀態</th><th>結果</th><th></th></tr></thead>
      <tbody>{d.rows.map((row: any) => <tr key={row.opp_code} className={row.overdue ? "is-overdue" : ""}><td><span className="crm-code is-static">{row.opp_code}</span></td><td><CodeLink code={row.customer_code} onOpen={onOpenCustomer} /></td><td>{row.referral_from_unit ?? "—"}<small className="crm-sub">{row.referral_by_staff ?? "—"}</small></td><td className="crm-wrap">{row.referral_need ?? row.need ?? "—"}</td><td>{row.owner_name ?? row.owner_staff_code ?? "未指派"}</td><td>{row.next_due_date ?? "—"}</td><td><StatusBadge status={row.handover_status} /> <StatusBadge status={row.stage} /></td><td>{row.won_txn_code ?? row.lost_reason ?? "—"}</td>
        <td>{row.handover_status === "待接手" && <button className="crm-btn" onClick={() => runAction(() => apiPost("/api/crm/opportunities", { action: "change", opp_code: row.opp_code, change: "accept" }), notice, "已接手").then(state.reload)}>接手</button>}</td></tr>)}</tbody></table> : <Empty label="沒有售後轉介" hint="服務廠可在工作台或客戶 360 建立「售後轉介」" />}</Async>
  </Panel>;
}

export { fmtNumber, Search, Field };
