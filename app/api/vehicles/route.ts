import * as XLSX from "xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Vehicle = {
  // De-identified: personal fields are replaced by one 識別碼 per vehicle, used to match back to the on-prem file.
  id: number; code: string; hasMobile: boolean; hasEmail: boolean; gender: string; customerAge: number | null;
  county: string; district: string;
  modelCode: string; model: string; registrationDate: string; vehicleAge: number | null; mileage: number | null;
  lastVisit: string; daysSinceVisit: number | null; branch: string; advisor: string; salesRepresentative: string; spend3m: number | null;
  technician: string; memberPassport: string; ownerAuthorization: string; returnCount1y: number | null;
  maintenanceCount1y: number | null; returnCategory: string; maintenanceFrequency: string;
  beautySpend1y: number | null; beautyHighSpend: string; fakeBeautySpend1y: number | null;
  windshieldCoatingCount1y: number | null; windshieldCoatingSpend1y: number | null;
  waxCount1y: number | null; waxSpend1y: number | null; bodyBeautyCount1y: number | null;
  bodyBeautySpend1y: number | null; interiorCleaningCount1y: number | null; interiorCleaningSpend1y: number | null;
  bodyCoatingCount1y: number | null; bodyCoatingSpend1y: number | null;
  warrantyStatus: string; warrantyExpiry: string; warrantyDaysLeft: number | null;
  warrantyKmLeft: number | null; extendedWarrantyExpiry: string; tireChanges1y: number | null;
  batteryChanges1y: number | null; airFilterChanges1y: number | null; cabinFilterChanges1y: number | null;
  wiperChanges1y: number | null; brakePadChanges1y: number | null; beltChanges1y: number | null;
  sparkPlugChanges1y: number | null; tireLastChanged: string; batteryLastChanged: string;
  airFilterLastChanged: string; cabinFilterLastChanged: string; wiperLastChanged: string;
  brakePadLastChanged: string; beltLastChanged: string; sparkPlugLastChanged: string;
  contactAuthorized: string; doNotContact: boolean; nextBestAction: string;
};
type IndexedVehicle = Vehicle & { _search: string; _priority: number };

let recordCache: IndexedVehicle[] | null = null;
// Day counts must use the dataset's 資料基準日 (as the build script does), not today.
let referenceTime = Date.now();
let loadingCache: Promise<IndexedVehicle[]> | null = null;

function warrantyGroup(status: string) {
  return status.startsWith("即將過保") ? "即將過保" : status.startsWith("已過保") ? "已過保" : status;
}

function canonicalCounty(value: string) {
  const county = (value || "").trim();
  const aliases: Record<string, string> = {
    "臺北市": "台北市", "台北巿": "台北市", "台北縣": "新北市", "臺北縣": "新北市",
    "基隆巿": "基隆市", "桃園縣": "桃園市", "臺中市": "台中市", "台中縣": "台中市",
    "臺南市": "台南市", "台南縣": "台南市", "高雄縣": "高雄市", "新竹巿": "新竹市",
    "汐止區": "新北市", "新莊區": "新北市", "林口區": "新北市", "內湖區": "台北市", "桃園區": "桃園市",
  };
  return aliases[county] || county;
}

function vehiclePriority(vehicle: Vehicle) {
  return (vehicle.warrantyStatus.startsWith("即將過保") ? 5 : 0)
    + ((vehicle.daysSinceVisit ?? 0) >= 365 ? 4 : 0)
    + ((vehicle.mileage ?? 0) >= 90000 ? 3 : 0)
    + ((vehicle.spend3m ?? 0) >= 30000 ? 2 : 0)
    - (vehicle.doNotContact ? 10 : 0);
}

