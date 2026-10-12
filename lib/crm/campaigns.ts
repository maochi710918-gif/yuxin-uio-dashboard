import { type Actor, HttpError, audit, customerScope, requireRole } from "./auth";
import { all, batch, first, nextCodes, nowIso, run } from "./db";
import { type ConditionGroup, baseCte, compile, describe, ensureSnapshot, parseDefinition } from "./segments";
import { analysisAsOf } from "./settings";
import { type TaskDraft, draftsFromDefinition, insertTasks } from "./tasks";

const exclusionCase = `CASE WHEN b.opt_out = 1 THEN '拒收' WHEN b.contact_eligible IS NULL THEN '聯絡資格資料不足' WHEN b.contact_eligible = 0 THEN '不可聯絡（未授權或地端註記）' WHEN b.complaint_open = 1 THEN '客訴處理中（暫停促銷）' ELSE NULL END`;

export async function segmentDefinition(input: { segment_code?: string; definition?: unknown }) {
  if (input.segment_code) {
    const segment = await first<{ definition: string; version: number; name: string }>("SELECT definition, version, name FROM segments WHERE segment_code = ?", input.segment_code);
    if (!segment) throw new HttpError(404, "查無客群");
    return { definition: parseDefinition(segment.definition), version: segment.version, name: segment.name };
  }
  return { definition: parseDefinition(input.definition), version: null, name: null };
}

export async function saveSegment(actor: Actor, input: { segment_code?: string; name: string; description?: string; definition: unknown }) {
  const definition = parseDefinition(input.definition);
  compile(definition, []); // validates fields and operators
  const stamp = nowIso();
  if (input.segment_code) {
    const existing = await first<{ is_preset: number; version: number }>("SELECT is_preset, version FROM segments WHERE segment_code = ?", input.segment_code);
    if (!existing) throw new HttpError(404, "查無客群");
    if (existing.is_preset && actor.role !== "company_manager") throw new HttpError(403, "預設客群僅公司主管可修改");
    await run("UPDATE segments SET name = ?, description = ?, definition = ?, version = version + 1, updated_at = ? WHERE segment_code = ?", input.name, input.description ?? "", JSON.stringify(definition), stamp, input.segment_code);
    await audit(actor, "更新客群", "segments", input.segment_code, { version: existing.version + 1, definition });
    return input.segment_code;
  }
  const [code] = await nextCodes("SEG", 1);
  await run("INSERT INTO segments (segment_code, name, description, definition, is_preset, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)", code, input.name, input.description ?? describe(definition), JSON.stringify(definition), actor.email, stamp, stamp);
  await audit(actor, "建立客群", "segments", code, { definition });
  return code;
}

export async function deleteSegment(actor: Actor, code: string) {
  const existing = await first<{ is_preset: number }>("SELECT is_preset FROM segments WHERE segment_code = ?", code);
  if (!existing) throw new HttpError(404, "查無客群");
  if (existing.is_preset) throw new HttpError(403, "預設客群不可刪除");
  await run("DELETE FROM segments WHERE segment_code = ?", code);
  await audit(actor, "刪除客群", "segments", code, {});
}

/** Freezes the segment's current members (included and excluded, with reasons) as a campaign list. */
export async function createCampaign(actor: Actor, input: { name: string; segment_code?: string; definition?: unknown; cost?: number | null; start_date?: string; end_date?: string }) {
  requireRole(actor, ["company_manager", "branch_manager"]);
  if (!input.name?.trim()) throw new HttpError(400, "請填寫活動名稱");
  const { definition, version } = await segmentDefinition(input);
  await ensureSnapshot();
  const asOf = await analysisAsOf();
  const compiled = compile(definition, []);
  const scope = customerScope(actor, "sc");
  const reason = describe(definition);
  const rows = await all<{ customer_code: string; vehicle_code: string | null; exclusion: string | null }>(`${baseCte} SELECT b.customer_code, b.vehicle_code, ${exclusionCase} AS exclusion FROM b WHERE (${compiled.sql}) AND EXISTS (SELECT 1 FROM customers sc WHERE sc.customer_code = b.customer_code AND ${scope.sql})`, asOf, ...compiled.params, ...scope.params);
  const [code] = await nextCodes("CMP", 1);
  const stamp = nowIso();
  await run("INSERT INTO campaigns (campaign_code, name, segment_code, segment_version, cost, start_date, end_date, status, snapshot_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '進行中', ?, ?, ?)",
    code, input.name.trim(), input.segment_code ?? null, version, input.cost ?? null, input.start_date ?? null, input.end_date ?? null, stamp, actor.email, stamp);
  await batch(rows.map((row) => ({ sql: "INSERT OR IGNORE INTO campaign_members (campaign_code, customer_code, vehicle_code, included, reason) VALUES (?, ?, ?, ?, ?)", params: [code, row.customer_code, row.vehicle_code ?? "", row.exclusion ? 0 : 1, row.exclusion ? `排除：${row.exclusion}` : reason] })));
  await audit(actor, "建立活動名單快照", "campaigns", code, { segment: input.segment_code, members: rows.length, asOf });
  return { campaign_code: code, members: rows.length, included: rows.filter((row) => !row.exclusion).length, excluded: rows.filter((row) => row.exclusion).length, asOf };
}

