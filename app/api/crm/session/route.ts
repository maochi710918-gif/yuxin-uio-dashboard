import { type AppRole, HttpError, audit, listUsers, requireRole, roleLabels } from "../../../../lib/crm/auth";
import { all, first, nowIso, run } from "../../../../lib/crm/db";
import { body, handler } from "../../../../lib/crm/http";
import { analysisAsOf, getSetting, setSetting, settingDefaults } from "../../../../lib/crm/settings";

export const dynamic = "force-dynamic";

export const GET = handler(async (actor, _request, url) => {
  const isManager = actor.role === "company_manager" || actor.realRole === "company_manager";
  const settings = Object.fromEntries(await Promise.all(Object.keys(settingDefaults).map(async (key) => [key, { value: await getSetting(key), description: settingDefaults[key].description }])));
  const result: Record<string, unknown> = {
    actor: { ...actor, roleLabel: roleLabels[actor.role] },
    asOf: await analysisAsOf(),
    settings,
    roles: roleLabels,
  };
  if (isManager || url.searchParams.get("users")) {
    if (isManager) result.users = await listUsers();
    result.audit = isManager ? await all("SELECT * FROM audit_log ORDER BY audit_id DESC LIMIT 100") : [];
  }
  return result;
});

export const POST = handler(async (actor, request) => {
  const input = await body(request);
  switch (input.action) {
    case "impersonate": {
      // 驗證用代理身分：只有公司主管可使用，伺服器端保存並寫入稽核紀錄；不能透過網址參數切換。
      if (actor.realRole !== "company_manager") throw new HttpError(403, "只有公司主管可以切換驗證身分");
      if (!input.email) { await run("DELETE FROM user_impersonation WHERE real_email = ?", actor.email); await audit(actor, "結束代理身分", "app_users", actor.email, {}); return { ok: true }; }
      const target = await first("SELECT email FROM app_users WHERE email = ? AND active = 1", String(input.email).toLowerCase());
      if (!target) throw new HttpError(404, "查無此使用者");
      await run("INSERT INTO user_impersonation (real_email, acting_email, at) VALUES (?, ?, ?) ON CONFLICT(real_email) DO UPDATE SET acting_email = excluded.acting_email, at = excluded.at", actor.email, String(input.email).toLowerCase(), nowIso());
      await audit(actor, "切換代理身分", "app_users", String(input.email), {});
      return { ok: true };
    }
    case "upsert_user": {
      requireRole(actor, ["company_manager"]);
      const role = input.app_role as AppRole;
      if (!roleLabels[role]) throw new HttpError(400, "角色不正確");
      if ((role === "sales" || role === "advisor") && !input.staff_code) throw new HttpError(400, "業務與服務顧問需綁定人員編碼");
      if (role === "branch_manager" && !input.unit_code) throw new HttpError(400, "據點主管需綁定單位編碼");
      if (input.staff_code && !(await first("SELECT 1 FROM staff WHERE staff_code = ?", input.staff_code))) throw new HttpError(400, "人員編碼不存在");
      if (input.unit_code && !(await first("SELECT 1 FROM units WHERE unit_code = ?", input.unit_code))) throw new HttpError(400, "單位編碼不存在");
      await run("INSERT INTO app_users (email, display_name, app_role, unit_code, staff_code, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name, app_role = excluded.app_role, unit_code = excluded.unit_code, staff_code = excluded.staff_code, active = excluded.active, updated_at = excluded.updated_at",
        String(input.email).trim().toLowerCase(), input.display_name || input.email, role, input.unit_code || null, input.staff_code || null, input.active === false ? 0 : 1, nowIso());
      await audit(actor, "設定使用者", "app_users", String(input.email), { role, unit: input.unit_code, staff: input.staff_code, active: input.active !== false });
      return { ok: true };
    }
    case "setting": {
      requireRole(actor, ["company_manager"]);
      if (!settingDefaults[input.key]) throw new HttpError(400, "未知設定");
      if (input.key === "analysis_as_of" && input.value && !/^\d{4}-\d{2}-\d{2}$/.test(input.value)) throw new HttpError(400, "日期格式需為 YYYY-MM-DD");
      await setSetting(input.key, String(input.value ?? ""), actor.email);
      await audit(actor, "變更設定", "app_settings", input.key, { value: input.value });
      return { ok: true };
    }
    default:
      throw new HttpError(400, "未知操作");
  }
});
