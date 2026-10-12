import { type Actor, HttpError, audit } from "./auth";
import { all, batch, first, jsonList, nextCodes, nowIso, run } from "./db";
import { type EntitySpec, type RowError, parseValue, specFor } from "./import-specs";

// Provenance columns each target table carries (the rest of its columns come from the spec fields).
const provenance: Record<string, string[]> = {
  units: ["source_code", "batch_code", "updated_at"],
  staff: ["source_code", "batch_code", "updated_at"],
  customers: ["source_code", "batch_code", "data_date", "updated_at"],
  vehicles: ["source_code", "batch_code", "data_date", "updated_at"],
  interactions: ["source_code", "batch_code", "updated_at"],
  satisfaction_surveys: ["source_code", "batch_code", "data_date", "updated_at"],
};
const pageSize = 300;

type Batch = { batch_code: string; entity: string; source_code: string; data_date: string | null; status: string; file_hash: string };
type Staged = { row_no: number; row_key: string; payload: string };
type Outcome = "新增" | "更新" | "無變更";

async function getBatch(batchCode: string) {
  const row = await first<Batch>("SELECT * FROM import_batches WHERE batch_code = ?", batchCode);
  if (!row) throw new HttpError(404, "查無匯入批次");
  return row;
}

async function sourcePriorities() {
  const rows = await all<{ source_code: string; priority: number }>("SELECT source_code, priority FROM sources");
  return new Map(rows.map((row) => [row.source_code, row.priority]));
}

export async function createBatch(actor: Actor, input: { entity: string; source_code: string; file_name?: string; file_hash: string; data_date: string }) {
  const spec = specFor(input.entity);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.data_date || "")) throw new HttpError(400, "請填寫資料日期（YYYY-MM-DD）");
  const source = await first<{ entity: string }>("SELECT entity FROM sources WHERE source_code = ?", input.source_code);
  if (!source) throw new HttpError(400, "未知的資料來源，請先建立來源");
  if (source.entity !== spec.entity) throw new HttpError(400, `此來源屬於「${specFor(source.entity).label}」，不能匯入「${spec.label}」`);
  const previous = await first<{ batch_code: string; finished_at: string }>(
    "SELECT batch_code, finished_at FROM import_batches WHERE file_hash = ? AND entity = ? AND source_code = ? AND status = '已完成' ORDER BY created_at DESC LIMIT 1",
    input.file_hash, spec.entity, input.source_code);
  const [code] = await nextCodes("IMP", 1);
  await run("INSERT INTO import_batches (batch_code, entity, source_code, file_name, file_hash, data_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, '預覽', ?, ?)",
    code, spec.entity, input.source_code, input.file_name ?? null, input.file_hash, input.data_date, actor.email, nowIso());
  await audit(actor, "建立匯入批次", "import_batches", code, { entity: spec.entity, source: input.source_code, file: input.file_name, previous: previous?.batch_code });
  return { batch_code: code, duplicate_of: previous ?? null };
}

function rowKey(spec: EntitySpec, values: Record<string, unknown>) {
  return spec.keys.map((key) => String(values[key] ?? "")).join("|");
}

