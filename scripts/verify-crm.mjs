// 驗收腳本：以 ZZTEST- 測試資料（TEST- 來源）實際走過匯入、客群、任務、匯出、回傳、自動化與權限，最後清除測試資料。
// 用法：node scripts/verify-crm.mjs [--base http://127.0.0.1:5173] [--keep]
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://127.0.0.1:5173";
const keep = args.includes("--keep");
const results = [];
const check = (name, pass, detail) => { results.push({ 項目: name, 結果: pass ? "PASS" : "FAIL", 說明: detail }); console.log(`${pass ? "✔" : "✘"} ${name}｜${detail}`); };

const signin = await fetch(`${base}/signin-with-chatgpt?return_to=/`, { redirect: "manual", headers: { "sec-fetch-site": "same-origin" } });
const cookie = signin.headers.get("set-cookie").split(";")[0];
async function call(method, path, payload, { raw = false, allowError = false } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
  if (raw) return response;
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !allowError) throw new Error(`${path} ${response.status} ${data.error}`);
  return allowError ? { status: response.status, data } : data;
}
const post = (path, payload, options) => call("POST", path, payload, options);
const get = (path, options) => call("GET", path, null, options);

async function importRows(entity, source, dataDate, rows) {
  const overview = await get("/api/crm/import");
  const spec = overview.specs.find((item) => item.entity === entity);
  const text = JSON.stringify(rows);
  const created = await post("/api/crm/import", { action: "create_batch", entity, source_code: source, file_name: `${entity}.test`, file_hash: createHash("sha256").update(text).digest("hex"), data_date: dataDate });
  await post("/api/crm/import", { action: "stage", batch_code: created.batch_code, rows: rows.map((values, index) => ({ row_no: index + 2, values: Object.fromEntries(Object.entries(values).map(([key, value]) => [spec.fields.find((field) => field.label === key)?.key ?? key, value])) })) });
  await post("/api/crm/import", { action: "check", batch_code: created.batch_code });
  let cursor = null; do { cursor = (await post("/api/crm/import", { action: "process", batch_code: created.batch_code, cursor, write: true })).next; } while (cursor);
  return (await post("/api/crm/import", { action: "finalize", batch_code: created.batch_code, decision: "commit" })).counts;
}

