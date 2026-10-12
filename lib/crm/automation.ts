import { type Actor, HttpError, audit, requireRole } from "./auth";
import { all, first, jsonList, nextCodes, nowIso, run } from "./db";
import { createOpportunity } from "./opportunities";
import { type ConditionGroup, parseDefinition } from "./segments";
import { getSetting } from "./settings";
import { type TaskDraft, draftsFromDefinition, insertTasks } from "./tasks";

export type RuleDefinition = {
  trigger: { kind: "segment"; segment_code: string } | { kind: "definition"; definition: ConditionGroup } | { kind: "referral_overdue"; hours: number };
  task: { task_type: string; action: string; owner_role: "sales" | "advisor" | "unit"; due_days: number; priority: number; promotional: boolean; opp_type?: string };
  stop: string[];
  frequency_days?: number;
};
type RuleRow = { rule_code: string; version: number; name: string; definition: string; enabled: number; is_current: number; updated_by: string; updated_at: string };

export async function listRules() {
  const rules = await all<RuleRow>("SELECT * FROM automation_rules WHERE is_current = 1 ORDER BY rule_code");
  const runs = await all("SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 50");
  return { rules: rules.map((rule) => ({ ...rule, definition: JSON.parse(rule.definition) as RuleDefinition })), runs };
}

export async function ruleHistory(code: string) {
  return all<RuleRow>("SELECT * FROM automation_rules WHERE rule_code = ? ORDER BY version DESC", code);
}

/** Saving creates a new version; earlier versions stay for audit and are referenced by the tasks they created. */
export async function saveRule(actor: Actor, code: string, name: string, definition: RuleDefinition, enabled: boolean) {
  requireRole(actor, ["company_manager", "branch_manager"]);
  validateRule(definition);
  const current = await first<{ version: number }>("SELECT MAX(version) AS version FROM automation_rules WHERE rule_code = ?", code);
  const version = (current?.version ?? 0) + 1;
  await run("UPDATE automation_rules SET is_current = 0 WHERE rule_code = ?", code);
  await run("INSERT INTO automation_rules (rule_code, version, name, definition, enabled, is_current, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)", code, version, name, JSON.stringify(definition), enabled ? 1 : 0, actor.email, nowIso());
  await audit(actor, "更新自動化規則", "automation_rules", code, { version, enabled });
  return version;
}

export async function setRuleEnabled(actor: Actor, code: string, enabled: boolean) {
  requireRole(actor, ["company_manager", "branch_manager"]);
  await run("UPDATE automation_rules SET enabled = ? WHERE rule_code = ? AND is_current = 1", enabled ? 1 : 0, code);
  await audit(actor, enabled ? "啟用自動化規則" : "停用自動化規則", "automation_rules", code, {});
}

function validateRule(definition: RuleDefinition) {
  if (!definition?.trigger || !definition.task?.task_type || !definition.task.action) throw new HttpError(400, "規則需包含觸發條件與任務內容");
  if (definition.trigger.kind === "definition") parseDefinition(definition.trigger.definition);
}

async function triggerDefinition(definition: RuleDefinition): Promise<ConditionGroup> {
  if (definition.trigger.kind === "segment") {
    const segment = await first<{ definition: string }>("SELECT definition FROM segments WHERE segment_code = ?", definition.trigger.segment_code);
    if (!segment) throw new HttpError(400, `規則引用的客群 ${definition.trigger.segment_code} 不存在`);
    return parseDefinition(segment.definition);
  }
  if (definition.trigger.kind === "definition") return definition.trigger.definition;
  throw new HttpError(400, "此觸發類型不使用客群條件");
}

/**
 * Runs a rule. mode 試算 only counts; 執行 creates tasks.
 * Order of exclusions: 不可聯絡／拒收 → 客訴暫停（促銷類）→ 停止條件 → 頻率控管 → 重複任務。
 */