async function loadRecords(requestUrl: string) {
  if (recordCache) return recordCache;
  if (loadingCache) return loadingCache;
  loadingCache = (async () => {
    const dataUrl = new URL("/data/vehicles.json", requestUrl);
    const [response, metadataResponse] = await Promise.all([fetch(dataUrl, { cache: "no-store" }), fetch(new URL("/data/metadata.json", requestUrl), { cache: "no-store" })]);
    if (metadataResponse.ok) {
      const asOf = (await metadataResponse.json() as { asOf?: string }).asOf;
      const parsed = asOf ? new Date(`${asOf}T00:00:00`).getTime() : NaN;
      if (Number.isFinite(parsed)) referenceTime = parsed;
    }
    if (!response.ok) throw new Error("無法讀取本機車輛資料");
    const source = await response.json() as Vehicle[];
    const indexed = source as IndexedVehicle[];
    for (const vehicle of indexed) {
      Object.defineProperties(vehicle, {
        _search: { value: [vehicle.code, vehicle.county, vehicle.district, vehicle.model, vehicle.modelCode, vehicle.branch, vehicle.advisor, vehicle.salesRepresentative, vehicle.technician, vehicle.memberPassport, vehicle.returnCategory].join("|").toUpperCase().replace(/[\s-]/g, "") },
        _priority: { value: vehiclePriority(vehicle) },
      });
    }
    indexed.sort((a, b) => b._priority - a._priority || a.code.localeCompare(b.code));
    recordCache = indexed;
    return indexed;
  })();
  return loadingCache;
}