function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; } else field += c; continue; }
    if (c === '"') quoted = true; else if (c === ",") { row.push(field); field = ""; } else if (c === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- setup
await post("/api/crm/import", { action: "purge_fixture" });
for (const [code, entity, priority] of [["TEST-STAFF", "staff", 50], ["TEST-CUST", "customers", 20], ["TEST-VEH", "vehicles", 20], ["TEST-REL", "vehicle_relations", 20], ["TEST-VSTAFF", "vehicle_staff", 20], ["TEST-TXN-A", "transactions", 10], ["TEST-TXN-B", "transactions", 20]]) {
  await post("/api/crm/import", { action: "create_source", source_code: code, name: `驗收 ${code}`, entity, priority, description: "驗收測試資料" });
}
await importRows("staff", "TEST-STAFF", "2026-01-01", [
  { 人員編碼: "ZZTEST-S1", 顯示名稱: "測試業代甲", 人員角色: "業代", 所屬單位編碼: "07S00" },
  { 人員編碼: "ZZTEST-S2", 顯示名稱: "測試業代乙", 人員角色: "業代", 所屬單位編碼: "07S00" },
]);
const customerRows = [
  { 客戶編碼: "ZZTEST-C1", 客戶類型: "個人", 可聯絡: "是", 可電話: "是", 拒收: "否" },
  { 客戶編碼: "ZZTEST-C2", 客戶類型: "個人", 可聯絡: "是", 可電話: "是", 拒收: "否" },
  { 客戶編碼: "ZZTEST-C3", 客戶類型: "個人", 可聯絡: "否", 拒收: "是", 拒收原因: "地端註記拒收" },
  { 客戶編碼: "ZZTEST-000123", 客戶類型: "法人", 可聯絡: "" },
];
const firstCustomers = await importRows("customers", "TEST-CUST", "2026-01-01", customerRows);
await importRows("vehicles", "TEST-VEH", "2026-01-01", [
  { 車輛編碼: "ZZTEST-V1", 車型: "P15", 領牌日: "2024-01-01", 最新里程: "30000", 里程依據: "實際", 服務單位編碼: "07S00", 最後進廠日: "2026-09-01" },
  { 車輛編碼: "ZZTEST-V2", 車型: "T32", 領牌日: "2018-01-01", 最新里程: "120000", 里程依據: "實際", 服務單位編碼: "07S00", 最後進廠日: "2025-01-01" },
  { 車輛編碼: "ZZTEST-V3", 車型: "B18", 領牌日: "2020-01-01", 服務單位編碼: "07S00", 最後進廠日: "2025-02-01" },
]);
await importRows("vehicle_relations", "TEST-REL", "2026-01-01", [
  { 車輛編碼: "ZZTEST-V1", 客戶編碼: "ZZTEST-C1", 關係: "持有人" }, { 車輛編碼: "ZZTEST-V2", 客戶編碼: "ZZTEST-C1", 關係: "持有人" },
  { 車輛編碼: "ZZTEST-V1", 客戶編碼: "ZZTEST-C2", 關係: "使用人" }, { 車輛編碼: "ZZTEST-V3", 客戶編碼: "ZZTEST-C3", 關係: "持有人" },
]);
await importRows("vehicle_staff", "TEST-VSTAFF", "2026-01-01", [
  { 車輛編碼: "ZZTEST-V1", 人員角色: "sales", 人員編碼: "ZZTEST-S1" }, { 車輛編碼: "ZZTEST-V2", 人員角色: "sales", 人員編碼: "ZZTEST-S1" }, { 車輛編碼: "ZZTEST-V3", 人員角色: "sales", 人員編碼: "ZZTEST-S2" },
]);
await importRows("transactions", "TEST-TXN-A", "2026-01-01", [{ 交易編碼: "ZZTEST-T1", 來源紀錄ID: "A-1", 交易類型: "維修", 車輛編碼: "ZZTEST-V2", 交易日: "2025-06-01", 金額: "1000" }]);
await importRows("transactions", "TEST-TXN-B", "2026-01-02", [{ 交易編碼: "ZZTEST-T1", 來源紀錄ID: "B-1", 交易類型: "維修", 車輛編碼: "ZZTEST-V2", 交易日: "2025-06-01", 金額: "999", 成本: "500" }, { 交易編碼: "ZZTEST-T2", 來源紀錄ID: "B-2", 交易類型: "保養", 車輛編碼: "ZZTEST-V2", 交易日: "2026-03-01", 金額: "2000" }]);

// 1. 相同編碼跨來源、跨批次正確串接
const c1 = await get("/api/crm/customers?code=ZZTEST-C1");
const t1 = c1.transactions.find((row) => row.txn_code === "ZZTEST-T1");
check("相同編碼跨來源、跨批次串接", t1 && t1.amount === 1000 && t1.sources.split(",").length === 2 && (await (async () => { const db = openDb(); const row = db.prepare("SELECT amount, cost FROM transactions WHERE txn_code = 'ZZTEST-T1'").get(); db.close(); return row.cost === 500; })()), `ZZTEST-T1 來自 ${t1?.sources}：金額取優先來源 A＝${t1?.amount}，成本由 B 補足＝500，只產生 1 筆交易`);

// 2. 一人多車與歷史人車關係
const ownedBefore = c1.relations.filter((row) => row.relation === "持有人" && !row.valid_to).length;
const segmentBefore = await post("/api/crm/segments", { action: "evaluate", definition: { op: "AND", items: [{ field: "sales_code", op: "eq", value: "ZZTEST-S1" }] } });
await importRows("vehicle_relations", "TEST-REL", "2026-02-01", [{ 車輛編碼: "ZZTEST-V2", 客戶編碼: "ZZTEST-C2", 關係: "持有人" }]);
const c1After = await get("/api/crm/customers?code=ZZTEST-C1");
const c2After = await get("/api/crm/customers?code=ZZTEST-C2");
const closed = c1After.relations.find((row) => row.vehicle_code === "ZZTEST-V2" && row.relation === "持有人");
check("一人多車與歷史人車關係", ownedBefore === 2 && closed?.valid_to === "2026-02-01" && c1After.relations.some((row) => row.vehicle_code === "ZZTEST-V1" && row.relation === "持有人" && !row.valid_to)
  && c1After.transactions.some((row) => row.txn_code === "ZZTEST-T1") && !c1After.transactions.some((row) => row.txn_code === "ZZTEST-T2") && c2After.transactions.some((row) => row.txn_code === "ZZTEST-T2") && !c2After.transactions.some((row) => row.txn_code === "ZZTEST-T1"),
  `C1 原持有 ${ownedBefore} 台；V2 轉手後 C1 關係結束於 ${closed?.valid_to}，轉手前交易 T1 留在 C1、轉手後交易 T2 只歸 C2；V1 使用人關係保留`);

// 3. 客群篩選與統計不重複（客戶與車輛分開計）
check("客群統計不重複、客戶與車輛分開", segmentBefore.customers === 1 && segmentBefore.vehicles === 2, `業代 S1 名下（轉手前）：客戶 ${segmentBefore.customers}、車輛 ${segmentBefore.vehicles}（同一客戶兩台車只算 1 位客戶）`);

// 4. 編碼保留前導零、資料不足不當成 0
const leading = await get("/api/crm/customers?code=ZZTEST-000123");
check("編碼文字保存、缺值為資料不足", leading.customer?.customer_code === "ZZTEST-000123" && leading.customer?.contact_eligible === null, `ZZTEST-000123 原樣保存；未提供的「可聯絡」為 NULL（資料不足），未補 0`);

// 5. 重複匯入不新增重複資料
const again = await importRows("customers", "TEST-CUST", "2026-01-01", customerRows);
check("重複匯入不新增重複資料", firstCustomers.insert === 4 && again.insert === 0 && again.unchanged === 4, `第一次新增 ${firstCustomers.insert}；同檔再匯入 新增 ${again.insert}、無變更 ${again.unchanged}`);

// 6. 任務與商機可持久儲存
const opp = await post("/api/crm/opportunities", { action: "create", opp_type: "換購", customer_code: "ZZTEST-C1", vehicle_code: "ZZTEST-V1", need: "驗收換購需求", owner_staff_code: "ZZTEST-S1" });
const taskA = await post("/api/crm/tasks", { action: "create", customer_code: "ZZTEST-C1", vehicle_code: "ZZTEST-V1", opp_code: opp.opp_code, task_type: "驗收追蹤A", action_text: "電話確認換購需求", owner_staff_code: "ZZTEST-S1" });
const taskB = await post("/api/crm/tasks", { action: "create", customer_code: "ZZTEST-C1", vehicle_code: "ZZTEST-V1", task_type: "驗收追蹤B", action_text: "保養提醒", owner_staff_code: "ZZTEST-S1" });
const dup = await post("/api/crm/tasks", { action: "create", customer_code: "ZZTEST-C1", vehicle_code: "ZZTEST-V1", task_type: "驗收追蹤B", action_text: "保養提醒", owner_staff_code: "ZZTEST-S1" }, { allowError: true });
const persisted = (() => { const db = openDb(); const n = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_code IN (?, ?)").get(taskA.task_code, taskB.task_code).n; const o = db.prepare("SELECT stage FROM opportunities WHERE opp_code = ?").get(opp.opp_code); db.close(); return { n, o }; })();
check("任務與商機持久儲存、重複任務排除", persisted.n === 2 && persisted.o?.stage === "分派" && dup.status === 409, `直接讀取資料庫檔：任務 ${persisted.n} 筆、商機 ${opp.opp_code} 階段 ${persisted.o?.stage}；同類型未完成任務再建立被擋（${dup.status}）`);

// 7. 下載與回傳精準對應原任務；已匯出 ≠ 已執行
const exported = await post("/api/crm/tasks", { action: "export", task_codes: [taskA.task_code, taskB.task_code] });
const csv = parseCsv(await (await call("GET", `/api/crm/tasks?view=download&export=${exported.export_code}&format=csv`, null, { raw: true })).text());
const header = csv[0];
const rows = csv.slice(1).map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""])));
const rowA = rows.find((row) => row["任務編碼"] === taskA.task_code);
const rowB = rows.find((row) => row["任務編碼"] === taskB.task_code);
rowA["執行日期"] = "2026-10-07"; rowA["聯絡結果"] = "已聯絡-有效回覆"; rowA["預約"] = "是";
rowB["客戶編碼"] = "ZZTEST-C2"; rowB["執行日期"] = "2026-10-07"; rowB["聯絡結果"] = "已聯絡-有效回覆";
const resultRows = [rowA, rowB].map((values, index) => ({ row_no: index + 2, values }));
const applied = await post("/api/crm/tasks", { action: "results", file_name: "verify.csv", file_hash: "verify-hash-1", rows: resultRows });
const detailA = await get(`/api/crm/tasks?view=detail&code=${taskA.task_code}`);
const detailB = await get(`/api/crm/tasks?view=detail&code=${taskB.task_code}`);
const oppAfter = await get(`/api/crm/opportunities?view=detail&code=${opp.opp_code}`);
check("下載與回傳精準對應原任務", header.includes("匯出批次編號") && header.includes("名單版本") && applied.summary.applied === 1 && applied.summary.rejected === 1 && detailA.task.status === "已完成" && oppAfter.opportunity.stage === "預約",
  `匯出 ${exported.export_code}；回傳 2 列：A 依任務編碼套用（任務已完成、商機→${oppAfter.opportunity.stage}），B 客戶編碼不符被拒絕`);
