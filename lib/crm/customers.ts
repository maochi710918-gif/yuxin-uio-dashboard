/* eslint-disable @typescript-eslint/no-explicit-any -- 360 aggregates heterogeneous rows from many tables */
import { type Actor, HttpError, assertCustomerAccess, customerScope } from "./auth";
import { all, first } from "./db";
import { scoreModels } from "./scores";
import { baseCteForCustomer, compile, describe, parseDefinition } from "./segments";
import { analysisAsOf } from "./settings";
import { explainColumns } from "./scores";

/** Server-side search by 客戶編碼 or 車輛編碼 (exact or prefix), paginated and scoped. */
export async function searchCustomers(actor: Actor, query: { q?: string; page: number; pageSize: number }) {
  const scope = customerScope(actor, "c");
  const q = (query.q ?? "").trim();
  const where = [scope.sql], params: unknown[] = [...scope.params];
  if (q) {
    where.push("(c.customer_code LIKE ? OR EXISTS (SELECT 1 FROM vehicle_relations r WHERE r.customer_code = c.customer_code AND r.vehicle_code LIKE ?))");
    params.push(`${q}%`, `${q}%`);
  }
  const sql = where.join(" AND ");
  const total = await first<{ n: number }>(`SELECT COUNT(*) AS n FROM customers c WHERE ${sql}`, ...params);
  const rows = await all(`SELECT c.customer_code, c.customer_type, c.county, c.contact_eligible, c.opt_out, c.complaint_open, c.data_date,
      (SELECT COUNT(*) FROM vehicle_relations r WHERE r.customer_code = c.customer_code AND r.relation = '持有人' AND r.valid_to IS NULL) AS owned_vehicles,
      (SELECT GROUP_CONCAT(r.vehicle_code) FROM vehicle_relations r WHERE r.customer_code = c.customer_code AND r.valid_to IS NULL) AS vehicles,
      (SELECT COUNT(*) FROM opportunities o WHERE o.customer_code = c.customer_code AND o.stage NOT IN ('成交', '未成交')) AS open_opps,
      (SELECT COUNT(*) FROM tasks t WHERE t.customer_code = c.customer_code AND t.status NOT IN ('已完成', '已取消')) AS open_tasks
    FROM customers c WHERE ${sql} ORDER BY c.customer_code LIMIT ? OFFSET ?`, ...params, query.pageSize, (query.page - 1) * query.pageSize);
  return { total: total?.n ?? 0, rows };
}

/** Resolves a 車輛編碼 to its current holder so vehicle codes can be looked up directly. */
export async function resolveCode(actor: Actor, code: string) {
  const customer = await first<{ customer_code: string }>("SELECT customer_code FROM customers WHERE customer_code = ?", code);
  if (customer) return customer.customer_code;
  const holder = await first<{ customer_code: string }>("SELECT customer_code FROM vehicle_relations WHERE vehicle_code = ? ORDER BY CASE WHEN valid_to IS NULL THEN 0 ELSE 1 END, CASE relation WHEN '持有人' THEN 0 ELSE 1 END, valid_from DESC LIMIT 1", code);
  if (!holder) throw new HttpError(404, "查無此客戶或車輛編碼");
  await assertCustomerAccess(actor, holder.customer_code);
  return holder.customer_code;
}

type Suggestion = { action: string; basis: string; to_confirm: string; owner: string; due_in_days: number; vehicle_code: string | null; kind: "規則建議" };