function numberParam(params: URLSearchParams, key: string) {
  const value = params.get(key);
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const serviceSignals = {
  maintenance: (v: Vehicle) => ({ count: v.maintenanceCount1y, spend: null, lastDate: "" }),
  beauty: (v: Vehicle) => ({ count: (v.windshieldCoatingCount1y ?? 0) + (v.waxCount1y ?? 0) + (v.bodyBeautyCount1y ?? 0) + (v.interiorCleaningCount1y ?? 0) + (v.bodyCoatingCount1y ?? 0), spend: v.beautySpend1y, lastDate: "" }),
  windshieldCoating: (v: Vehicle) => ({ count: v.windshieldCoatingCount1y, spend: v.windshieldCoatingSpend1y, lastDate: "" }),
  wax: (v: Vehicle) => ({ count: v.waxCount1y, spend: v.waxSpend1y, lastDate: "" }),
  bodyBeauty: (v: Vehicle) => ({ count: v.bodyBeautyCount1y, spend: v.bodyBeautySpend1y, lastDate: "" }),
  interiorCleaning: (v: Vehicle) => ({ count: v.interiorCleaningCount1y, spend: v.interiorCleaningSpend1y, lastDate: "" }),
  bodyCoating: (v: Vehicle) => ({ count: v.bodyCoatingCount1y, spend: v.bodyCoatingSpend1y, lastDate: "" }),
  tire: (v: Vehicle) => ({ count: v.tireChanges1y, spend: null, lastDate: v.tireLastChanged }),
  battery: (v: Vehicle) => ({ count: v.batteryChanges1y, spend: null, lastDate: v.batteryLastChanged }),
  airFilter: (v: Vehicle) => ({ count: v.airFilterChanges1y, spend: null, lastDate: v.airFilterLastChanged }),
  cabinFilter: (v: Vehicle) => ({ count: v.cabinFilterChanges1y, spend: null, lastDate: v.cabinFilterLastChanged }),
  wiper: (v: Vehicle) => ({ count: v.wiperChanges1y, spend: null, lastDate: v.wiperLastChanged }),
  brakePad: (v: Vehicle) => ({ count: v.brakePadChanges1y, spend: null, lastDate: v.brakePadLastChanged }),
  belt: (v: Vehicle) => ({ count: v.beltChanges1y, spend: null, lastDate: v.beltLastChanged }),
  sparkPlug: (v: Vehicle) => ({ count: v.sparkPlugChanges1y, spend: null, lastDate: v.sparkPlugLastChanged }),
} as const;

function daysSince(date: string) {
  if (!date) return null;
  const value = new Date(`${date}T00:00:00`).getTime();
  return Number.isFinite(value) ? Math.floor((referenceTime - value) / 86400000) : null;
}

const newTaipeiDistricts = new Set([
  "板橋區", "三重區", "中和區", "永和區", "新莊區", "新店區", "樹林區", "鶯歌區", "三峽區", "淡水區",
  "汐止區", "瑞芳區", "土城區", "蘆洲區", "五股區", "泰山區", "林口區", "深坑區", "石碇區", "坪林區",
  "三芝區", "石門區", "八里區", "平溪區", "雙溪區", "貢寮區", "金山區", "萬里區", "烏來區",
]);

const newTaipeiDistrictAliases: Record<string, string> = {
  新莊巿: "新莊區", 新店巿: "新店區", 中和巿: "中和區", 永和巿: "永和區", 汐止市: "汐止區", 汐止鎮: "汐止區",
  樹林鎮: "樹林區", 五股鄉: "五股區", 林口鄉: "林口區", 蘆洲鄉: "蘆洲區", 蘆洲巿: "蘆洲區", 金山鄉: "金山區",
};

function normalizedDistrict(county: string, district: string) {
  const raw = district?.trim() || "";
  if (!raw || raw.includes("*") || !/^[\u3400-\u9fff]{2,6}(區|市|鎮|鄉)$/.test(raw)) return "";
  if (canonicalCounty(county) === "新北市") {
    const normalized = newTaipeiDistrictAliases[raw] || raw;
    return newTaipeiDistricts.has(normalized) ? normalized : "";
  }
  return raw;
}

function filterRecords(records: IndexedVehicle[], params: URLSearchParams, options: { ignoreDistrict?: boolean } = {}) {
  const keyword = (params.get("keyword") || "").trim().toUpperCase().replace(/[\s-]/g, "");
  const model = params.get("model") || "";
  const county = params.get("county") || "";
  const district = params.get("district") || "";
  const branch = params.get("branch") || "";
  const advisor = params.get("advisor") || "";
  const technician = params.get("technician") || "";
  const salesRepresentative = params.get("salesRepresentative") || "";
  const recommendedAction = params.get("recommendedAction") || "";
  const warranty = params.get("warranty") || "";
  const serviceCategory = params.get("serviceCategory") || "";
  const gender = params.get("gender") || "";
  const passportStatus = params.get("passportStatus") || "";
  const authorizationStatus = params.get("authorizationStatus") || "";
  const opportunityType = params.get("opportunityType") || "";
  const opportunityCondition = params.get("opportunityCondition") || "";
  const minAge = numberParam(params, "minVehicleAge"), maxAge = numberParam(params, "maxVehicleAge");
  const minCustomerAge = numberParam(params, "minCustomerAge"), maxCustomerAge = numberParam(params, "maxCustomerAge");
  const minMileage = numberParam(params, "minMileage"), maxMileage = numberParam(params, "maxMileage");
  const minDays = numberParam(params, "minDaysSinceVisit"), minSpend = numberParam(params, "minSpend");
  const lastVisitFrom = params.get("lastVisitFrom") || "", lastVisitTo = params.get("lastVisitTo") || "";
  const minServiceSpend = numberParam(params, "minServiceSpend"), minServiceCount = numberParam(params, "minServiceCount");
  const minDaysSinceService = numberParam(params, "minDaysSinceService");
  const excludeDoNotContact = params.get("excludeDoNotContact") === "true";
  return records.filter((vehicle) => {
    if (keyword && !vehicle._search.includes(keyword)) return false;
    if (model && vehicle.model !== model) return false;
    if (county && canonicalCounty(vehicle.county) !== canonicalCounty(county)) return false;
    const vehicleDistrict = normalizedDistrict(vehicle.county, vehicle.district);
    if (!options.ignoreDistrict && district && (district === "__EMPTY__" ? Boolean(vehicleDistrict) : vehicleDistrict !== district)) return false;
    if (branch && vehicle.branch !== branch) return false;
    if (advisor && !vehicle.advisor.toLocaleUpperCase("zh-TW").includes(advisor.toLocaleUpperCase("zh-TW"))) return false;
    if (technician && !vehicle.technician.toLocaleUpperCase("zh-TW").includes(technician.toLocaleUpperCase("zh-TW"))) return false;
    if (salesRepresentative && !vehicle.salesRepresentative.toLocaleUpperCase("zh-TW").includes(salesRepresentative.toLocaleUpperCase("zh-TW"))) return false;
    if (recommendedAction && vehicle.nextBestAction !== recommendedAction) return false;
    if (warranty && warrantyGroup(vehicle.warrantyStatus) !== warranty) return false;
    if (gender && vehicle.gender !== gender) return false;
    if (passportStatus === "has" && !vehicle.memberPassport) return false;
    if (passportStatus === "none" && vehicle.memberPassport) return false;
    if (authorizationStatus === "authorized" && !`${vehicle.ownerAuthorization}|${vehicle.contactAuthorized}`.includes("同意")) return false;
    if (authorizationStatus === "notAuthorized" && `${vehicle.ownerAuthorization}|${vehicle.contactAuthorized}`.includes("同意")) return false;
    if (serviceCategory === "passport" && !vehicle.memberPassport) return false;
    if (serviceCategory === "maintenance" && (vehicle.maintenanceCount1y ?? 0) <= 0) return false;
    if (serviceCategory === "beauty" && (vehicle.beautySpend1y ?? 0) <= 0) return false;
    if (serviceCategory === "tire" && (vehicle.tireChanges1y ?? 0) <= 0) return false;
    if (serviceCategory === "battery" && (vehicle.batteryChanges1y ?? 0) <= 0) return false;
    if (excludeDoNotContact && vehicle.doNotContact) return false;
    if (minAge !== null && (vehicle.vehicleAge === null || vehicle.vehicleAge < minAge)) return false;
    if (maxAge !== null && (vehicle.vehicleAge === null || vehicle.vehicleAge > maxAge)) return false;
    if (minCustomerAge !== null && (vehicle.customerAge === null || vehicle.customerAge < minCustomerAge)) return false;
    if (maxCustomerAge !== null && (vehicle.customerAge === null || vehicle.customerAge > maxCustomerAge)) return false;
    if (minMileage !== null && (vehicle.mileage === null || vehicle.mileage < minMileage)) return false;
    if (maxMileage !== null && (vehicle.mileage === null || vehicle.mileage > maxMileage)) return false;
    if (minDays !== null && (vehicle.daysSinceVisit === null || vehicle.daysSinceVisit < minDays)) return false;
    if (lastVisitFrom && (!vehicle.lastVisit || vehicle.lastVisit < lastVisitFrom)) return false;
    if (lastVisitTo && (!vehicle.lastVisit || vehicle.lastVisit > lastVisitTo)) return false;
    if (minSpend !== null && (vehicle.spend3m === null || vehicle.spend3m < minSpend)) return false;
    if (opportunityType === "warranty" && !warranty && !vehicle.warrantyStatus.startsWith("即將過保")) return false;
    if (opportunityType === "dormant" && (vehicle.daysSinceVisit ?? 0) < (minDays ?? 365)) return false;
    if (opportunityType in serviceSignals) {
      const signal = serviceSignals[opportunityType as keyof typeof serviceSignals](vehicle);
      const activity = Math.max(signal.count ?? 0, signal.spend ?? 0);
      const serviceDays = daysSince(signal.lastDate);
      if (opportunityCondition === "done1y" && activity <= 0) return false;
      if (opportunityCondition === "notDone1y" && activity > 0) return false;
      if (opportunityCondition === "ever" && !signal.lastDate && activity <= 0) return false;
      if (opportunityCondition === "never" && (signal.lastDate || activity > 0)) return false;
      if (opportunityCondition === "over1y" && (serviceDays === null || serviceDays < 365)) return false;
      if (minServiceCount !== null && (signal.count === null || signal.count < minServiceCount)) return false;
      if (minServiceSpend !== null && (signal.spend === null || signal.spend < minServiceSpend)) return false;
      if (minDaysSinceService !== null && (serviceDays === null || serviceDays < minDaysSinceService)) return false;
    }
    return true;
  });
}

// 可聯絡 = has a mobile number on file, consented to personal-data use, and not on the do-not-contact list.
function isContactable(vehicle: Vehicle) {
  return vehicle.hasMobile && !vehicle.doNotContact && `${vehicle.ownerAuthorization}|${vehicle.contactAuthorized}`.includes("同意");
}

function summarizeDistricts(records: IndexedVehicle[]) {
  const districtMap = new Map<string, number>();
  for (const vehicle of records) {
    const name = normalizedDistrict(vehicle.county, vehicle.district) || "行政區待確認";
    districtMap.set(name, (districtMap.get(name) || 0) + 1);
  }
  return [...districtMap.entries()].map(([name, vehicles]) => ({ name, vehicles })).sort((a, b) => b.vehicles - a.vehicles || a.name.localeCompare(b.name, "zh-TW"));
}

function summarize(records: IndexedVehicle[]) {
  const mileageBands = [0, 0, 0, 0, 0];
  const warranty = { 保固內: 0, 即將過保: 0, 已過保: 0, 待確認: 0 };
  const branchMap = new Map<string, { name: string; vehicles: number; dormant: number; expiring: number; spend: number }>();
  const countyMap = new Map<string, number>();
  const serviceMix = { 定期保養: 0, 美容服務: 0, 輪胎: 0, 電瓶: 0 };
  let expiring = 0, dormant = 0, spend = 0, contactable = 0;
  for (const vehicle of records) {
    if (isContactable(vehicle)) contactable += 1;
    const group = warrantyGroup(vehicle.warrantyStatus) as keyof typeof warranty;
    if (group in warranty) warranty[group] += 1;
    if (group === "即將過保") expiring += 1;
    if ((vehicle.daysSinceVisit ?? 0) >= 365) dormant += 1;
    spend += vehicle.spend3m ?? 0;
    if (vehicle.mileage !== null) mileageBands[vehicle.mileage < 30000 ? 0 : vehicle.mileage < 50000 ? 1 : vehicle.mileage < 80000 ? 2 : vehicle.mileage < 100000 ? 3 : 4] += 1;
    if ((vehicle.maintenanceCount1y ?? 0) > 0) serviceMix.定期保養 += 1;
    if ((vehicle.beautySpend1y ?? 0) > 0) serviceMix.美容服務 += 1;
    if ((vehicle.tireChanges1y ?? 0) > 0) serviceMix.輪胎 += 1;
    if ((vehicle.batteryChanges1y ?? 0) > 0) serviceMix.電瓶 += 1;
    const countyName = canonicalCounty(vehicle.county);
    countyMap.set(countyName || "待確認", (countyMap.get(countyName || "待確認") || 0) + 1);
    const branchName = vehicle.branch || "未指定服務廠";
    const branch = branchMap.get(branchName) || { name: branchName, vehicles: 0, dormant: 0, expiring: 0, spend: 0 };
    branch.vehicles += 1;
    branch.spend += vehicle.spend3m ?? 0;
    if ((vehicle.daysSinceVisit ?? 0) >= 365) branch.dormant += 1;
    if (group === "即將過保") branch.expiring += 1;
    branchMap.set(branchName, branch);
  }
  const branchPerformance = [...branchMap.values()]
    .sort((a, b) => (b.dormant + b.expiring) - (a.dormant + a.expiring) || b.vehicles - a.vehicles);
  const countyDistribution = [...countyMap.entries()].map(([name, vehicles]) => ({ name, vehicles })).sort((a, b) => b.vehicles - a.vehicles);
  return { contactable, expiring, dormant, spend, mileageBands, warranty, serviceMix, branchPerformance, countyDistribution };
}

const sortableFields = {
  code: (v: Vehicle) => v.code,
  vehicleAge: (v: Vehicle) => v.vehicleAge,
  mileage: (v: Vehicle) => v.mileage,
  daysSinceVisit: (v: Vehicle) => v.daysSinceVisit,
  spend3m: (v: Vehicle) => v.spend3m,
  warrantyDaysLeft: (v: Vehicle) => v.warrantyDaysLeft,
} as const;

// Default order is the precomputed priority; an explicit sort keeps empty values last in both directions.
function sortRecords(records: IndexedVehicle[], params: URLSearchParams) {
  const key = params.get("sort") || "";
  if (!(key in sortableFields)) return records;
  const read = sortableFields[key as keyof typeof sortableFields];
  const direction = params.get("dir") === "asc" ? 1 : -1;
  return [...records].sort((a, b) => {
    const left = read(a), right = read(b);
    const leftEmpty = left === null || left === "", rightEmpty = right === null || right === "";
    if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;
    const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), "zh-TW");
    return order * direction || b._priority - a._priority;
  });
}

