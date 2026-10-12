"use client";
// API payloads from /api/crm/* are rendered as loosely typed records; the server is the source of truth for their shape.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { Download, FolderPlus, ListChecks, Play, Plus, Save, Trash2 } from "lucide-react";
import { apiGet, apiPost, download, fmtNumber } from "./api";
import { Async, Badge, CodeLink, Empty, ErrorState, Field, Loading, NotConnected, Pager, Panel, Stat, runAction, useApi, useNotice } from "./ui";

type Condition = { field: string; op: string; value?: unknown; value2?: unknown };
type Group = { op: "AND" | "OR"; not?: boolean; items: (Condition | Group)[] };
type FieldDef = { key: string; label: string; group: string; type: "number" | "text" | "bool" | "enum"; unit?: string; options?: string[]; source?: string };
type Segment = { segment_code: string; name: string; description: string; definition: Group; is_preset: number; version: number; readable: string };
const isGroup = (item: Condition | Group): item is Group => "items" in item;

const opsByType: Record<string, [string, string][]> = {
  number: [["gte", "≥"], ["lte", "≤"], ["between", "介於"], ["eq", "等於"], ["is_null", "資料不足"], ["not_null", "有資料"]],
  text: [["eq", "等於"], ["neq", "不等於"], ["in", "屬於（逗號分隔）"], ["not_in", "不屬於"], ["contains", "包含"], ["is_null", "資料不足"], ["not_null", "有資料"]],
  enum: [["eq", "等於"], ["neq", "不等於"], ["in", "屬於"], ["not_in", "不屬於"], ["is_null", "資料不足"]],
  bool: [["eq", "等於"], ["is_null", "資料不足"]],
};

