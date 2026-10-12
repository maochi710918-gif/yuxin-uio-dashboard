// 批次匯入：以平台的匯入 API（與畫面相同流程：建立批次 → 驗證暫存 → 關聯檢查 → 預覽 → 寫入 → 完成）匯入地端轉檔結果。
// 用法：node scripts/import-entities.mjs <資料夾> [--base http://127.0.0.1:5173] [--only vehicles,customers] [--preview-only]
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const folder = args[0];
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const base = option("--base", "http://127.0.0.1:5173");
const only = option("--only", "")?.split(",").filter(Boolean);
const previewOnly = args.includes("--preview-only");
if (!folder) { console.error("請指定轉檔資料夾"); process.exit(1); }

// Local development sign-in (mock auth on 127.0.0.1); in production supply a real session cookie via CRM_COOKIE.
async function signIn() {
  if (process.env.CRM_COOKIE) return process.env.CRM_COOKIE;
  const response = await fetch(`${base}/signin-with-chatgpt?return_to=/`, { redirect: "manual", headers: { "sec-fetch-site": "same-origin" } });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("無法取得本機登入");
  return cookie;
}
const cookie = await signIn();

async function api(method, path, payload) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${base}${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
    if (response.ok) return data;
    if (attempt < 3 && response.status >= 500) { await new Promise((resolve) => setTimeout(resolve, 1000 * attempt)); continue; }
    throw new Error(`${path} ${response.status}: ${data.error}`);
  }
}

function parseCsv(text) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) { if (char === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; } else field += char; continue; }
    if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const plan = [
  ["units", "units.csv", "UIO-UNIT"], ["staff", "staff.csv", "UIO-STAFF"], ["customers", "customers.csv", "UIO-CUST"], ["vehicles", "vehicles.csv", "UIO-VEH"],
  ["vehicle_relations", "vehicle_relations.csv", "UIO-REL"], ["vehicle_staff", "vehicle_staff.csv", "UIO-VSTAFF"], ["vehicle_service_summary", "vehicle_service_summary.csv", "UIO-SUMMARY"],
  ["transactions", "transactions_repair.csv", "DMS-REPAIR"], ["transactions", "transactions_spend.csv", "DMS-SPEND"], ["transactions", "transactions_beauty.csv", "DMS-BEAUTY"],
];

const overview = await api("GET", "/api/crm/import");
const dataDate = (await readFile(join(folder, "data_date.txt"), "utf8")).trim();
const report = [];
for (const [entity, file, source] of plan) {
  if (only?.length && !only.includes(entity) && !only.includes(file)) continue;
  const started = Date.now();
  const bytes = await readFile(join(folder, file));
  const [header, ...lines] = parseCsv(bytes.toString("utf8")).filter((row) => row.some((cell) => cell !== ""));
  const spec = overview.specs.find((item) => item.entity === entity);
  const mapping = header.map((name) => spec.fields.find((field) => field.label === name || field.key === name)?.key ?? (spec.kind === "summary" ? name : null));
  const created = await api("POST", "/api/crm/import", { action: "create_batch", entity, source_code: source, file_name: file, file_hash: createHash("sha256").update(bytes).digest("hex"), data_date: dataDate });
  const batch = created.batch_code;
  if (created.duplicate_of) console.log(`  ⚠ ${file} 與已完成批次 ${created.duplicate_of.batch_code} 內容相同，將判定為無變更`);
  for (let offset = 0; offset < lines.length; offset += 1000) {
    const rows = lines.slice(offset, offset + 1000).map((cells, index) => ({ row_no: offset + index + 2, values: Object.fromEntries(mapping.map((key, column) => [key, cells[column] ?? ""]).filter(([key]) => key)) }));
    await api("POST", "/api/crm/import", { action: "stage", batch_code: batch, rows });
  }
  await api("POST", "/api/crm/import", { action: "check", batch_code: batch });
  let cursor = null, closedPreview = 0;
  do { const page = await api("POST", "/api/crm/import", { action: "process", batch_code: batch, cursor, write: false }); cursor = page.next; closedPreview += page.closed ?? 0; } while (cursor);
  const preview = await api("POST", "/api/crm/import", { action: "summary", batch_code: batch });
  if (previewOnly) { await api("POST", "/api/crm/import", { action: "finalize", batch_code: batch, decision: "reject" }); report.push({ file, batch, ...preview.counts, closed: closedPreview, mode: "預覽" }); continue; }
  cursor = null;
  do { const page = await api("POST", "/api/crm/import", { action: "process", batch_code: batch, cursor, write: true }); cursor = page.next; } while (cursor);
  const final = await api("POST", "/api/crm/import", { action: "finalize", batch_code: batch, decision: "commit" });
  report.push({ file, batch, rows: lines.length, ...final.counts, seconds: Math.round((Date.now() - started) / 1000) });
  console.log(`${file}: ${JSON.stringify(final.counts)} ${Math.round((Date.now() - started) / 1000)}s` + (final.errorTypes?.length ? ` 錯誤 ${JSON.stringify(final.errorTypes)}` : ""));
}
console.table(report);
