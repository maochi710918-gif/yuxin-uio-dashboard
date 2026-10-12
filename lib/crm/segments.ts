import { type Actor, HttpError, customerScope } from "./auth";
import { all, d1, first } from "./db";
import { explainColumns, levelSql, scoreModels, scoreSql } from "./scores";
import { analysisAsOf } from "./settings";

// One base row per (customer, currently-held vehicle); customers without a vehicle appear once with no vehicle.
// All day counts are measured against the analysis date (分析基準日), never "today".
// Heavy, import-driven columns (customers × vehicles × transactions × staff) live in the seg_snapshot table, rebuilt only
// when the data version or 分析基準日 changes; task / opportunity / interaction columns are always joined live.
type Mode = "snapshot" | "customer";
function buildBase(mode: Mode) {
  const restrict = mode === "customer";
  const onlyVehicles = restrict ? "AND vehicle_code IN (SELECT vehicle_code FROM vehicle_relations WHERE customer_code = (SELECT c FROM one))" : "";
  const onlyCustomer = restrict ? "AND customer_code = (SELECT c FROM one)" : "";
  const asof = mode === "snapshot" ? "__ASOF__" : "(SELECT d FROM asof)";
  return `
WITH ${mode === "snapshot" ? "" : "asof AS (SELECT ? AS d),"}${restrict ? " one AS (SELECT ? AS c)," : ""}
txn AS (
  SELECT vehicle_code,
    COUNT(*) AS txn_count_all,
    MAX(txn_date) AS last_txn_date,
    SUM(CASE WHEN txn_date > date(${asof}, '-365 day') AND txn_date <= ${asof} THEN amount END) AS amount_365,
    SUM(CASE WHEN txn_date > date(${asof}, '-90 day') AND txn_date <= ${asof} THEN amount END) AS amount_90,
    SUM(CASE WHEN txn_date > date(${asof}, '-365 day') AND txn_date <= ${asof} THEN 1 ELSE 0 END) AS txn_count_365,
    SUM(CASE WHEN txn_date > date(${asof}, '-365 day') AND txn_date <= ${asof} THEN margin END) AS margin_365,
    SUM(CASE WHEN txn_type IN ('維修', '理賠') AND txn_date > date(${asof}, '-365 day') AND txn_date <= ${asof} THEN amount END) AS repair_amount_365,
    SUM(CASE WHEN txn_type = '美容' AND txn_date > date(${asof}, '-365 day') AND txn_date <= ${asof} THEN amount END) AS beauty_amount_365
  FROM transactions WHERE vehicle_code IS NOT NULL ${onlyVehicles} GROUP BY vehicle_code
),
vs AS (
  SELECT vehicle_code,
    MAX(CASE WHEN staff_role = 'sales' THEN staff_code END) AS sales_code,
    MAX(CASE WHEN staff_role = 'advisor' THEN staff_code END) AS advisor_code,
    MAX(CASE WHEN staff_role = 'technician' THEN staff_code END) AS technician_code
  FROM vehicle_staff WHERE valid_to IS NULL ${onlyVehicles} GROUP BY vehicle_code
),
own AS (
  SELECT customer_code, COUNT(*) AS owned_vehicles FROM vehicle_relations WHERE relation = '持有人' AND valid_to IS NULL ${onlyCustomer} GROUP BY customer_code
),
grp AS (
  SELECT m.customer_code, MIN(m.group_code) AS group_code, MIN(g.group_type) AS group_type FROM relation_group_members m JOIN relation_groups g ON g.group_code = m.group_code WHERE m.valid_to IS NULL GROUP BY m.customer_code
),
${restrict ? `${liveCtes(onlyCustomer)},` : ""}
b0 AS (
  SELECT c.customer_code, v.vehicle_code,
    c.customer_type, c.gender, c.age, c.county, c.district, c.member_passport, c.consent_status,
    c.contact_eligible, c.channel_phone, c.channel_sms, c.channel_email, c.channel_line, c.opt_out, c.complaint_open, c.satisfaction_score,
    v.model_series, v.model_code, v.registration_date, v.delivery_date, v.latest_mileage, v.mileage_basis, v.mileage_date,
    v.warranty_expiry, v.warranty_km_limit, v.extended_warranty_expiry, v.insurance_expiry, v.service_unit_code, v.last_visit_date,
    v.last_maintenance_date, v.maintenance_interval_months,
    st.sales_code, st.advisor_code, st.technician_code,
    t.txn_count_all, t.last_txn_date, t.amount_365, t.amount_90, t.txn_count_365, t.margin_365, t.repair_amount_365, t.beauty_amount_365,
    COALESCE(w.owned_vehicles, 0) AS owned_vehicles, gp.group_code, gp.group_type,
    ROUND((julianday(${asof}) - julianday(v.registration_date)) / 365.25, 1) AS vehicle_age,
    CAST(julianday(${asof}) - julianday(v.last_visit_date) AS INTEGER) AS last_visit_days,
    CAST(julianday(${asof}) - julianday(v.last_maintenance_date) AS INTEGER) AS last_maintenance_days,
    CAST(julianday(date(v.last_maintenance_date, '+' || COALESCE(v.maintenance_interval_months, 6) || ' month')) - julianday(${asof}) AS INTEGER) AS maintenance_due_days,
    CAST(julianday(COALESCE(v.warranty_expiry, date(v.registration_date, '+3 year'))) - julianday(${asof}) AS INTEGER) AS warranty_days_left,
    CASE WHEN v.latest_mileage IS NULL THEN NULL ELSE COALESCE(v.warranty_km_limit, 100000) - v.latest_mileage END AS warranty_km_left,
    CAST(julianday(v.insurance_expiry) - julianday(${asof}) AS INTEGER) AS insurance_days_left
    ${restrict ? `, ${liveColumns()}` : ""}
  FROM customers c
  LEFT JOIN vehicle_relations r ON r.customer_code = c.customer_code AND r.relation = '持有人' AND r.valid_to IS NULL
  LEFT JOIN vehicles v ON v.vehicle_code = r.vehicle_code
  LEFT JOIN txn t ON t.vehicle_code = v.vehicle_code
  LEFT JOIN vs st ON st.vehicle_code = v.vehicle_code
  LEFT JOIN own w ON w.customer_code = c.customer_code
  LEFT JOIN grp gp ON gp.customer_code = c.customer_code
  ${restrict ? liveJoins("c") : ""}
  ${restrict ? "WHERE c.customer_code = (SELECT c FROM one)" : ""}
),
b1 AS (
  SELECT b0.*,
    -- 保固：3 年或 10 萬 km 先到者為準；里程缺漏時只能判定「待確認」，不可僅依車齡判定仍在保固內。
    CASE
      WHEN b0.warranty_days_left IS NULL THEN '待確認'
      WHEN b0.warranty_days_left <= 0 OR (b0.warranty_km_left IS NOT NULL AND b0.warranty_km_left <= 0) THEN '已過保'
      WHEN b0.warranty_km_left IS NULL THEN '待確認'
      WHEN b0.warranty_days_left <= 180 OR b0.warranty_km_left <= 20000 THEN '即將過保'
      ELSE '保固內' END AS warranty_state
  FROM b0
)`;
}

