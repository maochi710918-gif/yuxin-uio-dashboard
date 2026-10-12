import { type Actor, vehicleScope, workScope } from "./auth";
import { all, first, today } from "./db";
import { analysisAsOf } from "./settings";

export type MetricFilters = { unit?: string; staff?: string; month?: string; campaign?: string; origin?: string; segment?: string };
type Metric = { key: string; label: string; notConnected?: boolean; value: number | null; numerator?: number | null; denominator?: number | null; unit: string; definition: string; denominatorLabel?: string; dateBasis: string; source: string; drill?: string };

const pct = (num: number | null | undefined, den: number | null | undefined) => (den ? Math.round(((num ?? 0) / den) * 1000) / 10 : null);

function taskFilter(actor: Actor, filters: MetricFilters, alias = "t") {
  const scope = workScope(actor, alias);
  const where = [scope.sql], params: unknown[] = [...scope.params];
  if (filters.unit) { where.push(`${alias}.owner_unit_code = ?`); params.push(filters.unit); }
  if (filters.staff) { where.push(`${alias}.owner_staff_code = ?`); params.push(filters.staff); }
  if (filters.campaign) { where.push(`${alias}.campaign_code = ?`); params.push(filters.campaign); }
  if (filters.segment) { where.push(`${alias}.segment_code = ?`); params.push(filters.segment); }
  // 名單成效依「分派（建立）月份」追蹤。
  if (filters.month) { where.push(`substr(${alias}.created_at, 1, 7) = ?`); params.push(filters.month); }
  return { sql: where.join(" AND "), params };
}

function oppFilter(actor: Actor, filters: MetricFilters, alias = "o") {
  const scope = workScope(actor, alias);
  const where = [scope.sql], params: unknown[] = [...scope.params];
  if (filters.unit) { where.push(`${alias}.owner_unit_code = ?`); params.push(filters.unit); }
  if (filters.staff) { where.push(`${alias}.owner_staff_code = ?`); params.push(filters.staff); }
  if (filters.origin) { where.push(`${alias}.origin = ?`); params.push(filters.origin); }
  if (filters.month) { where.push(`substr(${alias}.created_at, 1, 7) = ?`); params.push(filters.month); }
  return { sql: where.join(" AND "), params };
}

