import { all } from "../../../../lib/crm/db";
import { handler } from "../../../../lib/crm/http";

export const dynamic = "force-dynamic";

// Pickers for 單位／人員 (codes with display names); staff search is server-side for the 3,000+ 業代.
export const GET = handler(async (_actor, _request, url) => {
  const q = (url.searchParams.get("q") ?? "").trim();
  const role = url.searchParams.get("role");
  const where = ["active = 1"], params: unknown[] = [];
  if (role) { where.push("staff_role = ?"); params.push(role); }
  if (q) { where.push("(staff_code LIKE ? OR display_name LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
  const staff = await all(`SELECT staff_code, display_name, staff_role, unit_code, code_status FROM staff WHERE ${where.join(" AND ")} ORDER BY display_name LIMIT 50`, ...params);
  const units = await all("SELECT unit_code, name, unit_type, code_status FROM units ORDER BY code_status, name");
  return { staff, units };
});
