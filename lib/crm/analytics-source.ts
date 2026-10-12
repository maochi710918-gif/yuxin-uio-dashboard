/* eslint-disable @typescript-eslint/no-explicit-any -- rows mirror the legacy analytics record shape consumed by app/api/vehicles */
import { all, first } from "./db";
import { analysisAsOf } from "./settings";

// Builds the analytics records (總覽、客戶／車輛查詢、售後商機、金三角) from the CRM tables, so every view shares one ingestion path.
export type AnalyticsRecord = Record<string, any> & { code: string; _salesCode: string | null; _advisorCode: string | null; _unitCode: string | null };

const day = 86400000;

/** 保固：預設 3 年或 10 萬 km 先到者；最新里程缺漏時只能判定「待確認」，不依車齡推定仍在保固內。 */
export function warrantyState(registration: string | null, explicitExpiry: string | null, mileage: number | null, kmLimit: number, asOf: number) {
  let expiry = explicitExpiry && Number(explicitExpiry.slice(0, 4)) >= 1990 ? explicitExpiry : null;
  if (!expiry && registration) { const date = new Date(`${registration}T00:00:00`); date.setFullYear(date.getFullYear() + 3); expiry = date.toISOString().slice(0, 10); }
  const daysLeft = expiry ? Math.round((new Date(`${expiry}T00:00:00`).getTime() - asOf) / day) : null;
  const kmLeft = mileage === null ? null : kmLimit - mileage;
  const expiredTime = daysLeft !== null && daysLeft <= 0, expiredKm = mileage !== null && mileage >= kmLimit;
  let status: string;
  if (expiredTime && expiredKm) status = "已過保（年限與里程）";
  else if (expiredTime) status = "已過保（年限）";
  else if (expiredKm) status = "已過保（里程）";
  else if (daysLeft === null || mileage === null) status = "待確認";
  else if (daysLeft <= 180 && mileage >= kmLimit - 20000) status = "即將過保（雙重）";
  else if (daysLeft <= 180) status = "即將過保（年限）";
  else if (mileage >= kmLimit - 20000) status = "即將過保（里程）";
  else status = "保固內";
  return { status, daysLeft, kmLeft, expiry };
}

export function recommendedAction(status: string, daysSinceVisit: number | null, mileage: number | null, tires: number | null, battery: number | null) {
  if (status.startsWith("即將過保")) return "3 日內聯絡並安排保固健檢";
  if (status.startsWith("已過保") && daysSinceVisit !== null && daysSinceVisit >= 365) return "啟動久未回廠關懷與車況健檢";
  if (mileage !== null && mileage >= 90000) return "安排 100,000 km 前預防健檢";
  if (daysSinceVisit !== null && daysSinceVisit >= 270) return "本週由原服務專員邀約回廠";
  if (!tires) return "確認輪胎年限與磨耗";
  if (!battery) return "確認電瓶健康度";
  return "依保養週期持續追蹤";
}

const num = (value: unknown) => (value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null);
const int = (value: unknown) => { const parsed = num(value); return parsed === null ? null : Math.round(parsed); };

export async function dataVersion() {
  return (await first<{ setting_value: string }>("SELECT setting_value FROM app_settings WHERE setting_key = 'data_version'"))?.setting_value ?? "0";
}

export async function hasCrmVehicles() {
  return Boolean((await first<{ n: number }>("SELECT COUNT(*) AS n FROM (SELECT 1 FROM vehicles LIMIT 1)"))?.n);
}