/** Validates field formats and stages rows; duplicate keys inside the same file are rejected. */
export async function stageRows(batchCode: string, rows: { row_no: number; values: Record<string, unknown> }[]) {
  const current = await getBatch(batchCode);
  if (current.status !== "預覽") throw new HttpError(409, "此批次已確認匯入或已拒絕，無法再加入資料");
  const spec = specFor(current.entity);
  const known = new Set(spec.fields.map((field) => field.key));
  const staged: { sql: string; params: unknown[] }[] = [];
  const errors: { row_no: number; error: RowError }[] = [];
  for (const row of rows) {
    const values: Record<string, unknown> = {};
    const rowErrors: RowError[] = [];
    for (const field of spec.fields) {
      const parsed = parseValue(field, row.values[field.key]);
      if (parsed.error) rowErrors.push(parsed.error);
      values[field.key] = parsed.value;
    }
    if (spec.kind === "summary") {
      // Summary files keep every other column as-is (numbers stay numbers, blanks stay missing).
      for (const [key, raw] of Object.entries(row.values)) {
        if (known.has(key)) continue;
        const text = raw === null || raw === undefined ? "" : String(raw).trim();
        values[key] = text === "" ? null : /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
      }
    }
    if (rowErrors.length) {
      rowErrors.forEach((error) => errors.push({ row_no: row.row_no, error }));
      staged.push({ sql: "INSERT OR REPLACE INTO import_staging (batch_code, row_no, row_key, payload, status) VALUES (?, ?, ?, ?, '錯誤')", params: [batchCode, row.row_no, `#error:${row.row_no}`, JSON.stringify(values)] });
    } else {
      staged.push({ sql: "INSERT INTO import_staging (batch_code, row_no, row_key, payload, status) VALUES (?, ?, ?, ?, '待處理') ON CONFLICT(batch_code, row_key) DO NOTHING", params: [batchCode, row.row_no, rowKey(spec, values), JSON.stringify(values)] });
    }
  }
  await batch(staged);
  // Rows whose key already existed in this batch were not inserted → in-file duplicates.
  const accepted = new Set((await all<{ row_no: number }>(`SELECT row_no FROM import_staging WHERE batch_code = ? AND row_no IN (SELECT value FROM json_each(?))`, batchCode, jsonList(rows.map((row) => row.row_no)))).map((row) => row.row_no));
  for (const row of rows) if (!accepted.has(row.row_no)) errors.push({ row_no: row.row_no, error: { field: spec.keys.join("+"), code: "duplicate_in_file", message: `與檔案中前面的資料鍵值重複（${spec.keys.map((key) => specFor(spec.entity).fields.find((field) => field.key === key)?.label ?? key).join("＋")}）` } });
  await batch(errors.map(({ row_no, error }) => ({ sql: "INSERT INTO import_errors (batch_code, row_no, field, error_code, message) VALUES (?, ?, ?, ?, ?)", params: [batchCode, row_no, error.field, error.code, error.message] })));
  await run("UPDATE import_batches SET total_rows = total_rows + ? WHERE batch_code = ?", rows.length, batchCode);
  return { staged: rows.length, errors: errors.length };
}

/** Marks staged rows whose referenced codes do not exist (關聯編碼缺漏). */
export async function checkReferences(batchCode: string) {
  const current = await getBatch(batchCode);
  const spec = specFor(current.entity);
  let missing = 0;
  for (const field of spec.fields.filter((item) => item.ref)) {
    const condition = `s.batch_code = ? AND s.status = '待處理' AND json_extract(s.payload, '$.${field.key}') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${field.ref!.table} t WHERE t.${field.ref!.column} = json_extract(s.payload, '$.${field.key}'))`;
    const result = await run(`INSERT INTO import_errors (batch_code, row_no, field, error_code, message) SELECT s.batch_code, s.row_no, '${field.key}', 'missing_ref', '${field.label} 在平台中不存在：' || json_extract(s.payload, '$.${field.key}') FROM import_staging s WHERE ${condition}`, batchCode);
    missing += result.meta.changes ?? 0;
    await run(`UPDATE import_staging AS s SET status = '錯誤' WHERE ${condition}`, batchCode);
  }
  return { missing };
}

function mergeRecord(existing: Record<string, unknown> | undefined, incoming: Record<string, unknown>, fields: string[], priorities: Map<string, number>, incomingSource: string, incomingDate: string | null) {
  if (!existing) return { merged: { ...incoming }, outcome: "新增" as Outcome };
  const existingPriority = priorities.get(String(existing.source_code ?? "")) ?? 999;
  const incomingPriority = priorities.get(incomingSource) ?? 999;
  // 衝突規則：缺值不覆蓋既有值；雙方皆有值且不同時，優先順序數字小的來源勝；同優先順序時資料日期較新者勝。
  const incomingWins = incomingPriority < existingPriority || (incomingPriority === existingPriority && String(incomingDate ?? "") >= String(existing.data_date ?? ""));
  const merged: Record<string, unknown> = { ...existing };
  let changed = false;
  for (const field of fields) {
    const next = incoming[field], previous = existing[field];
    if (next === null || next === undefined) continue;
    if (previous === null || previous === undefined || (previous !== next && incomingWins)) {
      if (previous !== next) { merged[field] = next; changed = true; }
    }
  }
  return { merged, outcome: (changed ? "更新" : "無變更") as Outcome };
}

