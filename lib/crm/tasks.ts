import { type Actor, HttpError, audit, customerScope, workScope } from "./auth";
import { all, batch, first, jsonList, nextCodes, nowIso, run, today } from "./db";
import { advanceOpportunity } from "./opportunities";
import { type ConditionGroup, baseCte, compile, describe, ensureSnapshot } from "./segments";
import { analysisAsOf } from "./settings";

export const taskStatuses = ["待處理", "待匯出", "已匯出", "待回傳", "已完成", "已取消"] as const;
export type TaskStatus = (typeof taskStatuses)[number];
const openStatuses = ["待處理", "待匯出", "已匯出", "待回傳"];

// 聯絡結果 → 任務狀態。「已匯出」只代表名單已下載；完成與否只由回傳結果決定。
export const contactResults: Record<string, { final: boolean; stop: boolean }> = {
  "已聯絡-有效回覆": { final: true, stop: false },
  "已聯絡-無意願": { final: true, stop: false },
  "未接通": { final: false, stop: false },
  "拒收": { final: true, stop: true },
  "需求取消": { final: true, stop: true },
  "無法執行": { final: true, stop: false },
};

type TaskRow = { task_code: string; status: TaskStatus; customer_code: string; opp_code: string | null; owner_staff_code: string | null; owner_unit_code: string | null; task_type: string };

async function loadTasks(actor: Actor, codes: string[]) {
  const scope = workScope(actor, "t");
  return all<TaskRow>(`SELECT * FROM tasks t WHERE t.task_code IN (SELECT value FROM json_each(?)) AND ${scope.sql}`, jsonList(codes), ...scope.params);
}

function event(task: string, type: string, from: string | null, to: string | null, note: string | null, actor: Actor, at: string) {
  return { sql: "INSERT INTO task_events (task_code, event_type, from_value, to_value, note, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)", params: [task, type, from, to, note, actor.actingAs ? `${actor.email}（代理 ${actor.actingAs}）` : actor.email, at] };
}

export type TaskDraft = { customer_code: string; vehicle_code: string | null; reason: string; owner_staff_code: string | null; owner_unit_code: string | null; opp_code?: string | null };
export type TaskSpec = { task_type: string; action: string; due_days: number; priority: number; segment_code?: string | null; campaign_code?: string | null; rule_code?: string | null; rule_version?: number | null; initial_status?: TaskStatus };

