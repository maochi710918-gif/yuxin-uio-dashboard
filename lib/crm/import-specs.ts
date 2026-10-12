// Import templates: one spec per entity. Codes are always kept as text so leading zeros survive.
export type FieldType = "code" | "text" | "date" | "int" | "real" | "bool" | "enum";
export type FieldSpec = { key: string; label: string; type: FieldType; required?: boolean; aliases?: string[]; options?: string[]; ref?: { table: string; column: string } };
export type EntityKind = "record" | "relation" | "transaction" | "summary";
export type EntitySpec = {
  entity: string; label: string; table: string; kind: EntityKind; order: number;
  keys: string[];               // identity of a row inside the target table
  groupKey?: string;            // relation imports: rows for this key in the file replace that key's current rows
  fields: FieldSpec[];
  note: string;
};

const relationRoles = ["持有人", "使用人", "付款人", "決策者"];
const staffRoles = ["sales", "advisor", "technician"];
const staffRoleAliases: Record<string, string> = { 業代: "sales", 業務: "sales", 銷售: "sales", 銷售顧問: "sales", 服專: "advisor", 服務專員: "advisor", 服務顧問: "advisor", 技師: "technician" };

export const entitySpecs: EntitySpec[] = [
  { entity: "units", label: "據點／部門", table: "units", kind: "record", order: 1, keys: ["unit_code"], note: "據點與部門編碼；其他資料表引用的單位需先匯入。", fields: [
    { key: "unit_code", label: "單位編碼", type: "code", required: true },
    { key: "name", label: "單位名稱", type: "text", required: true },
    { key: "unit_type", label: "單位類型", type: "enum", options: ["公司", "據點", "部門"] },
    { key: "parent_code", label: "上層單位編碼", type: "code" },
    { key: "code_status", label: "編碼狀態", type: "enum", options: ["正式", "暫用（依名稱）"] },
  ] },
  { entity: "staff", label: "人員", table: "staff", kind: "record", order: 2, keys: ["staff_code"], note: "業代、服專、技師使用一致的人員編碼。", fields: [
    { key: "staff_code", label: "人員編碼", type: "code", required: true },
    { key: "display_name", label: "顯示名稱", type: "text", required: true },
    { key: "staff_role", label: "人員角色", type: "enum", required: true, options: staffRoles },
    { key: "unit_code", label: "所屬單位編碼", type: "code", ref: { table: "units", column: "unit_code" } },
    { key: "active", label: "在職", type: "bool" },
    { key: "code_status", label: "編碼狀態", type: "enum", options: ["正式", "暫用（依名稱）"] },
  ] },
  { entity: "customers", label: "客戶", table: "customers", kind: "record", order: 3, keys: ["customer_code"], note: "以客戶編碼識別；聯絡資格、管道與拒收狀態由地端提供，不含聯絡方式本身。", fields: [
    { key: "customer_code", label: "客戶編碼", type: "code", required: true },
    { key: "customer_type", label: "客戶類型", type: "enum", options: ["個人", "法人"] },
    { key: "gender", label: "性別", type: "text" },
    { key: "birth_year", label: "出生年", type: "int" },
    { key: "age", label: "年齡", type: "int" },
    { key: "home_unit_code", label: "歸屬單位編碼", type: "code", ref: { table: "units", column: "unit_code" } },
    { key: "county", label: "縣市", type: "text" },
    { key: "district", label: "行政區", type: "text" },
    { key: "member_passport", label: "會員護照", type: "text" },
    { key: "consent_status", label: "個資授權狀態", type: "text" },
    { key: "contact_eligible", label: "可聯絡", type: "bool" },
    { key: "channel_phone", label: "可電話", type: "bool" },
    { key: "channel_sms", label: "可簡訊", type: "bool" },
    { key: "channel_email", label: "可Email", type: "bool" },
    { key: "channel_line", label: "可LINE", type: "bool" },
    { key: "opt_out", label: "拒收", type: "bool" },
    { key: "opt_out_reason", label: "拒收原因", type: "text" },
    { key: "complaint_open", label: "客訴處理中", type: "bool" },
    { key: "satisfaction_score", label: "滿意度", type: "real" },
    { key: "source_record_id", label: "來源紀錄ID", type: "code" },
  ] },
  { entity: "vehicles", label: "車輛", table: "vehicles", kind: "record", order: 4, keys: ["vehicle_code"], note: "以車輛編碼識別；里程請註明為實際或推估。", fields: [
    { key: "vehicle_code", label: "車輛編碼", type: "code", required: true },
    { key: "model_series", label: "車型", type: "text" },
    { key: "model_code", label: "車型代碼", type: "text" },
    { key: "registration_date", label: "領牌日", type: "date" },
    { key: "delivery_date", label: "交車日", type: "date" },
    { key: "latest_mileage", label: "最新里程", type: "int" },
    { key: "mileage_date", label: "里程紀錄日", type: "date" },
    { key: "mileage_basis", label: "里程依據", type: "enum", options: ["實際", "推估"] },
    { key: "warranty_expiry", label: "保固到期日", type: "date" },
    { key: "warranty_km_limit", label: "保固里程上限", type: "int" },
    { key: "extended_warranty_expiry", label: "延長保固到期日", type: "date" },
    { key: "insurance_expiry", label: "保險到期日", type: "date" },
    { key: "service_unit_code", label: "服務單位編碼", type: "code", ref: { table: "units", column: "unit_code" } },
    { key: "last_visit_date", label: "最後進廠日", type: "date" },
    { key: "last_maintenance_date", label: "最後定保日", type: "date" },
    { key: "last_maintenance_mileage", label: "最後定保里程", type: "int" },
    { key: "maintenance_interval_months", label: "保養週期月", type: "int" },
    { key: "maintenance_interval_km", label: "保養週期里程", type: "int" },
    { key: "source_record_id", label: "來源紀錄ID", type: "code" },
  ] },
  { entity: "vehicle_relations", label: "人車關係", table: "vehicle_relations", kind: "relation", order: 5, keys: ["vehicle_code", "customer_code", "relation", "valid_from"], groupKey: "vehicle_code", note: "持有人／使用人／付款人／決策者。檔案中出現的車輛，其現行關係以本檔為準；未出現在本檔的舊關係會補上結束日（轉手保留歷史）。", fields: [
    { key: "vehicle_code", label: "車輛編碼", type: "code", required: true, ref: { table: "vehicles", column: "vehicle_code" } },
    { key: "customer_code", label: "客戶編碼", type: "code", required: true, ref: { table: "customers", column: "customer_code" } },
    { key: "relation", label: "關係", type: "enum", required: true, options: relationRoles },
    { key: "valid_from", label: "起日", type: "date" },
    { key: "valid_to", label: "迄日", type: "date" },
    { key: "source_record_id", label: "來源紀錄ID", type: "code" },
  ] },
  { entity: "vehicle_staff", label: "車輛負責人員", table: "vehicle_staff", kind: "relation", order: 6, keys: ["vehicle_code", "staff_role", "staff_code", "valid_from"], groupKey: "vehicle_code", note: "業代／服專／技師對車輛的指派，同樣保留期間。", fields: [
    { key: "vehicle_code", label: "車輛編碼", type: "code", required: true, ref: { table: "vehicles", column: "vehicle_code" } },
    { key: "staff_role", label: "人員角色", type: "enum", required: true, options: staffRoles },
    { key: "staff_code", label: "人員編碼", type: "code", required: true, ref: { table: "staff", column: "staff_code" } },
    { key: "valid_from", label: "起日", type: "date" },
    { key: "valid_to", label: "迄日", type: "date" },
  ] },
  { entity: "relation_groups", label: "家庭／企業成員", table: "relation_group_members", kind: "relation", order: 7, keys: ["group_code", "customer_code", "valid_from"], groupKey: "group_code", note: "家庭或企業車隊；群組編碼由地端提供。", fields: [
    { key: "group_code", label: "關係群組編碼", type: "code", required: true },
    { key: "group_type", label: "群組類型", type: "enum", required: true, options: ["家庭", "企業"] },
    { key: "customer_code", label: "客戶編碼", type: "code", required: true, ref: { table: "customers", column: "customer_code" } },
    { key: "member_role", label: "成員角色", type: "text" },
    { key: "valid_from", label: "起日", type: "date" },
    { key: "valid_to", label: "迄日", type: "date" },
  ] },
  { entity: "transactions", label: "交易", table: "transactions", kind: "transaction", order: 8, keys: ["source_record_id"], note: "購車、保養、維修、保險及其他服務。同一交易編碼可來自多個來源，依來源優先順序合併；營收以交易為準。", fields: [
    { key: "txn_code", label: "交易編碼", type: "code", required: true },
    { key: "source_record_id", label: "來源紀錄ID", type: "code", required: true },
    { key: "txn_type", label: "交易類型", type: "enum", options: ["購車", "保養", "維修", "保險", "美容", "理賠", "其他"] },
    { key: "vehicle_code", label: "車輛編碼", type: "code", ref: { table: "vehicles", column: "vehicle_code" } },
    { key: "customer_code", label: "客戶編碼", type: "code", ref: { table: "customers", column: "customer_code" } },
    { key: "txn_date", label: "交易日", type: "date", required: true },
    { key: "unit_code", label: "單位編碼", type: "code", ref: { table: "units", column: "unit_code" } },
    { key: "advisor_code", label: "服專編碼", type: "code" },
    { key: "technician_code", label: "技師編碼", type: "code" },
    { key: "mileage", label: "進廠里程", type: "int" },
    { key: "amount", label: "金額", type: "real" },
    { key: "cost", label: "成本", type: "real" },
    { key: "margin", label: "毛利", type: "real" },
  ] },
  { entity: "interactions", label: "互動", table: "interactions", kind: "record", order: 9, keys: ["interaction_code"], note: "聯絡、詢問、試乘、報價、活動、到店、客訴、滿意度事件。", fields: [
    { key: "interaction_code", label: "互動編碼", type: "code", required: true },
    { key: "interaction_type", label: "互動類型", type: "enum", required: true, options: ["聯絡", "詢問", "試乘", "報價", "活動", "到店", "客訴", "滿意度"] },
    { key: "customer_code", label: "客戶編碼", type: "code", required: true, ref: { table: "customers", column: "customer_code" } },
    { key: "vehicle_code", label: "車輛編碼", type: "code", ref: { table: "vehicles", column: "vehicle_code" } },
    { key: "channel", label: "通路", type: "text" },
    { key: "occurred_at", label: "發生日", type: "date", required: true },
    { key: "staff_code", label: "人員編碼", type: "code" },
    { key: "unit_code", label: "單位編碼", type: "code" },
    { key: "outcome", label: "結果", type: "text" },
    { key: "detail", label: "說明", type: "text" },
    { key: "opp_code", label: "商機編碼", type: "code" },
    { key: "campaign_code", label: "活動編碼", type: "code" },
    { key: "source_record_id", label: "來源紀錄ID", type: "code" },
  ] },
  { entity: "satisfaction", label: "滿意度問卷", table: "satisfaction_surveys", kind: "record", order: 11, keys: ["survey_code"], note: "CSI 問卷分數與客戶聲音。車牌須先在地端換成車輛編碼（data-pipeline/csi_to_platform.py），平台不接收車牌。", fields: [
    { key: "survey_code", label: "問卷編碼", type: "code", required: true },
    { key: "vehicle_code", label: "車輛編碼", type: "code", ref: { table: "vehicles", column: "vehicle_code" } },
    { key: "customer_code", label: "客戶編碼", type: "code", ref: { table: "customers", column: "customer_code" } },
    { key: "survey_month", label: "問卷月份", type: "code" },
    { key: "service_date", label: "進廠日", type: "date" },
    { key: "unit_code", label: "單位編碼", type: "code", ref: { table: "units", column: "unit_code" } },
    { key: "advisor_code", label: "服專編碼", type: "code" },
    { key: "technician_code", label: "技師編碼", type: "code" },
    { key: "delivery_mode", label: "交車方式", type: "text" },
    { key: "first_visit", label: "首次進廠", type: "bool" },
    { key: "service_category", label: "維修類別", type: "text" },
    { key: "score_overall", label: "整體滿意度", type: "real" },
    { key: "score_repair", label: "保修處理", type: "real" },
    { key: "score_checkout", label: "結帳服務", type: "real" },
    { key: "score_explain", label: "交修說明", type: "real" },
    { key: "score_lounge", label: "客休室", type: "real" },
    { key: "score_total", label: "均總分", type: "real" },
    { key: "voc_text", label: "客戶聲音", type: "text" },
    { key: "voc_category", label: "客戶聲音分類", type: "text" },
    { key: "source_record_id", label: "來源紀錄ID", type: "code" },
  ] },
  { entity: "vehicle_service_summary", label: "車輛服務彙總", table: "vehicle_service_summary", kind: "summary", order: 10, keys: ["vehicle_code"], note: "來源系統提供的一年服務次數與金額等彙總值（例如 UIO 總表）。除車輛編碼外的欄位皆原樣保存。", fields: [
    { key: "vehicle_code", label: "車輛編碼", type: "code", required: true, ref: { table: "vehicles", column: "vehicle_code" } },
  ] },
];

