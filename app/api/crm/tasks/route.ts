import { HttpError } from "../../../../lib/crm/auth";
import { body, csvResponse, handler, pageParams, xlsxResponse } from "../../../../lib/crm/http";
import { assertCustomerAccess } from "../../../../lib/crm/auth";
import { applyResults, exportBatches, exportColumns, exportRows, exportTasks, insertTasks, listTasks, taskDetail, todayWork, updateTasks } from "../../../../lib/crm/tasks";

export const dynamic = "force-dynamic";

export const GET = handler(async (actor, _request, url) => {
  const params = url.searchParams;
  const view = params.get("view") ?? "list";
  if (view === "today") return todayWork(actor);
  if (view === "detail") return taskDetail(actor, params.get("code") ?? "");
  if (view === "batches") return exportBatches(actor);
  if (view === "download") {
    const { header, rows } = await exportRows(actor, params.get("export") ?? "");
    const name = `行動名單_${header.export_code}`;
    return params.get("format") === "csv" ? csvResponse(`${name}.csv`, exportColumns, rows) : xlsxResponse(`${name}.xlsx`, "行動名單", exportColumns, rows);
  }
  return listTasks(actor, { status: params.get("status") ?? undefined, owner: params.get("owner") ?? undefined, type: params.get("type") ?? undefined, search: params.get("q") ?? undefined, overdue: params.get("overdue") === "1", export_code: params.get("export") ?? undefined, campaign: params.get("campaign") ?? undefined, ...pageParams(url) });
});

export const POST = handler(async (actor, request) => {
  const input = await body(request);
  switch (input.action) {
    case "update": return updateTasks(actor, input.task_codes ?? [], input as never);
    case "create": {
      // 單筆任務（客戶 360／工作台「安排任務」）：負責人預設為建立者本人。
      if (!input.customer_code || !input.task_type || !input.action_text) throw new HttpError(400, "請填寫客戶、任務類型與建議行動");
      await assertCustomerAccess(actor, input.customer_code);
      const result = await insertTasks(actor, { task_type: input.task_type, action: input.action_text, due_days: Number(input.due_days) || 3, priority: Number(input.priority) || 2, initial_status: "待匯出" },
        [{ customer_code: input.customer_code, vehicle_code: input.vehicle_code || null, opp_code: input.opp_code || null, reason: input.reason || "人工安排", owner_staff_code: input.owner_staff_code || actor.staffCode, owner_unit_code: input.owner_unit_code || actor.unitCode }]);
      if (!result.created.length) throw new HttpError(409, "已有相同類型且未完成的任務");
      return { task_code: result.created[0] };
    }
    case "export": {
      const result = await exportTasks(actor, { task_codes: input.task_codes });
      return { export_code: result.header.export_code, list_version: result.header.list_version, tasks: result.rows.length };
    }
    case "results": {
      if (!Array.isArray(input.rows) || !input.file_hash) throw new HttpError(400, "請提供回傳檔內容");
      if (input.rows.length > 20000) throw new HttpError(400, "單次回傳最多 20,000 列");
      return applyResults(actor, { file_name: input.file_name, file_hash: input.file_hash, rows: input.rows, dry_run: Boolean(input.dry_run) });
    }
    default: throw new HttpError(400, "未知操作");
  }
});