check("已匯出與已執行明確區分", detailB.task.status === "已匯出" && detailB.task.result === null, `B 已匯出但未回傳有效結果 → 狀態仍為「${detailB.task.status}」，不計為已執行`);
const reapply = await post("/api/crm/tasks", { action: "results", file_name: "verify.csv", file_hash: "verify-hash-1", rows: [resultRows[0]] });
check("回傳重複匯入防護", reapply.summary.applied === 0 && reapply.summary.unchanged === 1 && reapply.duplicate_of, `同內容再回傳：套用 ${reapply.summary.applied}、無變更 ${reapply.summary.unchanged}（偵測到重複檔 ${reapply.duplicate_of}）`);

// 8. 自動化遵守排除、停止與頻率規則
const rule = { trigger: { kind: "definition", definition: { op: "AND", items: [{ field: "sales_code", op: "in", value: ["ZZTEST-S1", "ZZTEST-S2"] }, { field: "last_visit_days", op: "gte", value: 365 }] } }, task: { task_type: "驗收喚回", action: "邀約回廠", owner_role: "sales", due_days: 7, priority: 2, promotional: true }, stop: ["已預約", "已成交", "拒收", "需求取消"] };
await post("/api/crm/automation", { action: "save", rule_code: "TEST-DORMANT", name: "驗收：未回廠喚回", definition: rule, enabled: true });
const run1 = await post("/api/crm/automation", { action: "run", rule_code: "TEST-DORMANT", mode: "執行" });
const run2 = await post("/api/crm/automation", { action: "run", rule_code: "TEST-DORMANT", mode: "執行" });
check("自動化排除、停止、頻率與重複規則", run1.matched === 2 && run1.skipped_ineligible === 1 && run1.created === 1 && run2.created === 0 && run2.skipped_duplicate + run2.skipped_frequency === 1,
  `第一次：符合 ${run1.matched}（V2→C2、V3→C3），C3 拒收排除 ${run1.skipped_ineligible}，建立 ${run1.created}；第二次：建立 ${run2.created}，重複 ${run2.skipped_duplicate}／頻率 ${run2.skipped_frequency}`);