function liveCtes(onlyCustomer = "") {
  return `inter AS (
  SELECT customer_code,
    MAX(occurred_at) AS last_interaction_date,
    MAX(CASE WHEN interaction_type IN ('試乘', '報價') THEN occurred_at END) AS last_test_drive_or_quote_date
  FROM interactions WHERE 1 = 1 ${onlyCustomer} GROUP BY customer_code
),
opp AS (
  SELECT customer_code,
    SUM(CASE WHEN stage NOT IN ('成交', '未成交') THEN 1 ELSE 0 END) AS open_opps,
    SUM(CASE WHEN stage = '成交' THEN 1 ELSE 0 END) AS won_opps,
    SUM(CASE WHEN origin = '售後轉介' AND stage NOT IN ('成交', '未成交') THEN 1 ELSE 0 END) AS open_referrals,
    GROUP_CONCAT(DISTINCT CASE WHEN stage NOT IN ('成交', '未成交') THEN stage END) AS open_stages,
    GROUP_CONCAT(DISTINCT lost_reason) AS lost_reasons
  FROM opportunities WHERE 1 = 1 ${onlyCustomer} GROUP BY customer_code
),
task AS (
  SELECT customer_code, SUM(CASE WHEN status NOT IN ('已完成', '已取消') THEN 1 ELSE 0 END) AS open_tasks FROM tasks WHERE 1 = 1 ${onlyCustomer} GROUP BY customer_code
)`;
}

