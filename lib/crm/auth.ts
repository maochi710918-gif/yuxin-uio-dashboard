import { all, first, nowIso, run } from "./db";

export type AppRole = "sales" | "advisor" | "branch_manager" | "company_manager";
export const roleLabels: Record<AppRole, string> = { sales: "業務（銷售顧問）", advisor: "服務顧問", branch_manager: "據點主管", company_manager: "公司主管" };

export type Actor = {
  email: string;            // signed-in identity (from the platform auth headers, never from the URL)
  actingAs: string | null;  // company managers may act as another user for verification; always audited
  displayName: string;
  role: AppRole;           // effective role (the acted-as user's role while impersonating)
  realRole: AppRole;
  unitCode: string | null;
  staffCode: string | null;
};

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type UserRow = { email: string; display_name: string; app_role: AppRole; unit_code: string | null; staff_code: string | null; active: number };

function toActor(user: UserRow, realEmail: string, realRole: AppRole): Actor {
  return { email: realEmail, actingAs: user.email === realEmail ? null : user.email, displayName: user.display_name, role: user.app_role, realRole, unitCode: user.unit_code, staffCode: user.staff_code };
}

/** Resolves the caller from the platform's authenticated-user headers; unauthenticated → 401, not provisioned → 403. */
export async function requireActor(request: Request): Promise<Actor> {
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (!email) throw new HttpError(401, "請先登入");
  let user = await first<UserRow>("SELECT * FROM app_users WHERE email = ?", email);
  if (!user) {
    // Bootstrap: the very first signed-in user becomes 公司主管 so the system can be configured.
    const existing = await first<{ n: number }>("SELECT COUNT(*) AS n FROM app_users");
    if ((existing?.n ?? 0) > 0) throw new HttpError(403, "此帳號尚未開通，請洽公司主管設定角色與單位");
    const name = request.headers.get("oai-authenticated-user-full-name") ? decodeURIComponent(request.headers.get("oai-authenticated-user-full-name")!) : email;
    await run("INSERT INTO app_users (email, display_name, app_role, unit_code, staff_code, active, updated_at) VALUES (?, ?, 'company_manager', NULL, NULL, 1, ?)", email, name, nowIso());
    await audit({ email, actingAs: null, displayName: name, role: "company_manager", realRole: "company_manager", unitCode: null, staffCode: null }, "初始化管理者", "app_users", email, {});
    user = await first<UserRow>("SELECT * FROM app_users WHERE email = ?", email);
  }
  if (!user || !user.active) throw new HttpError(403, "此帳號已停用");
  if (user.app_role === "company_manager") {
    const acting = await first<{ acting_email: string }>("SELECT acting_email FROM user_impersonation WHERE real_email = ?", email);
    if (acting) {
      const target = await first<UserRow>("SELECT * FROM app_users WHERE email = ? AND active = 1", acting.acting_email);
      if (target) return toActor(target, email, user.app_role);
    }
  }
  return toActor(user, email, user.app_role);
}

export function requireRole(actor: Actor, roles: AppRole[]) {
  if (!roles.includes(actor.role)) throw new HttpError(403, "目前角色沒有此操作權限");
}

/** SQL predicate limiting vehicles (alias `v`) to the caller's authorised scope. */
export function vehicleScope(actor: Actor, alias = "v"): { sql: string; params: unknown[] } {
  if (actor.role === "company_manager") return { sql: "1 = 1", params: [] };
  if (actor.role === "branch_manager") return actor.unitCode ? { sql: `${alias}.service_unit_code = ?`, params: [actor.unitCode] } : { sql: "1 = 0", params: [] };
  if (!actor.staffCode) return { sql: "1 = 0", params: [] };
  const staffRole = actor.role === "sales" ? "sales" : "advisor";
  return { sql: `EXISTS (SELECT 1 FROM vehicle_staff vsc WHERE vsc.vehicle_code = ${alias}.vehicle_code AND vsc.staff_role = '${staffRole}' AND vsc.staff_code = ? AND vsc.valid_to IS NULL)`, params: [actor.staffCode] };
}

/** SQL predicate for work items (tasks / opportunities, alias given) the caller may see. */
export function workScope(actor: Actor, alias: string): { sql: string; params: unknown[] } {
  if (actor.role === "company_manager") return { sql: "1 = 1", params: [] };
  if (actor.role === "branch_manager") return actor.unitCode ? { sql: `${alias}.owner_unit_code = ?`, params: [actor.unitCode] } : { sql: "1 = 0", params: [] };
  return actor.staffCode ? { sql: `${alias}.owner_staff_code = ?`, params: [actor.staffCode] } : { sql: "1 = 0", params: [] };
}

/** A customer is visible when one of its current vehicles is in scope, or the caller owns a task/opportunity for it. */
export function customerScope(actor: Actor, alias = "c"): { sql: string; params: unknown[] } {
  if (actor.role === "company_manager") return { sql: "1 = 1", params: [] };
  const vehicle = vehicleScope(actor, "vx");
  const work = workScope(actor, "wt");
  const workOpp = workScope(actor, "wo");
  return {
    sql: `(EXISTS (SELECT 1 FROM vehicle_relations rx JOIN vehicles vx ON vx.vehicle_code = rx.vehicle_code WHERE rx.customer_code = ${alias}.customer_code AND rx.valid_to IS NULL AND ${vehicle.sql})
      OR EXISTS (SELECT 1 FROM tasks wt WHERE wt.customer_code = ${alias}.customer_code AND ${work.sql})
      OR EXISTS (SELECT 1 FROM opportunities wo WHERE wo.customer_code = ${alias}.customer_code AND ${workOpp.sql}))`,
    params: [...vehicle.params, ...work.params, ...workOpp.params],
  };
}

export async function assertCustomerAccess(actor: Actor, customerCode: string) {
  const scope = customerScope(actor, "c");
  const row = await first<{ ok: number }>(`SELECT 1 AS ok FROM customers c WHERE c.customer_code = ? AND ${scope.sql}`, customerCode, ...scope.params);
  if (!row) throw new HttpError(404, "查無此客戶，或不在您的授權範圍");
}

export async function audit(actor: Actor, action: string, entity: string, entityCode: string | null, detail: unknown) {
  await run("INSERT INTO audit_log (actor, acting_as, action, entity, entity_code, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)", actor.email, actor.actingAs, action, entity, entityCode, JSON.stringify(detail ?? {}), nowIso());
}

export async function listUsers() {
  return all<UserRow>("SELECT * FROM app_users ORDER BY app_role, email");
}

/** Converts thrown errors into the JSON error contract used by every CRM endpoint. */
export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
  console.error("crm-api-failed", error);
  return Response.json({ error: "伺服器處理失敗，請稍後重試" }, { status: 500 });
}