function ConditionRow({ item, fields, onChange, onRemove }: { item: Condition; fields: FieldDef[]; onChange: (item: Condition) => void; onRemove: () => void }) {
  const field = fields.find((def) => def.key === item.field) ?? fields[0];
  const ops = opsByType[field.type];
  const groups = [...new Set(fields.map((def) => def.group))];
  return <div className="seg-cond">
    <select value={item.field} onChange={(event) => { const next = fields.find((def) => def.key === event.target.value)!; onChange({ field: next.key, op: opsByType[next.type][0][0], value: next.type === "bool" ? 1 : "" }); }} aria-label="欄位">
      {groups.map((group) => <optgroup key={group} label={group}>{fields.filter((def) => def.group === group).map((def) => <option key={def.key} value={def.key}>{def.label}{def.unit ? `（${def.unit}）` : ""}</option>)}</optgroup>)}
    </select>
    <select value={item.op} onChange={(event) => onChange({ ...item, op: event.target.value })} aria-label="條件">{ops.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
    {!["is_null", "not_null"].includes(item.op) && (field.type === "bool"
      ? <select value={String(item.value ?? 1)} onChange={(event) => onChange({ ...item, value: Number(event.target.value) })}><option value="1">是</option><option value="0">否</option></select>
      : field.type === "enum" && (item.op === "eq" || item.op === "neq")
        ? <select value={String(item.value ?? "")} onChange={(event) => onChange({ ...item, value: event.target.value })}><option value="">選擇</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select>
        : <input value={Array.isArray(item.value) ? item.value.join(",") : String(item.value ?? "")} onChange={(event) => onChange({ ...item, value: event.target.value })} placeholder={item.op === "between" ? "下限" : "值"} />)}
    {item.op === "between" && <input value={String(item.value2 ?? "")} onChange={(event) => onChange({ ...item, value2: event.target.value })} placeholder="上限" />}
    {field.source && <Badge tone="muted">需 {field.source}</Badge>}
    <button className="crm-icon-btn" onClick={onRemove} aria-label="移除條件"><Trash2 /></button>
  </div>;
}

function GroupEditor({ group, fields, onChange, onRemove, depth = 0 }: { group: Group; fields: FieldDef[]; onChange: (group: Group) => void; onRemove?: () => void; depth?: number }) {
  const update = (index: number, item: Condition | Group) => onChange({ ...group, items: group.items.map((current, i) => (i === index ? item : current)) });
  const remove = (index: number) => onChange({ ...group, items: group.items.filter((_, i) => i !== index) });
  return <div className={`seg-group depth-${depth}`}>
    <div className="seg-group-head">
      <div className="seg-toggle" role="radiogroup" aria-label="條件組合方式">{(["AND", "OR"] as const).map((op) => <button key={op} className={group.op === op ? "active" : ""} onClick={() => onChange({ ...group, op })}>{op === "AND" ? "全部符合 AND" : "任一符合 OR"}</button>)}</div>
      <label className="crm-check"><input type="checkbox" checked={Boolean(group.not)} onChange={(event) => onChange({ ...group, not: event.target.checked })} />排除此群組（NOT）</label>
      {onRemove && <button className="crm-icon-btn" onClick={onRemove} aria-label="移除群組"><Trash2 /></button>}
    </div>
    {group.items.map((item, index) => isGroup(item)
      ? <GroupEditor key={index} group={item} fields={fields} depth={depth + 1} onChange={(next) => update(index, next)} onRemove={() => remove(index)} />
      : <ConditionRow key={index} item={item} fields={fields} onChange={(next) => update(index, next)} onRemove={() => remove(index)} />)}
    <div className="seg-group-add"><button className="crm-btn" onClick={() => onChange({ ...group, items: [...group.items, { field: fields[0].key, op: opsByType[fields[0].type][0][0], value: "" }] })}><Plus />條件</button>{depth < 2 && <button className="crm-btn" onClick={() => onChange({ ...group, items: [...group.items, { op: group.op === "AND" ? "OR" : "AND", items: [] }] })}><FolderPlus />條件群組</button>}</div>
  </div>;
}

export function SegmentsView({ onOpenCustomer, onGoImport, canManage }: { onOpenCustomer: (code: string) => void; onGoImport: () => void; canManage: boolean }) {
  const meta = useApi(() => apiGet<{ segments: Segment[]; fields: FieldDef[]; campaigns: any[] }>("/api/crm/segments"), []);
  const [selected, setSelected] = useState<Segment | null>(null);
  const [draft, setDraft] = useState<Group>({ op: "AND", items: [] });
  const [result, setResult] = useState<any>(null);
  const [membersPage, setMembersPage] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [name, setName] = useState("");
  const [action, setAction] = useState<"save" | "campaign" | "tasks" | null>(null);
  const [taskInput, setTaskInput] = useState({ task_type: "", action_text: "", owner_role: "advisor", due_days: "7", priority: "2" });
  const [campaignInput, setCampaignInput] = useState({ name: "", cost: "", start_date: "", end_date: "" });
  const notice = useNotice();

  const payload = () => (selected && JSON.stringify(selected.definition) === JSON.stringify(draft) ? { segment_code: selected.segment_code } : { definition: draft });
  async function evaluate(page = 1) {
    setBusy(true); setError(null);
    try {
      const [summary, list] = await Promise.all([page === 1 ? apiPost("/api/crm/segments", { action: "evaluate", ...payload() }) : Promise.resolve(result), apiPost("/api/crm/segments", { action: "members", ...payload(), page, pageSize: 20 })]);
      setResult(summary); setMembersPage(list);
    } catch (err) { setError(err as Error); } finally { setBusy(false); }
  }
  function pick(segment: Segment) { setSelected(segment); setDraft(structuredClone(segment.definition)); setName(segment.name); setResult(null); setMembersPage(null); }

  return <Async state={meta}>{(data) => <div className="seg-layout">
    <Panel title="客群" eyebrow="動態客群（隨資料更新）" className="seg-list">
      <button className="crm-btn crm-btn-primary seg-new" onClick={() => { setSelected(null); setDraft({ op: "AND", items: [] }); setName(""); setResult(null); setMembersPage(null); }}><Plus />新增客群</button>
      <ul>{data.segments.map((segment) => <li key={segment.segment_code}><button className={selected?.segment_code === segment.segment_code ? "active" : ""} onClick={() => pick(segment)}><strong>{segment.name}</strong><small>{segment.is_preset ? "預設" : "自訂"}・v{segment.version}・{segment.segment_code}</small><span>{segment.readable}</span></button></li>)}</ul>
      <h3 className="seg-sub">活動名單快照</h3>
      {data.campaigns.length ? <ul className="seg-campaigns">{data.campaigns.map((campaign: any) => <li key={campaign.campaign_code}><strong>{campaign.name}</strong><small>{campaign.campaign_code}｜{campaign.snapshot_at.slice(0, 10)} 快照｜入選 {fmtNumber(campaign.included)}・排除 {fmtNumber(campaign.excluded)}・任務 {fmtNumber(campaign.tasks)}</small></li>)}</ul> : <span className="crm-muted">尚未建立活動</span>}
    </Panel>
    <div className="seg-main">
      <Panel title={selected ? selected.name : "自訂客群"} eyebrow={selected?.description || "條件可巢狀組合；客戶與車輛分開統計"} actions={<button className="crm-btn crm-btn-primary" disabled={busy || !draft.items.length} onClick={() => evaluate(1)}><Play />試算</button>}>
        <GroupEditor group={draft} fields={data.fields} onChange={setDraft} />
      </Panel>
      {notice.element}
      {error && <ErrorState error={error} onRetry={() => evaluate(1)} />}
      {busy && !result && <Loading label="計算中…" />}
      {result && <Panel title="試算結果" eyebrow={`分析基準日 ${result.asOf}｜${result.description}`} actions={<>
        <button className="crm-btn" onClick={() => download("/api/crm/segments", { view: "export", ...(payload().segment_code ? { segment: payload().segment_code! } : { definition: JSON.stringify(draft) }) })}><Download />下載名單</button>
        {canManage && <><button className="crm-btn" onClick={() => setAction(action === "save" ? null : "save")}><Save />儲存客群</button><button className="crm-btn" onClick={() => setAction(action === "campaign" ? null : "campaign")}><ListChecks />建立活動快照</button><button className="crm-btn crm-btn-primary" onClick={() => setAction(action === "tasks" ? null : "tasks")}><Plus />建立任務</button></>}
      </>}>
        {result.notConnected?.length > 0 && result.notConnected.map((source: string) => <NotConnected key={source} what={source} onImport={onGoImport} />)}
        <div className="crm-stats">
          <Stat label="客戶數" value={fmtNumber(result.customers)} />
          <Stat label="車輛數" value={fmtNumber(result.vehicles)} />
          <Stat label="可執行人數" value={fmtNumber(result.actionable)} tone="good" sub="可聯絡、未拒收、非客訴處理中" />
          <Stat label="排除人數" value={fmtNumber(result.excluded)} tone={result.excluded ? "warn" : "default"} />
        </div>
        {result.exclusions.length > 0 && <ul className="seg-exclusions">{result.exclusions.map((row: any) => <li key={row.reason}><span>{row.reason}</span><b>{fmtNumber(row.customers)} 人</b></li>)}</ul>}
        {action === "save" && <form className="crm-form" onSubmit={(event) => { event.preventDefault(); void runAction(() => apiPost<{ segment_code: string }>("/api/crm/segments", { action: "save", segment_code: selected && !selected.is_preset ? selected.segment_code : selected?.is_preset ? selected.segment_code : undefined, name, definition: draft }), notice, (r) => `已儲存客群 ${r.segment_code}`).then(() => { setAction(null); meta.reload(); }); }}>
          <Field label="客群名稱"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field><div className="crm-form-actions"><button className="crm-btn crm-btn-primary">{selected ? "儲存（版本 +1）" : "建立客群"}</button></div></form>}
        {action === "campaign" && <form className="crm-form" onSubmit={(event) => { event.preventDefault(); void runAction(() => apiPost("/api/crm/segments", { action: "campaign", ...payload(), ...campaignInput, cost: campaignInput.cost === "" ? null : Number(campaignInput.cost) }), notice, (r: any) => `已建立活動 ${r.campaign_code}：入選 ${r.included}、排除 ${r.excluded}（${r.asOf} 快照，之後不隨客群變動）`).then(() => { setAction(null); meta.reload(); }); }}>
          <Field label="活動名稱"><input value={campaignInput.name} onChange={(event) => setCampaignInput({ ...campaignInput, name: event.target.value })} required /></Field>
          <Field label="活動成本（元）" hint="空白＝資料不足"><input type="number" value={campaignInput.cost} onChange={(event) => setCampaignInput({ ...campaignInput, cost: event.target.value })} /></Field>
          <Field label="開始日"><input type="date" value={campaignInput.start_date} onChange={(event) => setCampaignInput({ ...campaignInput, start_date: event.target.value })} /></Field>
          <Field label="結束日"><input type="date" value={campaignInput.end_date} onChange={(event) => setCampaignInput({ ...campaignInput, end_date: event.target.value })} /></Field>
          <div className="crm-form-actions"><button className="crm-btn crm-btn-primary">建立快照</button></div></form>}
        {action === "tasks" && <form className="crm-form" onSubmit={(event) => { event.preventDefault(); void runAction(() => apiPost("/api/crm/segments", { ...payload(), ...taskInput, action: "tasks", due_days: Number(taskInput.due_days), priority: Number(taskInput.priority) }), notice, (r: any) => `已建立 ${r.created} 筆任務（重複略過 ${r.duplicates}、排除 ${r.excluded}、未指派負責人 ${r.unassigned}）`).then(() => setAction(null)); }}>
          <Field label="任務類型"><input value={taskInput.task_type} onChange={(event) => setTaskInput({ ...taskInput, task_type: event.target.value })} required placeholder="例：保養提醒" /></Field>
          <Field label="建議行動"><input value={taskInput.action_text} onChange={(event) => setTaskInput({ ...taskInput, action_text: event.target.value })} required /></Field>
          <Field label="負責人"><select value={taskInput.owner_role} onChange={(event) => setTaskInput({ ...taskInput, owner_role: event.target.value })}><option value="advisor">車輛的服專</option><option value="sales">車輛的業代</option><option value="unit">據點（待主管分派）</option></select></Field>
          <Field label="期限（天）"><input type="number" min={0} value={taskInput.due_days} onChange={(event) => setTaskInput({ ...taskInput, due_days: event.target.value })} /></Field>
          <Field label="優先順序"><select value={taskInput.priority} onChange={(event) => setTaskInput({ ...taskInput, priority: event.target.value })}><option value="1">1 最高</option><option value="2">2</option><option value="3">3</option></select></Field>
          <div className="crm-form-actions"><button className="crm-btn crm-btn-primary">建立任務（只含可執行名單）</button></div></form>}
      </Panel>}
      {membersPage && <Panel title="名單" eyebrow="客戶編碼與車輛編碼；點客戶編碼查看 360">
        {membersPage.rows.length ? <table className="crm-table"><thead><tr><th>客戶編碼</th><th>車輛編碼</th><th>車型</th><th>據點</th><th>業代／服專</th><th>未回廠</th><th>保固</th>{membersPage.fields.map((key: string) => <th key={key}>{data.fields.find((def) => def.key === key)?.label ?? key}</th>)}<th>價值／流失</th><th>排除原因</th></tr></thead>
          <tbody>{membersPage.rows.map((row: any) => <tr key={`${row.customer_code}${row.vehicle_code}`}><td><CodeLink code={row.customer_code} onOpen={onOpenCustomer} /></td><td>{row.vehicle_code ?? "—"}</td><td>{row.model_series ?? "—"}</td><td>{row.service_unit_code ?? "—"}</td><td><small>{row.sales_code ?? "—"}<br />{row.advisor_code ?? "—"}</small></td><td>{row.last_visit_days ?? "資料不足"}</td><td>{row.warranty_state}</td>{membersPage.fields.map((key: string) => <td key={key}>{row[`f_${key}`] ?? "資料不足"}</td>)}<td><small>{row.value_score_level}／{row.churn_score_level}</small></td><td>{row.exclusion_reason ? <Badge tone="warn">{row.exclusion_reason}</Badge> : <Badge tone="good">可執行</Badge>}</td></tr>)}</tbody></table> : <Empty label="沒有符合條件的客戶" />}
        <Pager page={membersPage.page} pageSize={membersPage.pageSize} total={membersPage.total} onPage={(page) => evaluate(page)} />
      </Panel>}
    </div>
  </div>}</Async>;
}