function liveColumns() {
  return `CAST(julianday((SELECT d FROM asof)) - julianday(i.last_interaction_date) AS INTEGER) AS last_interaction_days,
    CAST(julianday((SELECT d FROM asof)) - julianday(i.last_test_drive_or_quote_date) AS INTEGER) AS last_test_drive_or_quote_days,
    COALESCE(o.open_opps, 0) AS open_opps, COALESCE(o.won_opps, 0) AS won_opps, COALESCE(o.open_referrals, 0) AS open_referrals, o.open_stages, o.lost_reasons,
    COALESCE(k.open_tasks, 0) AS open_tasks`;
}

function liveJoins(alias: string) {
  return `LEFT JOIN inter i ON i.customer_code = ${alias}.customer_code
  LEFT JOIN opp o ON o.customer_code = ${alias}.customer_code
  LEFT JOIN task k ON k.customer_code = ${alias}.customer_code`;
}

/** Full base over every customer (params: 分析基準日). Callers run ensureSnapshot() first. */
export const baseCte = `
WITH asof AS (SELECT ? AS d),
${liveCtes()},
b AS MATERIALIZED (SELECT s.*, ${liveColumns()} FROM seg_snapshot s ${liveJoins("s")})`;
/** Single-customer base for Customer 360 (params: 分析基準日, 客戶編碼) — computed live, no snapshot needed. */
export const baseCteForCustomer = `${buildBase("customer")}, b AS MATERIALIZED (SELECT * FROM b1)`;

let building: Promise<void> | null = null;
/** Rebuilds seg_snapshot when the imported data version or 分析基準日 changed since the last build. */
export async function ensureSnapshot() {
  const asOf = await analysisAsOf();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new HttpError(500, "分析基準日格式錯誤");
  const version = (await first<{ setting_value: string }>("SELECT setting_value FROM app_settings WHERE setting_key = 'data_version'"))?.setting_value ?? "0";
  const key = `${version}|${asOf}`;
  const current = (await first<{ setting_value: string }>("SELECT setting_value FROM app_settings WHERE setting_key = 'seg_snapshot_key'"))?.setting_value;
  const exists = await first<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'seg_snapshot'");
  if (current === key && exists?.n) return;
  building ??= (async () => {
    const sql = `${buildBase("snapshot").replaceAll("__ASOF__", `'${asOf}'`)} SELECT * FROM b1`;
    const database = d1();
    await database.batch([
      database.prepare("DROP TABLE IF EXISTS seg_snapshot"),
      database.prepare(`CREATE TABLE seg_snapshot AS ${sql}`),
      database.prepare("CREATE INDEX seg_snapshot_customer_idx ON seg_snapshot (customer_code)"),
      database.prepare("INSERT INTO app_settings (setting_key, setting_value, description, updated_by, updated_at) VALUES ('seg_snapshot_key', ?, '客群運算快取版本（資料版本｜分析基準日）', 'system', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at").bind(key, new Date().toISOString()),
    ]);
  })().finally(() => { building = null; });
  await building;
}

export type FieldDef = { key: string; label: string; group: string; type: "number" | "text" | "bool" | "enum"; sql: string; unit?: string; options?: string[]; source?: string };

const scoreFields: FieldDef[] = scoreModels.flatMap((model) => [
  { key: model.key, label: `${model.label}分數`, group: "評分", type: "number" as const, sql: scoreSql(model) },
  { key: `${model.key}_level`, label: `${model.label}等級`, group: "評分", type: "enum" as const, sql: levelSql(model), options: [...model.levels.map((level) => level.label), "資料不足"] },
]);

