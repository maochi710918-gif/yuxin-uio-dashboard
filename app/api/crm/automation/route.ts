import { HttpError } from "../../../../lib/crm/auth";
import { listRules, ruleHistory, runRule, saveRule, setRuleEnabled } from "../../../../lib/crm/automation";
import { body, handler } from "../../../../lib/crm/http";

export const dynamic = "force-dynamic";

export const GET = handler(async (_actor, _request, url) => {
  const code = url.searchParams.get("history");
  return code ? ruleHistory(code) : listRules();
});

export const POST = handler(async (actor, request) => {
  const input = await body(request);
  switch (input.action) {
    case "save": return { version: await saveRule(actor, input.rule_code, input.name, input.definition, Boolean(input.enabled)) };
    case "enable": await setRuleEnabled(actor, input.rule_code, Boolean(input.enabled)); return { ok: true };
    case "run": return runRule(actor, input.rule_code, input.mode === "執行" ? "執行" : "試算");
    default: throw new HttpError(400, "未知操作");
  }
});