async function processRecords(spec: EntitySpec, current: Batch, rows: Staged[], write: boolean) {
  const priorities = await sourcePriorities();
  const key = spec.keys[0];
  const existing = new Map((await all<Record<string, unknown>>(`SELECT * FROM ${spec.table} WHERE ${key} IN (SELECT value FROM json_each(?))`, jsonList(rows.map((row) => row.row_key)))).map((row) => [String(row[key]), row]));
  const fields = spec.fields.map((field) => field.key);
  const extra = provenance[spec.table] ?? [];
  const columns = [...fields, ...extra];
  const outcomes: { row_no: number; outcome: Outcome }[] = [];
  const writes: { sql: string; params: unknown[] }[] = [];
  const stamp = nowIso();
  for (const row of rows) {
    const incoming = JSON.parse(row.payload) as Record<string, unknown>;
    const previous = existing.get(row.row_key);
    const { merged, outcome } = mergeRecord(previous, incoming, fields, priorities, current.source_code, current.data_date);
    outcomes.push({ row_no: row.row_no, outcome });
    if (!write || outcome === "無變更") continue;
    const incomingPriority = priorities.get(current.source_code) ?? 999, previousPriority = priorities.get(String(previous?.source_code ?? "")) ?? 999;
    const record: Record<string, unknown> = { ...merged, source_code: !previous || incomingPriority <= previousPriority ? current.source_code : previous.source_code, batch_code: current.batch_code, data_date: current.data_date, updated_at: stamp };
    // Only columns that carry a value are written, so table defaults apply to new rows and missing values never blank out existing ones.
    const present = columns.filter((column) => record[column] !== null && record[column] !== undefined);
    writes.push({ sql: `INSERT INTO ${spec.table} (${present.join(", ")}) VALUES (${present.map(() => "?").join(", ")}) ON CONFLICT(${key}) DO UPDATE SET ${present.filter((column) => column !== key).map((column) => `${column} = excluded.${column}`).join(", ")}`, params: present.map((column) => record[column]) });
  }
  if (writes.length) await batch(writes);
  return outcomes;
}

const relationShape: Record<string, { sub: string[]; typeField: string | null; table: string }> = {
  vehicle_relations: { sub: ["customer_code", "relation"], typeField: "relation", table: "vehicle_relations" },
  vehicle_staff: { sub: ["staff_role", "staff_code"], typeField: "staff_role", table: "vehicle_staff" },
  relation_groups: { sub: ["customer_code"], typeField: null, table: "relation_group_members" },
};