export const fieldDefs: FieldDef[] = [
  { key: "model_series", label: "車型", group: "車輛", type: "text", sql: "b.model_series" },
  { key: "model_code", label: "車型代碼", group: "車輛", type: "text", sql: "b.model_code" },
  { key: "vehicle_age", label: "車齡", group: "車輛", type: "number", unit: "年", sql: "b.vehicle_age" },
  { key: "latest_mileage", label: "最新里程", group: "車輛", type: "number", unit: "km", sql: "b.latest_mileage" },
  { key: "mileage_basis", label: "里程依據", group: "車輛", type: "enum", options: ["實際", "推估"], sql: "b.mileage_basis" },
  { key: "delivery_date", label: "交車日", group: "車輛", type: "text", sql: "b.delivery_date", source: "vehicles.delivery_date" },
  { key: "warranty_state", label: "保固狀態", group: "保固與保險", type: "enum", options: ["保固內", "即將過保", "已過保", "待確認"], sql: "b.warranty_state" },
  { key: "warranty_days_left", label: "保固剩餘天數", group: "保固與保險", type: "number", unit: "天", sql: "b.warranty_days_left" },
  { key: "warranty_km_left", label: "保固剩餘里程", group: "保固與保險", type: "number", unit: "km", sql: "b.warranty_km_left" },
  { key: "insurance_days_left", label: "保險到期剩餘天數", group: "保固與保險", type: "number", unit: "天", sql: "b.insurance_days_left", source: "vehicles.insurance_expiry" },
  { key: "last_visit_days", label: "未回廠天數", group: "回廠與互動", type: "number", unit: "天", sql: "b.last_visit_days" },
  { key: "last_maintenance_days", label: "距最後定保天數", group: "回廠與互動", type: "number", unit: "天", sql: "b.last_maintenance_days" },
  { key: "maintenance_due_days", label: "距下次保養天數（負數為逾期）", group: "回廠與互動", type: "number", unit: "天", sql: "b.maintenance_due_days" },
  { key: "last_interaction_days", label: "距最後互動天數", group: "回廠與互動", type: "number", unit: "天", sql: "b.last_interaction_days", source: "interactions" },
  { key: "last_test_drive_or_quote_days", label: "距最後試乘／報價天數", group: "銷售", type: "number", unit: "天", sql: "b.last_test_drive_or_quote_days", source: "interactions" },
  { key: "amount_365", label: "近一年交易金額", group: "消費", type: "number", unit: "元", sql: "b.amount_365" },
  { key: "amount_90", label: "近三月交易金額", group: "消費", type: "number", unit: "元", sql: "b.amount_90" },
  { key: "txn_count_365", label: "近一年交易筆數", group: "消費", type: "number", unit: "筆", sql: "b.txn_count_365" },
  { key: "margin_365", label: "近一年毛利", group: "消費", type: "number", unit: "元", sql: "b.margin_365" },
  { key: "repair_amount_365", label: "近一年維修金額", group: "消費", type: "number", unit: "元", sql: "b.repair_amount_365" },
  { key: "beauty_amount_365", label: "近一年美容金額", group: "消費", type: "number", unit: "元", sql: "b.beauty_amount_365" },
  { key: "service_unit_code", label: "服務據點", group: "據點與人員", type: "text", sql: "b.service_unit_code" },
  { key: "sales_code", label: "業代", group: "據點與人員", type: "text", sql: "b.sales_code" },
  { key: "advisor_code", label: "服專", group: "據點與人員", type: "text", sql: "b.advisor_code" },
  { key: "technician_code", label: "技師", group: "據點與人員", type: "text", sql: "b.technician_code" },
  { key: "customer_type", label: "客戶類型", group: "客戶", type: "enum", options: ["個人", "法人"], sql: "b.customer_type" },
  { key: "owned_vehicles", label: "現行持有車數", group: "客戶", type: "number", unit: "台", sql: "b.owned_vehicles" },
  { key: "group_type", label: "家庭／企業", group: "客戶", type: "enum", options: ["家庭", "企業"], sql: "b.group_type", source: "relation_groups" },
  { key: "member_passport", label: "會員護照", group: "客戶", type: "text", sql: "b.member_passport" },
  { key: "county", label: "縣市", group: "客戶", type: "text", sql: "b.county" },
  { key: "open_opps", label: "進行中商機數", group: "銷售", type: "number", sql: "b.open_opps" },
  { key: "won_opps", label: "成交商機數", group: "銷售", type: "number", sql: "b.won_opps" },
  { key: "open_referrals", label: "進行中售後轉介", group: "銷售", type: "number", sql: "b.open_referrals" },
  { key: "open_stages", label: "商機階段", group: "銷售", type: "text", sql: "b.open_stages" },
  { key: "lost_reasons", label: "未成交原因", group: "銷售", type: "text", sql: "b.lost_reasons" },
  { key: "complaint_open", label: "客訴處理中", group: "聯絡資格", type: "bool", sql: "b.complaint_open", source: "customers.complaint_open" },
  { key: "contact_eligible", label: "可聯絡", group: "聯絡資格", type: "bool", sql: "b.contact_eligible" },
  { key: "opt_out", label: "拒收", group: "聯絡資格", type: "bool", sql: "b.opt_out" },
  { key: "open_tasks", label: "未完成任務數", group: "聯絡資格", type: "number", sql: "b.open_tasks" },
  ...scoreFields,
];

