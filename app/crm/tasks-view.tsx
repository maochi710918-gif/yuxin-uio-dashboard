"use client";
// API payloads from /api/crm/* are rendered as loosely typed records; the server is the source of truth for their shape.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { Download, FileUp, History, Send, Upload, XCircle } from "lucide-react";
import { apiGet, apiPost, download, fileHash, fmtNumber, readSheet } from "./api";
import { StaffPicker } from "./customer-360";
import { Async, Badge, CodeLink, Drawer, Empty, Pager, Panel, Stat, StatusBadge, runAction, useApi, useNotice } from "./ui";

const statuses = ["待處理", "待匯出", "已匯出", "待回傳", "已完成", "已取消"];

export function TodayWork({ onFilter }: { onFilter: (filter: { status?: string; overdue?: boolean }) => void }) {
  const state = useApi(() => apiGet<Record<string, number | string>>("/api/crm/tasks", { view: "today" }), []);
  return <Async state={state}>{(d) => <div className="crm-stats">
    <Stat label="今日到期" value={fmtNumber(d.due_today ?? 0)} tone="info" onClick={() => onFilter({})} />
    <Stat label="逾期" value={fmtNumber(d.overdue ?? 0)} tone={Number(d.overdue) ? "bad" : "default"} onClick={() => onFilter({ overdue: true })} />
    <Stat label="待接手（商機）" value={fmtNumber(d.awaiting_handover ?? 0)} tone={Number(d.awaiting_handover) ? "warn" : "default"} />
    <Stat label="待處理" value={fmtNumber(d.pending ?? 0)} onClick={() => onFilter({ status: "待處理" })} />
    <Stat label="待匯出" value={fmtNumber(d.to_export ?? 0)} onClick={() => onFilter({ status: "待匯出" })} />
    <Stat label="待回傳" value={fmtNumber(d.awaiting_result ?? 0)} tone="warn" sub="已匯出但尚無最終結果" onClick={() => onFilter({ status: "已匯出,待回傳" })} />
  </div>}</Async>;
}