async function processRelations(spec: EntitySpec, current: Batch, groups: string[], write: boolean) {
  const shape = relationShape[spec.entity];
  const groupKey = spec.groupKey!;
  const staged = await all<Staged>(`SELECT row_no, row_key, payload FROM import_staging WHERE batch_code = ? AND status != '錯誤' AND json_extract(payload, '$.${groupKey}') IN (SELECT value FROM json_each(?)) ORDER BY row_no`, current.batch_code, jsonList(groups));
  const existing = await all<Record<string, unknown>>(`SELECT * FROM ${shape.table} WHERE ${groupKey} IN (SELECT value FROM json_each(?))`, jsonList(groups));
  const stamp = nowIso();
  const outcomes: { row_no: number; outcome: Outcome }[] = [];
  const writes: { sql: string; params: unknown[] }[] = [];
  let closed = 0;
  const subKey = (row: Record<string, unknown>) => shape.sub.map((field) => String(row[field] ?? "")).join("|");
  for (const group of groups) {
    const incoming = staged.filter((row) => String(JSON.parse(row.payload)[groupKey]) === group).map((row) => ({ row, values: JSON.parse(row.payload) as Record<string, unknown> }));
    const history = existing.filter((row) => String(row[groupKey]) === group);
    const open = history.filter((row) => row.valid_to === null || row.valid_to === undefined);
    const incomingTypes = new Set(incoming.map(({ values }) => (shape.typeField ? String(values[shape.typeField]) : "*")));
    for (const { row, values } of incoming) {
      const match = open.find((item) => subKey(item) === subKey(values));
      if (match) {
        const endChanged = values.valid_to && values.valid_to !== match.valid_to;
        outcomes.push({ row_no: row.row_no, outcome: endChanged ? "更新" : "無變更" });
        if (write && endChanged) writes.push({ sql: `UPDATE ${shape.table} SET valid_to = ?, batch_code = ?, updated_at = ? WHERE ${spec.keys.map((key) => `${key} = ?`).join(" AND ")}`, params: [values.valid_to, current.batch_code, stamp, ...spec.keys.map((key) => match[key] ?? "")] });
        continue;
      }
      const sameTypeHistory = history.some((item) => !shape.typeField || item[shape.typeField] === values[shape.typeField]);
      const validFrom = (values.valid_from as string | null) ?? (sameTypeHistory ? current.data_date : "");
      outcomes.push({ row_no: row.row_no, outcome: "新增" });
      if (!write) continue;
      if (spec.entity === "relation_groups") {
        writes.push({ sql: "INSERT INTO relation_groups (group_code, group_type, source_code, batch_code, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(group_code) DO UPDATE SET group_type = excluded.group_type, batch_code = excluded.batch_code, updated_at = excluded.updated_at", params: [values.group_code, values.group_type, current.source_code, current.batch_code, stamp] });
        writes.push({ sql: "INSERT OR IGNORE INTO relation_group_members (group_code, customer_code, member_role, valid_from, valid_to, source_code, batch_code, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", params: [values.group_code, values.customer_code, values.member_role ?? null, validFrom, values.valid_to ?? null, current.source_code, current.batch_code, stamp] });
      } else if (spec.entity === "vehicle_relations") {
        writes.push({ sql: "INSERT OR IGNORE INTO vehicle_relations (vehicle_code, customer_code, relation, valid_from, valid_to, source_code, source_record_id, batch_code, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", params: [values.vehicle_code, values.customer_code, values.relation, validFrom, values.valid_to ?? null, current.source_code, values.source_record_id ?? null, current.batch_code, stamp] });
      } else {
        writes.push({ sql: "INSERT OR IGNORE INTO vehicle_staff (vehicle_code, staff_role, staff_code, valid_from, valid_to, source_code, batch_code, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", params: [values.vehicle_code, values.staff_role, values.staff_code, validFrom, values.valid_to ?? null, current.source_code, current.batch_code, stamp] });
      }
    }
    // 轉手／換人：本檔中此車（此類型）已不存在的現行關係補上結束日，保留歷史而不刪除。
    for (const item of open) {
      if (shape.typeField && !incomingTypes.has(String(item[shape.typeField]))) continue;
      if (incoming.some(({ values }) => subKey(values) === subKey(item))) continue;
      closed += 1;
      if (write) writes.push({ sql: `UPDATE ${shape.table} SET valid_to = ?, batch_code = ?, updated_at = ? WHERE ${spec.keys.map((key) => `${key} = ?`).join(" AND ")}`, params: [current.data_date, current.batch_code, stamp, ...spec.keys.map((key) => item[key] ?? "")] });
    }
  }
  if (writes.length) await batch(writes);
  return { outcomes, closed };
}

function stableHash(value: unknown) {
  const text = JSON.stringify(value, Object.keys(value as object).sort());
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16) + ":" + text.length;
}