export type Condition = { field: string; op: string; value?: unknown; value2?: unknown };
export type ConditionGroup = { op: "AND" | "OR"; not?: boolean; items: (Condition | ConditionGroup)[] };
const isGroup = (item: Condition | ConditionGroup): item is ConditionGroup => "items" in item;

const ops: Record<string, string> = { eq: "等於", neq: "不等於", in: "屬於", not_in: "不屬於", gte: "≥", lte: "≤", between: "介於", is_null: "資料不足", not_null: "有資料", contains: "包含" };

/** Compiles a condition tree into a parameterised SQL predicate over base row `b`. Unknown fields are rejected. */
export function compile(group: ConditionGroup, params: unknown[] = []): { sql: string; params: unknown[] } {
  if (!group.items?.length) return { sql: "1 = 1", params };
  const parts = group.items.map((item) => {
    if (isGroup(item)) return `(${compile(item, params).sql})`;
    const field = fieldDefs.find((def) => def.key === item.field);
    if (!field) throw new HttpError(400, `未知的篩選欄位：${item.field}`);
    const value = field.type === "number" || field.type === "bool" ? Number(item.value) : item.value;
    switch (item.op) {
      case "eq": params.push(value); return `${field.sql} = ?`;
      case "neq": params.push(value); return `(${field.sql} IS NULL OR ${field.sql} != ?)`;
      case "gte": params.push(Number(item.value)); return `${field.sql} >= ?`;
      case "lte": params.push(Number(item.value)); return `${field.sql} <= ?`;
      case "between": params.push(Number(item.value), Number(item.value2)); return `${field.sql} BETWEEN ? AND ?`;
      case "in": case "not_in": {
        const list = Array.isArray(item.value) ? item.value : String(item.value ?? "").split(/[,，、]/).map((part) => part.trim()).filter(Boolean);
        params.push(JSON.stringify(list));
        return item.op === "in" ? `${field.sql} IN (SELECT value FROM json_each(?))` : `(${field.sql} IS NULL OR ${field.sql} NOT IN (SELECT value FROM json_each(?)))`;
      }
      case "is_null": return `${field.sql} IS NULL`;
      case "not_null": return `${field.sql} IS NOT NULL`;
      case "contains": params.push(`%${String(item.value ?? "")}%`); return `${field.sql} LIKE ?`;
      default: throw new HttpError(400, `未知的條件運算：${item.op}`);
    }
  });
  const joined = parts.join(group.op === "OR" ? " OR " : " AND ");
  return { sql: group.not ? `NOT (${joined})` : joined, params };
}

/** Human-readable 入選原因 for a definition. */
export function describe(group: ConditionGroup): string {
  if (!group.items?.length) return "全部客戶";
  const text = group.items.map((item) => {
    if (isGroup(item)) return `（${describe(item)}）`;
    const field = fieldDefs.find((def) => def.key === item.field);
    const label = field?.label ?? item.field;
    const unit = field?.unit ?? "";
    if (item.op === "between") return `${label} ${item.value}–${item.value2}${unit}`;
    if (item.op === "is_null" || item.op === "not_null") return `${label}${ops[item.op]}`;
    if (field?.type === "bool") return `${label}${Number(item.value) ? "＝是" : "＝否"}`;
    return `${label} ${ops[item.op] ?? item.op} ${Array.isArray(item.value) ? item.value.join("、") : item.value}${unit}`;
  }).join(group.op === "OR" ? " 或 " : " 且 ");
  return group.not ? `排除：${text}` : text;
}

export function referencedFields(group: ConditionGroup, out = new Set<string>()) {
  for (const item of group.items ?? []) {
    if (isGroup(item)) referencedFields(item, out);
    else out.add(item.field);
  }
  return out;
}

// 可執行 = 可聯絡、未拒收、非客訴處理中；其他列為排除並說明原因（同一客戶只歸入第一個符合的原因）。
const exclusionCase = `CASE
  WHEN b.opt_out = 1 THEN '拒收'
  WHEN b.contact_eligible IS NULL THEN '聯絡資格資料不足'
  WHEN b.contact_eligible = 0 THEN '不可聯絡（未授權或地端註記）'
  WHEN b.complaint_open = 1 THEN '客訴處理中（暫停促銷）'
  ELSE NULL END`;