function suggestions(row: Record<string, any>): Suggestion[] {
  const list: Suggestion[] = [];
  const v = row.vehicle_code as string | null;
  if (row.complaint_open === 1) list.push({ action: "優先處理客訴，暫停促銷聯絡", basis: "客訴處理中", to_confirm: "客訴進度與負責窗口", owner: "據點主管", due_in_days: 1, vehicle_code: v, kind: "規則建議" });
  if (row.warranty_state === "即將過保") list.push({ action: "安排保固到期前健檢", basis: `保固剩餘 ${row.warranty_days_left ?? "—"} 天／${row.warranty_km_left ?? "—"} km`, to_confirm: row.mileage_basis === "實際" ? `最新里程 ${row.latest_mileage} km 記錄於 ${row.mileage_date ?? "—"}，是否為最新` : "實際里程（目前非實際值）", owner: `服專 ${row.advisor_code ?? "未指派"}`, due_in_days: 3, vehicle_code: v, kind: "規則建議" });
  if (row.warranty_state === "待確認") list.push({ action: "補齊里程或保固資料", basis: "最新里程或保固到期日不足，無法判定保固狀態", to_confirm: "最新實際里程、保固到期日", owner: `服專 ${row.advisor_code ?? "未指派"}`, due_in_days: 7, vehicle_code: v, kind: "規則建議" });
  if (row.maintenance_due_days !== null && row.maintenance_due_days <= 30) list.push({ action: row.maintenance_due_days < 0 ? "保養已逾期，邀約回廠" : "保養即將到期，提前邀約", basis: `最後定保 ${row.last_maintenance_date}，週期 ${row.maintenance_interval_months ?? 6} 個月，${row.maintenance_due_days < 0 ? `逾期 ${-row.maintenance_due_days} 天` : `${row.maintenance_due_days} 天後到期`}`, to_confirm: "是否已在他廠保養", owner: `服專 ${row.advisor_code ?? "未指派"}`, due_in_days: 7, vehicle_code: v, kind: "規則建議" });
  if (row.last_visit_days !== null && row.last_visit_days >= 270) list.push({ action: "未回廠關懷與車況健檢邀約", basis: `已 ${row.last_visit_days} 天未回廠（最後進廠 ${row.last_visit_date}）`, to_confirm: "是否已售車或搬遷", owner: `服專 ${row.advisor_code ?? "未指派"}`, due_in_days: 7, vehicle_code: v, kind: "規則建議" });
  if (row.insurance_days_left !== null && row.insurance_days_left >= 0 && row.insurance_days_left <= 60) list.push({ action: "續保提醒與報價", basis: `保險 ${row.insurance_days_left} 天後到期（${row.insurance_expiry}）`, to_confirm: "「續保到期」欄位語意與承保公司", owner: `業代 ${row.sales_code ?? "未指派"}`, due_in_days: 7, vehicle_code: v, kind: "規則建議" });
  if (row.replacement_score_level === "強線索") list.push({ action: "確認換購需求（線索，非意願）", basis: scoreModels.find((model) => model.key === "replacement_score")!.rules.filter((rule) => row[`replacement_score__${rule.key}`] === 1).map((rule) => rule.label).join("、"), to_confirm: "實際換車需求、預算與時程", owner: `業代 ${row.sales_code ?? "未指派"}`, due_in_days: 14, vehicle_code: v, kind: "規則建議" });
  return list;
}