const txnFields = ["txn_type", "vehicle_code", "customer_code", "txn_date", "unit_code", "advisor_code", "technician_code", "mileage", "amount", "cost", "margin"];

async function processTransactions(current: Batch, rows: Staged[], write: boolean) {
  const existing = new Map((await all<{ source_record_id: string; payload_hash: string; txn_code: string }>("SELECT source_record_id, payload_hash, txn_code FROM transaction_source_records WHERE source_code = ? AND source_record_id IN (SELECT value FROM json_each(?))", current.source_code, jsonList(rows.map((row) => row.row_key)))).map((row) => [row.source_record_id, row]));
  const outcomes: { row_no: number; outcome: Outcome }[] = [];
  const writes: { sql: string; params: unknown[] }[] = [];
  const touched = new Set<string>();
  const stamp = nowIso();
  for (const row of rows) {
    const values = JSON.parse(row.payload) as Record<string, unknown>;
    const hash = stableHash(values);
    const previous = existing.get(String(values.source_record_id));
    const outcome: Outcome = !previous ? "新增" : previous.payload_hash === hash ? "無變更" : "更新";
    outcomes.push({ row_no: row.row_no, outcome });
    if (!write || outcome === "無變更") continue;
    if (previous && previous.txn_code !== values.txn_code) touched.add(previous.txn_code);
    touched.add(String(values.txn_code));
    writes.push({ sql: "INSERT INTO transaction_source_records (txn_code, source_code, source_record_id, payload_hash, payload, batch_code, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_code, source_record_id) DO UPDATE SET txn_code = excluded.txn_code, payload_hash = excluded.payload_hash, payload = excluded.payload, batch_code = excluded.batch_code, updated_at = excluded.updated_at", params: [values.txn_code, current.source_code, values.source_record_id, hash, row.payload, current.batch_code, stamp] });
  }
  if (writes.length) await batch(writes);
  if (write && touched.size) await rebuildTransactions([...touched], current, stamp);
  return outcomes;
}

/** Merges all source records of each transaction: per field, the highest-priority source with a value wins. */
async function rebuildTransactions(txnCodes: string[], current: Batch, stamp: string) {
  const records = await all<{ txn_code: string; source_code: string; payload: string; priority: number }>(
    "SELECT r.txn_code, r.source_code, r.payload, COALESCE(s.priority, 999) AS priority FROM transaction_source_records r LEFT JOIN sources s ON s.source_code = r.source_code WHERE r.txn_code IN (SELECT value FROM json_each(?)) ORDER BY r.txn_code, priority, r.updated_at DESC",
    jsonList(txnCodes));
  const grouped = new Map<string, typeof records>();
  for (const record of records) grouped.set(record.txn_code, [...(grouped.get(record.txn_code) ?? []), record]);
  const writes: { sql: string; params: unknown[] }[] = [];
  for (const code of txnCodes) {
    const list = grouped.get(code);
    if (!list?.length) { writes.push({ sql: "DELETE FROM transactions WHERE txn_code = ?", params: [code] }); continue; }
    const merged: Record<string, unknown> = {};
    for (const field of txnFields) {
      for (const record of list) { const value = (JSON.parse(record.payload) as Record<string, unknown>)[field]; if (value !== null && value !== undefined) { merged[field] = value; break; } }
    }
    writes.push({ sql: `INSERT INTO transactions (txn_code, ${txnFields.join(", ")}, source_code, batch_code, data_date, updated_at) VALUES (?, ${txnFields.map(() => "?").join(", ")}, ?, ?, ?, ?) ON CONFLICT(txn_code) DO UPDATE SET ${txnFields.map((field) => `${field} = excluded.${field}`).join(", ")}, source_code = excluded.source_code, batch_code = excluded.batch_code, data_date = excluded.data_date, updated_at = excluded.updated_at`,
      params: [code, ...txnFields.map((field) => merged[field] ?? null), list[0].source_code, current.batch_code, current.data_date, stamp] });
  }
  await batch(writes);
}