async function scoped(actor: Actor, definition: ConditionGroup) {
  await ensureSnapshot();
  const asOf = await analysisAsOf();
  const compiled = compile(definition, []);
  const scope = customerScope(actor, "sc");
  return { asOf, where: `(${compiled.sql}) AND EXISTS (SELECT 1 FROM customers sc WHERE sc.customer_code = b.customer_code AND ${scope.sql})`, params: [asOf, ...compiled.params, ...scope.params] };
}

export async function evaluate(actor: Actor, definition: ConditionGroup) {
  const { asOf, where, params } = await scoped(actor, definition);
  // One pass: members → per-customer exclusion → totals by reason (客戶與車輛分開計數，同一客戶只算一次).
  const grouped = await all<{ reason: string | null; customers: number; vehicles: number }>(
    `${baseCte}, m AS MATERIALIZED (SELECT b.customer_code, b.vehicle_code, ${exclusionCase} AS reason FROM b WHERE ${where}),
     x AS (SELECT customer_code, MIN(reason) AS reason, COUNT(vehicle_code) AS vehicles FROM m GROUP BY customer_code)
     SELECT reason, COUNT(*) AS customers, SUM(vehicles) AS vehicles FROM x GROUP BY reason ORDER BY customers DESC`, ...params);
  const totals = { customers: grouped.reduce((sum, row) => sum + row.customers, 0), vehicles: grouped.reduce((sum, row) => sum + (row.vehicles ?? 0), 0), actionable: grouped.find((row) => row.reason === null)?.customers ?? 0 };
  const exclusions = grouped.filter((row) => row.reason !== null).map((row) => ({ reason: row.reason!, customers: row.customers }));
  const fields = [...referencedFields(definition)];
  const missingSources = fieldDefs.filter((def) => fields.includes(def.key) && def.source).map((def) => def.source!);
  const connected = await sourceAvailability(missingSources);
  return { asOf, description: describe(definition), customers: totals?.customers ?? 0, vehicles: totals?.vehicles ?? 0, actionable: totals?.actionable ?? 0, excluded: (totals?.customers ?? 0) - (totals?.actionable ?? 0), exclusions, notConnected: connected };
}

/** Lists source tables/columns referenced by a definition that have no data yet → 尚未串接. */
export async function sourceAvailability(sources: string[]) {
  const missing: string[] = [];
  for (const source of new Set(sources)) {
    const [table, column] = source.split(".");
    const row = await first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}${column ? ` WHERE ${column} IS NOT NULL` : ""}`);
    if (!row?.n) missing.push(source);
  }
  return missing;
}

export async function members(actor: Actor, definition: ConditionGroup, page: number, pageSize: number, options: { actionableOnly?: boolean; search?: string } = {}) {
  const { asOf, where, params } = await scoped(actor, definition);
  const extra: string[] = [], extraParams: unknown[] = [];
  if (options.actionableOnly) extra.push(`(${exclusionCase}) IS NULL`);
  if (options.search) { extra.push("(b.customer_code LIKE ? OR b.vehicle_code LIKE ?)"); extraParams.push(`%${options.search}%`, `%${options.search}%`); }
  const fullWhere = [where, ...extra].join(" AND ");
  const count = await first<{ n: number }>(`${baseCte} SELECT COUNT(*) AS n FROM b WHERE ${fullWhere}`, ...params, ...extraParams);
  const fields = [...referencedFields(definition)];
  const rows = await all<Record<string, unknown>>(
    `${baseCte} SELECT b.customer_code, b.vehicle_code, b.model_series, b.service_unit_code, b.sales_code, b.advisor_code, b.last_visit_days, b.warranty_state, b.open_opps, b.open_tasks, b.open_stages,
      ${exclusionCase} AS exclusion_reason, ${fields.map((key) => `${fieldDefs.find((def) => def.key === key)!.sql} AS f_${key}`).join(", ") || "NULL AS f_none"},
      ${explainColumns().join(", ")}
     FROM b WHERE ${fullWhere} ORDER BY churn_score DESC, value_score DESC, b.customer_code, b.vehicle_code LIMIT ? OFFSET ?`,
    ...params, ...extraParams, pageSize, (page - 1) * pageSize);
  return { asOf, total: count?.n ?? 0, page, pageSize, description: describe(definition), fields, rows };
}

export function parseDefinition(raw: unknown): ConditionGroup {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object" || !Array.isArray((value as ConditionGroup).items)) throw new HttpError(400, "客群條件格式錯誤");
  return value as ConditionGroup;
}
