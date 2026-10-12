import { HttpError } from "../../../../lib/crm/auth";
import { createCampaign, createTasks, deleteSegment, listCampaigns, saveSegment, segmentDefinition } from "../../../../lib/crm/campaigns";
import { all } from "../../../../lib/crm/db";
import { body, csvResponse, handler } from "../../../../lib/crm/http";
import { scoreModels } from "../../../../lib/crm/scores";
import { describe, evaluate, fieldDefs, members, parseDefinition } from "../../../../lib/crm/segments";

export const dynamic = "force-dynamic";

export const GET = handler(async (actor, _request, url) => {
  if (url.searchParams.get("view") === "export") {
    const raw = url.searchParams.get("definition");
    const { definition, name } = await segmentDefinition({ segment_code: url.searchParams.get("segment") ?? undefined, definition: raw ? JSON.parse(raw) : undefined });
    const result = await members(actor, definition, 1, 60000);
    return csvResponse(`客群名單_${name ?? "自訂"}.csv`, ["客戶編碼", "車輛編碼", "車型", "服務據點", "業代", "服專", "未回廠天數", "保固狀態", "排除原因", "入選原因", "資料日期"],
      result.rows.map((row) => [row.customer_code, row.vehicle_code ?? "", row.model_series ?? "", row.service_unit_code ?? "", row.sales_code ?? "", row.advisor_code ?? "", row.last_visit_days ?? "資料不足", row.warranty_state, row.exclusion_reason ?? "", result.description, result.asOf]));
  }
  const segments = await all<Record<string, unknown>>("SELECT * FROM segments ORDER BY is_preset DESC, segment_code");
  return {
    segments: segments.map((segment) => ({ ...segment, definition: JSON.parse(String(segment.definition)), readable: describe(parseDefinition(String(segment.definition))) })),
    fields: fieldDefs.map((field) => ({ key: field.key, label: field.label, group: field.group, type: field.type, unit: field.unit, options: field.options, source: field.source })),
    scoreModels,
    campaigns: await listCampaigns(),
  };
});

export const POST = handler(async (actor, request) => {
  const input = await body(request);
  switch (input.action) {
    case "evaluate": { const { definition } = await segmentDefinition(input); return evaluate(actor, definition); }
    case "members": { const { definition } = await segmentDefinition(input); return members(actor, definition, Math.max(1, Number(input.page) || 1), Math.min(200, Number(input.pageSize) || 25), { actionableOnly: Boolean(input.actionableOnly), search: input.search }); }
    case "save": return { segment_code: await saveSegment(actor, input as never) };
    case "delete": await deleteSegment(actor, input.segment_code); return { ok: true };
    case "campaign": return createCampaign(actor, input as never);
    case "tasks": return createTasks(actor, { ...input, action: input.action_text } as never);
    default: throw new HttpError(400, "未知操作");
  }
});