function workbookResponse(records: IndexedVehicle[]) {
  const data = records.map((v) => ({ 識別碼: v.code, 有手機: v.hasMobile ? "是" : "否", 有Email: v.hasEmail ? "是" : "否", 性別: v.gender, 年齡: v.customerAge, 縣市: v.county, 行政區: v.district, 車型: v.model, 車型代碼: v.modelCode, 領牌日期: v.registrationDate, 車齡: v.vehicleAge, 最新里程: v.mileage, 最近回廠: v.lastVisit, 未回廠天數: v.daysSinceVisit, 最近服務廠: v.branch, 服務專員: v.advisor, 業代: v.salesRepresentative, 指定技師: v.technician, 會員護照: v.memberPassport, 車主授權狀態: v.ownerAuthorization, 近三月消費: v.spend3m, 一年定保次數: v.maintenanceCount1y, 回廠類別: v.returnCategory, 定保頻率: v.maintenanceFrequency, 美容一年消費: v.beautySpend1y, 美容高消費: v.beautyHighSpend, 假美容消費_原始分類: v.fakeBeautySpend1y, 前擋鍍膜次數: v.windshieldCoatingCount1y, 前擋鍍膜金額: v.windshieldCoatingSpend1y, 車身打蠟次數: v.waxCount1y, 車身打蠟金額: v.waxSpend1y, 車身美容次數: v.bodyBeautyCount1y, 車身美容金額: v.bodyBeautySpend1y, 內裝清洗次數: v.interiorCleaningCount1y, 內裝清洗金額: v.interiorCleaningSpend1y, 車身鍍膜次數: v.bodyCoatingCount1y, 車身鍍膜金額: v.bodyCoatingSpend1y, 輪胎更換次數: v.tireChanges1y, 輪胎最後更換: v.tireLastChanged, 電瓶更換次數: v.batteryChanges1y, 電瓶最後更換: v.batteryLastChanged, 空氣芯更換次數: v.airFilterChanges1y, 空氣芯最後更換: v.airFilterLastChanged, 空調濾網更換次數: v.cabinFilterChanges1y, 空調濾網最後更換: v.cabinFilterLastChanged, 雨刷更換次數: v.wiperChanges1y, 雨刷最後更換: v.wiperLastChanged, 來令片更換次數: v.brakePadChanges1y, 來令片最後更換: v.brakePadLastChanged, 皮帶更換次數: v.beltChanges1y, 皮帶最後更換: v.beltLastChanged, 火星塞更換次數: v.sparkPlugChanges1y, 火星塞最後更換: v.sparkPlugLastChanged, 保固狀態: v.warrantyStatus, 保固到期日: v.warrantyExpiry, 剩餘保固天數: v.warrantyDaysLeft, 剩餘保固里程: v.warrantyKmLeft, 延長保固到期: v.extendedWarrantyExpiry, 勿擾: v.doNotContact ? "是" : "否", 建議行動: v.nextBestAction }));
  const sheet = XLSX.utils.json_to_sheet(data);
  sheet["!autofilter"] = { ref: sheet["!ref"] || "A1:AB1" };
  sheet["!cols"] = Object.keys(data[0] || { 識別碼: "" }).map((key) => ({ wch: Math.min(32, Math.max(11, key.length * 2 + 2)) }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "查詢結果");
  const bytes = XLSX.write(book, { bookType: "xlsx", type: "buffer", compression: true }) as Buffer;
  const filename = encodeURIComponent(`裕信CRM查詢結果_去識別化_${new Date().toISOString().slice(0, 10)}_${records.length}筆.xlsx`);
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename*=UTF-8''${filename}`, "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const allRecords = await loadRecords(request.url);
    const filtered = sortRecords(filterRecords(allRecords, url.searchParams), url.searchParams);
    if (url.searchParams.get("format") === "xlsx") return workbookResponse(filtered);
    const pageSize = Math.min(100, Math.max(10, numberParam(url.searchParams, "pageSize") ?? 25));
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(totalPages, Math.max(1, numberParam(url.searchParams, "page") ?? 1));
    const start = (page - 1) * pageSize;
    const districtBase = url.searchParams.get("district") ? filterRecords(allRecords, url.searchParams, { ignoreDistrict: true }) : filtered;
    const metrics = { ...summarize(filtered), districtDistribution: summarizeDistricts(districtBase) };
    return Response.json({ records: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize, metrics }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("vehicle-query-failed", error);
    return Response.json({ error: "本機資料查詢失敗" }, { status: 500 });
  }
}
