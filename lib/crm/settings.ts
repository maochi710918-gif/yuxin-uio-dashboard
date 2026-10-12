import { first, nowIso, run } from "./db";

export const settingDefaults: Record<string, { value: string; description: string }> = {
  analysis_as_of: { value: "", description: "分析基準日（空白＝採最新車輛資料日期）。未回廠天數、保固剩餘等皆以此日計算。" },
  contact_frequency_days: { value: "14", description: "跨部門聯絡頻率：同一客戶在此天數內已有聯絡任務時，自動化不再建立新任務。" },
  stop_lookback_days: { value: "180", description: "停止條件回溯天數：此期間內回傳已預約、已成交、拒收或需求取消者，不再觸發同類任務。" },
  task_overdue_grace_days: { value: "0", description: "任務逾期寬限天數。" },
};

export async function getSetting(key: string) {
  const row = await first<{ setting_value: string }>("SELECT setting_value FROM app_settings WHERE setting_key = ?", key);
  return row?.setting_value ?? settingDefaults[key]?.value ?? "";
}

export async function setSetting(key: string, value: string, actor: string) {
  await run("INSERT INTO app_settings (setting_key, setting_value, description, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    key, value, settingDefaults[key]?.description ?? "", actor, nowIso());
}

/** 分析基準日: explicit setting, else the latest vehicle data date, else today. */
export async function analysisAsOf() {
  const explicit = await getSetting("analysis_as_of");
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const latest = await first<{ d: string | null }>("SELECT MAX(data_date) AS d FROM vehicles");
  return latest?.d ?? nowIso().slice(0, 10);
}
