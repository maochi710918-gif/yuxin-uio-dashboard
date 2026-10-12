import { type Actor, HttpError, assertCustomerAccess, audit, workScope } from "./auth";
import { all, batch, first, nextCodes, nowIso, today } from "./db";

export const oppTypes = ["新車", "換購", "增購", "保險", "售後服務"] as const;
// 漏斗階段（依序）；「未成交」為結案狀態，保留曾到達的最遠階段 max_stage_rank。
export const stages = ["分派", "已聯絡", "有效回覆", "預約", "到店試乘", "報價", "成交"] as const;
export const stageRank = (stage: string) => stages.indexOf(stage as (typeof stages)[number]);

type Opp = { opp_code: string; customer_code: string; stage: string; max_stage_rank: number; owner_staff_code: string | null; owner_unit_code: string | null; handover_status: string; origin: string; referral_by_staff: string | null; referral_from_unit: string | null };

function event(opp: string, type: string, from: string | null, to: string | null, note: string | null, actor: Actor, at: string) {
  return { sql: "INSERT INTO opportunity_events (opp_code, event_type, from_value, to_value, note, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)", params: [opp, type, from, to, note, actor.actingAs ? `${actor.email}（代理 ${actor.actingAs}）` : actor.email, at] };
}

async function loadOpp(actor: Actor, code: string) {
  const scope = workScope(actor, "o");
  const opp = await first<Opp>(`SELECT * FROM opportunities o WHERE o.opp_code = ? AND (${scope.sql} OR (o.referral_by_staff IS NOT NULL AND o.referral_by_staff = ?))`, code, ...scope.params, actor.staffCode ?? "");
  if (!opp) throw new HttpError(404, "查無商機或不在授權範圍");
  return opp;
}

export type OppInput = {
  opp_type: string; customer_code: string; vehicle_code?: string | null; origin?: string; need?: string; product?: string; budget_band?: string;
  expected_decision_date?: string; owner_staff_code?: string | null; owner_unit_code?: string | null; next_step?: string; next_due_date?: string;
  referral_from_unit?: string; referral_by_staff?: string; referral_need?: string; rule_code?: string; rule_version?: number;
};

