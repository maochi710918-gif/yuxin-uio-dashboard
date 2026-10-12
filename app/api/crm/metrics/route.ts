import { handler } from "../../../../lib/crm/http";
import { drill, managerDashboard } from "../../../../lib/crm/metrics";

export const dynamic = "force-dynamic";

export const GET = handler(async (actor, _request, url) => {
  const params = url.searchParams;
  const filters = { unit: params.get("unit") || undefined, staff: params.get("staff") || undefined, month: params.get("month") || undefined, campaign: params.get("campaign") || undefined, origin: params.get("origin") || undefined, segment: params.get("segment") || undefined };
  const key = params.get("drill");
  if (key) return { key, rows: await drill(actor, key, filters) };
  return managerDashboard(actor, filters);
});
