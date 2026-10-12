"use client";
// API payloads from /api/crm/* are rendered as loosely typed records; the server is the source of truth for their shape.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { CalendarClock, CarFront, ClipboardList, Lightbulb, Plus, Search, Target, UsersRound } from "lucide-react";
import { apiGet, apiPost, fmtMoney, fmtNumber } from "./api";
import { Async, Badge, CodeLink, Drawer, Empty, Field, NotConnected, StatusBadge, runAction, useApi, useNotice } from "./ui";

type C360 = Record<string, any>;
const yesNo = (value: unknown) => (value === null || value === undefined ? "資料不足" : Number(value) ? "是" : "否");

export function CustomerLookup({ onOpen }: { onOpen: (code: string) => void }) {
  const [code, setCode] = useState("");
  return <form className="crm-lookup" onSubmit={(event) => { event.preventDefault(); if (code.trim()) onOpen(code.trim().toUpperCase()); }}>
    <Search /><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="輸入客戶編碼或車輛編碼（例：ES-00001）" aria-label="客戶或車輛編碼" />
    <button className="crm-btn crm-btn-primary" type="submit">查看客戶 360</button>
  </form>;
}

export function Customer360Drawer({ code, onClose, onOpenCustomer, onGoImport }: { code: string | null; onClose: () => void; onOpenCustomer: (code: string) => void; onGoImport?: () => void }) {
  return <Drawer open={Boolean(code)} title={<>客戶 360 <span className="crm-muted">｜{code}</span></>} onClose={onClose} wide>
    {code && <Customer360 code={code} onOpenCustomer={onOpenCustomer} onGoImport={onGoImport} />}
  </Drawer>;
}