export async function createOpportunity(actor: Actor, input: OppInput, options: { skipAccessCheck?: boolean } = {}) {
  if (!oppTypes.includes(input.opp_type as (typeof oppTypes)[number])) throw new HttpError(400, `商機類型需為：${oppTypes.join("、")}`);
  if (!options.skipAccessCheck) await assertCustomerAccess(actor, input.customer_code);
  const referral = input.origin === "售後轉介";
  if (referral && !input.owner_staff_code && !input.owner_unit_code) throw new HttpError(400, "售後轉介需指定接手人員或單位");
  const [code] = await nextCodes("OPP", 1);
  const stamp = nowIso();
  const owner = input.owner_staff_code ?? (referral ? null : actor.staffCode);
  await batch([
    { sql: `INSERT INTO opportunities (opp_code, opp_type, customer_code, vehicle_code, origin, need, product, budget_band, expected_decision_date, stage, max_stage_rank, owner_staff_code, owner_unit_code, handover_status, referral_from_unit, referral_by_staff, referral_need, next_step, next_due_date, rule_code, rule_version, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '分派', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [code, input.opp_type, input.customer_code, input.vehicle_code ?? null, input.origin ?? "手動", input.need ?? null, input.product ?? null, input.budget_band ?? null, input.expected_decision_date ?? null,
        owner, input.owner_unit_code ?? actor.unitCode, referral || (owner && owner !== actor.staffCode) ? "待接手" : "已接手",
        input.referral_from_unit ?? (referral ? actor.unitCode : null), input.referral_by_staff ?? (referral ? actor.staffCode : null), input.referral_need ?? null,
        input.next_step ?? null, input.next_due_date ?? null, input.rule_code ?? null, input.rule_version ?? null, actor.email, stamp, stamp] },
    event(code, "建立", null, "分派", [input.origin ?? "手動", input.need].filter(Boolean).join("：") || null, actor, stamp),
  ]);
  await audit(actor, "建立商機", "opportunities", code, input);
  return code;
}

export async function listOpportunities(actor: Actor, filters: { stage?: string; type?: string; owner?: string; handover?: string; origin?: string; search?: string; overdue?: boolean; page: number; pageSize: number }) {
  const scope = workScope(actor, "o");
  const where = [`(${scope.sql} OR (o.referral_by_staff IS NOT NULL AND o.referral_by_staff = ?))`], params: unknown[] = [...scope.params, actor.staffCode ?? ""];
  if (filters.stage) { where.push("o.stage = ?"); params.push(filters.stage); }
  if (filters.type) { where.push("o.opp_type = ?"); params.push(filters.type); }
  if (filters.owner) { where.push("o.owner_staff_code = ?"); params.push(filters.owner); }
  if (filters.handover) { where.push("o.handover_status = ?"); params.push(filters.handover); }
  if (filters.origin) { where.push("o.origin = ?"); params.push(filters.origin); }
  if (filters.search) { where.push("(o.opp_code LIKE ? OR o.customer_code LIKE ? OR o.vehicle_code LIKE ?)"); params.push(...Array(3).fill(`%${filters.search}%`)); }
  if (filters.overdue) { where.push("o.stage NOT IN ('成交', '未成交') AND o.next_due_date < ?"); params.push(today()); }
  const sql = where.join(" AND ");
  const total = await first<{ n: number }>(`SELECT COUNT(*) AS n FROM opportunities o WHERE ${sql}`, ...params);
  const rows = await all(`SELECT o.*, s.display_name AS owner_name, t.amount AS won_amount, CASE WHEN o.stage NOT IN ('成交', '未成交') AND o.next_due_date < ? THEN 1 ELSE 0 END AS overdue
    FROM opportunities o LEFT JOIN staff s ON s.staff_code = o.owner_staff_code LEFT JOIN transactions t ON t.txn_code = o.won_txn_code
    WHERE ${sql} ORDER BY overdue DESC, o.updated_at DESC LIMIT ? OFFSET ?`, today(), ...params, filters.pageSize, (filters.page - 1) * filters.pageSize);
  return { total: total?.n ?? 0, rows };
}

/** 漏斗：每筆商機以曾到達的最遠階段計入（分派 → 成交），不因後來未成交而消失。 */
export async function funnel(actor: Actor, filters: { type?: string; origin?: string; owner?: string } = {}) {
  const scope = workScope(actor, "o");
  const where = [scope.sql], params: unknown[] = [...scope.params];
  if (filters.type) { where.push("o.opp_type = ?"); params.push(filters.type); }
  if (filters.origin) { where.push("o.origin = ?"); params.push(filters.origin); }
  if (filters.owner) { where.push("o.owner_staff_code = ?"); params.push(filters.owner); }
  const rows = await all<{ max_stage_rank: number; n: number }>(`SELECT o.max_stage_rank, COUNT(*) AS n FROM opportunities o WHERE ${where.join(" AND ")} GROUP BY o.max_stage_rank`, ...params);
  const lost = await all<{ lost_reason: string | null; n: number }>(`SELECT o.lost_reason, COUNT(*) AS n FROM opportunities o WHERE o.stage = '未成交' AND ${where.join(" AND ")} GROUP BY o.lost_reason ORDER BY n DESC`, ...params);
  const revenue = await first<{ amount: number | null; deals: number }>(`SELECT SUM(t.amount) AS amount, COUNT(t.txn_code) AS deals FROM opportunities o JOIN transactions t ON t.txn_code = o.won_txn_code WHERE o.stage = '成交' AND ${where.join(" AND ")}`, ...params);
  return { stages: stages.map((stage, index) => ({ stage, reached: rows.filter((row) => row.max_stage_rank >= index).reduce((sum, row) => sum + row.n, 0) })), lost, revenue: { amount: revenue?.amount ?? null, deals: revenue?.deals ?? 0, rule: "僅計入已連結實際交易編碼之成交；商機狀態本身不產生營收" } };
}

export async function opportunityDetail(actor: Actor, code: string) {
  const opp = await loadOpp(actor, code);
  const full = await first("SELECT o.*, t.amount AS won_amount, t.txn_date AS won_date FROM opportunities o LEFT JOIN transactions t ON t.txn_code = o.won_txn_code WHERE o.opp_code = ?", opp.opp_code);
  const events = await all("SELECT * FROM opportunity_events WHERE opp_code = ? ORDER BY event_id", code);
  const tasks = await all("SELECT task_code, task_type, status, due_date, result FROM tasks WHERE opp_code = ? ORDER BY created_at", code);
  return { opportunity: full, events, tasks };
}

export async function changeOpportunity(actor: Actor, code: string, change: { action: "accept" | "return" | "reassign" | "stage" | "close_won" | "close_lost" | "update"; stage?: string; owner_staff_code?: string; owner_unit_code?: string; reason?: string; won_txn_code?: string; next_step?: string; next_due_date?: string; expected_decision_date?: string; product?: string; budget_band?: string; need?: string }) {
  const opp = await loadOpp(actor, code);
  const stamp = nowIso();
  const closed = opp.stage === "成交" || opp.stage === "未成交";
  const writes: { sql: string; params: unknown[] }[] = [];
  const isOwner = actor.staffCode && actor.staffCode === opp.owner_staff_code;
  const isManager = actor.role === "branch_manager" || actor.role === "company_manager";
  if (closed && change.action !== "update") throw new HttpError(409, "商機已結案");
  switch (change.action) {
    case "accept":
      if (opp.handover_status !== "待接手") throw new HttpError(409, "此商機不在待接手狀態");
      if (!isOwner && !isManager) throw new HttpError(403, "只有接手人或主管可以接手");
      writes.push({ sql: "UPDATE opportunities SET handover_status = '已接手', owner_staff_code = COALESCE(owner_staff_code, ?), updated_at = ? WHERE opp_code = ?", params: [actor.staffCode, stamp, code] }, event(code, "接手", "待接手", "已接手", null, actor, stamp));
      break;
    case "return":
      if (!change.reason) throw new HttpError(400, "退回需填寫原因");
      if (!isOwner && !isManager) throw new HttpError(403, "只有接手人或主管可以退回");
      writes.push({ sql: "UPDATE opportunities SET handover_status = '已退回', owner_staff_code = referral_by_staff, owner_unit_code = COALESCE(referral_from_unit, owner_unit_code), updated_at = ? WHERE opp_code = ?", params: [stamp, code] }, event(code, "退回", opp.owner_staff_code, opp.referral_by_staff, change.reason, actor, stamp));
      break;
    case "reassign":
      if (!change.owner_staff_code && !change.owner_unit_code) throw new HttpError(400, "請指定轉派對象");
      if (!isOwner && !isManager) throw new HttpError(403, "只有負責人或主管可以轉派");
      writes.push({ sql: "UPDATE opportunities SET owner_staff_code = ?, owner_unit_code = COALESCE(?, owner_unit_code), handover_status = '待接手', updated_at = ? WHERE opp_code = ?", params: [change.owner_staff_code ?? null, change.owner_unit_code ?? null, stamp, code] }, event(code, "轉派", opp.owner_staff_code, change.owner_staff_code ?? change.owner_unit_code ?? null, change.reason ?? null, actor, stamp));
      break;
    case "stage": {
      const rank = stageRank(change.stage ?? "");
      if (rank < 0 || change.stage === "成交") throw new HttpError(400, "請選擇有效階段；成交請使用結案並填交易編碼");
      writes.push({ sql: "UPDATE opportunities SET stage = ?, max_stage_rank = MAX(max_stage_rank, ?), updated_at = ? WHERE opp_code = ?", params: [change.stage, rank, stamp, code] }, event(code, "階段變更", opp.stage, change.stage!, change.reason ?? null, actor, stamp));
      break;
    }
    case "close_won": {
      const txn = change.won_txn_code?.trim();
      if (!txn) throw new HttpError(400, "成交需連結實際訂單或交易編碼");
      const exists = await first<{ txn_code: string }>("SELECT txn_code FROM transactions WHERE txn_code = ?", txn);
      if (!exists) throw new HttpError(400, `交易編碼 ${txn} 不存在；請先匯入該筆交易`);
      writes.push({ sql: "UPDATE opportunities SET stage = '成交', max_stage_rank = ?, close_result = '成交', won_txn_code = ?, closed_at = ?, updated_at = ? WHERE opp_code = ?", params: [stageRank("成交"), txn, stamp, stamp, code] }, event(code, "結案", opp.stage, "成交", txn, actor, stamp));
      break;
    }
    case "close_lost":
      if (!change.reason) throw new HttpError(400, "未成交需記錄原因");
      writes.push({ sql: "UPDATE opportunities SET stage = '未成交', close_result = '未成交', lost_reason = ?, closed_at = ?, updated_at = ? WHERE opp_code = ?", params: [change.reason, stamp, stamp, code] }, event(code, "結案", opp.stage, "未成交", change.reason, actor, stamp));
      break;
    case "update":
      writes.push({ sql: "UPDATE opportunities SET next_step = COALESCE(?, next_step), next_due_date = COALESCE(?, next_due_date), expected_decision_date = COALESCE(?, expected_decision_date), product = COALESCE(?, product), budget_band = COALESCE(?, budget_band), need = COALESCE(?, need), updated_at = ? WHERE opp_code = ?",
        params: [change.next_step ?? null, change.next_due_date ?? null, change.expected_decision_date ?? null, change.product ?? null, change.budget_band ?? null, change.need ?? null, stamp, code] }, event(code, "更新", null, null, JSON.stringify({ next_step: change.next_step, next_due_date: change.next_due_date }), actor, stamp));
      break;
  }
  await batch(writes);
  await audit(actor, `商機${change.action}`, "opportunities", code, change);
  return opportunityDetail(actor, code);
}

/** Moves an opportunity forward from a returned task result (never backwards; 成交 only with a known transaction). */
export async function advanceOpportunity(actor: Actor, code: string, result: { contacted: boolean; effective: boolean; appointment: boolean; visit: boolean; quote: boolean; won_txn_code: string | null; lost_reason: string | null; note: string }) {
  const opp = await first<Opp>("SELECT * FROM opportunities WHERE opp_code = ?", code);
  if (!opp || opp.stage === "成交" || opp.stage === "未成交") return;
  const reached = result.won_txn_code ? "成交" : result.quote ? "報價" : result.visit ? "到店試乘" : result.appointment ? "預約" : result.effective ? "有效回覆" : result.contacted ? "已聯絡" : opp.stage;
  const rank = Math.max(stageRank(reached), opp.max_stage_rank);
  const stamp = nowIso();
  const writes: { sql: string; params: unknown[] }[] = [];
  if (result.won_txn_code) {
    writes.push({ sql: "UPDATE opportunities SET stage = '成交', max_stage_rank = ?, close_result = '成交', won_txn_code = ?, closed_at = ?, updated_at = ? WHERE opp_code = ?", params: [stageRank("成交"), result.won_txn_code, stamp, stamp, code] }, event(code, "結案", opp.stage, "成交", `${result.won_txn_code}｜${result.note}`, actor, stamp));
  } else if (result.lost_reason) {
    writes.push({ sql: "UPDATE opportunities SET stage = '未成交', max_stage_rank = ?, close_result = '未成交', lost_reason = ?, closed_at = ?, updated_at = ? WHERE opp_code = ?", params: [rank, result.lost_reason, stamp, stamp, code] }, event(code, "結案", opp.stage, "未成交", `${result.lost_reason}｜${result.note}`, actor, stamp));
  } else if (stageRank(reached) > stageRank(opp.stage)) {
    writes.push({ sql: "UPDATE opportunities SET stage = ?, max_stage_rank = ?, updated_at = ? WHERE opp_code = ?", params: [reached, rank, stamp, code] }, event(code, "回傳", opp.stage, reached, result.note, actor, stamp));
  }
  if (writes.length) await batch(writes);
}