// 9. 儀表板彙總與下鑽明細一致
const metrics = await get("/api/crm/metrics");
const assigned = metrics.metrics["名單執行"].find((metric) => metric.key === "assigned").value;
const drill = await get("/api/crm/metrics?drill=tasks_all");
check("儀表板彙總與下鑽明細一致", assigned <= 500 ? drill.rows.length === assigned : drill.rows.length === 500, `已分派任務 ${assigned}，下鑽明細 ${drill.rows.length} 筆（上限 500）`);

// 10. 各角色只能取得授權範圍資料（後端判定，網址參數無效）
await post("/api/crm/session", { action: "upsert_user", email: "zztest-sales@sites.test", display_name: "驗收業代甲", app_role: "sales", staff_code: "ZZTEST-S1" });
await post("/api/crm/session", { action: "impersonate", email: "zztest-sales@sites.test" });
const scoped = await get("/api/vehicles?pageSize=10");
const scopedWithParam = await get("/api/vehicles?pageSize=10&role=company_manager&view=triangle");
const forbidden = await get("/api/crm/customers?code=ZZTEST-C3", { allowError: true });
const importForbidden = await post("/api/crm/import", { action: "purge_fixture" }, { allowError: true });
await post("/api/crm/session", { action: "impersonate", email: "" });
check("角色只能取得授權範圍資料", scoped.total === 2 && scopedWithParam.total === 2 && forbidden.status === 404 && importForbidden.status === 403,
  `以業代 S1 身分：可見車輛 ${scoped.total} 台（只含指派給 S1 的 V1、V2，看不到 S2 的 V3）；加上 ?role=company_manager 仍為 ${scopedWithParam.total}；查他人客戶 → ${forbidden.status}；執行管理操作 → ${importForbidden.status}`);

