import { HttpError } from "../../../../lib/crm/auth";
import { customer360, overrideScore, searchCustomers } from "../../../../lib/crm/customers";
import { body, handler, pageParams } from "../../../../lib/crm/http";

export const dynamic = "force-dynamic";

export const GET = handler(async (actor, _request, url) => {
  const code = url.searchParams.get("code");
  if (code) return customer360(actor, code.trim());
  return searchCustomers(actor, { q: url.searchParams.get("q") ?? "", ...pageParams(url) });
});

export const POST = handler(async (actor, request) => {
  const input = await body(request);
  if (input.action !== "override_score") throw new HttpError(400, "未知操作");
  await overrideScore(actor, input.customer_code, input.score_type, input.level || null, input.note ?? "");
  return { ok: true };
});