export function TasksView({ onOpenCustomer, canManage, ownerFilter }: { onOpenCustomer: (code: string) => void; canManage: boolean; ownerFilter?: string }) {
  const [filter, setFilter] = useState<{ status?: string; overdue?: boolean; q?: string; export?: string }>({ status: "待匯出" });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [reassign, setReassign] = useState("");
  const notice = useNotice();
  const list = useApi(() => apiGet<{ total: number; rows: any[] }>("/api/crm/tasks", { ...filter, overdue: filter.overdue ? 1 : undefined, owner: ownerFilter, page, pageSize: 25 }), [JSON.stringify(filter), page, ownerFilter]);
  const batches = useApi(() => apiGet<any[]>("/api/crm/tasks", { view: "batches" }), []);
  const refresh = () => { list.reload(); batches.reload(); setSelected([]); };
  const act = (payload: Record<string, unknown>, text: (r: any) => string) => runAction(() => apiPost("/api/crm/tasks", { action: "update", task_codes: selected, ...payload }), notice, text).then(refresh);

  return <div className="crm-stack">
    <Panel title="今日工作" eyebrow="到期、逾期、待接手、待匯出、待回傳"><TodayWork onFilter={(next) => { setFilter(next); setPage(1); }} /></Panel>
    {notice.element}
    <Panel title="任務" eyebrow="「已匯出」只代表名單已下載；完成與否依回傳結果判定" actions={<>
      <select value={filter.status ?? ""} onChange={(event) => { setFilter({ ...filter, status: event.target.value || undefined, overdue: false }); setPage(1); }} aria-label="狀態"><option value="">全部狀態</option>{statuses.map((status) => <option key={status}>{status}</option>)}<option value="已匯出,待回傳">已匯出＋待回傳</option></select>
      <input value={filter.q ?? ""} onChange={(event) => { setFilter({ ...filter, q: event.target.value }); setPage(1); }} placeholder="任務／客戶／車輛／商機編碼" />
      <button className="crm-btn crm-btn-primary" onClick={() => runAction(() => apiPost<any>("/api/crm/tasks", { action: "export", task_codes: selected.length ? selected : undefined }), notice, (r) => `已建立匯出批次 ${r.export_code}（${r.tasks} 筆），開始下載`).then((r: any) => { if (r) download("/api/crm/tasks", { view: "download", export: r.export_code }); refresh(); })}><Download />{selected.length ? `匯出選取 ${selected.length} 筆` : "匯出全部待匯出"}</button>
    </>}>
      {selected.length > 0 && <div className="crm-bulk"><span>已選 {selected.length} 筆</span>
        <button className="crm-btn" onClick={() => act({ action: "confirm" }, (r) => `已確認 ${r.updated} 筆為待匯出（略過 ${r.skipped}）`)}><Send />確認待匯出</button>
        <button className="crm-btn" onClick={() => act({ action: "reopen", reason: "名單未使用" }, (r) => `已撤回匯出 ${r.updated} 筆`)}><History />撤回匯出</button>
        {canManage && <span className="crm-inline"><StaffPicker value={reassign} onChange={setReassign} /><button className="crm-btn" disabled={!reassign} onClick={() => act({ action: "reassign", owner_staff_code: reassign }, (r) => `已轉派 ${r.updated} 筆（已匯出／待回傳者不可轉派，略過 ${r.skipped}）`)}>轉派</button></span>}
        <button className="crm-btn crm-btn-danger" onClick={() => { const reason = window.prompt("取消原因（必填）"); if (reason) void act({ action: "cancel", reason }, (r) => `已取消 ${r.updated} 筆`); }}><XCircle />取消</button>
      </div>}
      <Async state={list}>{(d) => d.rows.length ? <>
        <table className="crm-table"><thead><tr><th><input type="checkbox" aria-label="全選" checked={d.rows.every((row) => selected.includes(row.task_code))} onChange={(event) => setSelected(event.target.checked ? d.rows.map((row) => row.task_code) : [])} /></th><th>任務編碼</th><th>客戶／車輛</th><th>類型</th><th>入選原因</th><th>建議行動</th><th>優先</th><th>負責</th><th>期限</th><th>狀態</th><th>結果</th></tr></thead>
          <tbody>{d.rows.map((row) => <tr key={row.task_code} className={row.overdue ? "is-overdue" : ""}>
            <td><input type="checkbox" checked={selected.includes(row.task_code)} onChange={(event) => setSelected(event.target.checked ? [...selected, row.task_code] : selected.filter((code) => code !== row.task_code))} aria-label={`選取 ${row.task_code}`} /></td>
            <td><CodeLink code={row.task_code} onOpen={setDetail} />{row.opp_code && <small className="crm-sub">{row.opp_code}</small>}</td>
            <td><CodeLink code={row.customer_code} onOpen={onOpenCustomer} /><small className="crm-sub">{row.vehicle_code ?? "—"}</small></td>
            <td>{row.task_type}{row.rule_code && <small className="crm-sub">{row.rule_code} v{row.rule_version}</small>}</td>
            <td className="crm-wrap">{row.reason}</td><td className="crm-wrap">{row.recommended_action}</td><td>{row.priority}</td>
            <td>{row.owner_name ?? row.owner_staff_code ?? <Badge tone="warn">未指派</Badge>}<small className="crm-sub">{row.owner_unit_name ?? row.owner_unit_code ?? ""}</small></td>
            <td>{row.due_date}{row.overdue ? <Badge tone="bad">逾期</Badge> : null}</td><td><StatusBadge status={row.status} />{row.export_code && <small className="crm-sub">{row.export_code}</small>}</td><td className="crm-wrap"><small>{row.result ?? "—"}</small></td>
          </tr>)}</tbody></table>
        <Pager page={page} pageSize={25} total={d.total} onPage={setPage} />
      </> : <Empty label="沒有符合的任務" hint="可到「客群」建立任務，或啟用自動化規則" />}</Async>
    </Panel>
    <div className="crm-two">
      <Panel title="匯出批次" eyebrow="下載後是否真正執行：看回傳與完成數">
        <Async state={batches}>{(rows) => rows.length ? <table className="crm-table"><thead><tr><th>批次</th><th>建立</th><th>任務</th><th>已完成</th><th>待回傳</th><th>未回傳</th><th></th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.export_code}><td><span className="crm-code is-static">{row.export_code}</span><small className="crm-sub">{row.list_version}｜資料 {row.data_date}</small></td><td><small>{row.created_at.slice(0, 16).replace("T", " ")}<br />{row.created_by}</small></td><td>{row.visible_tasks}</td><td>{row.completed}</td><td>{row.awaiting_final}</td><td>{row.not_returned ? <Badge tone="warn">{row.not_returned}</Badge> : 0}</td>
            <td><button className="crm-link" onClick={() => download("/api/crm/tasks", { view: "download", export: row.export_code })}>Excel</button>｜<button className="crm-link" onClick={() => download("/api/crm/tasks", { view: "download", export: row.export_code, format: "csv" })}>CSV</button>｜<button className="crm-link" onClick={() => { setFilter({ export: row.export_code }); setPage(1); }}>任務</button></td></tr>)}</tbody></table> : <Empty label="尚無匯出批次" />}</Async>
      </Panel>
      <ResultsImport onApplied={refresh} />
    </div>
    <TaskDetail code={detail} onClose={() => setDetail(null)} />
  </div>;
}