export async function customer360(actor: Actor, code: string) {
  const customerCode = await resolveCode(actor, code);
  await assertCustomerAccess(actor, customerCode);
  const asOf = await analysisAsOf();
  const customer = await first<Record<string, unknown>>("SELECT * FROM customers WHERE customer_code = ?", customerCode);
  const relations = await all<Record<string, unknown>>(`SELECT r.*, v.model_series, v.model_code, v.registration_date, v.latest_mileage, v.mileage_date, v.mileage_basis, v.warranty_expiry, v.extended_warranty_expiry, v.insurance_expiry, v.last_visit_date, v.service_unit_code, u.name AS unit_name, v.data_date AS vehicle_data_date, v.source_code AS vehicle_source
    FROM vehicle_relations r LEFT JOIN vehicles v ON v.vehicle_code = r.vehicle_code LEFT JOIN units u ON u.unit_code = v.service_unit_code WHERE r.customer_code = ? ORDER BY r.valid_to IS NOT NULL, r.vehicle_code, r.relation`, customerCode);
  const vehicleCodes = [...new Set(relations.map((row) => String(row.vehicle_code)))];
  const coHolders = await all(`SELECT r.vehicle_code, r.customer_code, r.relation, r.valid_from, r.valid_to FROM vehicle_relations r WHERE r.vehicle_code IN (SELECT value FROM json_each(?)) AND r.customer_code != ? ORDER BY r.vehicle_code, r.valid_from`, JSON.stringify(vehicleCodes), customerCode);
  const staffRows = await all(`SELECT vs.vehicle_code, vs.staff_role, vs.staff_code, s.display_name, s.code_status, vs.valid_from, vs.valid_to FROM vehicle_staff vs LEFT JOIN staff s ON s.staff_code = vs.staff_code WHERE vs.vehicle_code IN (SELECT value FROM json_each(?)) ORDER BY vs.valid_to IS NOT NULL, vs.staff_role`, JSON.stringify(vehicleCodes));
  const groups = await all(`SELECT m.*, g.group_type, (SELECT COUNT(*) FROM relation_group_members m2 WHERE m2.group_code = m.group_code AND m2.valid_to IS NULL) AS members FROM relation_group_members m JOIN relation_groups g ON g.group_code = m.group_code WHERE m.customer_code = ?`, customerCode);
  // 交易只列此客戶持有期間的車輛交易，轉手前的紀錄不混入此客戶。
  const transactions = await all(`SELECT t.txn_code, t.txn_type, t.vehicle_code, t.txn_date, t.unit_code, u.name AS unit_name, t.amount, t.cost, t.margin, t.mileage, t.source_code, t.data_date,
      (SELECT GROUP_CONCAT(source_code) FROM transaction_source_records sr WHERE sr.txn_code = t.txn_code) AS sources
    FROM transactions t LEFT JOIN units u ON u.unit_code = t.unit_code
    WHERE t.customer_code = ? OR EXISTS (SELECT 1 FROM vehicle_relations r WHERE r.customer_code = ? AND r.vehicle_code = t.vehicle_code AND r.relation = '持有人' AND (r.valid_from = '' OR t.txn_date >= r.valid_from) AND (r.valid_to IS NULL OR t.txn_date < r.valid_to))
    ORDER BY t.txn_date DESC LIMIT 200`, customerCode, customerCode);
  const txnSummary = await first<Record<string, unknown>>(`SELECT COUNT(*) AS n, SUM(amount) AS amount, SUM(margin) AS margin, SUM(CASE WHEN margin IS NOT NULL THEN 1 ELSE 0 END) AS with_margin, MIN(txn_date) AS first_date, MAX(txn_date) AS last_date,
      SUM(CASE WHEN txn_type = '購車' THEN 1 ELSE 0 END) AS purchases
    FROM transactions t WHERE t.customer_code = ? OR EXISTS (SELECT 1 FROM vehicle_relations r WHERE r.customer_code = ? AND r.vehicle_code = t.vehicle_code AND r.relation = '持有人' AND (r.valid_from = '' OR t.txn_date >= r.valid_from) AND (r.valid_to IS NULL OR t.txn_date < r.valid_to))`, customerCode, customerCode);
  const interactions = await all("SELECT * FROM interactions WHERE customer_code = ? ORDER BY occurred_at DESC LIMIT 100", customerCode);
  const surveys = await all(`SELECT s.*, u.name AS unit_name FROM satisfaction_surveys s LEFT JOIN units u ON u.unit_code = s.unit_code
    WHERE s.customer_code = ? OR EXISTS (SELECT 1 FROM vehicle_relations r WHERE r.customer_code = ? AND r.vehicle_code = s.vehicle_code AND r.relation = '持有人' AND (r.valid_from = '' OR s.service_date >= r.valid_from) AND (r.valid_to IS NULL OR s.service_date < r.valid_to))
    ORDER BY s.service_date DESC LIMIT 50`, customerCode, customerCode);
  const opportunities = await all("SELECT o.*, s.display_name AS owner_name, t.amount AS won_amount FROM opportunities o LEFT JOIN staff s ON s.staff_code = o.owner_staff_code LEFT JOIN transactions t ON t.txn_code = o.won_txn_code WHERE o.customer_code = ? ORDER BY o.created_at DESC", customerCode);
  const tasks = await all("SELECT t.*, s.display_name AS owner_name FROM tasks t LEFT JOIN staff s ON s.staff_code = t.owner_staff_code WHERE t.customer_code = ? ORDER BY t.created_at DESC LIMIT 100", customerCode);
  const campaigns = await all("SELECT m.*, c.name, c.snapshot_at FROM campaign_members m JOIN campaigns c ON c.campaign_code = m.campaign_code WHERE m.customer_code = ? ORDER BY c.snapshot_at DESC", customerCode);
  const base = await all<Record<string, any>>(`${baseCteForCustomer} SELECT b.*, ${explainColumns().join(", ")} FROM b`, asOf, customerCode);
  const overrides = await all("SELECT * FROM score_overrides WHERE customer_code = ?", customerCode);
  const presets = await all<{ segment_code: string; name: string; definition: string }>("SELECT segment_code, name, definition FROM segments ORDER BY is_preset DESC, segment_code");
  const tags: { segment_code: string; name: string }[] = [];
  for (const preset of presets) {
    const compiled = compile(parseDefinition(preset.definition), []);
    const hit = await first(`${baseCteForCustomer} SELECT 1 AS ok FROM b WHERE (${compiled.sql}) LIMIT 1`, asOf, customerCode, ...compiled.params);
    if (hit) tags.push({ segment_code: preset.segment_code, name: preset.name });
  }
  const scores = scoreModels.map((model) => {
    const row = base.find((item) => item[model.key] !== null) ?? base[0];
    return {
      key: model.key, label: model.label, version: model.version, updated: model.updated, caveat: model.caveat ?? null,
      score: row?.[model.key] ?? null, level: row?.[`${model.key}_level`] ?? "資料不足", vehicle_code: row?.vehicle_code ?? null,
      reasons: model.rules.map((rule) => ({ label: rule.label, points: rule.points, basis: rule.basis, hit: row?.[`${model.key}__${rule.key}`] === 1 })),
      override: overrides.find((item: any) => item.score_type === model.key) ?? null,
    };
  });
  // 生命週期：同一客戶可同時有多台車、多個階段，逐車／逐商機呈現，不以單一標籤覆蓋。
  const lifecycle = [
    ...base.filter((row) => row.vehicle_code).map((row) => ({ vehicle_code: row.vehicle_code, stage: row.warranty_state === "即將過保" ? "保固到期" : (row.last_visit_days ?? 0) >= 365 ? "流失風險" : row.insurance_days_left !== null && row.insurance_days_left <= 60 && row.insurance_days_left >= 0 ? "續保" : row.replacement_score_level === "強線索" ? "換購線索" : "保養", basis: `保固 ${row.warranty_state}｜未回廠 ${row.last_visit_days ?? "資料不足"} 天` })),
    ...opportunities.filter((opp: any) => opp.stage !== "成交" && opp.stage !== "未成交").map((opp: any) => ({ vehicle_code: opp.vehicle_code, stage: opp.stage === "到店試乘" ? "試乘" : opp.stage === "報價" ? "報價" : "潛客", basis: `${opp.opp_code} ${opp.opp_type}` })),
  ];
  return {
    asOf, customer, groups, relations, coHolders, staff: staffRows, transactions, txnSummary, interactions, surveys, opportunities, tasks, campaigns, tags, scores, lifecycle,
    suggestions: base.flatMap(suggestions),
    lastInteraction: (interactions[0] as any)?.occurred_at ?? null,
    connected: {
      interactions: (await first<{ n: number }>("SELECT COUNT(*) AS n FROM interactions WHERE source_code != 'RESULT'"))?.n ? "已串接" : "尚未串接",
      complaints: (await first<{ n: number }>("SELECT COUNT(*) AS n FROM customers WHERE complaint_open IS NOT NULL"))?.n ? "已串接" : "尚未串接",
      satisfaction: (await first<{ n: number }>("SELECT COUNT(*) AS n FROM satisfaction_surveys"))?.n ? "已串接" : "尚未串接",
      purchases: (await first<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE txn_type = '購車'"))?.n ? "已串接" : "尚未串接",
      insurance: (await first<{ n: number }>("SELECT COUNT(*) AS n FROM vehicles WHERE insurance_expiry IS NOT NULL"))?.n ? "已串接" : "尚未串接",
      groups: (await first<{ n: number }>("SELECT COUNT(*) AS n FROM relation_groups"))?.n ? "已串接" : "尚未串接",
      margin: (await first<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE margin IS NOT NULL"))?.n ? "部分串接（僅含成本來源之交易）" : "尚未串接",
    },
  };
}

export async function overrideScore(actor: Actor, customerCode: string, scoreType: string, level: string | null, note: string) {
  await assertCustomerAccess(actor, customerCode);
  if (!scoreModels.some((model) => model.key === scoreType)) throw new HttpError(400, "未知的評分類型");
  const { run, nowIso } = await import("./db");
  const { audit } = await import("./auth");
  if (!level) await run("DELETE FROM score_overrides WHERE customer_code = ? AND score_type = ?", customerCode, scoreType);
  else await run("INSERT INTO score_overrides (customer_code, score_type, override_level, note, actor, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(customer_code, score_type) DO UPDATE SET override_level = excluded.override_level, note = excluded.note, actor = excluded.actor, at = excluded.at", customerCode, scoreType, level, note, actor.email, nowIso());
  await audit(actor, level ? "人工修正評分" : "移除評分修正", "score_overrides", customerCode, { scoreType, level, note });
}

export { describe };