function Section({ icon, title, meta, children }: { icon?: React.ReactNode; title: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return <section className="c360-section"><header>{icon}<h3>{title}</h3>{meta && <small>{meta}</small>}</header>{children}</section>;
}

export function Customer360({ code, onOpenCustomer, onGoImport }: { code: string; onOpenCustomer: (code: string) => void; onGoImport?: () => void }) {
  const state = useApi(() => apiGet<C360>("/api/crm/customers", { code }), [code]);
  const notice = useNotice();
  const [showAll, setShowAll] = useState(false);
  const [form, setForm] = useState<"opp" | "task" | null>(null);
  return <Async state={state}>{(d) => {
    const c = d.customer ?? {};
    const current = d.relations.filter((row: any) => !row.valid_to);
    const history = d.relations.filter((row: any) => row.valid_to);
    const txns = showAll ? d.transactions : d.transactions.slice(0, 12);
    return <div className="c360">
      {notice.element}
      <div className="c360-hero">
        <div><span className="crm-code is-static is-large">{c.customer_code}</span><p>{c.customer_type ?? "類型資料不足"}｜{c.county ?? "縣市資料不足"}{c.district ? ` ${c.district}` : ""}｜資料日期 {c.data_date ?? "—"}｜來源 {c.source_code ?? "—"}</p></div>
        <div className="c360-flags">
          <Badge tone={c.contact_eligible === 1 ? "good" : c.contact_eligible === 0 ? "bad" : "muted"}>可聯絡：{yesNo(c.contact_eligible)}</Badge>
          <Badge tone={c.opt_out ? "bad" : "default"}>拒收：{yesNo(c.opt_out)}</Badge>
          <Badge tone="info">管道：{[c.channel_phone ? "電話" : null, c.channel_sms ? "簡訊" : null, c.channel_email ? "Email" : null, c.channel_line ? "LINE" : null].filter(Boolean).join("、") || "資料不足"}</Badge>
          <Badge tone={c.complaint_open ? "bad" : "muted"}>客訴：{d.connected.complaints === "尚未串接" ? "尚未串接" : c.complaint_open ? "處理中" : "無"}</Badge>
          <Badge>授權：{c.consent_status ?? "資料不足"}</Badge>
        </div>
        <div className="c360-actions"><button className="crm-btn crm-btn-primary" onClick={() => setForm(form === "opp" ? null : "opp")}><Plus />建立商機</button><button className="crm-btn" onClick={() => setForm(form === "task" ? null : "task")}><CalendarClock />安排任務</button></div>
      </div>
      {form === "opp" && <OppQuickForm customer={c.customer_code} vehicles={current.map((row: any) => row.vehicle_code)} onDone={(text) => { setForm(null); notice.show("good", text); state.reload(); }} onError={(text) => notice.show("bad", text)} />}
      {form === "task" && <TaskQuickForm customer={c.customer_code} vehicles={current.map((row: any) => row.vehicle_code)} onDone={(text) => { setForm(null); notice.show("good", text); state.reload(); }} onError={(text) => notice.show("bad", text)} />}

      <Section icon={<Lightbulb />} title="下一步建議" meta="規則建議（非 AI 預測）：含判斷依據、待確認資訊、負責人與期限">
        {d.suggestions.length ? <div className="c360-suggestions">{d.suggestions.map((item: any, index: number) => <article key={index}><strong>{item.action}</strong><dl><div><dt>判斷依據</dt><dd>{item.basis}</dd></div><div><dt>待確認</dt><dd>{item.to_confirm}</dd></div><div><dt>負責人</dt><dd>{item.owner}</dd></div><div><dt>期限</dt><dd>{item.due_in_days} 天內</dd></div><div><dt>車輛</dt><dd>{item.vehicle_code ?? "—"}</dd></div></dl></article>)}</div> : <Empty label="目前沒有觸發的建議" />}
      </Section>

      <div className="c360-grid">
        <Section icon={<Target />} title="評分" meta={`可解釋規則｜版本與更新日期見各分數`}>
          <div className="c360-scores">{d.scores.map((score: any) => <ScoreCard key={score.key} score={score} customer={c.customer_code} onSaved={() => state.reload()} />)}</div>
        </Section>
        <Section icon={<ClipboardList />} title="客群標籤與生命週期" meta={`分析基準日 ${d.asOf}`}>
          <div className="c360-tags">{d.tags.length ? d.tags.map((tag: any) => <Badge key={tag.segment_code} tone="info">{tag.name}</Badge>) : <span className="crm-muted">未落入任何客群</span>}</div>
          <ul className="c360-lifecycle">{d.lifecycle.map((item: any, index: number) => <li key={index}><Badge>{item.stage}</Badge><span>{item.vehicle_code ?? "—"}</span><small>{item.basis}</small></li>)}</ul>
        </Section>
      </div>

      <Section icon={<UsersRound />} title="家庭／企業與人車關係" meta="現行關係與歷史關係分開；轉手前的紀錄不計入此客戶">
        {d.connected.groups === "尚未串接" ? <NotConnected what="家庭／企業關係" template="家庭／企業成員" onImport={onGoImport} /> : d.groups.length ? <div className="c360-tags">{d.groups.map((group: any) => <Badge key={group.group_code} tone="info">{group.group_type} {group.group_code}（{group.members} 人）</Badge>)}</div> : <span className="crm-muted">不屬於任何家庭／企業群組</span>}
        <table className="crm-table"><thead><tr><th>車輛編碼</th><th>關係</th><th>期間</th><th>車型</th><th>領牌</th><th>最新里程（依據／日期）</th><th>保固到期</th><th>保險到期</th><th>服務據點</th><th>最後進廠</th></tr></thead>
          <tbody>{current.map((row: any) => <tr key={`${row.vehicle_code}${row.relation}${row.valid_from}`}><td><CodeLink code={row.vehicle_code} /></td><td>{row.relation}</td><td>{row.valid_from || "（起日資料不足）"} 起</td><td>{row.model_series ?? "—"}<small className="crm-sub">{row.model_code}</small></td><td>{row.registration_date ?? "資料不足"}</td><td>{row.latest_mileage === null ? "資料不足" : `${fmtNumber(row.latest_mileage)} km`}<small className="crm-sub">{row.mileage_basis ?? "—"}｜{row.mileage_date ?? "—"}</small></td><td>{row.warranty_expiry ?? "資料不足"}{row.extended_warranty_expiry && <small className="crm-sub">延保 {row.extended_warranty_expiry}</small>}</td><td>{row.insurance_expiry ?? "資料不足"}</td><td>{row.unit_name ?? row.service_unit_code ?? "—"}</td><td>{row.last_visit_date ?? "資料不足"}</td></tr>)}</tbody></table>
        {history.length > 0 && <><h4 className="c360-sub">歷史關係（已結束）</h4><table className="crm-table"><tbody>{history.map((row: any) => <tr key={`${row.vehicle_code}${row.relation}${row.valid_from}`}><td><CodeLink code={row.vehicle_code} /></td><td>{row.relation}</td><td>{row.valid_from || "—"} ～ {row.valid_to}</td></tr>)}</tbody></table></>}
        {d.coHolders.length > 0 && <><h4 className="c360-sub">同車其他關係人</h4><div className="c360-tags">{d.coHolders.map((row: any) => <button key={`${row.vehicle_code}${row.customer_code}${row.relation}${row.valid_from}`} className="crm-chip" onClick={() => onOpenCustomer(row.customer_code)}>{row.vehicle_code}｜{row.relation} {row.customer_code}{row.valid_to ? `（至 ${row.valid_to}）` : ""}</button>)}</div></>}
        <h4 className="c360-sub">負責人員</h4>
        <div className="c360-tags">{d.staff.filter((row: any) => !row.valid_to).map((row: any) => <Badge key={`${row.vehicle_code}${row.staff_role}${row.staff_code}`}>{row.vehicle_code}｜{{ sales: "業代", advisor: "服專", technician: "技師" }[row.staff_role as string]} {row.display_name ?? row.staff_code}<small>（{row.staff_code}{row.code_status !== "正式" ? "・暫用編碼" : ""}）</small></Badge>)}</div>
      </Section>

      <Section icon={<CarFront />} title="保養、維修與消費" meta={`交易 ${fmtNumber(d.txnSummary?.n)} 筆｜${d.txnSummary?.first_date ?? "—"} ～ ${d.txnSummary?.last_date ?? "—"}`}>
        <div className="c360-kpis"><div><span>累計金額</span><strong>{fmtMoney(d.txnSummary?.amount)}</strong></div><div><span>可取得毛利</span><strong>{d.txnSummary?.with_margin ? fmtMoney(d.txnSummary?.margin) : "資料不足"}</strong><small>{d.connected.margin}</small></div><div><span>最後互動</span><strong>{d.lastInteraction ?? "資料不足"}</strong></div></div>
        {d.transactions.length ? <table className="crm-table"><thead><tr><th>交易編碼</th><th>類型</th><th>車輛</th><th>日期</th><th>據點</th><th>金額</th><th>毛利</th><th>里程</th><th>來源</th></tr></thead>
          <tbody>{txns.map((row: any) => <tr key={row.txn_code}><td><span className="crm-code is-static">{row.txn_code}</span></td><td>{row.txn_type ?? "—"}</td><td>{row.vehicle_code}</td><td>{row.txn_date}</td><td>{row.unit_name ?? row.unit_code ?? "—"}</td><td>{fmtMoney(row.amount)}</td><td>{row.margin === null ? "資料不足" : fmtMoney(row.margin)}</td><td>{row.mileage === null ? "—" : fmtNumber(row.mileage)}</td><td><small>{row.sources}｜{row.data_date}</small></td></tr>)}</tbody></table> : <Empty label="平台內尚無此客戶的交易" />}
        {d.transactions.length > 12 && <button className="crm-link" onClick={() => setShowAll(!showAll)}>{showAll ? "收合" : `顯示全部 ${d.transactions.length} 筆`}</button>}
      </Section>

      <div className="c360-grid">
        <Section title="購車、試乘、報價與成交歷程">
          {d.connected.purchases === "尚未串接" && <NotConnected what="購車交易" template="交易（類型＝購車）" onImport={onGoImport} />}
          {d.connected.interactions === "尚未串接" && <NotConnected what="試乘／報價紀錄" template="互動（試乘、報價）" onImport={onGoImport} />}
          {d.opportunities.length ? <ul className="c360-list">{d.opportunities.map((opp: any) => <li key={opp.opp_code}><span className="crm-code is-static">{opp.opp_code}</span><Badge>{opp.opp_type}</Badge><StatusBadge status={opp.stage} /><small>{opp.origin}｜負責 {opp.owner_name ?? opp.owner_staff_code ?? "未指派"}｜{opp.won_txn_code ? `成交 ${opp.won_txn_code} ${fmtMoney(opp.won_amount)}` : opp.lost_reason ? `未成交：${opp.lost_reason}` : `下一步 ${opp.next_step ?? "—"} ${opp.next_due_date ?? ""}`}</small></li>)}</ul> : <span className="crm-muted">尚無商機</span>}
        </Section>
        <Section title="客訴、滿意度與待辦">
          {d.connected.complaints === "尚未串接" && <NotConnected what="客訴紀錄" template="互動（類型＝客訴）或客戶「客訴處理中」欄" onImport={onGoImport} />}
          {d.connected.satisfaction === "尚未串接" ? <NotConnected what="滿意度問卷" template="滿意度問卷" onImport={onGoImport} /> : d.surveys.length ? <ul className="c360-list">{d.surveys.map((survey: any) => <li key={survey.survey_code}><Badge tone={(survey.score_overall ?? 5) < 4 ? "bad" : "good"}>整體 {survey.score_overall ?? "—"}</Badge><span>{survey.service_date}｜{survey.unit_name ?? survey.unit_code ?? "—"}｜{survey.service_category}</span>{survey.voc_text && <small>「{survey.voc_text}」（{survey.voc_category}）</small>}</li>)}</ul> : <span className="crm-muted">此客戶沒有問卷紀錄</span>}
          <h4 className="c360-sub">待辦任務</h4>
          {d.tasks.filter((task: any) => !["已完成", "已取消"].includes(task.status)).length ? <ul className="c360-list">{d.tasks.filter((task: any) => !["已完成", "已取消"].includes(task.status)).map((task: any) => <li key={task.task_code}><span className="crm-code is-static">{task.task_code}</span><StatusBadge status={task.status} /><span>{task.task_type}｜期限 {task.due_date}</span><small>{task.recommended_action}｜負責 {task.owner_name ?? task.owner_staff_code ?? task.owner_unit_code ?? "未指派"}</small></li>)}</ul> : <span className="crm-muted">沒有未完成任務</span>}
        </Section>
      </div>

      <Section title="互動時間軸" meta="包含地端回傳的執行結果">
        {d.interactions.length ? <ol className="c360-timeline">{d.interactions.map((row: any) => <li key={row.interaction_code}><time>{row.occurred_at}</time><Badge>{row.interaction_type}</Badge><span>{row.outcome ?? "—"}</span><small>{row.detail}｜{row.channel ?? "—"}｜{row.task_code ?? ""}{row.source_code === "RESULT" ? "｜地端回傳" : `｜${row.source_code}`}</small></li>)}</ol> : d.connected.interactions === "尚未串接" ? <NotConnected what="互動紀錄" template="互動" onImport={onGoImport} /> : <Empty label="尚無互動紀錄" />}
      </Section>
    </div>;
  }}</Async>;
}

function ScoreCard({ score, customer, onSaved }: { score: any; customer: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(score.override?.override_level ?? "");
  const [note, setNote] = useState(score.override?.note ?? "");
  const notice = useNotice();
  return <article className="c360-score">
    <header><strong>{score.label}</strong><Badge tone={score.level === "資料不足" ? "muted" : ["高", "強線索", "熱"].includes(score.level) ? "warn" : "default"}>{score.override ? `${score.override.override_level}（人工）` : score.level}</Badge></header>
    <p>{score.score === null ? "資料不足，不輸出分數" : `${score.score} 分`}<small>｜{score.version}・{score.updated}{score.vehicle_code ? `・依 ${score.vehicle_code}` : ""}</small></p>
    <ul>{score.reasons.map((reason: any) => <li key={reason.label} className={reason.hit ? "is-hit" : ""}><span>{reason.hit ? "✓" : "·"} {reason.label}</span><b>+{reason.points}</b><small>{reason.basis}</small></li>)}</ul>
    {score.caveat && <small className="crm-muted">{score.caveat}</small>}
    <button className="crm-link" onClick={() => setOpen(!open)}>人工修正／回饋</button>
    {open && <div className="c360-override">{notice.element}<select value={level} onChange={(event) => setLevel(event.target.value)}><option value="">（移除修正）</option>{["高", "中", "低", "強線索", "一般線索", "無明顯線索", "熱", "溫", "冷"].map((item) => <option key={item}>{item}</option>)}</select><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="修正原因（必填）" /><button className="crm-btn" onClick={() => { if (level && !note.trim()) { notice.show("bad", "請填寫修正原因"); return; } void runAction(() => apiPost("/api/crm/customers", { action: "override_score", customer_code: customer, score_type: score.key, level, note }), notice, "已儲存並記錄").then((ok) => ok && onSaved()); }}>儲存</button></div>}
  </article>;
}

export function OppQuickForm({ customer, vehicles, onDone, onError, referral }: { customer: string; vehicles: string[]; onDone: (text: string) => void; onError: (text: string) => void; referral?: boolean }) {
  const [input, setInput] = useState({ opp_type: referral ? "換購" : "售後服務", vehicle_code: vehicles[0] ?? "", need: "", product: "", budget_band: "", expected_decision_date: "", next_step: "", next_due_date: "", owner_staff_code: "", owner_unit_code: "" });
  const set = (key: string, value: string) => setInput((current) => ({ ...current, [key]: value }));
  return <form className="crm-form" onSubmit={async (event) => {
    event.preventDefault();
    try { const result = await apiPost<{ opp_code: string }>("/api/crm/opportunities", { action: "create", customer_code: customer, origin: referral ? "售後轉介" : "手動", referral_need: referral ? input.need : undefined, ...input }); onDone(`已建立商機 ${result.opp_code}`); } catch (error) { onError(error instanceof Error ? error.message : "建立失敗"); }
  }}>
    <Field label="商機類型"><select value={input.opp_type} onChange={(event) => set("opp_type", event.target.value)}>{["新車", "換購", "增購", "保險", "售後服務"].map((item) => <option key={item}>{item}</option>)}</select></Field>
    <Field label="相關車輛"><select value={input.vehicle_code} onChange={(event) => set("vehicle_code", event.target.value)}><option value="">（不指定）</option>{vehicles.map((item) => <option key={item}>{item}</option>)}</select></Field>
    <Field label={referral ? "轉介需求" : "需求"}><input value={input.need} onChange={(event) => set("need", event.target.value)} required /></Field>
    <Field label="意向產品"><input value={input.product} onChange={(event) => set("product", event.target.value)} /></Field>
    <Field label="預算區間"><input value={input.budget_band} onChange={(event) => set("budget_band", event.target.value)} placeholder="例：80–100 萬" /></Field>
    <Field label="預計決策日"><input type="date" value={input.expected_decision_date} onChange={(event) => set("expected_decision_date", event.target.value)} /></Field>
    <Field label="下一步"><input value={input.next_step} onChange={(event) => set("next_step", event.target.value)} /></Field>
    <Field label="下一步期限"><input type="date" value={input.next_due_date} onChange={(event) => set("next_due_date", event.target.value)} /></Field>
    <Field label={referral ? "接手業代編碼（必填其一）" : "負責人員編碼（空白＝自己）"}><StaffPicker role={referral ? "sales" : undefined} value={input.owner_staff_code} onChange={(value) => set("owner_staff_code", value)} /></Field>
    <Field label="負責單位編碼"><input value={input.owner_unit_code} onChange={(event) => set("owner_unit_code", event.target.value)} placeholder="空白＝自己的單位" /></Field>
    <div className="crm-form-actions"><button className="crm-btn crm-btn-primary" type="submit">{referral ? "建立轉介" : "建立商機"}</button></div>
  </form>;
}

export function TaskQuickForm({ customer, vehicles, opp, onDone, onError }: { customer: string; vehicles: string[]; opp?: string; onDone: (text: string) => void; onError: (text: string) => void }) {
  const [input, setInput] = useState({ task_type: "人工追蹤", action_text: "", vehicle_code: vehicles[0] ?? "", due_days: "3", priority: "2", owner_staff_code: "" });
  const set = (key: string, value: string) => setInput((current) => ({ ...current, [key]: value }));
  return <form className="crm-form" onSubmit={async (event) => {
    event.preventDefault();
    try { const result = await apiPost<{ task_code: string }>("/api/crm/tasks", { action: "create", customer_code: customer, opp_code: opp, ...input }); onDone(`已建立任務 ${result.task_code}（待匯出）`); } catch (error) { onError(error instanceof Error ? error.message : "建立失敗"); }
  }}>
    <Field label="任務類型"><input value={input.task_type} onChange={(event) => set("task_type", event.target.value)} required /></Field>
    <Field label="建議行動"><input value={input.action_text} onChange={(event) => set("action_text", event.target.value)} required placeholder="例：電話確認換車時程" /></Field>
    <Field label="車輛"><select value={input.vehicle_code} onChange={(event) => set("vehicle_code", event.target.value)}><option value="">（不指定）</option>{vehicles.map((item) => <option key={item}>{item}</option>)}</select></Field>
    <Field label="期限（天）"><input type="number" min={0} value={input.due_days} onChange={(event) => set("due_days", event.target.value)} /></Field>
    <Field label="優先順序"><select value={input.priority} onChange={(event) => set("priority", event.target.value)}><option value="1">1 最高</option><option value="2">2</option><option value="3">3</option></select></Field>
    <Field label="負責人員編碼（空白＝自己）"><StaffPicker value={input.owner_staff_code} onChange={(value) => set("owner_staff_code", value)} /></Field>
    <div className="crm-form-actions"><button className="crm-btn crm-btn-primary" type="submit">建立任務</button></div>
  </form>;
}

/** Server-side staff search (3,000+ 業代) returning the staff code. */
export function StaffPicker({ value, onChange, role }: { value: string; onChange: (value: string) => void; role?: string }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<{ staff_code: string; display_name: string; staff_role: string }[]>([]);
  return <div className="crm-staff-picker">
    <input value={value} onChange={(event) => onChange(event.target.value.trim())} placeholder="人員編碼" />
    <input value={query} onChange={async (event) => { setQuery(event.target.value); if (event.target.value.trim().length >= 1) setOptions((await apiGet<{ staff: typeof options }>("/api/crm/directory", { q: event.target.value.trim(), role })).staff); else setOptions([]); }} placeholder="或輸入姓名搜尋" />
    {options.length > 0 && <ul>{options.map((option) => <li key={option.staff_code}><button type="button" onClick={() => { onChange(option.staff_code); setQuery(option.display_name); setOptions([]); }}>{option.display_name}<small>{option.staff_code}・{{ sales: "業代", advisor: "服專", technician: "技師" }[option.staff_role]}</small></button></li>)}</ul>}
  </div>;
}