export async function runRule(actor: Actor, code: string, mode: "試算" | "執行") {
  requireRole(actor, ["company_manager", "branch_manager"]);
  const rule = await first<RuleRow>("SELECT * FROM automation_rules WHERE rule_code = ? AND is_current = 1", code);
  if (!rule) throw new HttpError(404, "查無規則");
  if (mode === "執行" && !rule.enabled) throw new HttpError(409, "規則未啟用，只能試算");
  const definition = JSON.parse(rule.definition) as RuleDefinition;
  const [runCode] = await nextCodes("RUN", 1);
  const started = nowIso();
  await run("INSERT INTO automation_runs (run_code, rule_code, rule_version, mode, started_by, started_at) VALUES (?, ?, ?, ?, ?, ?)", runCode, code, rule.version, mode, actor.email, started);
  const stats = { matched: 0, created: 0, skipped_duplicate: 0, skipped_frequency: 0, skipped_stop: 0, skipped_complaint: 0, skipped_ineligible: 0, failed: 0 };
  try {
    let drafts: TaskDraft[] = [];
    const trigger = definition.trigger;
    if (trigger.kind === "referral_overdue") {
      const hours = trigger.hours;
      const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
      const overdue = await all<{ opp_code: string; customer_code: string; vehicle_code: string | null; owner_unit_code: string | null; created_at: string }>("SELECT opp_code, customer_code, vehicle_code, owner_unit_code, created_at FROM opportunities WHERE origin = '售後轉介' AND handover_status = '待接手' AND stage NOT IN ('成交', '未成交') AND created_at < ?", cutoff);
      stats.matched = overdue.length;
      drafts = overdue.map((opp) => ({ customer_code: opp.customer_code, vehicle_code: opp.vehicle_code, owner_staff_code: null, owner_unit_code: opp.owner_unit_code, opp_code: opp.opp_code, reason: `轉介 ${opp.opp_code} 建立於 ${opp.created_at.slice(0, 10)}，逾 ${hours} 小時未接手` }));
    } else {
      const candidates = await draftsFromDefinition(actor, await triggerDefinition(definition), definition.task.owner_role);
      stats.matched = candidates.length;
      const eligible = candidates.filter(({ row }) => {
        if (row.opt_out === 1 || row.contact_eligible !== 1) { stats.skipped_ineligible += 1; return false; }
        if (definition.task.promotional && row.complaint_open === 1) { stats.skipped_complaint += 1; return false; }
        return true;
      });
      const customers = [...new Set(eligible.map(({ draft }) => draft.customer_code))];
      // 停止條件：回溯期間內，同類任務回傳為停止結果，或互動紀錄為拒收／需求取消；已成交則不再觸發同類商機任務。
      const lookback = new Date(Date.now() - Number(await getSetting("stop_lookback_days")) * 86400000).toISOString().slice(0, 10);
      const stopped = new Set((await all<{ customer_code: string }>(`SELECT DISTINCT customer_code FROM tasks WHERE customer_code IN (SELECT value FROM json_each(?)) AND task_type = ? AND result_date >= ? AND (${(definition.stop.length ? definition.stop : ["__none__"]).map(() => "result LIKE ?").join(" OR ")})
        UNION SELECT DISTINCT customer_code FROM interactions WHERE customer_code IN (SELECT value FROM json_each(?)) AND occurred_at >= ? AND outcome IN ('拒收', '需求取消')`,
        jsonList(customers), definition.task.task_type, lookback, ...(definition.stop.length ? definition.stop : ["__none__"]).map((item) => `%${item}%`), jsonList(customers), lookback)).map((row) => row.customer_code));
      if (definition.task.opp_type) {
        (await all<{ customer_code: string }>("SELECT DISTINCT customer_code FROM opportunities WHERE customer_code IN (SELECT value FROM json_each(?)) AND opp_type = ? AND stage = '成交' AND closed_at >= ?", jsonList(customers), definition.task.opp_type, lookback)).forEach((row) => stopped.add(row.customer_code));
      }
      // 頻率控管（跨部門）：近 N 天已有任何聯絡任務（不論類型、未取消）者略過。
      const frequencyDays = definition.frequency_days ?? Number(await getSetting("contact_frequency_days"));
      const since = new Date(Date.now() - frequencyDays * 86400000).toISOString();
      const recent = new Set((await all<{ customer_code: string }>("SELECT DISTINCT customer_code FROM tasks WHERE customer_code IN (SELECT value FROM json_each(?)) AND status != '已取消' AND created_at >= ?", jsonList(customers), since)).map((row) => row.customer_code));
      const openSame = new Set((await all<{ dedupe_key: string }>("SELECT dedupe_key FROM tasks WHERE task_type = ? AND customer_code IN (SELECT value FROM json_each(?)) AND status NOT IN ('已完成', '已取消')", definition.task.task_type, jsonList(customers))).map((row) => row.dedupe_key));
      for (const { draft } of eligible) {
        if (stopped.has(draft.customer_code)) { stats.skipped_stop += 1; continue; }
        if (openSame.has(`${definition.task.task_type}|${draft.customer_code}|${draft.vehicle_code ?? ""}`)) { stats.skipped_duplicate += 1; continue; }
        if (recent.has(draft.customer_code)) { stats.skipped_frequency += 1; continue; }
        recent.add(draft.customer_code); // one task per customer per run (multi-car owners are contacted once)
        drafts.push(draft);
      }
    }
    if (mode === "執行" && drafts.length) {
      if (definition.task.opp_type) {
        for (const draft of drafts) {
          draft.opp_code = await createOpportunity(actor, { opp_type: definition.task.opp_type, customer_code: draft.customer_code, vehicle_code: draft.vehicle_code, origin: "自動化規則", need: definition.task.action, owner_staff_code: draft.owner_staff_code, owner_unit_code: draft.owner_unit_code, rule_code: code, rule_version: rule.version }, { skipAccessCheck: true });
        }
      }
      const result = await insertTasks(actor, { task_type: definition.task.task_type, action: definition.task.action, due_days: definition.task.due_days, priority: definition.task.priority, rule_code: code, rule_version: rule.version, initial_status: definition.task.owner_role === "unit" ? "待處理" : "待匯出" }, drafts);
      stats.created = result.created.length;
      stats.skipped_duplicate += result.duplicates;
    } else {
      stats.created = drafts.length; // 試算：預計建立數
    }
    await run(`UPDATE automation_runs SET matched = ?, created = ?, skipped_duplicate = ?, skipped_frequency = ?, skipped_stop = ?, skipped_complaint = ?, skipped_ineligible = ?, failed = ?, message = ?, finished_at = ? WHERE run_code = ?`,
      stats.matched, stats.created, stats.skipped_duplicate, stats.skipped_frequency, stats.skipped_stop, stats.skipped_complaint, stats.skipped_ineligible, stats.failed, mode === "試算" ? "試算，未建立任務" : "完成", nowIso(), runCode);
    await audit(actor, `自動化${mode}`, "automation_runs", runCode, { rule: code, version: rule.version, ...stats });
    return { run_code: runCode, rule_code: code, version: rule.version, mode, ...stats };
  } catch (error) {
    await run("UPDATE automation_runs SET failed = 1, message = ?, finished_at = ? WHERE run_code = ?", error instanceof Error ? error.message : "執行失敗", nowIso(), runCode);
    throw error;
  }
}
