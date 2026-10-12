"use client";
// API payloads from /api/crm/* are rendered as loosely typed records; the server is the source of truth for their shape.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { CheckCircle2, Download, FileUp, Play, Power, Save, UserCog } from "lucide-react";
import { apiGet, apiPost, download, fileHash, fmtNumber, readSheet } from "./api";
import { StaffPicker } from "./customer-360";
import { Async, Badge, Empty, Field, Panel, Stat, runAction, useApi, useNotice } from "./ui";

type Spec = { entity: string; label: string; order: number; kind: string; note: string; keys: string[]; fields: { key: string; label: string; type: string; required?: boolean }[] };
type Overview = { specs: Spec[]; sources: any[]; batches: any[]; results: any[] };
const tabs = ["資料匯入", "匯入紀錄", "資料來源", "自動化", "使用者與權限", "系統設定", "稽核紀錄"] as const;

export function AdminView({ session, onSessionChange }: { session: any; onSessionChange: () => void }) {
  const [tab, setTab] = useState<(typeof tabs)[number]>("資料匯入");
  const overview = useApi(() => apiGet<Overview>("/api/crm/import"), []);
  const isCompany = session.actor.realRole === "company_manager";
  return <div className="crm-stack">
    <div className="crm-tabs" role="tablist">{tabs.filter((item) => isCompany || ["匯入紀錄", "資料來源", "自動化"].includes(item)).map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
    {tab === "資料匯入" && isCompany && <Async state={overview}>{(d) => <ImportWizard overview={d} onDone={overview.reload} />}</Async>}
    {tab === "匯入紀錄" && <Async state={overview}>{(d) => <BatchHistory overview={d} />}</Async>}
    {tab === "資料來源" && <Async state={overview}>{(d) => <Sources overview={d} canEdit={isCompany} onChanged={overview.reload} />}</Async>}
    {tab === "自動化" && <Automation />}
    {tab === "使用者與權限" && isCompany && <Users session={session} onChanged={onSessionChange} />}
    {tab === "系統設定" && isCompany && <Settings session={session} onChanged={onSessionChange} />}
    {tab === "稽核紀錄" && isCompany && <Panel title="稽核紀錄" eyebrow="分派、匯出、回傳、匯入與設定變更">{session.audit?.length ? <table className="crm-table"><thead><tr><th>時間</th><th>操作人</th><th>代理</th><th>動作</th><th>對象</th><th>內容</th></tr></thead><tbody>{session.audit.map((row: any) => <tr key={row.audit_id}><td><small>{row.at.slice(0, 19).replace("T", " ")}</small></td><td>{row.actor}</td><td>{row.acting_as ?? "—"}</td><td>{row.action}</td><td>{row.entity} {row.entity_code ?? ""}</td><td className="crm-wrap"><small>{row.detail}</small></td></tr>)}</tbody></table> : <Empty />}</Panel>}
  </div>;
}

function ImportWizard({ overview, onDone }: { overview: Overview; onDone: () => void }) {
  const specs = [...overview.specs].sort((a, b) => a.order - b.order);
  const [entity, setEntity] = useState(specs[0].entity);
  const spec = specs.find((item) => item.entity === entity)!;
  const sources = overview.sources.filter((source) => source.entity === entity);
  const [source, setSource] = useState("");
  const [dataDate, setDataDate] = useState(new Date().toISOString().slice(0, 10));
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<{ header: string[]; rows: string[][] } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState("");
  const [batch, setBatch] = useState<{ code: string; duplicate: any } | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const notice = useNotice();
  const chosenSource = source || sources[0]?.source_code || "";
  const missingRequired = spec.fields.filter((field) => field.required && !Object.values(mapping).includes(field.key));

  async function choose(next: File) {
    setFile(next); setSummary(null); setBatch(null);
    const parsed = await readSheet(next);
    setSheet(parsed);
    const norm = (value: string) => value.replace(/[\s_（）()]/g, "").toLowerCase();
    setMapping(Object.fromEntries(parsed.header.map((header) => [header, spec.fields.find((field) => norm(field.label) === norm(header) || norm(field.key) === norm(header))?.key ?? (spec.kind === "summary" ? header : "")])));
  }
  async function validate() {
    if (!file || !sheet) return;
    try {
      setProgress("建立批次…");
      const created = await apiPost<{ batch_code: string; duplicate_of: any }>("/api/crm/import", { action: "create_batch", entity, source_code: chosenSource, file_name: file.name, file_hash: await fileHash(file), data_date: dataDate });
      setBatch({ code: created.batch_code, duplicate: created.duplicate_of });
      const columns = sheet.header.map((header) => mapping[header]);
      for (let offset = 0; offset < sheet.rows.length; offset += 1000) {
        setProgress(`驗證格式 ${fmtNumber(Math.min(offset + 1000, sheet.rows.length))}／${fmtNumber(sheet.rows.length)}`);
        await apiPost("/api/crm/import", { action: "stage", batch_code: created.batch_code, rows: sheet.rows.slice(offset, offset + 1000).map((cells, index) => ({ row_no: offset + index + 2, values: Object.fromEntries(columns.map((key, column) => [key, cells[column] ?? ""]).filter(([key]) => key)) })) });
      }
      setProgress("檢查關聯編碼…");
      await apiPost("/api/crm/import", { action: "check", batch_code: created.batch_code });
      let cursor: string | null = null, pages = 0;
      do { setProgress(`比對既有資料（第 ${++pages} 頁）…`); cursor = (await apiPost<{ next: string | null }>("/api/crm/import", { action: "process", batch_code: created.batch_code, cursor, write: false })).next; } while (cursor);
      setSummary(await apiPost("/api/crm/import", { action: "summary", batch_code: created.batch_code }));
      setProgress("");
    } catch (error) { setProgress(""); notice.show("bad", error instanceof Error ? error.message : "驗證失敗"); }
  }
  async function commit() {
    if (!batch) return;
    try {
      let cursor: string | null = null, pages = 0;
      do { setProgress(`寫入中（第 ${++pages} 頁）…`); cursor = (await apiPost<{ next: string | null }>("/api/crm/import", { action: "process", batch_code: batch.code, cursor, write: true })).next; } while (cursor);
      const final = await apiPost<any>("/api/crm/import", { action: "finalize", batch_code: batch.code, decision: "commit" });
      setSummary(final); setProgress(""); notice.show("good", `已完成匯入 ${batch.code}：新增 ${final.counts.insert}、更新 ${final.counts.update}、無變更 ${final.counts.unchanged}、失敗 ${final.counts.failed}`); onDone();
    } catch (error) { setProgress(""); notice.show("bad", error instanceof Error ? error.message : "匯入失敗"); }
  }

  return <div className="crm-stack">
    <Panel title="資料匯入" eyebrow="欄位對照 → 格式／必填／編碼／關聯檢查 → 預覽 → 確認寫入" actions={<button className="crm-btn" onClick={() => download("/api/crm/import", { view: "template", entity })}><Download />下載「{spec.label}」範本</button>}>
      {notice.element}
      <div className="crm-form">
        <Field label="資料類型"><select value={entity} onChange={(event) => { setEntity(event.target.value); setSource(""); setSheet(null); setFile(null); setSummary(null); }}>{specs.map((item) => <option key={item.entity} value={item.entity}>{item.order}. {item.label}</option>)}</select></Field>
        <Field label="資料來源"><select value={chosenSource} onChange={(event) => setSource(event.target.value)}>{sources.length ? sources.map((item) => <option key={item.source_code} value={item.source_code}>{item.name}（優先 {item.priority}）</option>) : <option value="">請先在「資料來源」建立</option>}</select></Field>
        <Field label="資料日期" hint="地端資料的截止日期"><input type="date" value={dataDate} onChange={(event) => setDataDate(event.target.value)} /></Field>
      </div>
      <p className="crm-muted">{spec.note}｜鍵值：{spec.keys.map((key) => spec.fields.find((field) => field.key === key)?.label ?? key).join("＋")}｜編碼一律以文字保存，保留前導零；空白視為「資料不足」，不會當成 0。</p>
      <label className="crm-drop"><FileUp /><span>{file ? `${file.name}（${fmtNumber(sheet?.rows.length ?? 0)} 列）` : "選擇 CSV 或 Excel 檔"}</span><input type="file" accept=".csv,.xlsx,.xls" onChange={(event) => event.target.files?.[0] && choose(event.target.files[0])} /></label>
      {sheet && !summary && <>
        <table className="crm-table"><thead><tr><th>檔案欄位</th><th>對應平台欄位</th><th>範例值</th></tr></thead><tbody>{sheet.header.map((header, column) => <tr key={header}><td>{header}</td><td><select value={mapping[header] ?? ""} onChange={(event) => setMapping({ ...mapping, [header]: event.target.value })}><option value="">（不匯入）</option>{spec.fields.map((field) => <option key={field.key} value={field.key}>{field.label}{field.required ? "＊" : ""}</option>)}{spec.kind === "summary" && <option value={header}>原樣保存：{header}</option>}</select></td><td><small>{sheet.rows.slice(0, 3).map((row) => row[column]).join("｜")}</small></td></tr>)}</tbody></table>
        {missingRequired.length > 0 && <div className="crm-notice crm-tone-bad">缺少必填欄位對照：{missingRequired.map((field) => field.label).join("、")}</div>}
        <div className="crm-form-actions"><button className="crm-btn crm-btn-primary" disabled={Boolean(progress) || missingRequired.length > 0 || !chosenSource} onClick={validate}><CheckCircle2 />驗證並預覽</button></div>
      </>}
      {progress && <p className="crm-progress">{progress}</p>}
    </Panel>
    {summary && batch && <Panel title={`預覽：${batch.code}`} eyebrow={summary.batch?.status === "已完成" ? "已完成" : "尚未寫入，確認後才會更新正式資料"}>
      {batch.duplicate && <div className="crm-notice crm-tone-warn">此檔案與已完成批次 {batch.duplicate.batch_code} 內容相同；重複匯入只會判定為「無變更」，不會新增重複資料。</div>}
      <div className="crm-stats"><Stat label="新增" value={fmtNumber(summary.counts.insert)} tone="good" /><Stat label="更新" value={fmtNumber(summary.counts.update)} tone="info" /><Stat label="無變更" value={fmtNumber(summary.counts.unchanged)} /><Stat label="失敗" value={fmtNumber(summary.counts.failed)} tone={summary.counts.failed ? "bad" : "default"} /></div>
      {summary.errorTypes.length > 0 && <div className="c360-tags">{summary.errorTypes.map((row: any) => <Badge key={row.error_code} tone="bad">{({ required: "必填缺漏", date_format: "日期格式", date_invalid: "無效日期", number_format: "數字格式", bool_format: "是否格式", enum: "選項不符", code_format: "編碼格式", missing_ref: "關聯編碼缺漏", duplicate_in_file: "檔案內重複" } as Record<string, string>)[row.error_code] ?? row.error_code} {fmtNumber(row.n)}</Badge>)}<button className="crm-link" onClick={() => download("/api/crm/import", { view: "errors", batch: batch.code })}>下載錯誤明細</button></div>}
      {summary.errors.length > 0 && <table className="crm-table"><thead><tr><th>列</th><th>欄位</th><th>說明</th></tr></thead><tbody>{summary.errors.slice(0, 50).map((row: any, index: number) => <tr key={index}><td>{row.row_no}</td><td>{row.field ?? "—"}</td><td>{row.message}</td></tr>)}</tbody></table>}
      {summary.sample.length > 0 && <details><summary>預覽前 15 列（解析後）</summary><pre className="crm-pre">{JSON.stringify(summary.sample, null, 1)}</pre></details>}
      {summary.batch?.status !== "已完成" && <div className="crm-form-actions"><button className="crm-btn crm-btn-danger" onClick={() => runAction(() => apiPost("/api/crm/import", { action: "finalize", batch_code: batch.code, decision: "reject" }), notice, "已放棄此批次").then(() => { setSummary(null); setBatch(null); onDone(); })}>放棄</button><button className="crm-btn crm-btn-primary" disabled={Boolean(progress)} onClick={commit}><Save />確認匯入（失敗列不寫入）</button></div>}
    </Panel>}
  </div>;
}

function BatchHistory({ overview }: { overview: Overview }) {
  return <div className="crm-two">
    <Panel title="資料匯入紀錄" eyebrow="來源、批次、資料日期與成功／失敗筆數">{overview.batches.length ? <table className="crm-table"><thead><tr><th>批次</th><th>類型／來源</th><th>資料日期</th><th>狀態</th><th>總列</th><th>新增</th><th>更新</th><th>無變更</th><th>失敗</th></tr></thead><tbody>{overview.batches.map((row) => <tr key={row.batch_code}><td><span className="crm-code is-static">{row.batch_code}</span><small className="crm-sub">{row.file_name}｜{row.created_at.slice(0, 16).replace("T", " ")}</small></td><td>{row.entity}<small className="crm-sub">{row.source_code}</small></td><td>{row.data_date}</td><td><Badge tone={row.status === "已完成" ? "good" : row.status === "已拒絕" ? "muted" : "warn"}>{row.status}</Badge></td><td>{fmtNumber(row.total_rows)}</td><td>{fmtNumber(row.inserted)}</td><td>{fmtNumber(row.updated)}</td><td>{fmtNumber(row.unchanged)}</td><td>{row.failed ? <button className="crm-link" onClick={() => download("/api/crm/import", { view: "errors", batch: row.batch_code })}>{fmtNumber(row.failed)}</button> : 0}</td></tr>)}</tbody></table> : <Empty />}</Panel>
    <Panel title="結果回傳紀錄">{overview.results.length ? <table className="crm-table"><thead><tr><th>批次</th><th>檔案</th><th>總列</th><th>套用</th><th>無變更</th><th>拒絕</th></tr></thead><tbody>{overview.results.map((row) => <tr key={row.result_batch_code}><td><span className="crm-code is-static">{row.result_batch_code}</span><small className="crm-sub">{row.created_at.slice(0, 16).replace("T", " ")}｜{row.created_by}</small></td><td>{row.file_name}</td><td>{row.total_rows}</td><td>{row.applied}</td><td>{row.unchanged}</td><td>{row.rejected}</td></tr>)}</tbody></table> : <Empty label="尚未回傳結果" />}</Panel>
  </div>;
}

function Sources({ overview, canEdit, onChanged }: { overview: Overview; canEdit: boolean; onChanged: () => void }) {
  const notice = useNotice();
  const [input, setInput] = useState({ source_code: "", name: "", entity: "interactions", priority: "50", description: "" });
  return <Panel title="資料來源與衝突優先規則" eyebrow="同一欄位不同來源有衝突時：優先數字小者勝；同優先時資料日期新者勝；空白不覆蓋既有值">
    {notice.element}
    <table className="crm-table"><thead><tr><th>來源代碼</th><th>名稱</th><th>資料類型</th><th>優先順序</th><th>狀態</th><th>最後批次</th></tr></thead><tbody>{overview.sources.map((row) => <tr key={row.source_code}><td><span className="crm-code is-static">{row.source_code}</span></td><td>{row.name}<small className="crm-sub">{row.description}</small></td><td>{overview.specs.find((spec) => spec.entity === row.entity)?.label ?? row.entity}</td>
      <td>{canEdit ? <input type="number" defaultValue={row.priority} className="crm-small-input" onBlur={(event) => Number(event.target.value) !== row.priority && runAction(() => apiPost("/api/crm/import", { action: "set_priority", source_code: row.source_code, priority: Number(event.target.value) }), notice, "已更新優先順序").then(onChanged)} /> : row.priority}</td>
      <td><Badge tone={row.status === "已串接" ? "good" : "muted"}>{row.status}</Badge></td><td><small>{row.last_batch_code ?? "—"}</small></td></tr>)}</tbody></table>
    {canEdit && <form className="crm-form" onSubmit={(event) => { event.preventDefault(); void runAction(() => apiPost("/api/crm/import", { action: "create_source", ...input }), notice, "已建立來源").then(onChanged); }}>
      <Field label="來源代碼"><input value={input.source_code} onChange={(event) => setInput({ ...input, source_code: event.target.value.toUpperCase() })} placeholder="例：CRM-TESTDRIVE" required /></Field>
      <Field label="名稱"><input value={input.name} onChange={(event) => setInput({ ...input, name: event.target.value })} required /></Field>
      <Field label="資料類型"><select value={input.entity} onChange={(event) => setInput({ ...input, entity: event.target.value })}>{overview.specs.map((spec) => <option key={spec.entity} value={spec.entity}>{spec.label}</option>)}</select></Field>
      <Field label="優先順序"><input type="number" value={input.priority} onChange={(event) => setInput({ ...input, priority: event.target.value })} /></Field>
      <div className="crm-form-actions"><button className="crm-btn crm-btn-primary">新增來源</button></div>
    </form>}
  </Panel>;
}

function Automation() {
  const state = useApi(() => apiGet<{ rules: any[]; runs: any[] }>("/api/crm/automation"), []);
  const notice = useNotice();
  const [editing, setEditing] = useState<{ code: string; name: string; json: string; enabled: boolean } | null>(null);
  return <div className="crm-stack">
    {notice.element}
    <Panel title="自動化任務與旅程" eyebrow="觸發條件 → 排除條件 → 建立任務 → 地端執行 → 結果回傳 → 後續行動或停止">
      <p className="crm-muted">排除順序：不可聯絡／拒收 → 客訴處理中（促銷類暫停）→ 停止條件（已預約、已成交、拒收、需求取消）→ 跨部門聯絡頻率 → 重複任務。每次執行都有紀錄；修改規則會產生新版本，任務記錄其建立時的版本。建議先「試算」再執行。</p>
      <Async state={state}>{(d) => <table className="crm-table"><thead><tr><th>規則</th><th>觸發</th><th>任務</th><th>停止條件</th><th>版本</th><th>狀態</th><th></th></tr></thead><tbody>{d.rules.map((rule) => <tr key={rule.rule_code}>
        <td><strong>{rule.name}</strong><small className="crm-sub">{rule.rule_code}</small></td>
        <td className="crm-wrap"><small>{rule.definition.trigger.kind === "segment" ? `客群 ${rule.definition.trigger.segment_code}` : rule.definition.trigger.kind === "referral_overdue" ? `轉介逾 ${rule.definition.trigger.hours} 小時未接手` : "自訂條件"}</small></td>
        <td className="crm-wrap"><small>{rule.definition.task.task_type}：{rule.definition.task.action}｜{({ sales: "業代", advisor: "服專", unit: "據點" } as Record<string, string>)[rule.definition.task.owner_role]}｜{rule.definition.task.due_days} 天{rule.definition.task.promotional ? "｜促銷類" : ""}{rule.definition.task.opp_type ? `｜建立${rule.definition.task.opp_type}商機` : ""}</small></td>
        <td><small>{rule.definition.stop.join("、") || "—"}</small></td><td>v{rule.version}<small className="crm-sub">{rule.updated_at.slice(0, 10)}</small></td>
        <td><Badge tone={rule.enabled ? "good" : "muted"}>{rule.enabled ? "啟用" : "停用"}</Badge></td>
        <td className="crm-actions-cell"><button className="crm-btn" onClick={() => runAction(() => apiPost<any>("/api/crm/automation", { action: "run", rule_code: rule.rule_code, mode: "試算" }), notice, (r) => `試算 ${rule.name}：符合 ${r.matched}，預計建立 ${r.created}；排除 不可聯絡 ${r.skipped_ineligible}、客訴 ${r.skipped_complaint}、停止 ${r.skipped_stop}、頻率 ${r.skipped_frequency}、重複 ${r.skipped_duplicate}`).then(state.reload)}><Play />試算</button>
          <button className="crm-btn" onClick={() => runAction(() => apiPost("/api/crm/automation", { action: "enable", rule_code: rule.rule_code, enabled: !rule.enabled }), notice, rule.enabled ? "已停用" : "已啟用").then(state.reload)}><Power />{rule.enabled ? "停用" : "啟用"}</button>
          {rule.enabled ? <button className="crm-btn crm-btn-primary" onClick={() => { if (window.confirm(`確定執行「${rule.name}」並建立任務？`)) void runAction(() => apiPost<any>("/api/crm/automation", { action: "run", rule_code: rule.rule_code, mode: "執行" }), notice, (r) => `已建立 ${r.created} 筆任務（${r.run_code}）`).then(state.reload); }}>執行</button> : null}
          <button className="crm-btn" onClick={() => setEditing({ code: rule.rule_code, name: rule.name, json: JSON.stringify(rule.definition, null, 2), enabled: Boolean(rule.enabled) })}>編輯</button></td>
      </tr>)}</tbody></table>}</Async>
    </Panel>
    {editing && <Panel title={`編輯規則 ${editing.code}`} eyebrow="儲存會建立新版本（人工介入）">
      <Field label="名稱"><input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></Field>
      <Field label="規則定義（JSON）"><textarea className="crm-code-area" rows={14} value={editing.json} onChange={(event) => setEditing({ ...editing, json: event.target.value })} /></Field>
      <div className="crm-form-actions"><button className="crm-btn" onClick={() => setEditing(null)}>取消</button><button className="crm-btn crm-btn-primary" onClick={() => { let definition; try { definition = JSON.parse(editing.json); } catch { notice.show("bad", "JSON 格式錯誤"); return; } void runAction(() => apiPost<any>("/api/crm/automation", { action: "save", rule_code: editing.code, name: editing.name, definition, enabled: editing.enabled }), notice, (r) => `已儲存為 v${r.version}`).then((ok) => { if (ok) { setEditing(null); state.reload(); } }); }}><Save />儲存新版本</button></div>
    </Panel>}
    <Panel title="執行紀錄"><Async state={state}>{(d) => d.runs.length ? <table className="crm-table"><thead><tr><th>執行</th><th>規則</th><th>模式</th><th>符合</th><th>建立</th><th>不可聯絡</th><th>客訴</th><th>停止</th><th>頻率</th><th>重複</th><th>結果</th></tr></thead><tbody>{d.runs.map((run) => <tr key={run.run_code}><td><small>{run.run_code}<br />{run.started_at.slice(0, 16).replace("T", " ")}</small></td><td>{run.rule_code} v{run.rule_version}</td><td>{run.mode}</td><td>{run.matched}</td><td>{run.created}</td><td>{run.skipped_ineligible}</td><td>{run.skipped_complaint}</td><td>{run.skipped_stop}</td><td>{run.skipped_frequency}</td><td>{run.skipped_duplicate}</td><td>{run.failed ? <Badge tone="bad">失敗：{run.message}</Badge> : <small>{run.message}</small>}</td></tr>)}</tbody></table> : <Empty label="尚未執行" />}</Async></Panel>
  </div>;
}

function Users({ session, onChanged }: { session: any; onChanged: () => void }) {
  const notice = useNotice();
  const [input, setInput] = useState({ email: "", display_name: "", app_role: "sales", unit_code: "", staff_code: "", active: true });
  return <div className="crm-two">
    <Panel title="使用者與權限" eyebrow="權限由後端依登入帳號判定；網址參數不影響可存取的資料">
      {notice.element}
      <table className="crm-table"><thead><tr><th>帳號</th><th>角色</th><th>單位</th><th>人員編碼</th><th>狀態</th><th></th></tr></thead><tbody>{session.users?.map((user: any) => <tr key={user.email}><td>{user.display_name}<small className="crm-sub">{user.email}</small></td><td>{session.roles[user.app_role]}</td><td>{user.unit_code ?? "—"}</td><td>{user.staff_code ?? "—"}</td><td><Badge tone={user.active ? "good" : "muted"}>{user.active ? "啟用" : "停用"}</Badge></td>
        <td>{user.email !== session.actor.email && <button className="crm-btn" onClick={() => runAction(() => apiPost("/api/crm/session", { action: "impersonate", email: user.email }), notice, `已切換為 ${user.email}（驗證用，已記錄）`).then(onChanged)}><UserCog />以此身分檢視</button>}</td></tr>)}</tbody></table>
    </Panel>
    <Panel title="新增或修改使用者">
      <form className="crm-form" onSubmit={(event) => { event.preventDefault(); void runAction(() => apiPost("/api/crm/session", { action: "upsert_user", ...input }), notice, "已儲存").then(onChanged); }}>
        <Field label="登入 Email"><input type="email" value={input.email} onChange={(event) => setInput({ ...input, email: event.target.value })} required /></Field>
        <Field label="顯示名稱"><input value={input.display_name} onChange={(event) => setInput({ ...input, display_name: event.target.value })} /></Field>
        <Field label="角色"><select value={input.app_role} onChange={(event) => setInput({ ...input, app_role: event.target.value })}>{Object.entries(session.roles).map(([key, label]) => <option key={key} value={key}>{label as string}</option>)}</select></Field>
        <Field label="單位編碼" hint="據點主管必填"><input value={input.unit_code} onChange={(event) => setInput({ ...input, unit_code: event.target.value.trim() })} /></Field>
        <Field label="人員編碼" hint="業務、服務顧問必填"><StaffPicker role={input.app_role === "sales" ? "sales" : input.app_role === "advisor" ? "advisor" : undefined} value={input.staff_code} onChange={(staff) => setInput({ ...input, staff_code: staff })} /></Field>
        <label className="crm-check"><input type="checkbox" checked={input.active} onChange={(event) => setInput({ ...input, active: event.target.checked })} />啟用</label>
        <div className="crm-form-actions"><button className="crm-btn crm-btn-primary">儲存</button></div>
      </form>
    </Panel>
  </div>;
}

function Settings({ session, onChanged }: { session: any; onChanged: () => void }) {
  const notice = useNotice();
  return <Panel title="系統設定">{notice.element}
    <table className="crm-table"><tbody>{Object.entries(session.settings as Record<string, { value: string; description: string }>).map(([key, setting]) => <tr key={key}><td><strong>{key}</strong><small className="crm-sub">{setting.description}</small></td><td><input defaultValue={setting.value} placeholder={key === "analysis_as_of" ? `目前採用 ${session.asOf}` : ""} onBlur={(event) => event.target.value !== setting.value && runAction(() => apiPost("/api/crm/session", { action: "setting", key, value: event.target.value }), notice, "已更新設定").then(onChanged)} /></td></tr>)}</tbody></table>
  </Panel>;
}