export function specFor(entity: string) {
  const spec = entitySpecs.find((item) => item.entity === entity);
  if (!spec) throw new Error(`未知的匯入類型：${entity}`);
  return spec;
}

export type RowError = { field: string | null; code: string; message: string };

const truthy = new Set(["1", "Y", "YES", "TRUE", "是", "有", "可", "同意", "V"]);
const falsy = new Set(["0", "N", "NO", "FALSE", "否", "無", "不可", "不同意"]);

/** Excel serial date (days since 1899-12-30) → ISO date. */
function excelSerialToIso(serial: number) {
  const ms = Math.round((serial - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseValue(field: FieldSpec, raw: unknown): { value: unknown; error?: RowError } {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!text) return field.required ? { value: null, error: { field: field.key, code: "required", message: `${field.label} 為必填` } } : { value: null };
  switch (field.type) {
    case "code":
      if (/\s/.test(text)) return { value: null, error: { field: field.key, code: "code_format", message: `${field.label} 含空白字元` } };
      return { value: text };
    case "text":
      return { value: text };
    case "date": {
      if (/^\d+(\.\d+)?$/.test(text) && Number(text) > 20000 && Number(text) < 80000) return { value: excelSerialToIso(Number(text)) };
      const match = text.replace(/\./g, "-").replace(/\//g, "-").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (!match) return { value: null, error: { field: field.key, code: "date_format", message: `${field.label} 日期格式錯誤：${text}（需 YYYY-MM-DD）` } };
      const iso = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
      const date = new Date(`${iso}T00:00:00Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return { value: null, error: { field: field.key, code: "date_invalid", message: `${field.label} 不是有效日期：${text}` } };
      return { value: iso };
    }
    case "int":
    case "real": {
      const cleaned = text.replace(/[,，\s]/g, "").replace(/^\$/, "");
      const number = Number(cleaned);
      if (!Number.isFinite(number)) return { value: null, error: { field: field.key, code: "number_format", message: `${field.label} 必須是數字：${text}` } };
      if (field.type === "int" && !Number.isInteger(number)) return { value: Math.round(number) };
      return { value: number };
    }
    case "bool": {
      const upper = text.toUpperCase();
      if (truthy.has(upper)) return { value: 1 };
      if (falsy.has(upper)) return { value: 0 };
      return { value: null, error: { field: field.key, code: "bool_format", message: `${field.label} 需為 是／否：${text}` } };
    }
    case "enum": {
      const normalized = field.key === "staff_role" ? staffRoleAliases[text] ?? text : field.key === "customer_type" && text === "公司法人" ? "法人" : text;
      if (field.options && !field.options.includes(normalized)) return { value: null, error: { field: field.key, code: "enum", message: `${field.label} 只能是 ${field.options.join("、")}：${text}` } };
      return { value: normalized };
    }
  }
}

/** Header → field mapping by key, label or alias (case/space-insensitive). */
export function autoMapping(spec: EntitySpec, headers: string[]) {
  const norm = (value: string) => value.replace(/[\s_（）()]/g, "").toLowerCase();
  const mapping: Record<string, string> = {};
  for (const header of headers) {
    const field = spec.fields.find((item) => [item.key, item.label, ...(item.aliases ?? [])].some((name) => norm(name) === norm(header)));
    if (field && !Object.values(mapping).includes(field.key)) mapping[header] = field.key;
  }
  return mapping;
}