export async function loadAnalyticsRecords() {
  const asOfDate = await analysisAsOf();
  const asOf = new Date(`${asOfDate}T00:00:00`).getTime();
  const staff = new Map((await all<{ staff_code: string; display_name: string }>("SELECT staff_code, display_name FROM staff")).map((row) => [row.staff_code, row.display_name]));
  const rows = await all<Record<string, any>>(`SELECT v.vehicle_code, v.model_series, v.model_code, v.registration_date, v.latest_mileage, v.warranty_expiry, v.warranty_km_limit, v.extended_warranty_expiry, v.service_unit_code, v.last_visit_date,
      u.name AS unit_name, u.code_status AS unit_status, r.customer_code, c.customer_type, c.gender, c.age, c.county, c.district, c.member_passport, c.consent_status, c.channel_phone, c.channel_sms, c.channel_email, c.opt_out, s.payload,
      (SELECT staff_code FROM vehicle_staff x WHERE x.vehicle_code = v.vehicle_code AND x.staff_role = 'sales' AND x.valid_to IS NULL LIMIT 1) AS sales_code,
      (SELECT staff_code FROM vehicle_staff x WHERE x.vehicle_code = v.vehicle_code AND x.staff_role = 'advisor' AND x.valid_to IS NULL LIMIT 1) AS advisor_code,
      (SELECT staff_code FROM vehicle_staff x WHERE x.vehicle_code = v.vehicle_code AND x.staff_role = 'technician' AND x.valid_to IS NULL LIMIT 1) AS technician_code
    FROM vehicles v
    LEFT JOIN vehicle_relations r ON r.vehicle_code = v.vehicle_code AND r.relation = '持有人' AND r.valid_to IS NULL
    LEFT JOIN customers c ON c.customer_code = r.customer_code
    LEFT JOIN units u ON u.unit_code = v.service_unit_code
    LEFT JOIN vehicle_service_summary s ON s.vehicle_code = v.vehicle_code
    ORDER BY v.vehicle_code`);
  const records: AnalyticsRecord[] = rows.map((row, index) => {
    const p = row.payload ? JSON.parse(row.payload) : {};
    const mileage = row.latest_mileage ?? null;
    const daysSinceVisit = row.last_visit_date ? Math.round((asOf - new Date(`${row.last_visit_date}T00:00:00`).getTime()) / day) : null;
    const warranty = warrantyState(row.registration_date, row.warranty_expiry, mileage, row.warranty_km_limit ?? 100000, asOf);
    const vehicleAge = row.registration_date ? Math.round(((asOf - new Date(`${row.registration_date}T00:00:00`).getTime()) / day / 365.25) * 10) / 10 : null;
    const tires = int(p.tireChanges1y), battery = int(p.batteryChanges1y);
    return {
      id: index + 1, code: row.vehicle_code, customerCode: row.customer_code ?? "", hasMobile: Boolean(row.channel_sms || row.channel_phone), hasEmail: Boolean(row.channel_email),
      gender: row.customer_type === "法人" ? "公司法人" : row.gender ?? "", customerAge: row.age ?? null, county: row.county ?? "", district: row.district ?? "",
      modelCode: row.model_code ?? "", model: row.model_series ?? "", registrationDate: row.registration_date ?? "", vehicleAge, mileage,
      lastVisit: row.last_visit_date ?? "", daysSinceVisit, branch: row.unit_name ?? "", advisor: staff.get(row.advisor_code) ?? "", salesRepresentative: staff.get(row.sales_code) ?? "", technician: staff.get(row.technician_code) ?? "",
      spend3m: num(p.spend3m), memberPassport: row.member_passport ?? "", ownerAuthorization: row.consent_status ?? "",
      returnCount1y: int(p.maintenanceCount1y), maintenanceCount1y: int(p.maintenanceCount1y), returnCategory: p.returnCategory ?? "", maintenanceFrequency: p.maintenanceFrequency ?? "",
      beautySpend1y: int(p.beautySpend1y), beautyHighSpend: p.beautyHighSpend ?? "", fakeBeautySpend1y: int(p.fakeBeautySpend1y),
      windshieldCoatingCount1y: int(p.windshieldCoatingCount1y), windshieldCoatingSpend1y: int(p.windshieldCoatingSpend1y), waxCount1y: int(p.waxCount1y), waxSpend1y: int(p.waxSpend1y),
      bodyBeautyCount1y: int(p.bodyBeautyCount1y), bodyBeautySpend1y: int(p.bodyBeautySpend1y), interiorCleaningCount1y: int(p.interiorCleaningCount1y), interiorCleaningSpend1y: int(p.interiorCleaningSpend1y),
      bodyCoatingCount1y: int(p.bodyCoatingCount1y), bodyCoatingSpend1y: int(p.bodyCoatingSpend1y),
      warrantyStatus: warranty.status, warrantyExpiry: warranty.expiry ?? "", warrantyDaysLeft: warranty.daysLeft, warrantyKmLeft: warranty.kmLeft, extendedWarrantyExpiry: row.extended_warranty_expiry ?? "",
      tireChanges1y: tires, batteryChanges1y: battery, airFilterChanges1y: int(p.airFilterChanges1y), cabinFilterChanges1y: int(p.cabinFilterChanges1y), wiperChanges1y: int(p.wiperChanges1y), brakePadChanges1y: int(p.brakePadChanges1y), beltChanges1y: int(p.beltChanges1y), sparkPlugChanges1y: int(p.sparkPlugChanges1y),
      tireLastChanged: p.tireLastChanged ?? "", batteryLastChanged: p.batteryLastChanged ?? "", airFilterLastChanged: p.airFilterLastChanged ?? "", cabinFilterLastChanged: p.cabinFilterLastChanged ?? "", wiperLastChanged: p.wiperLastChanged ?? "", brakePadLastChanged: p.brakePadLastChanged ?? "", beltLastChanged: p.beltLastChanged ?? "", sparkPlugLastChanged: p.sparkPlugLastChanged ?? "",
      contactAuthorized: row.consent_status ?? "", doNotContact: Boolean(row.opt_out), nextBestAction: recommendedAction(warranty.status, daysSinceVisit, mileage, tires, battery),
      _salesCode: row.sales_code, _advisorCode: row.advisor_code, _unitCode: row.service_unit_code, _unitFormal: row.unit_status === "正式",
    };
  });
  return { records, asOf, asOfDate };
}