/** Inserts tasks; an open task with the same 類型＋客戶＋車輛 already existing is skipped (重複任務排除). */
export async function insertTasks(actor: Actor, spec: TaskSpec, drafts: TaskDraft[]) {
  if (!drafts.length) return { created: [] as string[], duplicates: 0 };
  const keys = drafts.map((draft) => `${spec.task_type}|${draft.customer_code}|${draft.vehicle_code ?? ""}`);
  const open = new Set((await all<{ dedupe_key: string }>("SELECT dedupe_key FROM tasks WHERE dedupe_key IN (SELECT value FROM json_each(?)) AND status NOT IN ('已完成', '已取消')", jsonList(keys))).map((row) => row.dedupe_key));
  const fresh = drafts.map((draft, index) => ({ draft, key: keys[index] })).filter(({ key }, index, list) => !open.has(key) && list.findIndex((item) => item.key === key) === index);
  const codes = await nextCodes("TSK", fresh.length);
  const stamp = nowIso();
  const due = new Date(Date.now() + spec.due_days * 86400000).toISOString().slice(0, 10);
  const writes = fresh.flatMap(({ draft, key }, index) => [
    { sql: `INSERT OR IGNORE INTO tasks (task_code, task_type, customer_code, vehicle_code, opp_code, campaign_code, segment_code, rule_code, rule_version, reason, recommended_action, priority, owner_staff_code, owner_unit_code, due_date, status, dedupe_key, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [codes[index], spec.task_type, draft.customer_code, draft.vehicle_code, draft.opp_code ?? null, spec.campaign_code ?? null, spec.segment_code ?? null, spec.rule_code ?? null, spec.rule_version ?? null, draft.reason, spec.action, spec.priority, draft.owner_staff_code, draft.owner_unit_code, due, spec.initial_status ?? "待匯出", key, actor.email, stamp, stamp] },
    event(codes[index], "建立", null, spec.initial_status ?? "待匯出", spec.rule_code ? `自動化 ${spec.rule_code} v${spec.rule_version}` : draft.reason, actor, stamp),
  ]);
  await batch(writes);
  return { created: codes, duplicates: drafts.length - fresh.length };
}

/** Builds task drafts from a segment definition (only 可執行 members, owner = the vehicle's responsible staff for the role). */
export async function draftsFromDefinition(actor: Actor, definition: ConditionGroup, ownerRole: "sales" | "advisor" | "unit", limit = 20000) {
  await ensureSnapshot();
  const asOf = await analysisAsOf();
  const compiled = compile(definition, []);
  const scope = customerScope(actor, "sc");
  const reason = describe(definition);
  const rows = await all<{ customer_code: string; vehicle_code: string | null; sales_code: string | null; advisor_code: string | null; service_unit_code: string | null; opt_out: number | null; contact_eligible: number | null; complaint_open: number | null }>(
    `${baseCte} SELECT b.customer_code, b.vehicle_code, b.sales_code, b.advisor_code, b.service_unit_code, b.opt_out, b.contact_eligible, b.complaint_open FROM b
     WHERE (${compiled.sql}) AND EXISTS (SELECT 1 FROM customers sc WHERE sc.customer_code = b.customer_code AND ${scope.sql}) ORDER BY b.customer_code, b.vehicle_code LIMIT ?`,
    asOf, ...compiled.params, ...scope.params, limit);
  return rows.map((row) => ({ row, draft: { customer_code: row.customer_code, vehicle_code: row.vehicle_code, reason, owner_staff_code: ownerRole === "sales" ? row.sales_code : ownerRole === "advisor" ? row.advisor_code : null, owner_unit_code: row.service_unit_code } as TaskDraft }));
}

export async function listTasks(actor: Actor, filters: { status?: string; owner?: string; type?: string; search?: string; overdue?: boolean; export_code?: string; campaign?: string; page: number; pageSize: number }) {
  const scope = workScope(actor, "t");
  const where = [scope.sql], params: unknown[] = [...scope.params];
  if (filters.status) { where.push("t.status IN (SELECT value FROM json_each(?))"); params.push(jsonList(filters.status.split(","))); }
  if (filters.owner) { where.push("t.owner_staff_code = ?"); params.push(filters.owner); }
  if (filters.type) { where.push("t.task_type = ?"); params.push(filters.type); }
  if (filters.export_code) { where.push("t.export_code = ?"); params.push(filters.export_code); }
  if (filters.campaign) { where.push("t.campaign_code = ?"); params.push(filters.campaign); }
  if (filters.search) { where.push("(t.task_code LIKE ? OR t.customer_code LIKE ? OR t.vehicle_code LIKE ? OR t.opp_code LIKE ?)"); params.push(...Array(4).fill(`%${filters.search}%`)); }
  if (filters.overdue) { where.push(`t.status IN ('待處理', '待匯出', '已匯出', '待回傳') AND t.due_date < ?`); params.push(today()); }
  const sql = where.join(" AND ");
  const total = await first<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks t WHERE ${sql}`, ...params);
  const rows = await all<Record<string, unknown>>(`SELECT t.*, s.display_name AS owner_name, u.name AS owner_unit_name, CASE WHEN t.status IN ('待處理', '待匯出', '已匯出', '待回傳') AND t.due_date < ? THEN 1 ELSE 0 END AS overdue
    FROM tasks t LEFT JOIN staff s ON s.staff_code = t.owner_staff_code LEFT JOIN units u ON u.unit_code = t.owner_unit_code WHERE ${sql}
    ORDER BY overdue DESC, t.priority, t.due_date, t.task_code LIMIT ? OFFSET ?`, today(), ...params, filters.pageSize, (filters.page - 1) * filters.pageSize);
  return { total: total?.n ?? 0, rows };
}

/** 今日工作：到期、逾期、待接手（商機）、待匯出、待回傳。 */
export async function todayWork(actor: Actor) {
  const scope = workScope(actor, "t");
  const oppScope = workScope(actor, "o");
  const day = today();
  const counts = await first<Record<string, number>>(`SELECT
      SUM(CASE WHEN t.status IN ('待處理', '待匯出', '已匯出', '待回傳') AND t.due_date = ? THEN 1 ELSE 0 END) AS due_today,
      SUM(CASE WHEN t.status IN ('待處理', '待匯出', '已匯出', '待回傳') AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN t.status = '待處理' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN t.status = '待匯出' THEN 1 ELSE 0 END) AS to_export,
      SUM(CASE WHEN t.status IN ('已匯出', '待回傳') THEN 1 ELSE 0 END) AS awaiting_result
    FROM tasks t WHERE ${scope.sql}`, day, day, ...scope.params);
  const handover = await first<{ n: number }>(`SELECT COUNT(*) AS n FROM opportunities o WHERE o.handover_status = '待接手' AND o.stage NOT IN ('成交', '未成交') AND ${oppScope.sql}`, ...oppScope.params);
  return { date: day, ...counts, awaiting_handover: handover?.n ?? 0 };
}

export async function updateTasks(actor: Actor, codes: string[], change: { action: "confirm" | "cancel" | "reassign" | "reopen"; reason?: string; owner_staff_code?: string; owner_unit_code?: string }) {
  const tasks = await loadTasks(actor, codes);
  if (!tasks.length) throw new HttpError(404, "查無任務或不在授權範圍");
  const stamp = nowIso();
  const writes: { sql: string; params: unknown[] }[] = [];
  let skipped = 0;
  for (const task of tasks) {
    if (change.action === "confirm") {
      if (task.status !== "待處理") { skipped += 1; continue; }
      writes.push({ sql: "UPDATE tasks SET status = '待匯出', updated_at = ? WHERE task_code = ?", params: [stamp, task.task_code] }, event(task.task_code, "狀態變更", task.status, "待匯出", change.reason ?? null, actor, stamp));
    } else if (change.action === "cancel") {
      if (!openStatuses.includes(task.status)) { skipped += 1; continue; }
      if (!change.reason) throw new HttpError(400, "取消任務需填寫原因");
      writes.push({ sql: "UPDATE tasks SET status = '已取消', result = ?, updated_at = ?, completed_at = ? WHERE task_code = ?", params: [`取消：${change.reason}`, stamp, stamp, task.task_code] }, event(task.task_code, "取消", task.status, "已取消", change.reason, actor, stamp));
    } else if (change.action === "reassign") {
      if (!openStatuses.includes(task.status)) { skipped += 1; continue; }
      if (task.status === "已匯出" || task.status === "待回傳") { skipped += 1; continue; } // 已在地端執行中的任務不可轉派，避免重複聯絡
      writes.push({ sql: "UPDATE tasks SET owner_staff_code = ?, owner_unit_code = COALESCE(?, owner_unit_code), updated_at = ? WHERE task_code = ?", params: [change.owner_staff_code ?? null, change.owner_unit_code ?? null, stamp, task.task_code] }, event(task.task_code, "轉派", task.owner_staff_code, change.owner_staff_code ?? null, change.reason ?? null, actor, stamp));
    } else if (change.action === "reopen") {
      if (task.status !== "已匯出") { skipped += 1; continue; }
      writes.push({ sql: "UPDATE tasks SET status = '待匯出', export_code = NULL, updated_at = ? WHERE task_code = ?", params: [stamp, task.task_code] }, event(task.task_code, "撤回匯出", task.status, "待匯出", change.reason ?? "名單未使用", actor, stamp));
    }
  }
  await batch(writes);
  await audit(actor, `任務${change.action}`, "tasks", null, { codes: tasks.map((task) => task.task_code), skipped, reason: change.reason });
  return { updated: tasks.length - skipped, skipped };
}

export const exportColumns = ["匯出批次編號", "名單版本", "資料日期", "任務編碼", "商機編碼", "客戶編碼", "車輛編碼", "客群編碼", "活動編碼", "任務類型", "入選原因", "建議行動", "優先順序", "負責單位編碼", "負責人員編碼", "期限",
  "執行日期", "聯絡結果", "預約", "預約日期", "到店", "試乘", "報價", "成交交易編碼", "未成交原因", "下次追蹤日期", "備註"];

/** Creates an export batch from 待匯出 tasks (or the given codes) and marks them 已匯出. */
export async function exportTasks(actor: Actor, input: { task_codes?: string[]; status?: string }) {
  const scope = workScope(actor, "t");
  const rows = input.task_codes?.length
    ? await all<Record<string, unknown>>(`SELECT t.* FROM tasks t WHERE t.task_code IN (SELECT value FROM json_each(?)) AND t.status = '待匯出' AND ${scope.sql} ORDER BY t.priority, t.due_date, t.task_code`, jsonList(input.task_codes), ...scope.params)
    : await all<Record<string, unknown>>(`SELECT t.* FROM tasks t WHERE t.status = '待匯出' AND ${scope.sql} ORDER BY t.priority, t.due_date, t.task_code LIMIT 20000`, ...scope.params);
  if (!rows.length) throw new HttpError(400, "沒有可匯出的任務（狀態需為「待匯出」）");
  const [code] = await nextCodes("EXP", 1);
  const stamp = nowIso();
  const dataDate = await analysisAsOf();
  const version = `${code}-v1`;
  await run("INSERT INTO export_batches (export_code, list_version, data_date, task_count, scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", code, version, dataDate, rows.length, `${actor.role}:${actor.unitCode ?? actor.staffCode ?? "全公司"}`, actor.email, stamp);
  await batch(rows.flatMap((row) => [
    { sql: "UPDATE tasks SET status = '已匯出', export_code = ?, updated_at = ? WHERE task_code = ? AND status = '待匯出'", params: [code, stamp, row.task_code] },
    event(String(row.task_code), "匯出", "待匯出", "已匯出", code, actor, stamp),
  ]));
  await audit(actor, "匯出行動名單", "export_batches", code, { tasks: rows.length });
  return exportRows(actor, code);
}

export async function exportRows(actor: Actor, exportCode: string) {
  const header = await first<{ export_code: string; list_version: string; data_date: string }>("SELECT * FROM export_batches WHERE export_code = ?", exportCode);
  if (!header) throw new HttpError(404, "查無匯出批次");
  const scope = workScope(actor, "t");
  const rows = await all<Record<string, unknown>>(`SELECT t.* FROM tasks t WHERE t.export_code = ? AND ${scope.sql} ORDER BY t.priority, t.due_date, t.task_code`, exportCode, ...scope.params);
  return { header, rows: rows.map((row) => [header.export_code, header.list_version, header.data_date, row.task_code, row.opp_code ?? "", row.customer_code, row.vehicle_code ?? "", row.segment_code ?? "", row.campaign_code ?? "", row.task_type, row.reason, row.recommended_action, row.priority, row.owner_unit_code ?? "", row.owner_staff_code ?? "", row.due_date ?? "", "", "", "", "", "", "", "", "", "", "", ""]) };
}

type ResultRow = { row_no: number; values: Record<string, string> };
const yes = (value: string | undefined) => ["是", "Y", "1", "TRUE", "V", "有"].includes(String(value ?? "").trim().toUpperCase());
const isDate = (value: string | undefined) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim().replace(/\//g, "-"));
const normDate = (value: string | undefined) => { const text = String(value ?? "").trim().replace(/\//g, "-"); const m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : ""; };

/** Applies a returned result file. Rows are matched by 任務編碼 (and verified against 客戶／商機編碼) — never by customer alone. */
export async function applyResults(actor: Actor, input: { file_name?: string; file_hash: string; rows: ResultRow[]; dry_run?: boolean }) {
  const previous = await first<{ result_batch_code: string }>("SELECT result_batch_code FROM result_batches WHERE file_hash = ? ORDER BY created_at DESC LIMIT 1", input.file_hash);
  const codes = [...new Set(input.rows.map((row) => String(row.values["任務編碼"] ?? "").trim()).filter(Boolean))];
  const tasks = new Map((await loadTasks(actor, codes)).map((task) => [task.task_code, task]));
  const lastHashes = new Map((await all<{ task_code: string; row_hash: string }>("SELECT task_code, row_hash FROM result_rows WHERE task_code IN (SELECT value FROM json_each(?)) AND status = '已套用' ORDER BY result_batch_code", jsonList(codes))).map((row) => [row.task_code, row.row_hash]));
  const txnCodes = input.rows.map((row) => String(row.values["成交交易編碼"] ?? "").trim()).filter(Boolean);
  const knownTxn = new Set((await all<{ txn_code: string }>("SELECT txn_code FROM transactions WHERE txn_code IN (SELECT value FROM json_each(?))", jsonList(txnCodes))).map((row) => row.txn_code));
  const results: { row_no: number; task_code: string | null; opp_code: string | null; status: "已套用" | "無變更" | "拒絕"; message: string; hash?: string }[] = [];
  const seenInFile = new Set<string>();
  for (const row of input.rows) {
    const v = row.values;
    const taskCode = String(v["任務編碼"] ?? "").trim();
    const reject = (message: string) => results.push({ row_no: row.row_no, task_code: taskCode || null, opp_code: String(v["商機編碼"] ?? "").trim() || null, status: "拒絕", message });
    if (!taskCode) { reject("缺少任務編碼"); continue; }
    const task = tasks.get(taskCode);
    if (!task) { reject("任務編碼不存在或不在您的授權範圍"); continue; }
    if (String(v["客戶編碼"] ?? "").trim() !== task.customer_code) { reject(`客戶編碼與任務不符（任務為 ${task.customer_code}）`); continue; }
    const oppCode = String(v["商機編碼"] ?? "").trim();
    if (oppCode && task.opp_code && oppCode !== task.opp_code) { reject(`商機編碼與任務不符（任務為 ${task.opp_code}）`); continue; }
    if (task.status === "已取消") { reject("任務已取消，不接受回傳"); continue; }
    if (task.status === "待處理" || task.status === "待匯出") { reject("任務尚未匯出，不能回傳結果"); continue; }
    const result = String(v["聯絡結果"] ?? "").trim();
    if (!result) { results.push({ row_no: row.row_no, task_code: taskCode, opp_code: oppCode || null, status: "無變更", message: "未填聯絡結果（視為尚未執行）" }); continue; }
    if (!contactResults[result]) { reject(`聯絡結果需為：${Object.keys(contactResults).join("、")}`); continue; }
    if (!isDate(v["執行日期"])) { reject("執行日期需為 YYYY-MM-DD"); continue; }
    const txn = String(v["成交交易編碼"] ?? "").trim();
    if (txn && !knownTxn.has(txn)) { reject(`成交交易編碼 ${txn} 不存在於交易資料；請先匯入交易後再回傳`); continue; }
    if (seenInFile.has(taskCode)) { reject("同一任務在檔案中出現多次，請保留一列"); continue; }
    seenInFile.add(taskCode);
    const hash = JSON.stringify(["執行日期", "聯絡結果", "預約", "預約日期", "到店", "試乘", "報價", "成交交易編碼", "未成交原因", "下次追蹤日期", "備註"].map((key) => String(v[key] ?? "").trim()));
    if (lastHashes.get(taskCode) === hash) { results.push({ row_no: row.row_no, task_code: taskCode, opp_code: oppCode || task.opp_code, status: "無變更", message: "與先前回傳內容相同", hash }); continue; }
    results.push({ row_no: row.row_no, task_code: taskCode, opp_code: oppCode || task.opp_code, status: "已套用", message: lastHashes.has(taskCode) ? "修正先前回傳" : "已更新任務", hash });
  }
  const summary = { total: input.rows.length, applied: results.filter((item) => item.status === "已套用").length, unchanged: results.filter((item) => item.status === "無變更").length, rejected: results.filter((item) => item.status === "拒絕").length };
  if (input.dry_run) return { duplicate_of: previous?.result_batch_code ?? null, summary, results };

  const [batchCode] = await nextCodes("RES", 1);
  const stamp = nowIso();
  await run("INSERT INTO result_batches (result_batch_code, file_name, file_hash, total_rows, applied, unchanged, rejected, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", batchCode, input.file_name ?? null, input.file_hash, summary.total, summary.applied, summary.unchanged, summary.rejected, actor.email, stamp);
  const writes: { sql: string; params: unknown[] }[] = results.map((item) => ({ sql: "INSERT INTO result_rows (result_batch_code, row_no, task_code, opp_code, row_hash, status, message) VALUES (?, ?, ?, ?, ?, ?, ?)", params: [batchCode, item.row_no, item.task_code, item.opp_code, item.hash ?? null, item.status, item.message] }));
  const oppUpdates: { opp: string; v: Record<string, string>; result: string; task: string }[] = [];
  for (const item of results.filter((entry) => entry.status === "已套用")) {
    const row = input.rows.find((entry) => entry.row_no === item.row_no)!;
    const v = row.values;
    const task = tasks.get(item.task_code!)!;
    const result = String(v["聯絡結果"]).trim();
    const nextFollow = normDate(v["下次追蹤日期"]) || null;
    const flags = ["預約", "到店", "試乘", "報價"].filter((key) => yes(v[key]));
    const status: TaskStatus = contactResults[result].final ? "已完成" : "待回傳";
    const summaryText = [result, ...flags.map((flag) => `已${flag}`), v["成交交易編碼"] ? `成交 ${v["成交交易編碼"]}` : "", v["未成交原因"] ? `未成交：${v["未成交原因"]}` : ""].filter(Boolean).join("；");
    writes.push(
      { sql: "UPDATE tasks SET status = ?, result = ?, result_date = ?, next_follow_date = ?, updated_at = ?, completed_at = CASE WHEN ? = '已完成' THEN ? ELSE NULL END WHERE task_code = ?", params: [status, summaryText, normDate(v["執行日期"]), nextFollow, stamp, status, stamp, task.task_code] },
      event(task.task_code, "回傳", task.status, status, `${batchCode}：${summaryText}`, actor, stamp),
      // 回傳結果同時寫入互動時間軸（每次有效回傳一筆）；內容相同的重複回傳被判為無變更，不會新增互動。
      { sql: "INSERT OR REPLACE INTO interactions (interaction_code, interaction_type, customer_code, vehicle_code, channel, occurred_at, staff_code, unit_code, outcome, detail, task_code, opp_code, campaign_code, source_code, source_record_id, batch_code, updated_at) SELECT ?, '聯絡', t.customer_code, t.vehicle_code, '地端執行', ?, t.owner_staff_code, t.owner_unit_code, ?, ?, t.task_code, t.opp_code, t.campaign_code, 'RESULT', ?, ?, ? FROM tasks t WHERE t.task_code = ?",
        params: [`INT-${task.task_code}-${batchCode}`, normDate(v["執行日期"]), result, [summaryText, v["備註"]].filter(Boolean).join("｜"), item.row_no, batchCode, stamp, task.task_code] },
    );
    if (item.opp_code) oppUpdates.push({ opp: item.opp_code, v, result, task: task.task_code });
  }
  await batch(writes);
  for (const update of oppUpdates) {
    const v = update.v;
    await advanceOpportunity(actor, update.opp, {
      contacted: true, effective: update.result === "已聯絡-有效回覆", appointment: yes(v["預約"]), visit: yes(v["到店"]) || yes(v["試乘"]), quote: yes(v["報價"]),
      won_txn_code: String(v["成交交易編碼"] ?? "").trim() || null, lost_reason: String(v["未成交原因"] ?? "").trim() || (update.result === "需求取消" ? "需求取消" : update.result === "拒收" ? "拒收" : null),
      note: `回傳 ${batchCode}（任務 ${update.task}）`,
    });
  }
  await audit(actor, "匯入回傳結果", "result_batches", batchCode, summary);
  return { result_batch_code: batchCode, duplicate_of: previous?.result_batch_code ?? null, summary, results };
}

export async function taskDetail(actor: Actor, code: string) {
  const [task] = await loadTasks(actor, [code]);
  if (!task) throw new HttpError(404, "查無任務或不在授權範圍");
  const events = await all("SELECT * FROM task_events WHERE task_code = ? ORDER BY event_id", code);
  const returns = await all("SELECT r.*, b.file_name, b.created_at, b.created_by FROM result_rows r JOIN result_batches b ON b.result_batch_code = r.result_batch_code WHERE r.task_code = ? ORDER BY b.created_at", code);
  return { task: await first("SELECT * FROM tasks WHERE task_code = ?", code), events, returns };
}

export async function exportBatches(actor: Actor) {
  const scope = workScope(actor, "t");
  return all(`SELECT e.*, COUNT(t.task_code) AS visible_tasks,
      SUM(CASE WHEN t.status IN ('已完成') THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN t.status = '待回傳' THEN 1 ELSE 0 END) AS awaiting_final,
      SUM(CASE WHEN t.status = '已匯出' THEN 1 ELSE 0 END) AS not_returned,
      SUM(CASE WHEN t.status = '已取消' THEN 1 ELSE 0 END) AS cancelled
    FROM export_batches e JOIN tasks t ON t.export_code = e.export_code AND ${scope.sql} GROUP BY e.export_code ORDER BY e.created_at DESC LIMIT 100`, ...scope.params);
}