function ResultsImport({ onApplied }: { onApplied: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<{ hash: string; rows: { row_no: number; values: Record<string, string> }[] } | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const notice = useNotice();
  async function load(next: File) {
    setFile(next); setPreview(null); setBusy(true);
    try {
      const { header, rows } = await readSheet(next);
      if (!header.includes("任務編碼")) throw new Error("檔案缺少「任務編碼」欄，請使用平台下載的行動名單或回傳範本");
      const payload = { hash: await fileHash(next), rows: rows.map((cells, index) => ({ row_no: index + 2, values: Object.fromEntries(header.map((name, column) => [name, cells[column] ?? ""])) })) };
      setParsed(payload);
      setPreview(await apiPost("/api/crm/tasks", { action: "results", file_name: next.name, file_hash: payload.hash, rows: payload.rows, dry_run: true }));
    } catch (error) { notice.show("bad", error instanceof Error ? error.message : "讀取失敗"); } finally { setBusy(false); }
  }
  return <Panel title="結果回傳" eyebrow="依任務編碼精準回寫，並核對客戶／商機編碼" actions={<button className="crm-btn" onClick={() => download("/api/crm/import", { view: "template", entity: "results" })}><Download />回傳範本</button>}>
    {notice.element}
    <label className="crm-drop"><FileUp /><span>{file ? file.name : "選擇已填寫結果的行動名單（Excel／CSV）"}</span><input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => event.target.files?.[0] && load(event.target.files[0])} /></label>
    {busy && <p className="crm-muted">檢查中…</p>}
    {preview && <>
      {preview.duplicate_of && <div className="crm-notice crm-tone-warn">此檔案內容與回傳批次 {preview.duplicate_of} 相同；相同內容會判為無變更，不會重複套用。</div>}
      <div className="crm-stats"><Stat label="總列數" value={fmtNumber(preview.summary.total)} /><Stat label="將套用" value={fmtNumber(preview.summary.applied)} tone="good" /><Stat label="無變更" value={fmtNumber(preview.summary.unchanged)} /><Stat label="拒絕" value={fmtNumber(preview.summary.rejected)} tone={preview.summary.rejected ? "bad" : "default"} /></div>
      {preview.results.filter((row: any) => row.status !== "已套用").length > 0 && <table className="crm-table"><thead><tr><th>列</th><th>任務編碼</th><th>狀態</th><th>說明</th></tr></thead><tbody>{preview.results.filter((row: any) => row.status !== "已套用").slice(0, 100).map((row: any) => <tr key={row.row_no}><td>{row.row_no}</td><td>{row.task_code ?? "—"}</td><td><Badge tone={row.status === "拒絕" ? "bad" : "muted"}>{row.status}</Badge></td><td>{row.message}</td></tr>)}</tbody></table>}
      <div className="crm-form-actions"><button className="crm-btn crm-btn-primary" disabled={!preview.summary.applied || !parsed} onClick={() => runAction(() => apiPost<any>("/api/crm/tasks", { action: "results", file_name: file?.name, file_hash: parsed!.hash, rows: parsed!.rows }), notice, (r) => `已套用 ${r.summary.applied} 筆（批次 ${r.result_batch_code}）`).then((r) => { if (r) { setPreview(null); setParsed(null); setFile(null); onApplied(); } })}><Upload />確認套用 {preview.summary.applied} 筆</button></div>
    </>}
  </Panel>;
}

function TaskDetail({ code, onClose }: { code: string | null; onClose: () => void }) {
  return <Drawer open={Boolean(code)} title={<>任務 <span className="crm-muted">｜{code}</span></>} onClose={onClose}>{code && <TaskDetailBody code={code} />}</Drawer>;
}

function TaskDetailBody({ code }: { code: string }) {
  const state = useApi(() => apiGet<any>("/api/crm/tasks", { view: "detail", code }), [code]);
  return <Async state={state}>{(d) => <div className="crm-stack">
    <dl className="crm-dl">{[["客戶", d.task.customer_code], ["車輛", d.task.vehicle_code], ["商機", d.task.opp_code], ["客群／活動", [d.task.segment_code, d.task.campaign_code].filter(Boolean).join("／")], ["規則", d.task.rule_code ? `${d.task.rule_code} v${d.task.rule_version}` : "人工"], ["入選原因", d.task.reason], ["建議行動", d.task.recommended_action], ["負責", `${d.task.owner_staff_code ?? "未指派"}／${d.task.owner_unit_code ?? "—"}`], ["期限", d.task.due_date], ["狀態", d.task.status], ["結果", d.task.result], ["下次追蹤", d.task.next_follow_date]].map(([label, value]) => <div key={label as string}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}</dl>
    <h3>異動紀錄</h3><ol className="c360-timeline">{d.events.map((event: any) => <li key={event.event_id}><time>{event.at.slice(0, 16).replace("T", " ")}</time><Badge>{event.event_type}</Badge><span>{event.from_value ?? ""} → {event.to_value ?? ""}</span><small>{event.note}｜{event.actor}</small></li>)}</ol>
    <h3>回傳紀錄</h3>{d.returns.length ? <ol className="c360-timeline">{d.returns.map((row: any) => <li key={`${row.result_batch_code}${row.row_no}`}><time>{row.created_at.slice(0, 16).replace("T", " ")}</time><Badge tone={row.status === "拒絕" ? "bad" : "default"}>{row.status}</Badge><span>{row.result_batch_code} 第 {row.row_no} 列</span><small>{row.message}｜{row.file_name}</small></li>)}</ol> : <span className="crm-muted">尚未回傳</span>}
  </div>}</Async>;
}