async function processSummary(current: Batch, rows: Staged[], write: boolean) {
  const existing = new Map((await all<{ vehicle_code: string; payload: string }>("SELECT vehicle_code, payload FROM vehicle_service_summary WHERE vehicle_code IN (SELECT value FROM json_each(?))", jsonList(rows.map((row) => row.row_key)))).map((row) => [row.vehicle_code, row.payload]));
  const outcomes: { row_no: number; outcome: Outcome }[] = [];
  const writes: { sql: string; params: unknown[] }[] = [];
  for (const row of rows) {
    const values = JSON.parse(row.payload) as Record<string, unknown>;
    const code = String(values.vehicle_code);
    delete values.vehicle_code;
    const payload = JSON.stringify(values, Object.keys(values).sort());
    const previous = existing.get(code);
    const outcome: Outcome = previous === undefined ? "新增" : previous === payload ? "無變更" : "更新";
    outcomes.push({ row_no: row.row_no, outcome });
    if (write && outcome !== "無變更") writes.push({ sql: "INSERT INTO vehicle_service_summary (vehicle_code, payload, source_code, batch_code, data_date, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(vehicle_code) DO UPDATE SET payload = excluded.payload, source_code = excluded.source_code, batch_code = excluded.batch_code, data_date = excluded.data_date, updated_at = excluded.updated_at", params: [code, payload, current.source_code, current.batch_code, current.data_date, nowIso()] });
  }
  if (writes.length) await batch(writes);
  return outcomes;
}

/** Processes one page of a batch. write=false is the preview (dry run); write=true commits. Returns the next cursor. */
export async function processPage(batchCode: string, cursor: string | null, write: boolean) {
  const current = await getBatch(batchCode);
  if (current.status !== "預覽" && current.status !== "匯入中") throw new HttpError(409, "此批次已結束");
  if (write && current.status === "預覽") await run("UPDATE import_batches SET status = '匯入中' WHERE batch_code = ?", batchCode);
  const spec = specFor(current.entity);
  let outcomes: { row_no: number; outcome: Outcome }[] = [];
  let next: string | null = null;
  let closed = 0;
  if (spec.kind === "relation") {
    const groups = (await all<{ g: string }>(`SELECT DISTINCT json_extract(payload, '$.${spec.groupKey}') AS g FROM import_staging WHERE batch_code = ? AND status != '錯誤' AND json_extract(payload, '$.${spec.groupKey}') > ? ORDER BY g LIMIT ?`, batchCode, cursor ?? "", pageSize)).map((row) => row.g);
    if (groups.length) { const result = await processRelations(spec, current, groups, write); outcomes = result.outcomes; closed = result.closed; next = groups.length === pageSize ? groups[groups.length - 1] : null; }
  } else {
    const rows = await all<Staged>("SELECT row_no, row_key, payload FROM import_staging WHERE batch_code = ? AND status != '錯誤' AND row_no > ? ORDER BY row_no LIMIT ?", batchCode, Number(cursor ?? 0), pageSize);
    if (rows.length) {
      outcomes = spec.kind === "transaction" ? await processTransactions(current, rows, write) : spec.kind === "summary" ? await processSummary(current, rows, write) : await processRecords(spec, current, rows, write);
      next = rows.length === pageSize ? String(rows[rows.length - 1].row_no) : null;
    }
  }
  if (outcomes.length) await batch(outcomes.map((item) => ({ sql: `UPDATE import_staging SET outcome = ?, status = ? WHERE batch_code = ? AND row_no = ?`, params: [item.outcome, write ? "已處理" : "待處理", batchCode, item.row_no] })));
  if (closed) await run(`UPDATE import_batches SET ${write ? "updated = updated + ?" : "updated = updated"} WHERE batch_code = ?`, ...(write ? [closed, batchCode] : [batchCode]));
  return { next, processed: outcomes.length, closed };
}