// 11. 56,000 筆資料下的查詢效能
const timings = [];
for (const [label, fn] of [["總覽查詢", () => get("/api/vehicles?pageSize=25")], ["條件篩選（車型＋縣市）", () => get("/api/vehicles?model=P15&county=%E6%96%B0%E5%8C%97%E5%B8%82&pageSize=25")], ["客群試算（未回廠 365 天）", () => post("/api/crm/segments", { action: "evaluate", segment_code: "SEG-P02" })], ["客群名單分頁", () => post("/api/crm/segments", { action: "members", segment_code: "SEG-P02", page: 3, pageSize: 25 })], ["客戶搜尋", () => get("/api/crm/customers?q=ES-0123")], ["客戶 360", () => get("/api/crm/customers?code=ES-00001")], ["任務列表", () => get("/api/crm/tasks?pageSize=25")], ["主管儀表板", () => get("/api/crm/metrics")]]) {
  const started = performance.now(); await fn(); timings.push(`${label} ${((performance.now() - started) / 1000).toFixed(2)}s`);
}
const total = (await get("/api/vehicles?pageSize=10")).total;
check("5.6 萬筆資料下查詢順暢", total >= 54000, `母體 ${total.toLocaleString()} 台｜${timings.join("、")}`);

// 12. 正式資料、示範資料與推估結果明確區分
if (!keep) await post("/api/crm/import", { action: "purge_fixture" });
const leftovers = (() => { const db = openDb(); const n = ["customers", "vehicles", "tasks", "opportunities", "transactions"].reduce((sum, table) => sum + db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table === "transactions" ? "txn_code" : table === "vehicles" ? "vehicle_code" : "customer_code"} LIKE 'ZZTEST-%'`).get().n, 0); db.close(); return n; })();
check("正式／示範／推估資料區分", keep || leftovers === 0, keep ? "保留測試資料（--keep）" : `測試資料以 ZZTEST- 編碼與 TEST- 來源隔離，驗收後已清除（殘留 ${leftovers} 筆）；評分標示規則版本，資料不足不輸出分數；里程標示實際／推估`);

console.log("");
console.table(results);
process.exit(results.some((row) => row.結果 === "FAIL") ? 1 : 0);

function openDb() {
  const folder = join(process.cwd(), ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(folder).find((name) => name.endsWith(".sqlite") && !name.startsWith("metadata"));
  return new DatabaseSync(join(folder, file), { readOnly: true });
}