export async function managerDashboard(actor: Actor, filters: MetricFilters) {
  const asOf = await analysisAsOf();
  const vs = vehicleScope(actor, "v");
  const vWhere = [vs.sql], vParams = [...vs.params];
  if (filters.unit) { vWhere.push("v.service_unit_code = ?"); vParams.push(filters.unit); }
  const vSql = vWhere.join(" AND ");

  // --- 資料品質
  const quality = await first<Record<string, number>>(`SELECT COUNT(*) AS vehicles,
      SUM(CASE WHEN v.latest_mileage IS NOT NULL THEN 1 ELSE 0 END) AS with_mileage,
      SUM(CASE WHEN v.last_visit_date IS NOT NULL THEN 1 ELSE 0 END) AS with_visit,
      SUM(CASE WHEN v.registration_date IS NOT NULL THEN 1 ELSE 0 END) AS with_registration,
      SUM(CASE WHEN v.service_unit_code IS NOT NULL THEN 1 ELSE 0 END) AS with_unit,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM vehicle_relations r WHERE r.vehicle_code = v.vehicle_code AND r.relation = '持有人' AND r.valid_to IS NULL) THEN 1 ELSE 0 END) AS with_holder,
      SUM(CASE WHEN v.last_visit_date > date(?, '-365 day') THEN 1 ELSE 0 END) AS retained_365
    FROM vehicles v WHERE ${vSql}`, asOf, ...vParams);
  const customers = await first<Record<string, number>>(`SELECT COUNT(*) AS customers, SUM(CASE WHEN contact_eligible IS NOT NULL THEN 1 ELSE 0 END) AS with_eligibility FROM customers c WHERE EXISTS (SELECT 1 FROM vehicle_relations r JOIN vehicles v ON v.vehicle_code = r.vehicle_code WHERE r.customer_code = c.customer_code AND r.valid_to IS NULL AND ${vSql})`, ...vParams);
  const imports = await first<Record<string, number>>("SELECT SUM(total_rows) AS rows, SUM(failed) AS failed FROM import_batches WHERE status = '已完成'");
  const duplicates = await first<{ n: number }>("SELECT COUNT(*) AS n FROM import_errors e JOIN import_batches b ON b.batch_code = e.batch_code WHERE e.error_code = 'duplicate_in_file' AND b.status = '已完成'");
  const sources = await all("SELECT source_code, name, entity, priority, status, last_batch_code, last_imported_at FROM sources ORDER BY entity, priority");
  const staffCodes = await first<Record<string, number>>("SELECT COUNT(*) AS n, SUM(CASE WHEN code_status = '正式' THEN 1 ELSE 0 END) AS formal FROM staff");

  // --- 名單與任務（依分派月份）
  const tf = taskFilter(actor, filters);
  const day = today();
  const tasks = await first<Record<string, number>>(`SELECT COUNT(*) AS assigned,
      SUM(CASE WHEN t.export_code IS NOT NULL THEN 1 ELSE 0 END) AS exported,
      SUM(CASE WHEN t.result_date IS NOT NULL THEN 1 ELSE 0 END) AS returned,
      SUM(CASE WHEN t.status = '已完成' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN t.status = '已取消' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN t.status IN ('待處理', '待匯出', '已匯出', '待回傳') AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN t.status IN ('待處理', '待匯出', '已匯出', '待回傳') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN t.result LIKE '已聯絡-有效回覆%' THEN 1 ELSE 0 END) AS effective,
      SUM(CASE WHEN t.result LIKE '%已預約%' THEN 1 ELSE 0 END) AS appointments,
      SUM(CASE WHEN t.result LIKE '%已到店%' OR t.result LIKE '%已試乘%' THEN 1 ELSE 0 END) AS visits,
      SUM(CASE WHEN t.result LIKE '%已報價%' THEN 1 ELSE 0 END) AS quotes,
      SUM(CASE WHEN t.result LIKE '%成交 %' THEN 1 ELSE 0 END) AS won
    FROM tasks t WHERE ${tf.sql}`, day, ...tf.params);

  // --- 轉介接手
  const of = oppFilter(actor, filters);
  const referral = await first<Record<string, number>>(`SELECT COUNT(*) AS referrals,
      SUM(CASE WHEN o.handover_status = '已接手' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN o.handover_status = '待接手' THEN 1 ELSE 0 END) AS waiting,
      AVG((SELECT (julianday(e.at) - julianday(o.created_at)) * 24 FROM opportunity_events e WHERE e.opp_code = o.opp_code AND e.event_type = '接手' ORDER BY e.event_id LIMIT 1)) AS avg_accept_hours
    FROM opportunities o WHERE o.origin = '售後轉介' AND ${of.sql}`, ...of.params);
  const funnelRows = await all<{ max_stage_rank: number; n: number }>(`SELECT o.max_stage_rank, COUNT(*) AS n FROM opportunities o WHERE ${of.sql} GROUP BY o.max_stage_rank`, ...of.params);
  const reached = (rank: number) => funnelRows.filter((row) => row.max_stage_rank >= rank).reduce((sum, row) => sum + row.n, 0);
  const wonRevenue = await first<{ amount: number | null; deals: number; margin: number | null }>(`SELECT SUM(t.amount) AS amount, SUM(t.margin) AS margin, COUNT(*) AS deals FROM opportunities o JOIN transactions t ON t.txn_code = o.won_txn_code WHERE o.stage = '成交' AND ${of.sql}`, ...of.params);

  // --- 營運結果（依實際發生月份）
  const tScope = vehicleScope(actor, "v");
  const monthly = await all<{ month: string; revenue: number | null; txns: number; vehicles: number; margin: number | null }>(`SELECT substr(t.txn_date, 1, 7) AS month, SUM(t.amount) AS revenue, SUM(t.margin) AS margin, COUNT(*) AS txns, COUNT(DISTINCT t.vehicle_code) AS vehicles
    FROM transactions t JOIN vehicles v ON v.vehicle_code = t.vehicle_code WHERE ${tScope.sql}${filters.unit ? " AND t.unit_code = ?" : ""} AND t.txn_date > date(?, '-13 month') GROUP BY month ORDER BY month`, ...tScope.params, ...(filters.unit ? [filters.unit] : []), asOf);

  // --- 活動成效（關聯成效：成交歸屬於產生該商機任務的單一活動，不重複計入）
  const campaigns = await all(`SELECT c.campaign_code, c.name, c.cost, c.snapshot_at,
      (SELECT COUNT(*) FROM campaign_members m WHERE m.campaign_code = c.campaign_code AND m.included = 1) AS members,
      (SELECT COUNT(*) FROM tasks t WHERE t.campaign_code = c.campaign_code) AS tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.campaign_code = c.campaign_code AND t.status = '已完成') AS completed,
      (SELECT SUM(x.amount) FROM (SELECT DISTINCT o.won_txn_code, tx.amount FROM tasks t JOIN opportunities o ON o.opp_code = t.opp_code AND o.stage = '成交' JOIN transactions tx ON tx.txn_code = o.won_txn_code WHERE t.campaign_code = c.campaign_code) x) AS attributed_revenue
    FROM campaigns c ORDER BY c.snapshot_at DESC LIMIT 20`);

  // --- 單位與人員差異
  const byOwner = await all<Record<string, unknown>>(`SELECT t.owner_unit_code AS unit_code, u.name AS unit_name, t.owner_staff_code AS staff_code, s.display_name AS staff_name,
      COUNT(*) AS assigned, SUM(CASE WHEN t.status = '已完成' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN t.status IN ('待處理', '待匯出', '已匯出', '待回傳') AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN t.export_code IS NOT NULL AND t.result_date IS NULL AND t.status != '已取消' THEN 1 ELSE 0 END) AS exported_not_returned
    FROM tasks t LEFT JOIN units u ON u.unit_code = t.owner_unit_code LEFT JOIN staff s ON s.staff_code = t.owner_staff_code WHERE ${tf.sql}
    GROUP BY t.owner_unit_code, t.owner_staff_code ORDER BY overdue DESC, assigned DESC LIMIT 50`, day, ...tf.params);

  // --- 滿意度（CSI）：依問卷進廠日統計；未匯入時標示尚未串接
  const csiWhere = filters.unit ? "WHERE unit_code = ?" : "";
  const csi = await first<Record<string, number | null>>(`SELECT COUNT(*) AS surveys, AVG(score_overall) AS overall, AVG(score_total) AS total,
      SUM(CASE WHEN score_overall < 4 THEN 1 ELSE 0 END) AS low, SUM(CASE WHEN voc_text IS NOT NULL AND voc_text != '' THEN 1 ELSE 0 END) AS voc,
      SUM(CASE WHEN vehicle_code IS NOT NULL THEN 1 ELSE 0 END) AS linked FROM satisfaction_surveys ${csiWhere}`, ...(filters.unit ? [filters.unit] : []));
  const csiConnected = Boolean(csi?.surveys);
  const q = quality ?? {};
  const t = tasks ?? {};
  const metrics: Record<string, Metric[]> = {
    資料品質: [
      { key: "mileage_complete", label: "車輛里程完整率", value: pct(q.with_mileage, q.vehicles), numerator: q.with_mileage, denominator: q.vehicles, unit: "%", definition: "有最新里程的車輛 ÷ 車輛數", denominatorLabel: "授權範圍內車輛", dateBasis: `資料基準日 ${asOf}`, source: "vehicles.latest_mileage", drill: "vehicles_missing_mileage" },
      { key: "holder_complete", label: "人車關係完整率", value: pct(q.with_holder, q.vehicles), numerator: q.with_holder, denominator: q.vehicles, unit: "%", definition: "有現行持有人的車輛 ÷ 車輛數", denominatorLabel: "授權範圍內車輛", dateBasis: "現行關係（無結束日）", source: "vehicle_relations", drill: "vehicles_missing_holder" },
      { key: "eligibility_complete", label: "聯絡資格完整率", value: pct(customers?.with_eligibility, customers?.customers), numerator: customers?.with_eligibility, denominator: customers?.customers, unit: "%", definition: "有地端聯絡資格狀態的客戶 ÷ 客戶數", denominatorLabel: "授權範圍內客戶", dateBasis: "最新匯入", source: "customers.contact_eligible" },
      { key: "duplicate_rate", label: "匯入重複率", value: pct(duplicates?.n, imports?.rows), numerator: duplicates?.n, denominator: imports?.rows, unit: "%", definition: "檔案內重複鍵值列數 ÷ 已完成批次總列數", denominatorLabel: "已完成匯入列數", dateBasis: "全部批次", source: "import_errors (duplicate_in_file)" },
      { key: "staff_code_formal", label: "人員正式編碼比例", value: pct(staffCodes?.formal, staffCodes?.n), numerator: staffCodes?.formal, denominator: staffCodes?.n, unit: "%", definition: "正式人員編碼 ÷ 人員數（其餘為依姓名暫編）", denominatorLabel: "人員數", dateBasis: "最新匯入", source: "staff.code_status" },
    ],
    名單執行: [
      { key: "assigned", label: "已分派任務", value: t.assigned ?? 0, unit: "筆", definition: "建立的任務數", dateBasis: filters.month ? `分派月份 ${filters.month}` : "全部分派月份", source: "tasks", drill: "tasks_all" },
      { key: "export_rate", label: "下載率", value: pct(t.exported, t.assigned), numerator: t.exported, denominator: t.assigned, unit: "%", definition: "已納入匯出批次的任務 ÷ 已分派", denominatorLabel: "已分派任務", dateBasis: "依分派月份", source: "tasks.export_code" },
      { key: "return_rate", label: "回傳率", value: pct(t.returned, t.exported), numerator: t.returned, denominator: t.exported, unit: "%", definition: "已回傳結果 ÷ 已下載（已匯出不代表已聯絡）", denominatorLabel: "已下載任務", dateBasis: "依分派月份", source: "tasks.result_date", drill: "tasks_exported_not_returned" },
      { key: "completion_rate", label: "實際完成率", value: pct(t.completed, (t.assigned ?? 0) - (t.cancelled ?? 0)), numerator: t.completed, denominator: (t.assigned ?? 0) - (t.cancelled ?? 0), unit: "%", definition: "回傳最終結果的任務 ÷（已分派 − 已取消）", denominatorLabel: "有效任務", dateBasis: "依分派月份", source: "tasks.status" },
      { key: "overdue", label: "逾期任務", value: t.overdue ?? 0, numerator: t.overdue, denominator: t.open, unit: "筆", definition: "未完成且已過期限", denominatorLabel: "未完成任務", dateBasis: `今天 ${day}`, source: "tasks.due_date", drill: "tasks_overdue" },
    ],
    轉換: [
      { key: "effective_rate", label: "有效聯絡率", value: pct(t.effective, t.returned), numerator: t.effective, denominator: t.returned, unit: "%", definition: "回傳「已聯絡-有效回覆」÷ 已回傳", denominatorLabel: "已回傳任務", dateBasis: "依分派月份", source: "tasks.result" },
      { key: "appointment_rate", label: "預約率", value: pct(t.appointments, t.returned), numerator: t.appointments, denominator: t.returned, unit: "%", definition: "回傳含預約 ÷ 已回傳", denominatorLabel: "已回傳任務", dateBasis: "依分派月份", source: "tasks.result" },
      { key: "visit_rate", label: "到店／試乘率", value: pct(t.visits, t.returned), numerator: t.visits, denominator: t.returned, unit: "%", definition: "回傳含到店或試乘 ÷ 已回傳", denominatorLabel: "已回傳任務", dateBasis: "依分派月份", source: "tasks.result" },
      { key: "quote_rate", label: "報價率", value: pct(reached(5), reached(0)), numerator: reached(5), denominator: reached(0), unit: "%", definition: "曾到達報價階段的商機 ÷ 商機數", denominatorLabel: "商機數", dateBasis: "依商機建立月份", source: "opportunities.max_stage_rank" },
      { key: "win_rate", label: "成交率", value: pct(reached(6), reached(0)), numerator: reached(6), denominator: reached(0), unit: "%", definition: "成交（已連結交易編碼）÷ 商機數", denominatorLabel: "商機數", dateBasis: "依商機建立月份", source: "opportunities.won_txn_code", drill: "opps_won" },
      { key: "won_revenue", label: "成交營收（交易）", value: wonRevenue?.amount ?? null, numerator: wonRevenue?.deals, unit: "元", definition: "成交商機所連結之實際交易金額加總；不以商機狀態估算", dateBasis: "依商機建立月份", source: "transactions.amount" },
    ],
    滿意度: [
      { key: "csi_overall", label: "整體滿意度平均", notConnected: !csiConnected, value: csiConnected ? Math.round((csi!.overall ?? 0) * 100) / 100 : null, numerator: csi?.surveys, unit: "分", definition: "CSI 問卷「整體滿意度」平均（5 分制）", dateBasis: "依問卷進廠日", source: "satisfaction_surveys.score_overall" },
      { key: "csi_low_rate", label: "低分（< 4）比例", notConnected: !csiConnected, value: csiConnected ? pct(csi!.low, csi!.surveys) : null, numerator: csi?.low, denominator: csi?.surveys, unit: "%", definition: "整體滿意度低於 4 分的問卷 ÷ 問卷數", denominatorLabel: "問卷數", dateBasis: "依問卷進廠日", source: "satisfaction_surveys" },
      { key: "csi_voc", label: "客戶聲音", notConnected: !csiConnected, value: csiConnected ? csi!.voc ?? 0 : null, unit: "筆", definition: "填寫文字意見的問卷數（數字已於地端遮罩）", dateBasis: "依問卷進廠日", source: "satisfaction_surveys.voc_text" },
      { key: "csi_linked", label: "問卷對到車輛編碼", notConnected: !csiConnected, value: csiConnected ? pct(csi!.linked, csi!.surveys) : null, numerator: csi?.linked, denominator: csi?.surveys, unit: "%", definition: "地端轉檔時成功以車牌對到車輛編碼的問卷比例", denominatorLabel: "問卷數", dateBasis: "最新匯入", source: "satisfaction_surveys.vehicle_code" },
    ],
    轉介與留存: [
      { key: "referrals", label: "售後轉介", value: referral?.referrals ?? 0, unit: "筆", definition: "來源為售後轉介的商機", dateBasis: "依建立月份", source: "opportunities.origin", drill: "opps_referral" },
      { key: "referral_accept_rate", label: "轉介接手率", value: pct(referral?.accepted, referral?.referrals), numerator: referral?.accepted, denominator: referral?.referrals, unit: "%", definition: "已接手 ÷ 售後轉介", denominatorLabel: "售後轉介", dateBasis: "依建立月份", source: "opportunities.handover_status" },
      { key: "referral_accept_hours", label: "平均接手時間", value: referral?.avg_accept_hours === null || referral?.avg_accept_hours === undefined ? null : Math.round(referral.avg_accept_hours * 10) / 10, unit: "小時", definition: "建立到第一次「接手」事件", dateBasis: "依建立月份", source: "opportunity_events" },
      { key: "retention_365", label: "一年內回廠率（留存）", value: pct(q.retained_365, q.vehicles), numerator: q.retained_365, denominator: q.vehicles, unit: "%", definition: "基準日前 365 天內有進廠的車輛 ÷ 車輛數", denominatorLabel: "授權範圍內車輛", dateBasis: `資料基準日 ${asOf}`, source: "vehicles.last_visit_date" },
    ],
  };

  // --- 診斷：每一項都附數據依據，並區分事實、推論與建議
  const findings: { title: string; fact: string; inference: string; suggestion: string; metric: string }[] = [];
  const returnRate = pct(t.returned, t.exported);
  if ((t.exported ?? 0) > 0 && returnRate !== null && returnRate < 60) findings.push({ title: "名單下載後回傳不足", fact: `已下載 ${t.exported} 筆，僅 ${t.returned ?? 0} 筆回傳（${returnRate}%）`, inference: "部分名單可能未實際執行，或已執行但未回傳結果", suggestion: "依「已下載未回傳」清單追蹤負責人，並設定回傳期限", metric: "return_rate" });
  if ((t.open ?? 0) > 0 && (t.overdue ?? 0) / (t.open ?? 1) > 0.2) findings.push({ title: "逾期任務比例偏高", fact: `未完成 ${t.open} 筆中 ${t.overdue} 筆已逾期`, inference: "任務量可能超出人力或期限設定過短", suggestion: "檢視逾期集中的單位／人員，調整分派量或期限", metric: "overdue" });
  if (q.vehicles && pct(q.with_mileage, q.vehicles)! < 90) findings.push({ title: "里程資料不完整", fact: `${q.vehicles - (q.with_mileage ?? 0)} 台車缺最新里程`, inference: "保固狀態會被判為「待確認」，影響保固與保養名單", suggestion: "請地端補齊里程或於進廠時回寫", metric: "mileage_complete" });
  if (staffCodes?.n && (staffCodes.formal ?? 0) < staffCodes.n) findings.push({ title: "人員多為暫用編碼", fact: `${staffCodes.n - (staffCodes.formal ?? 0)} 位人員依姓名暫編`, inference: "同名或改名時可能造成歸屬錯誤", suggestion: "請地端提供員工編碼對照，以正式編碼重新匯入人員與負責人員", metric: "staff_code_formal" });
  if ((referral?.waiting ?? 0) > 0) findings.push({ title: "售後轉介待接手", fact: `${referral!.waiting} 筆轉介尚未接手`, inference: "跨部門交接可能延誤", suggestion: "啟用「轉介逾期提醒」規則並由據點主管追蹤", metric: "referrals" });

  return { asOf, today: day, filters, metrics, monthly, campaigns, byOwner, sources, findings, notes: [
    "名單成效（下載、回傳、完成、轉換）依任務分派月份統計；營運結果（營收、交易）依交易實際發生月份統計。",
    "活動歸因：成交只歸屬於產生或推進該商機的任務所屬活動，同一筆交易不重複計入；未設對照組，屬「關聯成效」，不代表新增收益。",
  ] };
}