export async function batchSummary(batchCode: string) {
  const current = await getBatch(batchCode);
  const staged = await all<{ outcome: string | null; status: string; n: number }>("SELECT outcome, status, COUNT(*) AS n FROM import_staging WHERE batch_code = ? GROUP BY outcome, status", batchCode);
  const errors = await all<{ row_no: number; field: string | null; error_code: string; message: string }>("SELECT row_no, field, error_code, message FROM import_errors WHERE batch_code = ? ORDER BY row_no LIMIT 300", batchCode);
  const errorTypes = await all<{ error_code: string; n: number }>("SELECT error_code, COUNT(*) AS n FROM import_errors WHERE batch_code = ? GROUP BY error_code", batchCode);
  const failedRows = await first<{ n: number }>("SELECT COUNT(DISTINCT row_no) AS n FROM import_errors WHERE batch_code = ?", batchCode);
  const sample = await all<{ row_no: number; payload: string; outcome: string | null }>("SELECT row_no, payload, outcome FROM import_staging WHERE batch_code = ? AND status != '錯誤' ORDER BY row_no LIMIT 15", batchCode);
  const tally = (outcome: string) => staged.filter((row) => row.outcome === outcome && row.status !== "錯誤").reduce((sum, row) => sum + row.n, 0);
  const full = await first<Record<string, unknown>>("SELECT * FROM import_batches WHERE batch_code = ?", batchCode);
  const finished = current.status === "已完成" || current.status === "已拒絕";
  const counts = finished
    ? { insert: Number(full?.inserted ?? 0), update: Number(full?.updated ?? 0), unchanged: Number(full?.unchanged ?? 0), failed: Number(full?.failed ?? 0), closed: 0 }
    : { insert: tally("新增"), update: tally("更新"), unchanged: tally("無變更"), failed: failedRows?.n ?? 0, closed: Number(full?.updated ?? 0) };
  return { batch: full, counts, errors, errorTypes, sample: sample.map((row) => ({ row_no: row.row_no, outcome: row.outcome, values: JSON.parse(row.payload) })), entity: current.entity };
}

export async function finalizeBatch(actor: Actor, batchCode: string, decision: "commit" | "reject") {
  const current = await getBatch(batchCode);
  if (decision === "reject") {
    await run("UPDATE import_batches SET status = '已拒絕', finished_at = ? WHERE batch_code = ?", nowIso(), batchCode);
    await run("DELETE FROM import_staging WHERE batch_code = ?", batchCode);
    await audit(actor, "放棄匯入批次", "import_batches", batchCode, {});
    return batchSummary(batchCode);
  }
  const pending = await first<{ n: number }>("SELECT COUNT(*) AS n FROM import_staging WHERE batch_code = ? AND status = '待處理'", batchCode);
  if ((pending?.n ?? 0) > 0) throw new HttpError(409, `尚有 ${pending!.n} 筆未寫入，請完成匯入步驟`);
  const summary = await batchSummary(batchCode);
  await run("UPDATE import_batches SET status = '已完成', inserted = ?, updated = updated + ?, unchanged = ?, failed = ?, finished_at = ? WHERE batch_code = ?",
    summary.counts.insert, summary.counts.update, summary.counts.unchanged, summary.counts.failed, nowIso(), batchCode);
  await run("UPDATE sources SET status = '已串接', last_batch_code = ?, last_imported_at = ? WHERE source_code = ?", batchCode, nowIso(), current.source_code);
  await run("DELETE FROM import_staging WHERE batch_code = ?", batchCode);
  await bumpDataVersion(actor.email);
  await audit(actor, "完成匯入批次", "import_batches", batchCode, summary.counts);
  return batchSummary(batchCode);
}

export async function bumpDataVersion(actor: string) {
  await run("INSERT INTO app_settings (setting_key, setting_value, description, updated_by, updated_at) VALUES ('data_version', '1', '資料版本（匯入完成時遞增，分析快取據此更新）', ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = CAST(setting_value AS INTEGER) + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at", actor, nowIso());
}