export async function listCampaigns() {
  return all(`SELECT c.*, (SELECT COUNT(*) FROM campaign_members m WHERE m.campaign_code = c.campaign_code AND m.included = 1) AS included,
    (SELECT COUNT(*) FROM campaign_members m WHERE m.campaign_code = c.campaign_code AND m.included = 0) AS excluded,
    (SELECT COUNT(*) FROM tasks t WHERE t.campaign_code = c.campaign_code) AS tasks FROM campaigns c ORDER BY c.created_at DESC LIMIT 100`);
}

export type BulkTaskInput = { segment_code?: string; definition?: unknown; campaign_code?: string; task_type: string; action: string; due_days: number; owner_role: "sales" | "advisor" | "unit"; priority: number };

/** Creates tasks for every 可執行 member of a segment (live) or a campaign (snapshot). */
export async function createTasks(actor: Actor, input: BulkTaskInput) {
  requireRole(actor, ["company_manager", "branch_manager"]);
  if (!input.task_type?.trim() || !input.action?.trim()) throw new HttpError(400, "請填寫任務類型與建議行動");
  let drafts: TaskDraft[] = [];
  let excluded = 0;
  if (input.campaign_code) {
    const campaign = await first<{ campaign_code: string; segment_code: string | null }>("SELECT campaign_code, segment_code FROM campaigns WHERE campaign_code = ?", input.campaign_code);
    if (!campaign) throw new HttpError(404, "查無活動");
    await ensureSnapshot();
    const asOf = await analysisAsOf();
    const scope = customerScope(actor, "sc");
    const rows = await all<{ customer_code: string; vehicle_code: string; reason: string; sales_code: string | null; advisor_code: string | null; service_unit_code: string | null }>(
      `${baseCte} SELECT m.customer_code, m.vehicle_code, m.reason, b.sales_code, b.advisor_code, b.service_unit_code FROM campaign_members m LEFT JOIN b ON b.customer_code = m.customer_code AND COALESCE(b.vehicle_code, '') = m.vehicle_code
       WHERE m.campaign_code = ? AND m.included = 1 AND EXISTS (SELECT 1 FROM customers sc WHERE sc.customer_code = m.customer_code AND ${scope.sql})`, asOf, input.campaign_code, ...scope.params);
    drafts = rows.map((row) => ({ customer_code: row.customer_code, vehicle_code: row.vehicle_code || null, reason: row.reason, owner_staff_code: input.owner_role === "sales" ? row.sales_code : input.owner_role === "advisor" ? row.advisor_code : null, owner_unit_code: row.service_unit_code }));
  } else {
    const { definition } = await segmentDefinition(input);
    const candidates = await draftsFromDefinition(actor, definition as ConditionGroup, input.owner_role);
    drafts = candidates.filter(({ row }) => { const ok = row.opt_out !== 1 && row.contact_eligible === 1 && row.complaint_open !== 1; if (!ok) excluded += 1; return ok; }).map(({ draft }) => draft);
  }
  const result = await insertTasks(actor, { task_type: input.task_type.trim(), action: input.action.trim(), due_days: Number(input.due_days) || 7, priority: Number(input.priority) || 3, segment_code: input.segment_code ?? null, campaign_code: input.campaign_code ?? null, initial_status: input.owner_role === "unit" ? "待處理" : "待匯出" }, drafts);
  await audit(actor, "批次建立任務", "tasks", null, { ...input, definition: undefined, created: result.created.length, duplicates: result.duplicates, excluded });
  return { created: result.created.length, duplicates: result.duplicates, excluded, unassigned: drafts.filter((draft) => !draft.owner_staff_code).length };
}