/** Drill-down: codes behind a metric (scoped, max 500). */
export async function drill(actor: Actor, key: string, filters: MetricFilters) {
  const day = today();
  const tf = taskFilter(actor, filters);
  const of = oppFilter(actor, filters);
  const vs = vehicleScope(actor, "v");
  switch (key) {
    case "tasks_all": return all(`SELECT t.task_code, t.customer_code, t.vehicle_code, t.task_type, t.status, t.owner_staff_code, t.due_date FROM tasks t WHERE ${tf.sql} ORDER BY t.created_at DESC LIMIT 500`, ...tf.params);
    case "tasks_overdue": return all(`SELECT t.task_code, t.customer_code, t.vehicle_code, t.task_type, t.status, t.owner_staff_code, t.due_date FROM tasks t WHERE ${tf.sql} AND t.status IN ('待處理', '待匯出', '已匯出', '待回傳') AND t.due_date < ? ORDER BY t.due_date LIMIT 500`, ...tf.params, day);
    case "tasks_exported_not_returned": return all(`SELECT t.task_code, t.customer_code, t.vehicle_code, t.task_type, t.export_code, t.owner_staff_code, t.due_date FROM tasks t WHERE ${tf.sql} AND t.export_code IS NOT NULL AND t.result_date IS NULL AND t.status != '已取消' ORDER BY t.due_date LIMIT 500`, ...tf.params);
    case "opps_won": return all(`SELECT o.opp_code, o.customer_code, o.vehicle_code, o.opp_type, o.won_txn_code, t.amount FROM opportunities o JOIN transactions t ON t.txn_code = o.won_txn_code WHERE ${of.sql} AND o.stage = '成交' LIMIT 500`, ...of.params);
    case "opps_referral": return all(`SELECT o.opp_code, o.customer_code, o.vehicle_code, o.handover_status, o.owner_staff_code, o.created_at FROM opportunities o WHERE ${of.sql} AND o.origin = '售後轉介' ORDER BY o.created_at DESC LIMIT 500`, ...of.params);
    case "vehicles_missing_mileage": return all(`SELECT v.vehicle_code, v.model_series, v.service_unit_code, v.last_visit_date FROM vehicles v WHERE ${vs.sql} AND v.latest_mileage IS NULL LIMIT 500`, ...vs.params);
    case "vehicles_missing_holder": return all(`SELECT v.vehicle_code, v.model_series, v.service_unit_code FROM vehicles v WHERE ${vs.sql} AND NOT EXISTS (SELECT 1 FROM vehicle_relations r WHERE r.vehicle_code = v.vehicle_code AND r.relation = '持有人' AND r.valid_to IS NULL) LIMIT 500`, ...vs.params);
    default: return [];
  }
}
