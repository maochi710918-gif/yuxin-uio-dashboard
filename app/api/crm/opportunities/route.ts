import { HttpError } from "../../../../lib/crm/auth";
import { body, handler, pageParams } from "../../../../lib/crm/http";
import { changeOpportunity, createOpportunity, funnel, listOpportunities, opportunityDetail, oppTypes, stages } from "../../../../lib/crm/opportunities";

export const dynamic = "force-dynamic";

export const GET = handler(async (actor, _request, url) => {
  const params = url.searchParams;
  const view = params.get("view") ?? "list";
  if (view === "funnel") return funnel(actor, { type: params.get("type") ?? undefined, origin: params.get("origin") ?? undefined, owner: params.get("owner") ?? undefined });
  if (view === "detail") return opportunityDetail(actor, params.get("code") ?? "");
  const list = await listOpportunities(actor, { stage: params.get("stage") ?? undefined, type: params.get("type") ?? undefined, owner: params.get("owner") ?? undefined, handover: params.get("handover") ?? undefined, origin: params.get("origin") ?? undefined, search: params.get("q") ?? undefined, overdue: params.get("overdue") === "1", ...pageParams(url) });
  return { ...list, stages, types: oppTypes };
});

export const POST = handler(async (actor, request) => {
  const input = await body(request);
  if (input.action === "create") return { opp_code: await createOpportunity(actor, input as never) };
  if (input.action === "change") return changeOpportunity(actor, input.opp_code, { ...input, action: input.change } as never);
  throw new HttpError(400, "未知操作");
});
