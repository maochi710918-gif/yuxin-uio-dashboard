import { HttpError, audit, requireRole } from "../../../../lib/crm/auth";
import { all, nowIso, run } from "../../../../lib/crm/db";
import { body, csvResponse, handler } from "../../../../lib/crm/http";
import { batchSummary, checkReferences, createBatch, finalizeBatch, processPage, stageRows } from "../../../../lib/crm/import";
import { entitySpecs, specFor } from "../../../../lib/crm/import-specs";
import { exportColumns } from "../../../../lib/crm/tasks";

export const dynamic = "force-dynamic";

export const GET = handler(async (actor, _request, url) => {
  requireRole(actor, ["company_manager", "branch_manager"]);
  const view = url.searchParams.get("view") ?? "overview";
  if (view === "template") {
    const entity = url.searchParams.get("entity") ?? "";
    if (entity === "results") return csvResponse("結果回傳範本.csv", exportColumns, []);
    const spec = specFor(entity);
    return csvResponse(`匯入範本_${spec.label}.csv`, spec.fields.map((field) => field.label), []);
  }
  if (view === "summary") return batchSummary(url.searchParams.get("batch") ?? "");
  if (view === "errors") {
    const rows = await all<{ row_no: number; field: string | null; error_code: string; message: string }>("SELECT row_no, field, error_code, message FROM import_errors WHERE batch_code = ? ORDER BY row_no", url.searchParams.get("batch") ?? "");
    return csvResponse(`匯入錯誤明細_${url.searchParams.get("batch")}.csv`, ["列號", "欄位", "錯誤代碼", "說明"], rows.map((row) => [row.row_no, row.field ?? "", row.error_code, row.message]));
  }
  return {
    specs: entitySpecs.map((spec) => ({ entity: spec.entity, label: spec.label, order: spec.order, kind: spec.kind, note: spec.note, keys: spec.keys, fields: spec.fields })),
    sources: await all("SELECT * FROM sources ORDER BY entity, priority"),
    batches: await all("SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 100"),
    results: await all("SELECT * FROM result_batches ORDER BY created_at DESC LIMIT 50"),
  };
});

export const POST = handler(async (actor, request) => {
  requireRole(actor, ["company_manager"]);
  const input = await body(request);
  switch (input.action) {
    case "create_batch": return createBatch(actor, input as Parameters<typeof createBatch>[1]);
    case "stage": {
      if (!Array.isArray(input.rows) || input.rows.length > 2000) throw new HttpError(400, "每次最多 2,000 列");
      return stageRows(input.batch_code, input.rows);
    }
    case "check": return checkReferences(input.batch_code);
    case "process": return processPage(input.batch_code, input.cursor ?? null, Boolean(input.write));
    case "summary": return batchSummary(input.batch_code);
    case "finalize": return finalizeBatch(actor, input.batch_code, input.decision === "reject" ? "reject" : "commit");
    case "create_source": {
      const spec = specFor(input.entity);
      if (!/^[A-Z0-9-]{3,30}$/.test(input.source_code ?? "")) throw new HttpError(400, "來源代碼需為 3–30 個大寫英數字或連字號");
      await run("INSERT INTO sources (source_code, name, entity, priority, description) VALUES (?, ?, ?, ?, ?)", input.source_code, input.name || input.source_code, spec.entity, Number(input.priority) || 100, input.description ?? "");
      await audit(actor, "建立資料來源", "sources", input.source_code, { entity: spec.entity, priority: input.priority });
      return { ok: true };
    }
    case "set_priority": {
      await run("UPDATE sources SET priority = ? WHERE source_code = ?", Number(input.priority), input.source_code);
      await audit(actor, "變更來源優先順序", "sources", input.source_code, { priority: input.priority, at: nowIso() });
      return { ok: true };
    }
    case "purge_fixture": {
      // 驗收／示範資料一律使用 ZZTEST- 編碼與 TEST- 來源，與正式資料分開，並可一鍵清除。
      const like = "ZZTEST-%";
      const statements: [string, unknown[]][] = [
        ["DELETE FROM task_events WHERE task_code IN (SELECT task_code FROM tasks WHERE customer_code LIKE ?)", [like]],
        ["DELETE FROM result_rows WHERE task_code IN (SELECT task_code FROM tasks WHERE customer_code LIKE ?)", [like]],
        ["DELETE FROM tasks WHERE customer_code LIKE ?", [like]],
        ["DELETE FROM opportunity_events WHERE opp_code IN (SELECT opp_code FROM opportunities WHERE customer_code LIKE ?)", [like]],
        ["DELETE FROM opportunities WHERE customer_code LIKE ?", [like]],
        ["DELETE FROM interactions WHERE customer_code LIKE ?", [like]],
        ["DELETE FROM campaign_members WHERE customer_code LIKE ?", [like]],
        ["DELETE FROM transaction_source_records WHERE txn_code LIKE ?", [like]],
        ["DELETE FROM transactions WHERE txn_code LIKE ?", [like]],
        ["DELETE FROM vehicle_staff WHERE vehicle_code LIKE ?", [like]],
        ["DELETE FROM vehicle_relations WHERE vehicle_code LIKE ?", [like]],
        ["DELETE FROM vehicle_service_summary WHERE vehicle_code LIKE ?", [like]],
        ["DELETE FROM vehicles WHERE vehicle_code LIKE ?", [like]],
        ["DELETE FROM customers WHERE customer_code LIKE ?", [like]],
        ["DELETE FROM staff WHERE staff_code LIKE ?", [like]],
        ["DELETE FROM app_users WHERE email LIKE ?", ["zztest-%"]],
        ["DELETE FROM user_impersonation WHERE acting_email LIKE ?", ["zztest-%"]],
        ["DELETE FROM import_errors WHERE batch_code IN (SELECT batch_code FROM import_batches WHERE source_code LIKE 'TEST-%')", []],
        ["DELETE FROM import_batches WHERE source_code LIKE 'TEST-%'", []],
        ["DELETE FROM export_batches WHERE export_code NOT IN (SELECT export_code FROM tasks WHERE export_code IS NOT NULL)", []],
        ["DELETE FROM result_rows WHERE result_batch_code IN (SELECT result_batch_code FROM result_batches WHERE file_hash LIKE 'verify-%')", []],
        ["DELETE FROM result_batches WHERE file_hash LIKE 'verify-%'", []],
        ["DELETE FROM automation_runs WHERE rule_code LIKE 'TEST-%'", []],
        ["DELETE FROM automation_rules WHERE rule_code LIKE 'TEST-%'", []],
        ["DELETE FROM sources WHERE source_code LIKE 'TEST-%'", []],
      ];
      let removed = 0;
      for (const [sql, params] of statements) removed += (await run(sql, ...params)).meta.changes ?? 0;
      await audit(actor, "清除驗收測試資料", "fixtures", "ZZTEST", { removed });
      const { bumpDataVersion } = await import("../../../../lib/crm/import");
      await bumpDataVersion(actor.email);
      return { removed };
    }
    default: throw new HttpError(400, "未知操作");
  }
});
