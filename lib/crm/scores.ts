// Rule-based, explainable scores. Each rule is a SQL condition over the segment base row (see segments.ts).
// Vehicle age and repair spend are only 線索 (leads) — never treated as purchase intent.
export type ScoreRule = { key: string; label: string; condition: string; points: number; basis: string };
export type ScoreModel = {
  key: string; label: string; version: string; updated: string; description: string;
  rules: ScoreRule[];
  insufficient: string;           // SQL: 1 when the data needed for this score is missing → 資料不足
  levels: { min: number; label: string }[];
  caveat?: string;
};

export const scoreModels: ScoreModel[] = [
  {
    key: "value_score", label: "客戶價值", version: "v1", updated: "2026-10-07",
    description: "以平台內交易金額、回廠次數、持有車數與會員資格評估。",
    insufficient: "(b.txn_count_all IS NULL OR b.txn_count_all = 0)",
    rules: [
      { key: "spend_high", label: "近一年交易金額 ≥ 30,000", condition: "b.amount_365 >= 30000", points: 30, basis: "transactions.amount（近 365 天）" },
      { key: "spend_mid", label: "近一年交易金額 10,000–29,999", condition: "b.amount_365 >= 10000 AND b.amount_365 < 30000", points: 15, basis: "transactions.amount（近 365 天）" },
      { key: "visits", label: "近一年交易 ≥ 3 筆", condition: "b.txn_count_365 >= 3", points: 20, basis: "transactions 筆數（近 365 天）" },
      { key: "fleet", label: "現行持有 ≥ 2 台", condition: "b.owned_vehicles >= 2", points: 20, basis: "vehicle_relations 持有人（現行）" },
      { key: "passport", label: "具會員護照", condition: "b.member_passport IS NOT NULL", points: 10, basis: "customers.member_passport" },
      { key: "margin", label: "近一年毛利 ≥ 10,000", condition: "b.margin_365 >= 10000", points: 20, basis: "transactions.margin（僅有成本資料之交易）" },
    ],
    levels: [{ min: 60, label: "高" }, { min: 30, label: "中" }, { min: 0, label: "低" }],
  },
  {
    key: "engagement_score", label: "互動熱度", version: "v1", updated: "2026-10-07",
    description: "近期到廠、互動紀錄與進行中商機。",
    insufficient: "(b.last_visit_days IS NULL AND b.last_interaction_days IS NULL)",
    rules: [
      { key: "visit_90", label: "90 天內到廠", condition: "b.last_visit_days <= 90", points: 30, basis: "vehicles.last_visit_date" },
      { key: "visit_180", label: "91–180 天內到廠", condition: "b.last_visit_days > 90 AND b.last_visit_days <= 180", points: 15, basis: "vehicles.last_visit_date" },
      { key: "interaction_90", label: "90 天內有互動紀錄", condition: "b.last_interaction_days <= 90", points: 40, basis: "interactions.occurred_at" },
      { key: "open_opp", label: "有進行中商機", condition: "b.open_opps > 0", points: 30, basis: "opportunities（未結案）" },
    ],
    levels: [{ min: 60, label: "熱" }, { min: 30, label: "溫" }, { min: 0, label: "冷" }],
    caveat: "互動來源尚未串接時，僅以到廠與商機計分。",
  },
  {
    key: "replacement_score", label: "換購線索", version: "v1", updated: "2026-10-07",
    description: "車齡、里程、保固與維修支出只代表「值得確認」的線索，不等於購車意願。",
    insufficient: "(b.vehicle_age IS NULL)",
    rules: [
      { key: "age_7", label: "車齡 ≥ 7 年", condition: "b.vehicle_age >= 7", points: 25, basis: "vehicles.registration_date" },
      { key: "age_5", label: "車齡 5–7 年", condition: "b.vehicle_age >= 5 AND b.vehicle_age < 7", points: 10, basis: "vehicles.registration_date" },
      { key: "km_100k", label: "實際里程 ≥ 100,000 km", condition: "b.latest_mileage >= 100000 AND b.mileage_basis = '實際'", points: 20, basis: "vehicles.latest_mileage（實際）" },
      { key: "warranty_out", label: "已過原廠保固", condition: "b.warranty_state = '已過保'", points: 10, basis: "保固規則（3 年或 10 萬 km）" },
      { key: "repair_spend", label: "近一年維修支出 ≥ 30,000", condition: "b.repair_amount_365 >= 30000", points: 15, basis: "transactions 維修／理賠（近 365 天）" },
      { key: "test_drive", label: "180 天內試乘或報價", condition: "b.last_test_drive_or_quote_days <= 180", points: 30, basis: "interactions 試乘／報價" },
    ],
    levels: [{ min: 50, label: "強線索" }, { min: 25, label: "一般線索" }, { min: 0, label: "無明顯線索" }],
    caveat: "線索需由業代確認需求後才建立商機。",
  },
  {
    key: "churn_score", label: "流失風險", version: "v1", updated: "2026-10-07",
    description: "未回廠期間、定保中斷、保固狀態與客訴。",
    insufficient: "(b.last_visit_days IS NULL)",
    rules: [
      { key: "dormant_365", label: "≥ 365 天未回廠", condition: "b.last_visit_days >= 365", points: 40, basis: "vehicles.last_visit_date" },
      { key: "dormant_270", label: "270–364 天未回廠", condition: "b.last_visit_days >= 270 AND b.last_visit_days < 365", points: 25, basis: "vehicles.last_visit_date" },
      { key: "no_maintenance", label: "一年以上未定保", condition: "(b.last_maintenance_days >= 365 OR (b.last_maintenance_days IS NULL AND b.vehicle_age >= 1))", points: 20, basis: "vehicles.last_maintenance_date" },
      { key: "warranty_out", label: "已過原廠保固", condition: "b.warranty_state = '已過保'", points: 10, basis: "保固規則" },
      { key: "complaint", label: "客訴處理中", condition: "b.complaint_open = 1", points: 20, basis: "customers.complaint_open" },
    ],
    levels: [{ min: 50, label: "高" }, { min: 25, label: "中" }, { min: 0, label: "低" }],
  },
];

export function scoreSql(model: ScoreModel) {
  return `(CASE WHEN ${model.insufficient} THEN NULL ELSE ${model.rules.map((rule) => `(CASE WHEN ${rule.condition} THEN ${rule.points} ELSE 0 END)`).join(" + ")} END)`;
}

export function levelSql(model: ScoreModel) {
  const score = scoreSql(model);
  return `(CASE WHEN ${score} IS NULL THEN '資料不足' ${model.levels.map((level) => `WHEN ${score} >= ${level.min} THEN '${level.label}'`).join(" ")} END)`;
}

/** Columns that expose each rule as 0/1 so the UI can explain a single customer's score. */
export function explainColumns() {
  return scoreModels.flatMap((model) => [
    `${scoreSql(model)} AS ${model.key}`,
    `${levelSql(model)} AS ${model.key}_level`,
    ...model.rules.map((rule) => `(CASE WHEN ${rule.condition} THEN 1 ELSE 0 END) AS ${model.key}__${rule.key}`),
  ]);
}
