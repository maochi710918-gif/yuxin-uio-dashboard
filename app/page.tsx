"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDown, ArrowUp, ArrowUpDown, Building2, CalendarDays, CarFront, ChevronLeft, ChevronRight, Download, Eye, Gauge, LoaderCircle, MapPin, RefreshCw, Search, ShieldAlert, Sparkles, UsersRound, WalletCards, Wrench, X, Copy, Layers, Target, ClipboardList, BarChart3, Settings2, LogIn, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import taiwanCountyPaths from "./taiwan-counties.json";
import { InsightCharts } from "./insight-charts";
import { AdminView } from "./crm/admin-view";
import { apiGet, apiPost } from "./crm/api";
import { Customer360Drawer, CustomerLookup } from "./crm/customer-360";
import { OpportunitiesView } from "./crm/opportunities-view";
import { PerformanceView } from "./crm/performance-view";
import { SegmentsView } from "./crm/segments-view";
import { TasksView } from "./crm/tasks-view";
import { ErrorState, Loading } from "./crm/ui";
import { SalesWorkbench } from "./crm/workbench";

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
type Metadata = { source: string; asOf: string; deidentified?: boolean; recordCount: number; models: string[]; counties: string[]; branches: string[]; advisors: string[]; technicians: string[]; salesRepresentatives: string[] };
type Filters = { keyword: string; model: string; county: string; district: string; branch: string; advisor: string; technician: string; salesRepresentative: string; recommendedAction: string; warranty: string; serviceCategory: string; gender: string; minCustomerAge: string; maxCustomerAge: string; passportStatus: string; authorizationStatus: string; opportunityType: string; opportunityCondition: string; minServiceSpend: string; minServiceCount: string; minDaysSinceService: string; minVehicleAge: string; maxVehicleAge: string; minMileage: string; maxMileage: string; minDaysSinceVisit: string; lastVisitFrom: string; lastVisitTo: string; minSpend: string; excludeDoNotContact: boolean; exactPerson: boolean; contactableOnly: boolean };
type BranchPerformance = { name: string; vehicles: number; dormant: number; expiring: number; spend: number; spendVehicles: number };
type CountyDistribution = { name: string; vehicles: number };
type DistrictDistribution = { name: string; vehicles: number };
type Metrics = { contactable: number; expiring: number; dormant: number; spend: number; spendVehicles: number; mileageBands: number[]; warranty: Record<string, number>; serviceMix: Record<string, number>; branchPerformance: BranchPerformance[]; countyDistribution: CountyDistribution[]; districtDistribution: DistrictDistribution[]; people?: PeopleSummary; visitMonths: { month: string; vehicles: number }[]; latestVisit: string; visitWeekdays: number[]; modelMix: { name: string; vehicles: number }[]; branchWarranty: { name: string; vehicles: number; 保固內: number; 即將過保: number; 已過保: number; 待確認: number }[]; branchWarrantyTotal?: { name: string; vehicles: number; 保固內: number; 即將過保: number; 已過保: number; 待確認: number } };
type QueryResult = { records: Vehicle[]; total: number; page: number; pageSize: number; metrics: Metrics; error?: string };
type ViewName = "dashboard" | "customer" | "vehicle" | "opportunity" | "triangle" | "segments" | "opps" | "tasks" | "performance" | "admin";
const crmViews = new Set<ViewName>(["segments", "opps", "tasks", "performance", "admin"]);
type SortKey = "code" | "vehicleAge" | "mileage" | "daysSinceVisit" | "spend3m" | "warrantyDaysLeft";
type SortState = { key: SortKey; dir: "asc" | "desc" } | null;
type PeopleRole = "advisor" | "technician" | "salesRepresentative";
type PeopleSortKey = "vehicles" | "spendAverage" | "expiring" | "dormant" | "contactable";
type PersonRow = { name: string; vehicles: number; spendAverage: number; spendVehicles: number; expiring: number; dormant: number; contactable: number };
type PeopleSummary = { role: PeopleRole; total: number; matched: number; minSample: number; rows: PersonRow[] } | null;

const emptyFilters: Filters = { keyword: "", model: "", county: "", district: "", branch: "", advisor: "", technician: "", salesRepresentative: "", recommendedAction: "", warranty: "", serviceCategory: "", gender: "", minCustomerAge: "", maxCustomerAge: "", passportStatus: "", authorizationStatus: "", opportunityType: "", opportunityCondition: "", minServiceSpend: "", minServiceCount: "", minDaysSinceService: "", minVehicleAge: "", maxVehicleAge: "", minMileage: "", maxMileage: "", minDaysSinceVisit: "", lastVisitFrom: "", lastVisitTo: "", minSpend: "", excludeDoNotContact: false, exactPerson: false, contactableOnly: false };
const emptyMetrics: Metrics = { contactable: 0, expiring: 0, dormant: 0, spend: 0, spendVehicles: 0, mileageBands: [0, 0, 0, 0, 0], warranty: { 保固內: 0, 即將過保: 0, 已過保: 0, 待確認: 0 }, serviceMix: { 定期保養: 0, 美容服務: 0, 輪胎: 0, 電瓶: 0 }, branchPerformance: [], countyDistribution: [], districtDistribution: [], visitMonths: [], latestVisit: "", visitWeekdays: [0, 0, 0, 0, 0, 0, 0], modelMix: [], branchWarranty: [] };
const peopleRoles: { role: PeopleRole; label: string; nav: string }[] = [
  { role: "advisor", label: "服務專員", nav: "服專" },
  { role: "technician", label: "技師", nav: "技師" },
  { role: "salesRepresentative", label: "業代", nav: "業代" },
];
const peopleSortColumns: { key: PeopleSortKey; label: string }[] = [
  { key: "vehicles", label: "車輛數" }, { key: "spendAverage", label: "有消費台均" }, { key: "expiring", label: "即將過保" }, { key: "dormant", label: "久未回廠" }, { key: "contactable", label: "可聯絡" },
];
const viewNames: ViewName[] = ["dashboard", "customer", "vehicle", "opportunity", "triangle", "segments", "opps", "tasks", "performance", "admin"];
const sortKeys: SortKey[] = ["code", "vehicleAge", "mileage", "daysSinceVisit", "spend3m", "warrantyDaysLeft"];
const pageSizes = [25, 50, 100];
const branchPreviewCount = 13;
// Typed filters wait for a pause before querying; selects and buttons apply immediately.
const typedFilterKeys = new Set<keyof Filters>(["keyword", "advisor", "technician", "salesRepresentative", "minCustomerAge", "maxCustomerAge", "minServiceSpend", "minServiceCount", "minDaysSinceService", "minVehicleAge", "maxVehicleAge", "minMileage", "maxMileage", "minDaysSinceVisit", "minSpend"]);
const typingDelayMs = 300;
const numberFormatter = new Intl.NumberFormat("zh-TW");
const currencyFormatter = new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 });

function ContactChannels({ vehicle }: { vehicle: Vehicle }) { return <span className="contact-channels"><i className={vehicle.hasMobile ? "on" : ""}>手機</i><i className={vehicle.hasEmail ? "on" : ""}>Email</i></span>; }
function warrantyGroup(status: string) { return status.startsWith("即將過保") ? "即將過保" : status.startsWith("已過保") ? "已過保" : status; }
function warrantyClass(status: string) { const group = warrantyGroup(status); return group === "保固內" ? "status-green" : group === "即將過保" ? "status-amber" : group === "已過保" ? "status-red" : "status-gray"; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="filter-field"><span>{label}</span>{children}</label>; }
function PeopleFilterField({ label, listId, value, options, onChange }: { label: string; listId: string; value: string; options: string[]; onChange: (value: string) => void }) { return <Field label={label}><Input list={listId} value={value} onChange={(event) => onChange(event.target.value)} placeholder="輸入姓名或從清單挑選" autoComplete="off" /><datalist id={listId}>{options.map((name) => <option key={name} value={name} />)}</datalist></Field>; }
function KpiCard({ icon, label, value, detail, ratio, tone = "blue", active, onSelect, onExport }: { icon: React.ReactNode; label: string; value: string; detail: string; ratio?: number; tone?: "blue" | "amber" | "red" | "green"; active?: boolean; onSelect?: () => void; onExport?: () => void }) { return <Card className={`kpi-card kpi-${tone} ${onSelect ? "is-clickable" : ""} ${active ? "is-active" : ""}`} role={onSelect ? "button" : undefined} tabIndex={onSelect ? 0 : undefined} aria-pressed={onSelect ? Boolean(active) : undefined} title={onSelect ? (active ? "再點一次取消篩選" : `點選以篩選「${label}」名單`) : undefined} onClick={onSelect} onKeyDown={(event) => { if (onSelect && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelect(); } }}>{onExport && <button type="button" className="kpi-export" onClick={(event) => { event.stopPropagation(); onExport(); }} title={`匯出「${label}」名單 Excel`}><Download />匯出</button>}<CardContent className="kpi-content"><div className="kpi-copy"><div className="kpi-label-row"><p className="kpi-label">{label}</p>{ratio !== undefined && <span>{ratio.toFixed(1)}%</span>}</div><p className="kpi-value">{value}</p><p className="kpi-detail">{detail}</p><div className="kpi-meter"><span style={{ width: `${Math.min(100, Math.max(3, ratio ?? 68))}%` }} /></div></div><div className="kpi-icon">{icon}</div></CardContent></Card>; }
function DetailItem({ label, value }: { label: string; value: React.ReactNode }) { return <div className="detail-item"><span>{label}</span><strong>{value || "—"}</strong></div>; }
function ServiceMetric({ label, count, spend }: { label: string; count: number | null; spend?: number | null }) { return <div className="service-card"><span>{label}</span><strong>{numberFormatter.format(count ?? 0)} 次</strong>{spend !== undefined && <small>{currencyFormatter.format(spend ?? 0)}</small>}</div>; }

function TaiwanCountyMap({ distribution, activeCounty, onSelect }: { distribution: CountyDistribution[]; activeCounty: string; onSelect: (county: string) => void }) {
  const counts = new Map(distribution.map((item) => [item.name, item.vehicles]));
  const officialNames = new Set(taiwanCountyPaths.map((item) => item.name));
  const ranked = taiwanCountyPaths.map((county) => ({ ...county, vehicles: counts.get(county.name) || 0 })).sort((a, b) => b.vehicles - a.vehicles);
  const max = Math.max(1, ...ranked.map((item) => item.vehicles));
  const mapped = ranked.reduce((sum, item) => sum + item.vehicles, 0);
  const unassigned = distribution.filter((item) => !officialNames.has(item.name)).reduce((sum, item) => sum + item.vehicles, 0);
  const labelOffsets: Record<string, [number, number]> = { "台北市": [34, -5], "基隆市": [44, -4], "新竹市": [-34, 2], "嘉義市": [-36, 2] };
  return <section className="taiwan-map-card">
    <div className="map-heading"><div><p className="eyebrow">地域分布</p><h2>台灣縣市車輛台數</h2><span>依官方縣市行政界線著色；顏色越亮代表車輛越多，點選可直接查看名單。</span></div><MapPin /></div>
    <div className="taiwan-map-layout">
      <div className="map-stage">
        <svg viewBox="0 0 500 600" role="img" aria-label="台灣各縣市行政區車輛台數分布圖">
          <defs><filter id="countyGlow"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
          {ranked.map((item) => { const ratio = item.vehicles / max; const selected = activeCounty === item.name; const offset = labelOffsets[item.name] || [0, 0]; const labelX = item.labelX + offset[0], labelY = item.labelY + offset[1]; return <g key={item.name} className={`county-region ${selected ? "is-selected" : ""}`} onClick={() => onSelect(selected ? "" : item.name)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(selected ? "" : item.name); }} aria-label={`${item.name} ${numberFormatter.format(item.vehicles)} 台`}>
            <path d={item.path} style={{ fill: selected ? "#ffbd4a" : `hsl(${198 - ratio * 18} 78% ${18 + ratio * 31}%)` }} />
            {(offset[0] !== 0 || offset[1] !== 0) && <line x1={item.labelX} y1={item.labelY} x2={labelX} y2={labelY} />}
            <text x={labelX} y={labelY} textAnchor="middle">{item.name}</text>
          </g>; })}
        </svg>
        <div className="map-legend"><span>少</span><i /><span>多</span></div>
        <div className="map-total"><strong>{numberFormatter.format(mapped)}</strong><span>已定位車輛</span>{unassigned > 0 && <small>{numberFormatter.format(unassigned)} 台縣市待整理</small>}</div>
      </div>
      <div className="county-ranking">{ranked.map((item, index) => <button key={item.name} className={activeCounty === item.name ? "active" : ""} onClick={() => onSelect(activeCounty === item.name ? "" : item.name)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.name}</strong><i><b style={{ width: `${Math.max(item.vehicles ? 3 : 0, item.vehicles / max * 100)}%` }} /></i><em>{numberFormatter.format(item.vehicles)} 台</em></button>)}</div>
    </div>
  </section>;
}

const districtColors = ["#35c7f3", "#7b8cff", "#a879ff", "#ef6fa9", "#ff826f", "#ffb84e", "#63d39a", "#28c7bd", "#56a8ff", "#d68cff", "#f08d5d", "#9aca55"];

function DistrictDrilldown({ county, distribution, activeDistrict, onSelect }: { county: string; distribution: DistrictDistribution[]; activeDistrict: string; onSelect: (district: string) => void }) {
  const totalVehicles = distribution.reduce((sum, item) => sum + item.vehicles, 0);
  const maxVehicles = Math.max(1, ...distribution.map((item) => item.vehicles));
  return <section className="district-drilldown">
    <div className="district-heading"><div><p className="eyebrow">縣市下鑽</p><h2>{county}行政區數量</h2><span>點選行政區後，下方車輛清單與 Excel 匯出會同步套用條件。</span></div><div className="district-total"><strong>{numberFormatter.format(totalVehicles)}</strong><span>台車輛｜{distribution.length} 個行政區</span></div></div>
    <div className="district-color-grid">{distribution.map((item, index) => { const color = districtColors[index % districtColors.length]; const value = item.name === "行政區待確認" ? "__EMPTY__" : item.name; const active = activeDistrict === value; return <button key={item.name} className={active ? "active" : ""} style={{ borderTopColor: color }} onClick={() => onSelect(active ? "" : value)}><span style={{ background: color }} /><small>{item.name}</small><strong>{numberFormatter.format(item.vehicles)}</strong><em>{totalVehicles ? (item.vehicles / totalVehicles * 100).toFixed(1) : "0.0"}%</em></button>; })}</div>
    <div className="district-list"><div className="district-list-head"><span>排名</span><span>行政區</span><span>車輛占比</span><span>台數</span><span>名單</span></div>{distribution.map((item, index) => { const color = districtColors[index % districtColors.length]; const value = item.name === "行政區待確認" ? "__EMPTY__" : item.name; const active = activeDistrict === value; return <button key={item.name} className={active ? "active" : ""} onClick={() => onSelect(active ? "" : value)}><span className="district-rank">{String(index + 1).padStart(2, "0")}</span><strong><i style={{ background: color }} />{item.name}</strong><span className="district-meter"><i style={{ width: `${item.vehicles / maxVehicles * 100}%`, background: color }} /></span><b>{numberFormatter.format(item.vehicles)} 台</b><em>{active ? "已篩選" : "查看車輛"}</em></button>; })}</div>
  </section>;
}

const opportunityTypes = [
  ["beauty", "美容整體"], ["windshieldCoating", "前擋鍍膜"], ["wax", "車身打蠟"], ["bodyBeauty", "車身美容"], ["interiorCleaning", "內裝清洗"], ["bodyCoating", "車身鍍膜"],
  ["maintenance", "定期保養"], ["tire", "輪胎"], ["battery", "電瓶"], ["airFilter", "空氣芯"], ["cabinFilter", "空調濾網"], ["wiper", "雨刷"], ["brakePad", "來令片"], ["belt", "皮帶"], ["sparkPlug", "火星塞"], ["warranty", "即將過保健檢"], ["dormant", "久未回廠喚回"],
] as const;
const datedOpportunityTypes = new Set(["tire", "battery", "airFilter", "cabinFilter", "wiper", "brakePad", "belt", "sparkPlug"]);
const spendOpportunityTypes = new Set(["beauty", "windshieldCoating", "wax", "bodyBeauty", "interiorCleaning", "bodyCoating"]);
const recommendedActionDefinitions = [
  { action: "3 日內聯絡並安排保固健檢", trigger: "車輛仍在保固內，且距年限到期 180 天內、里程達 80,000 km，或兩者同時成立。" },
  { action: "啟動久未回廠關懷與車況健檢", trigger: "車輛已過保，且距最近一次回廠已滿 365 天。" },
  { action: "安排 100,000 km 前預防健檢", trigger: "最新有效里程已達 90,000 km，且沒有符合前兩項更高優先條件。" },
  { action: "本週由原服務專員邀約回廠", trigger: "距最近一次回廠已滿 270 天，且沒有符合更高優先條件。" },
  { action: "確認輪胎年限與磨耗", trigger: "一年內輪胎更換次數為 0 或資料沒有紀錄；代表需要確認，不等於判定必須更換。" },
  { action: "確認電瓶健康度", trigger: "一年內電瓶更換次數為 0 或資料沒有紀錄；代表需要確認，不等於判定必須更換。" },
  { action: "依保養週期持續追蹤", trigger: "以上高優先條件皆未成立，維持一般週期追蹤。" },
] as const;

const opportunityConditionLabels: Record<string, string> = { done1y: "一年內有做", notDone1y: "一年內未做", ever: "曾有紀錄", over1y: "最後紀錄超過一年", never: "從未有紀錄" };
const filterLabels: Record<keyof Filters, string> = { keyword: "關鍵字", model: "車型", county: "縣市", district: "行政區", branch: "服務廠", advisor: "服務專員", technician: "技師", salesRepresentative: "業代", recommendedAction: "建議行動", warranty: "保固", serviceCategory: "服務類別", gender: "客戶類型", minCustomerAge: "客戶年齡 ≥", maxCustomerAge: "客戶年齡 ≤", passportStatus: "會員護照", authorizationStatus: "車主授權", opportunityType: "商機", opportunityCondition: "歷史行為", minServiceSpend: "一年消費 ≥", minServiceCount: "一年次數 ≥", minDaysSinceService: "距最後更換 ≥", minVehicleAge: "車齡 ≥", maxVehicleAge: "車齡 ≤", minMileage: "里程 ≥", maxMileage: "里程 ≤", minDaysSinceVisit: "未回廠 ≥", lastVisitFrom: "最後進廠起", lastVisitTo: "最後進廠迄", minSpend: "近三月消費 ≥", excludeDoNotContact: "排除勿擾名單", exactPerson: "人員精確比對", contactableOnly: "只看可聯絡車主" };
const filterUnits: Partial<Record<keyof Filters, string>> = { minCustomerAge: " 歲", maxCustomerAge: " 歲", minServiceSpend: " 元", minServiceCount: " 次", minDaysSinceService: " 天", minVehicleAge: " 年", maxVehicleAge: " 年", minMileage: " km", maxMileage: " km", minDaysSinceVisit: " 天", minSpend: " 元" };

function filterValueLabel(key: keyof Filters, value: string) {
  if (key === "passportStatus") return value === "has" ? "有會員護照" : "無會員護照";
  if (key === "authorizationStatus") return value === "authorized" ? "已同意使用個資" : "未同意／待確認";
  if (key === "opportunityType") return opportunityTypes.find(([type]) => type === value)?.[1] || value;
  if (key === "opportunityCondition") return opportunityConditionLabels[value] || value;
  if (key === "district" && value === "__EMPTY__") return "行政區待確認";
  const unit = filterUnits[key];
  return unit && Number.isFinite(Number(value)) ? `${numberFormatter.format(Number(value))}${unit}` : value;
}

function filtersFromSearch(params: URLSearchParams) {
  const next: Record<string, string | boolean> = { ...emptyFilters };
  for (const key of Object.keys(emptyFilters)) {
    const value = params.get(key);
    if (value !== null) next[key] = typeof emptyFilters[key as keyof Filters] === "boolean" ? value === "true" : value;
  }
  return next as Filters;
}

function SortableHead({ parts, sort, onSort, className }: { parts: { label: string; key?: SortKey }[]; sort: SortState; onSort: (key: SortKey) => void; className?: string }) {
  const activePart = parts.find((part) => part.key && part.key === sort?.key);
  return <TableHead className={className} aria-sort={activePart && sort ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}><span className="sort-head">{parts.map((part, index) => { const active = Boolean(part.key) && part.key === sort?.key; const Icon = !active ? ArrowUpDown : sort?.dir === "asc" ? ArrowUp : ArrowDown; return <span key={part.label}>{index > 0 && <i>／</i>}{part.key ? <button type="button" className={`sort-button ${active ? "active" : ""}`} onClick={() => onSort(part.key!)} title={`依${part.label}排序`}>{part.label}<Icon /></button> : part.label}</span>; })}</span></TableHead>;
}

function PeopleRoster({ summary, role, label, selected, search, onSearch, sort, onSort, onSelect }: { summary: PeopleSummary; role: PeopleRole; label: string; selected: string; search: string; onSearch: (value: string) => void; sort: PeopleSortKey; onSort: (key: PeopleSortKey) => void; onSelect: (name: string) => void }) {
  const rows = summary?.role === role ? summary.rows : [];
  const maxVehicles = Math.max(1, ...rows.map((row) => row.vehicles));
  return <section className="people-roster">
    <div className="people-heading"><div><p className="eyebrow">服務金三角</p><h2>{label}名單</h2><span>點選{label}即可列出他負責的車主；再點一次取消。統計會套用上方其他篩選條件。</span></div><div className="people-search"><Search /><Input value={search} onChange={(event) => onSearch(event.target.value)} placeholder={`搜尋${label}姓名`} aria-label={`搜尋${label}姓名`} /></div></div>
    <div className="people-meta">{summary?.role === role ? `共 ${numberFormatter.format(summary.total)} 位${summary.matched !== summary.total ? `，符合搜尋 ${numberFormatter.format(summary.matched)} 位` : ""}${summary.matched > rows.length ? `，顯示前 ${rows.length} 位` : ""}` : "統計中…"}{sort === "spendAverage" && summary?.role === role && <span>有消費未滿 {summary.minSample} 台者排在最後，避免少數車輛拉高平均</span>}{selected && <b>已選：{selected}</b>}</div>
    <div className="people-table-wrap"><table className="people-table"><thead><tr><th>排名</th><th>{label}</th>{peopleSortColumns.map((column) => <th key={column.key} aria-sort={sort === column.key ? "descending" : undefined}><button type="button" className={`sort-button ${sort === column.key ? "active" : ""}`} onClick={() => onSort(column.key)}>{column.label}{sort === column.key ? <ArrowDown /> : <ArrowUpDown />}</button></th>)}</tr></thead>
      <tbody>{rows.length ? rows.map((row, index) => <tr key={row.name} className={selected === row.name ? "active" : ""} onClick={() => onSelect(row.name)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(row.name); } }} aria-pressed={selected === row.name}>
        <td><span className="table-rank">{String(index + 1).padStart(2, "0")}</span></td>
        <td><strong className={row.name === "未指派" ? "people-unassigned" : ""}>{row.name}</strong></td>
        <td><strong>{numberFormatter.format(row.vehicles)}</strong><span className="inline-meter"><i style={{ width: `${row.vehicles / maxVehicles * 100}%` }} /></span></td>
        <td><strong className={summary && row.spendVehicles < summary.minSample ? "people-thin" : ""}>{currencyFormatter.format(row.spendAverage)}</strong><span className="cell-subtext">有消費 {numberFormatter.format(row.spendVehicles)} 台{summary && row.spendVehicles < summary.minSample ? "・樣本少" : ""}</span></td>
        <td><span className="metric-warning">{numberFormatter.format(row.expiring)}</span></td>
        <td><span className="metric-danger">{numberFormatter.format(row.dormant)}</span></td>
        <td>{numberFormatter.format(row.contactable)}<span className="cell-subtext">{(row.vehicles ? row.contactable / row.vehicles * 100 : 0).toFixed(0)}%</span></td>
      </tr>) : <tr><td colSpan={7} className="empty-results">{summary?.role === role ? "沒有符合的人員" : "統計中…"}</td></tr>}</tbody></table></div>
  </section>;
}

function queryParams(filters: Filters, page?: number, pageSize?: number) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== "" && value !== false) params.set(key, String(value));
  if (page !== undefined) params.set("page", String(page));
  if (pageSize !== undefined) params.set("pageSize", String(pageSize));
  return params;
}

export default function Home() {
  const [activeView, setActiveView] = useState<ViewName>("dashboard");
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [records, setRecords] = useState<Vehicle[]>([]), [total, setTotal] = useState(0), [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<SortState>(null);
  const [ready, setReady] = useState(false), [showAllBranches, setShowAllBranches] = useState(false);
  const lastAppliedRef = useRef<Filters>(emptyFilters);
  const [peopleRole, setPeopleRole] = useState<PeopleRole | "">("");
  const [peopleSearch, setPeopleSearch] = useState(""), [appliedPeopleSearch, setAppliedPeopleSearch] = useState("");
  const [peopleSort, setPeopleSort] = useState<PeopleSortKey>("vehicles");
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState("");
  const [exporting, setExporting] = useState(false), [exportMessage, setExportMessage] = useState("");
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null), [copiedCode, setCopiedCode] = useState("");
  // 登入身分、角色與單位由後端決定（/api/crm/session）；網址參數只切換畫面，不影響可存取的資料。
  const [session, setSession] = useState<any>(null), [sessionError, setSessionError] = useState<Error | null>(null), [sessionVersion, setSessionVersion] = useState(0);
  const [customer360, setCustomer360] = useState<string | null>(null);
  const [units, setUnits] = useState<{ unit_code: string; name: string }[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiGet<any>("/api/crm/session").then((value) => { setSession(value); setSessionError(null); }).catch((error: Error & { status?: number }) => {
      // 未登入時自動導向登入，登入後回到原頁面（本機為免密碼的開發登入）。
      if (error.status === 401) { window.location.href = `/signin-with-chatgpt?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`; return; }
      setSessionError(error);
    });
    apiGet<{ units: { unit_code: string; name: string }[] }>("/api/crm/directory").then((value) => setUnits(value.units)).catch(() => undefined);
  }, [sessionVersion]);
  useEffect(() => { fetch("/api/vehicles?meta=1", { cache: "no-store" }).then(async (r) => { if (!r.ok) throw new Error(); return r.json() as Promise<Metadata>; }).then(setMetadata).catch(() => setLoadError("無法讀取資料摘要（請確認已登入）")); }, [sessionVersion]);
  useEffect(() => {
    // Restore view, filters, paging and sort from the URL so a list can be bookmarked or shared.
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view") as ViewName | null;
    const urlFilters = filtersFromSearch(params);
    const urlPageSize = Number(params.get("pageSize")), urlPage = Number(params.get("page"));
    const urlSort = params.get("sort") as SortKey | null;
    if (view && viewNames.includes(view)) setActiveView(view);
    const urlRole = params.get("role") as PeopleRole | null;
    if (view === "triangle" && urlRole && peopleRoles.some((item) => item.role === urlRole)) setPeopleRole(urlRole);
    lastAppliedRef.current = urlFilters; setFilters(urlFilters); setAppliedFilters(urlFilters);
    if (pageSizes.includes(urlPageSize)) setPageSize(urlPageSize);
    if (Number.isInteger(urlPage) && urlPage > 1) setPage(urlPage);
    if (urlSort && sortKeys.includes(urlSort)) setSort({ key: urlSort, dir: params.get("dir") === "asc" ? "asc" : "desc" });
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready || filters === lastAppliedRef.current) return;
    const previous = lastAppliedRef.current;
    const apply = () => { lastAppliedRef.current = filters; setAppliedFilters(filters); setPage(1); setExportMessage(""); };
    const typed = (Object.keys(filters) as (keyof Filters)[]).some((key) => typedFilterKeys.has(key) && filters[key] !== previous[key]);
    if (!typed) { apply(); return; }
    const timer = window.setTimeout(apply, typingDelayMs);
    return () => window.clearTimeout(timer);
  }, [filters, ready]);
  useEffect(() => {
    if (!ready) return;
    const params = queryParams(appliedFilters);
    if (activeView !== "dashboard") params.set("view", activeView);
    if (activeView === "triangle" && peopleRole) params.set("role", peopleRole);
    if (page > 1) params.set("page", String(page));
    if (pageSize !== 25) params.set("pageSize", String(pageSize));
    if (sort) { params.set("sort", sort.key); params.set("dir", sort.dir); }
    const search = params.toString();
    window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
  }, [ready, appliedFilters, activeView, page, pageSize, sort, peopleRole]);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    setLoading(true); setLoadError("");
    const params = queryParams(appliedFilters, page, pageSize);
    if (sort) { params.set("sort", sort.key); params.set("dir", sort.dir); }
    if (activeView === "triangle" && peopleRole) { params.set("peopleRole", peopleRole); params.set("peopleSort", peopleSort); if (appliedPeopleSearch) params.set("peopleSearch", appliedPeopleSearch); }
    fetch(`/api/vehicles?${params}`, { signal: controller.signal })
      .then(async (response) => { const body = await response.json() as QueryResult; if (!response.ok) throw new Error(body.error || "本機資料查詢失敗"); return body; })
      .then((body) => { setRecords(body.records); setTotal(body.total); setMetrics(body.metrics); if (body.page !== page) setPage(body.page); setLoading(false); })
      .catch((error: Error) => { if (error.name !== "AbortError") { setLoadError(error.message); setLoading(false); } });
    return () => controller.abort();
  }, [ready, appliedFilters, page, pageSize, sort, activeView, peopleRole, peopleSort, appliedPeopleSearch, sessionVersion]);
  useEffect(() => { const timer = window.setTimeout(() => setAppliedPeopleSearch(peopleSearch.trim()), typingDelayMs); return () => window.clearTimeout(timer); }, [peopleSearch]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const mileageLabels = ["0–30K", "30–50K", "50–80K", "80–100K", "100K+"];
  const maxMileageBand = Math.max(...metrics.mileageBands, 1);
  const serviceMixEntries = Object.entries(metrics.serviceMix);
  const serviceMixTotal = Math.max(1, serviceMixEntries.reduce((sum, [, count]) => sum + count, 0));
  const serviceColors = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)"];
  let serviceCursor = 0;
  const serviceGradient = serviceMixEntries.map(([, count], index) => {
    const start = serviceCursor;
    serviceCursor += count / serviceMixTotal * 100;
    return `${serviceColors[index]} ${start}% ${serviceCursor}%`;
  }).join(", ");
  const maxBranchActions = Math.max(1, ...metrics.branchPerformance.map((branch) => branch.dormant + branch.expiring));
  const expiringHotspots = [...metrics.branchPerformance].sort((a, b) => b.expiring - a.expiring).slice(0, 4);
  const dormantHotspots = [...metrics.branchPerformance].sort((a, b) => b.dormant - a.dormant).slice(0, 4);
  const maxExpiringHotspot = Math.max(1, ...expiringHotspots.map((branch) => branch.expiring));
  const maxDormantHotspot = Math.max(1, ...dormantHotspots.map((branch) => branch.dormant));
  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((current) => ({ ...current, [key]: value }));
  const updateCounty = (county: string) => setFilters((current) => ({ ...current, county, district: "" }));
  const selectedOpportunityLabel = opportunityTypes.find(([value]) => value === filters.opportunityType)?.[1] || "全部商機";
  const activeQuery = useMemo(() => { const params = queryParams(appliedFilters); if (sort) { params.set("sort", sort.key); params.set("dir", sort.dir); } return params; }, [appliedFilters, sort]);
  const activeFilterEntries = (Object.entries(filters) as [keyof Filters, string | boolean][]).filter(([key, value]) => key !== "exactPerson" && value !== "" && value !== false);
  const visibleBranches = showAllBranches ? metrics.branchPerformance : metrics.branchPerformance.slice(0, branchPreviewCount);
  const maxBranchVehicles = Math.max(1, ...metrics.branchPerformance.map((branch) => branch.vehicles));
  const mileageRanges = [["0", "29999"], ["30000", "49999"], ["50000", "79999"], ["80000", "99999"], ["100000", ""]];
  const viewTitle = { segments: "客群", opps: "商機", tasks: "任務", performance: "成效", admin: "資料管理", dashboard: "總覽｜客戶與車輛儀表板", customer: "客戶查詢", vehicle: "車輛查詢", opportunity: "售後商機線索", triangle: peopleRole ? `服務金三角｜${peopleRoles.find((item) => item.role === peopleRole)?.label}` : "服務金三角名單" }[activeView];
  const resultTitle = activeView === "customer" ? "筆客戶／車輛資料" : activeView === "vehicle" ? "台符合條件的車輛" : activeView === "opportunity" ? "筆商機候選" : activeView === "triangle" ? "筆金三角名單" : "台車輛";
  const opportunityConditionLabel = opportunityConditionLabels[filters.opportunityCondition] || "不限歷史行為";
  const searchPlaceholder = activeView === "customer" ? "輸入識別碼（如 ES-00001）、縣市或行政區" : activeView === "vehicle" ? "輸入識別碼、車型或服務專員" : activeView === "triangle" ? "輸入識別碼、服務專員、技師或業代" : "輸入識別碼、車型、地區或服務專員";

  function activateView(view: ViewName) {
    setActiveView(view); setFilters({ ...emptyFilters }); setExportMessage(""); window.scrollTo({ top: 0, behavior: "smooth" });
    if (view !== "dashboard") window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  // KPI 卡片：點選套用該群體的篩選（再點一次取消）；「匯出」直接下載該群體（套用目前其他條件）。
  const kpiPresets: Record<string, Partial<Filters>> = { contactable: { contactableOnly: true }, expiring: { warranty: "即將過保" }, dormant: { minDaysSinceVisit: "365" }, spending: { minSpend: "1" } };
  const kpiKeys: (keyof Filters)[] = ["contactableOnly", "warranty", "minDaysSinceVisit", "minSpend"];
  const kpiActive = (key: string) => key === "all" ? kpiKeys.every((field) => filters[field] === emptyFilters[field]) : Object.entries(kpiPresets[key]).every(([field, value]) => filters[field as keyof Filters] === value);
  function selectKpi(key: string) {
    const cleared = Object.fromEntries(kpiKeys.map((field) => [field, emptyFilters[field]])) as Partial<Filters>;
    setFilters((current) => ({ ...current, ...cleared, ...(key === "all" || kpiActive(key) ? {} : kpiPresets[key]) }));
    window.setTimeout(() => document.querySelector(".results-card")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  function exportKpi(key: string) {
    const cleared = Object.fromEntries(kpiKeys.map((field) => [field, emptyFilters[field]])) as Partial<Filters>;
    const params = queryParams({ ...appliedFilters, ...cleared, ...(key === "all" ? {} : kpiPresets[key]) });
    if (sort) { params.set("sort", sort.key); params.set("dir", sort.dir); }
    params.set("format", "xlsx");
    const link = document.createElement("a"); link.href = `/api/vehicles?${params}`; link.download = ""; document.body.appendChild(link); link.click(); link.remove();
    setExportMessage("已開始下載 Excel（依卡片群體＋目前條件）");
  }

  function copyCode(code: string) {
    void navigator.clipboard?.writeText(code).then(() => { setCopiedCode(code); window.setTimeout(() => setCopiedCode(""), 1500); }).catch(() => undefined);
  }

  // Typing a name switches back to partial matching; picking from the roster matches exactly.
  function updatePerson(key: PeopleRole, value: string) {
    setFilters((current) => ({ ...current, [key]: value, exactPerson: false }));
  }

  function selectPerson(role: PeopleRole, name: string) {
    setFilters((current) => current[role] === name && current.exactPerson ? { ...current, [role]: "", exactPerson: false } : { ...current, [role]: name, exactPerson: true });
  }

  function activateTriangle(role: PeopleRole | "") {
    activateView("triangle"); setPeopleRole(role); setPeopleSearch(""); setAppliedPeopleSearch(""); setPeopleSort("vehicles");
  }

  function removeFilter(key: keyof Filters) {
    if (key === "advisor" || key === "technician" || key === "salesRepresentative") { updatePerson(key, ""); return; }
    if (key === "county") updateCounty("");
    else if (key === "opportunityType") selectOpportunityType("");
    else updateFilter(key, emptyFilters[key]);
  }

  function toggleSort(key: SortKey) {
    // Cycle: first direction → opposite direction → back to the default priority order.
    const first = key === "code" ? "asc" : "desc", second = first === "asc" ? "desc" : "asc";
    setSort((current) => current?.key !== key ? { key, dir: first } : current.dir === first ? { key, dir: second } : null);
    setPage(1);
  }

  function selectOpportunityType(value: string) {
    setFilters((current) => ({ ...current, opportunityType: value, opportunityCondition: "", minServiceSpend: "", minServiceCount: "", minDaysSinceService: "", warranty: "", minDaysSinceVisit: "" }));
  }

  function applyOpportunityPreset(type: string, condition = "", extras: Partial<Filters> = {}) {
    setFilters({ ...emptyFilters, opportunityType: type, opportunityCondition: condition, ...extras });
  }

  function exportRows() {
    setExporting(true); setExportMessage("正在準備 Excel…");
    const link = document.createElement("a");
    const params = new URLSearchParams(activeQuery); params.set("format", "xlsx");
    link.href = `/api/vehicles?${params}`; link.download = ""; document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => { setExporting(false); setExportMessage(`已送出 ${numberFormatter.format(total)} 筆匯出`); }, 900);
  }

  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: Record<string, unknown>, options?: { signal?: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return; const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({ name: "filter_after_sales_vehicles", title: "篩選售後客戶車輛", description: "套用識別碼、車型、地區、服務廠、服務專員、技師、業代、保固與里程篩選，更新畫面結果。", inputSchema: { type: "object", properties: { keyword: { type: "string" }, model: { type: "string" }, county: { type: "string" }, branch: { type: "string" }, advisor: { type: "string" }, technician: { type: "string" }, salesRepresentative: { type: "string" }, warranty: { type: "string", enum: ["", "保固內", "即將過保", "已過保", "待確認"] }, minMileage: { type: "number" }, maxMileage: { type: "number" }, minDaysSinceVisit: { type: "number" } }, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: false }, execute(input: Record<string, unknown>) { setFilters((current) => ({ ...current, keyword: input.keyword === undefined ? current.keyword : String(input.keyword), model: input.model === undefined ? current.model : String(input.model), county: input.county === undefined ? current.county : String(input.county), branch: input.branch === undefined ? current.branch : String(input.branch), advisor: input.advisor === undefined ? current.advisor : String(input.advisor), technician: input.technician === undefined ? current.technician : String(input.technician), salesRepresentative: input.salesRepresentative === undefined ? current.salesRepresentative : String(input.salesRepresentative), warranty: input.warranty === undefined ? current.warranty : String(input.warranty), minMileage: input.minMileage === undefined ? current.minMileage : String(input.minMileage), maxMileage: input.maxMileage === undefined ? current.maxMileage : String(input.maxMileage), minDaysSinceVisit: input.minDaysSinceVisit === undefined ? current.minDaysSinceVisit : String(input.minDaysSinceVisit) })); return { status: "applied" }; } }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand-lockup"><div className="brand-mark"><CarFront /></div><div><strong>裕信汽車</strong><span>零服UIO管理系統</span></div></div><nav aria-label="主要導覽">
      {([["dashboard", <Gauge key="i" />, "總覽"], ["segments", <Layers key="i" />, "客群"], ["customer", <UsersRound key="i" />, "客戶查詢"], ["vehicle", <CarFront key="i" />, "車輛查詢"], ["opps", <Target key="i" />, "商機"], ["opportunity", <Wrench key="i" />, "售後商機線索"], ["tasks", <ClipboardList key="i" />, "任務"], ["performance", <BarChart3 key="i" />, "成效"]] as [ViewName, React.ReactNode, string][]).map(([view, icon, label]) => <button key={view} className={`nav-item ${activeView === view ? "active" : ""}`} aria-current={activeView === view ? "page" : undefined} onClick={() => activateView(view)}>{icon}<span>{label}</span></button>)}
      <button className={`nav-item ${activeView === "triangle" && !peopleRole ? "active" : ""}`} aria-current={activeView === "triangle" && !peopleRole ? "page" : undefined} onClick={() => activateTriangle("")}><UsersRound /><span>服務金三角</span></button><div className="nav-sub" role="group" aria-label="服務金三角分類">{peopleRoles.map((item) => <button key={item.role} className={`nav-sub-item ${activeView === "triangle" && peopleRole === item.role ? "active" : ""}`} aria-current={activeView === "triangle" && peopleRole === item.role ? "page" : undefined} onClick={() => activateTriangle(item.role)}><span>{item.role === "salesRepresentative" ? "業代（工作台）" : item.nav}</span></button>)}</div>
      {session && ["company_manager", "branch_manager"].includes(session.actor.role) && <button className={`nav-item ${activeView === "admin" ? "active" : ""}`} aria-current={activeView === "admin" ? "page" : undefined} onClick={() => activateView("admin")}><Settings2 /><span>資料管理</span></button>}
    </nav><div className="sidebar-insight"><Sparkles /><div><span>{metadata?.deidentified ? "去識別化資料" : "本機智慧分析"}</span><strong>{metadata?.deidentified ? "不含個資・以識別碼比對" : "資料已就緒"}</strong></div></div><div className="sidebar-meta"><span>資料基準</span><strong>{metadata?.asOf || "讀取中"}</strong><small>{metadata?.source || "本機資料"}</small></div></aside>
    <main className="workspace dashboard-mode">
      <header className="topbar"><div><p className="eyebrow">YULON AFTERSALES INTELLIGENCE</p><h1>{viewTitle}</h1><p className="page-description">即時掌握客戶價值、回廠風險與售後商機</p></div><div className="topbar-actions">{session && <div className="crm-session" title={session.actor.email}><UserCog /><span>{session.actor.displayName}</span><strong>{session.actor.roleLabel}</strong>{session.actor.actingAs && <button className="crm-link" onClick={() => apiPost("/api/crm/session", { action: "impersonate", email: "" }).then(() => setSessionVersion((v) => v + 1))}>結束代理（目前以 {session.actor.actingAs} 檢視）</button>}</div>}<div className="data-date"><CalendarDays /><span>資料基準</span><strong>{metadata?.asOf || "讀取中"}</strong></div>{!crmViews.has(activeView) && <div className="export-area"><span aria-live="polite">{exportMessage}</span><Button className="export-button" onClick={exportRows} disabled={exporting || loading || !total}>{exporting ? <LoaderCircle className="animate-spin" /> : <Download />}匯出目前結果 Excel</Button></div>}</div></header>
      {!session && sessionError ? <ErrorState error={sessionError} onRetry={() => setSessionVersion((v) => v + 1)} /> : null}
      <div className="crm-direct"><CustomerLookup onOpen={setCustomer360} /></div>
      {!crmViews.has(activeView) && <>
      <section className="search-panel" aria-label="查詢條件">
        <div className="global-search"><Search /><Input ref={searchInputRef} value={filters.keyword} onChange={(e) => updateFilter("keyword", e.target.value)} placeholder={searchPlaceholder} aria-label="全域搜尋" /></div>
        {activeView === "opportunity" && <div className="opportunity-presets"><span>快速商機</span><button onClick={() => applyOpportunityPreset("beauty", "notDone1y")}>一年未做美容</button><button onClick={() => applyOpportunityPreset("maintenance", "notDone1y")}>一年未定保</button><button onClick={() => applyOpportunityPreset("tire", "over1y")}>輪胎超過一年</button><button onClick={() => applyOpportunityPreset("battery", "over1y")}>電瓶超過一年</button><button onClick={() => applyOpportunityPreset("dormant", "", { minDaysSinceVisit: "365" })}>一年未回廠</button></div>}
        <div className={`filter-grid ${activeView === "opportunity" ? "opportunity-filter-grid" : ""}`}>
          {activeView === "customer" && <>
            <Field label="客戶類型／性別"><NativeSelect value={filters.gender} onChange={(e) => updateFilter("gender", e.target.value)}><NativeSelectOption value="">全部客戶</NativeSelectOption><NativeSelectOption value="男性">男性</NativeSelectOption><NativeSelectOption value="女性">女性</NativeSelectOption><NativeSelectOption value="公司法人">公司法人</NativeSelectOption></NativeSelect></Field>
            <Field label="客戶年齡"><div className="range-inputs"><Input placeholder="最低" value={filters.minCustomerAge} onChange={(e) => updateFilter("minCustomerAge", e.target.value)} /><span>至</span><Input placeholder="最高" value={filters.maxCustomerAge} onChange={(e) => updateFilter("maxCustomerAge", e.target.value)} /></div></Field>
            <Field label="會員護照"><NativeSelect value={filters.passportStatus} onChange={(e) => updateFilter("passportStatus", e.target.value)}><NativeSelectOption value="">全部</NativeSelectOption><NativeSelectOption value="has">有會員護照</NativeSelectOption><NativeSelectOption value="none">無會員護照</NativeSelectOption></NativeSelect></Field>
            <Field label="車主授權"><NativeSelect value={filters.authorizationStatus} onChange={(e) => updateFilter("authorizationStatus", e.target.value)}><NativeSelectOption value="">全部</NativeSelectOption><NativeSelectOption value="authorized">已同意使用個資</NativeSelectOption><NativeSelectOption value="notAuthorized">未同意／待確認</NativeSelectOption></NativeSelect></Field>
            <Field label="縣市"><NativeSelect value={filters.county} onChange={(e) => updateCounty(e.target.value)}><NativeSelectOption value="">全部縣市</NativeSelectOption>{metadata?.counties.map((v) => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></Field>
            <Field label="所屬服務廠"><NativeSelect value={filters.branch} onChange={(e) => updateFilter("branch", e.target.value)}><NativeSelectOption value="">全部服務廠</NativeSelectOption>{metadata?.branches.map((v) => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></Field>
            <PeopleFilterField label="業代／銷售人員" listId="sales-representative-options" value={filters.salesRepresentative} options={metadata?.salesRepresentatives || []} onChange={(value) => updatePerson("salesRepresentative", value)} />
            <Field label="近三月最低消費"><Input placeholder="例如 30000" value={filters.minSpend} onChange={(e) => updateFilter("minSpend", e.target.value)} /></Field>
          </>}
          {activeView === "vehicle" && <>
            <Field label="車型"><NativeSelect value={filters.model} onChange={(e) => updateFilter("model", e.target.value)}><NativeSelectOption value="">全部車型</NativeSelectOption>{metadata?.models.map((v) => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></Field>
            <Field label="車齡（年）"><div className="range-inputs"><Input placeholder="最低" value={filters.minVehicleAge} onChange={(e) => updateFilter("minVehicleAge", e.target.value)} /><span>至</span><Input placeholder="最高" value={filters.maxVehicleAge} onChange={(e) => updateFilter("maxVehicleAge", e.target.value)} /></div></Field>
            <Field label="里程（km）"><div className="range-inputs"><Input placeholder="最低" value={filters.minMileage} onChange={(e) => updateFilter("minMileage", e.target.value)} /><span>至</span><Input placeholder="最高" value={filters.maxMileage} onChange={(e) => updateFilter("maxMileage", e.target.value)} /></div></Field>
            <Field label="保固狀態"><NativeSelect value={filters.warranty} onChange={(e) => updateFilter("warranty", e.target.value)}><NativeSelectOption value="">全部狀態</NativeSelectOption><NativeSelectOption value="保固內">保固內</NativeSelectOption><NativeSelectOption value="即將過保">即將過保</NativeSelectOption><NativeSelectOption value="已過保">已過保</NativeSelectOption><NativeSelectOption value="待確認">待確認</NativeSelectOption></NativeSelect></Field>
            <Field label="縣市"><NativeSelect value={filters.county} onChange={(e) => updateCounty(e.target.value)}><NativeSelectOption value="">全部縣市</NativeSelectOption>{metadata?.counties.map((v) => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></Field>
            <Field label="最近服務廠"><NativeSelect value={filters.branch} onChange={(e) => updateFilter("branch", e.target.value)}><NativeSelectOption value="">全部服務廠</NativeSelectOption>{metadata?.branches.map((v) => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></Field>
            <PeopleFilterField label="業代／銷售人員" listId="sales-representative-options" value={filters.salesRepresentative} options={metadata?.salesRepresentatives || []} onChange={(value) => updatePerson("salesRepresentative", value)} />
          </>}
          {activeView === "opportunity" && <>
            <Field label="商機類型"><NativeSelect value={filters.opportunityType} onChange={(e) => selectOpportunityType(e.target.value)}><NativeSelectOption value="">全部商機</NativeSelectOption>{opportunityTypes.map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
            {filters.opportunityType && filters.opportunityType !== "warranty" && filters.opportunityType !== "dormant" && <Field label={`${selectedOpportunityLabel}歷史行為`}><NativeSelect value={filters.opportunityCondition} onChange={(e) => updateFilter("opportunityCondition", e.target.value)}><NativeSelectOption value="">不限行為</NativeSelectOption><NativeSelectOption value="done1y">一年內有做</NativeSelectOption><NativeSelectOption value="notDone1y">一年內未做</NativeSelectOption>{datedOpportunityTypes.has(filters.opportunityType) && <><NativeSelectOption value="ever">曾有更換紀錄</NativeSelectOption><NativeSelectOption value="over1y">最後更換超過一年</NativeSelectOption><NativeSelectOption value="never">從未有更換紀錄</NativeSelectOption></>}</NativeSelect></Field>}
            {filters.opportunityType === "warranty" && <Field label="保固商機"><NativeSelect value={filters.warranty} onChange={(e) => updateFilter("warranty", e.target.value)}><NativeSelectOption value="">系統判定即將過保</NativeSelectOption><NativeSelectOption value="保固內">保固內</NativeSelectOption><NativeSelectOption value="即將過保">即將過保</NativeSelectOption><NativeSelectOption value="已過保">已過保</NativeSelectOption></NativeSelect></Field>}
            {filters.opportunityType === "dormant" && <Field label="至少未回廠天數"><Input placeholder="預設 365" value={filters.minDaysSinceVisit} onChange={(e) => updateFilter("minDaysSinceVisit", e.target.value)} /></Field>}
            {filters.opportunityType && !["warranty", "dormant"].includes(filters.opportunityType) && <Field label="一年內至少次數"><Input placeholder="例如 1" value={filters.minServiceCount} onChange={(e) => updateFilter("minServiceCount", e.target.value)} /></Field>}
            {spendOpportunityTypes.has(filters.opportunityType) && <Field label="一年最低消費"><Input placeholder="例如 5000" value={filters.minServiceSpend} onChange={(e) => updateFilter("minServiceSpend", e.target.value)} /></Field>}
            {datedOpportunityTypes.has(filters.opportunityType) && <Field label="距最後更換至少天數"><Input placeholder="例如 365" value={filters.minDaysSinceService} onChange={(e) => updateFilter("minDaysSinceService", e.target.value)} /></Field>}
            <Field label="車型"><NativeSelect value={filters.model} onChange={(e) => updateFilter("model", e.target.value)}><NativeSelectOption value="">全部車型</NativeSelectOption>{metadata?.models.map((v) => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></Field>
            <Field label="車齡（年）"><div className="range-inputs"><Input placeholder="最低" value={filters.minVehicleAge} onChange={(e) => updateFilter("minVehicleAge", e.target.value)} /><span>至</span><Input placeholder="最高" value={filters.maxVehicleAge} onChange={(e) => updateFilter("maxVehicleAge", e.target.value)} /></div></Field>
            <Field label="里程（km）"><div className="range-inputs"><Input placeholder="最低" value={filters.minMileage} onChange={(e) => updateFilter("minMileage", e.target.value)} /><span>至</span><Input placeholder="最高" value={filters.maxMileage} onChange={(e) => updateFilter("maxMileage", e.target.value)} /></div></Field>
            <Field label="服務廠"><NativeSelect value={filters.branch} onChange={(e) => updateFilter("branch", e.target.value)}><NativeSelectOption value="">全部服務廠</NativeSelectOption>{metadata?.branches.map((v) => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></Field>
            <PeopleFilterField label="業代／銷售人員" listId="sales-representative-options" value={filters.salesRepresentative} options={metadata?.salesRepresentatives || []} onChange={(value) => updatePerson("salesRepresentative", value)} />
            <Field label="建議行動"><NativeSelect value={filters.recommendedAction} onChange={(e) => updateFilter("recommendedAction", e.target.value)}><NativeSelectOption value="">全部建議行動</NativeSelectOption>{recommendedActionDefinitions.map((item) => <NativeSelectOption key={item.action} value={item.action}>{item.action}</NativeSelectOption>)}</NativeSelect></Field>
          </>}
          {activeView === "triangle" && <>
            <Field label="服務廠"><NativeSelect value={filters.branch} onChange={(e) => updateFilter("branch", e.target.value)}><NativeSelectOption value="">全部服務廠</NativeSelectOption>{metadata?.branches.map((v) => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></Field>
            <PeopleFilterField label="服務專員" listId="advisor-options" value={filters.advisor} options={metadata?.advisors || []} onChange={(value) => updatePerson("advisor", value)} />
            <PeopleFilterField label="技師" listId="technician-options" value={filters.technician} options={metadata?.technicians || []} onChange={(value) => updatePerson("technician", value)} />
            <PeopleFilterField label="業代／銷售人員" listId="triangle-sales-representative-options" value={filters.salesRepresentative} options={metadata?.salesRepresentatives || []} onChange={(value) => updatePerson("salesRepresentative", value)} />
            <Field label="縣市"><NativeSelect value={filters.county} onChange={(e) => updateCounty(e.target.value)}><NativeSelectOption value="">全部縣市</NativeSelectOption>{metadata?.counties.map((v) => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></Field>
          </>}
          {activeView === "dashboard" && <>
            <Field label="車型"><NativeSelect value={filters.model} onChange={(e) => updateFilter("model", e.target.value)}><NativeSelectOption value="">全部車型</NativeSelectOption>{metadata?.models.map((v) => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></Field>
            <Field label="縣市"><NativeSelect value={filters.county} onChange={(e) => updateCounty(e.target.value)}><NativeSelectOption value="">全部縣市</NativeSelectOption>{metadata?.counties.map((v) => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></Field>
            <Field label="服務廠"><NativeSelect value={filters.branch} onChange={(e) => updateFilter("branch", e.target.value)}><NativeSelectOption value="">全部服務廠</NativeSelectOption>{metadata?.branches.map((v) => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}</NativeSelect></Field>
            <PeopleFilterField label="業代／銷售人員" listId="sales-representative-options" value={filters.salesRepresentative} options={metadata?.salesRepresentatives || []} onChange={(value) => updatePerson("salesRepresentative", value)} />
            <Field label="保固狀態"><NativeSelect value={filters.warranty} onChange={(e) => updateFilter("warranty", e.target.value)}><NativeSelectOption value="">全部狀態</NativeSelectOption><NativeSelectOption value="保固內">保固內</NativeSelectOption><NativeSelectOption value="即將過保">即將過保</NativeSelectOption><NativeSelectOption value="已過保">已過保</NativeSelectOption><NativeSelectOption value="待確認">待確認</NativeSelectOption></NativeSelect></Field>
            <Field label="車齡（年）"><div className="range-inputs"><Input placeholder="最低" value={filters.minVehicleAge} onChange={(e) => updateFilter("minVehicleAge", e.target.value)} /><span>至</span><Input placeholder="最高" value={filters.maxVehicleAge} onChange={(e) => updateFilter("maxVehicleAge", e.target.value)} /></div></Field>
            <Field label="里程（km）"><div className="range-inputs"><Input placeholder="最低" value={filters.minMileage} onChange={(e) => updateFilter("minMileage", e.target.value)} /><span>至</span><Input placeholder="最高" value={filters.maxMileage} onChange={(e) => updateFilter("maxMileage", e.target.value)} /></div></Field>
            <Field label="至少未回廠天數"><Input placeholder="例如 365" value={filters.minDaysSinceVisit} onChange={(e) => updateFilter("minDaysSinceVisit", e.target.value)} /></Field>
            <Field label="近三月最低消費"><Input placeholder="例如 30000" value={filters.minSpend} onChange={(e) => updateFilter("minSpend", e.target.value)} /></Field>
          </>}
          <Field label="最後進廠日期"><div className="range-inputs date-range-inputs"><Input type="date" aria-label="最後進廠日期起日" value={filters.lastVisitFrom} onInput={(e) => updateFilter("lastVisitFrom", e.currentTarget.value)} /><span>至</span><Input type="date" aria-label="最後進廠日期迄日" value={filters.lastVisitTo} min={filters.lastVisitFrom || undefined} onInput={(e) => updateFilter("lastVisitTo", e.currentTarget.value)} /></div></Field>
        </div>
        {activeFilterEntries.length > 0 && <div className="active-filters" aria-label="目前套用條件"><span>目前條件</span>{activeFilterEntries.map(([key, value]) => <button key={key} type="button" onClick={() => removeFilter(key)} title={`移除「${filterLabels[key]}」條件`}>{filterLabels[key]}{typeof value === "string" && <b>{filterValueLabel(key, value)}</b>}<X /></button>)}</div>}
        <div className="filter-actions"><label className="checkbox-label"><input type="checkbox" checked={filters.excludeDoNotContact} onChange={(e) => updateFilter("excludeDoNotContact", e.target.checked)} />排除勿擾名單</label><div className="query-status" aria-live="polite">{loading && <><LoaderCircle className="animate-spin" />查詢中</>}{loadError && <><ShieldAlert />{loadError}</>}</div><Button variant="ghost" onClick={() => setFilters({ ...emptyFilters })}><RefreshCw />清除條件</Button></div>
      </section>
      {activeView === "opportunity" && filters.opportunityType && <section className="opportunity-rule"><strong>目前商機邏輯：{selectedOpportunityLabel}</strong><span>{filters.opportunityType === "warranty" ? (filters.warranty || "系統判定即將過保") : filters.opportunityType === "dormant" ? `至少 ${filters.minDaysSinceVisit || "365"} 天未回廠` : opportunityConditionLabel}{filters.minServiceSpend ? `，一年消費至少 ${currencyFormatter.format(Number(filters.minServiceSpend))}` : ""}{filters.minDaysSinceService ? `，距最後更換至少 ${numberFormatter.format(Number(filters.minDaysSinceService))} 天` : ""}</span></section>}
      <section className={`dashboard-content ${loading ? "is-loading" : ""}`}>
        <section className="kpi-grid"><KpiCard active={kpiActive("all")} onSelect={() => selectKpi("all")} onExport={() => exportKpi("all")} icon={<CarFront />} label={activeView === "opportunity" ? "商機候選" : "符合車輛"} value={numberFormatter.format(total)} detail={`母體 ${numberFormatter.format(metadata?.recordCount || 0)} 台`} ratio={(metadata?.recordCount || 0) ? total / (metadata?.recordCount || 1) * 100 : 0} /><KpiCard active={kpiActive("contactable")} onSelect={() => selectKpi("contactable")} onExport={() => exportKpi("contactable")} icon={<UsersRound />} label="可聯絡車主" value={numberFormatter.format(metrics.contactable)} detail="有手機、已授權個資、非勿擾" ratio={total ? metrics.contactable / total * 100 : 0} tone="green" /><KpiCard active={kpiActive("expiring")} onSelect={() => selectKpi("expiring")} onExport={() => exportKpi("expiring")} icon={<ShieldAlert />} label="即將過保" value={numberFormatter.format(metrics.expiring)} detail="180 天內或里程 80,000+" ratio={total ? metrics.expiring / total * 100 : 0} tone="amber" /><KpiCard active={kpiActive("dormant")} onSelect={() => selectKpi("dormant")} onExport={() => exportKpi("dormant")} icon={<Wrench />} label="一年未回廠" value={numberFormatter.format(metrics.dormant)} detail="最近回廠超過 365 天" ratio={total ? metrics.dormant / total * 100 : 0} tone="red" /><KpiCard active={kpiActive("spending")} onSelect={() => selectKpi("spending")} onExport={() => exportKpi("spending")} icon={<WalletCards />} label="近三月單台平均" value={currencyFormatter.format(metrics.spendVehicles ? metrics.spend / metrics.spendVehicles : 0)} detail={`以有消費 ${numberFormatter.format(metrics.spendVehicles)} 台計｜全車平均 ${currencyFormatter.format(total ? metrics.spend / total : 0)}`} ratio={total ? metrics.spendVehicles / total * 100 : 0} tone="green" /></section>
        {(activeView === "dashboard" || activeView === "opportunity") && <section className="analytics-grid">
          <Card className="chart-card"><CardContent className="px-5"><div className="section-heading"><div><p className="eyebrow">保固</p><h2>保固狀態分布</h2></div><span>{numberFormatter.format(total)} 台</span></div><div className="distribution-list">{Object.entries(metrics.warranty).map(([label, count]) => { const pct = total ? count / total * 100 : 0; return <button key={label} onClick={() => updateFilter("warranty", filters.warranty === label ? "" : label)} className={`distribution-row ${filters.warranty === label ? "active" : ""}`} aria-pressed={filters.warranty === label}><span className={`legend-dot ${warrantyClass(label)}`} /><span>{label}</span><strong>{numberFormatter.format(count)}</strong><span className="bar-track"><span style={{ width: `${pct}%` }} /></span><small>{pct.toFixed(1)}%</small></button>; })}</div></CardContent></Card>
          <Card className="chart-card"><CardContent className="px-5"><div className="section-heading"><div><p className="eyebrow">里程</p><h2>實際里程分布</h2></div><span>點擊區間篩選，再點一次取消</span></div><div className="mileage-chart">{metrics.mileageBands.map((count, index) => { const [min, max] = mileageRanges[index]; const active = filters.minMileage === min && filters.maxMileage === max; return <button key={mileageLabels[index]} onClick={() => setFilters((f) => ({ ...f, minMileage: active ? "" : min, maxMileage: active ? "" : max }))} className={`mileage-column ${active ? "active" : ""}`} aria-pressed={active}><strong>{numberFormatter.format(count)}</strong><span className="mileage-bar"><span style={{ height: `${Math.max(5, count / maxMileageBand * 100)}%` }} /></span><small>{mileageLabels[index]}</small></button>; })}</div></CardContent></Card>
          <Card className="chart-card service-mix-card"><CardContent className="px-5"><div className="section-heading"><div><p className="eyebrow">服務動能</p><h2>一年服務組合</h2></div><Activity /></div><div className="service-mix-body"><div className="donut-chart" style={{ background: `conic-gradient(${serviceGradient || "#213d62 0 100%"})` }}><div><strong>{numberFormatter.format(serviceMixTotal)}</strong><span>服務觸點</span></div></div><div className="service-legend">{serviceMixEntries.map(([label, count], index) => <div key={label}><span style={{ background: serviceColors[index] }} /><p>{label}<small>{numberFormatter.format(count)} 台</small></p><strong>{(count / serviceMixTotal * 100).toFixed(1)}%</strong></div>)}</div></div></CardContent></Card>
          {activeView === "opportunity" && <Card className="chart-card branch-card"><CardContent className="px-5"><div className="section-heading"><div><p className="eyebrow">行動優先</p><h2>服務廠商機排行</h2></div><Building2 /></div><div className="branch-ranking">{metrics.branchPerformance.slice(0, 6).map((branch, index) => { const actions = branch.dormant + branch.expiring; return <button key={branch.name} onClick={() => updateFilter("branch", branch.name)}><span className="rank-number">{String(index + 1).padStart(2, "0")}</span><div><strong>{branch.name}</strong><small>{numberFormatter.format(branch.vehicles)} 台車 · {currencyFormatter.format(branch.spend)}</small><span className="rank-track"><i style={{ width: `${actions / maxBranchActions * 100}%` }} /></span></div><div className="rank-score"><strong>{numberFormatter.format(actions)}</strong><small>待行動</small></div></button>; })}</div></CardContent></Card>}
        </section>}
        {activeView === "dashboard" && <InsightCharts metrics={{ ...metrics, total }} modelOrder={metadata?.models || []} activeBranch={filters.branch} activeModel={filters.model} onBranch={(branch) => updateFilter("branch", branch)} onModel={(model) => updateFilter("model", model)} />}
        {activeView === "dashboard" && <section className="management-analysis">
          <TaiwanCountyMap distribution={metrics.countyDistribution} activeCounty={filters.county} onSelect={(county) => setFilters((current) => ({ ...current, county, district: "" }))} />
          {filters.county && <DistrictDrilldown county={filters.county} distribution={metrics.districtDistribution} activeDistrict={filters.district} onSelect={(district) => updateFilter("district", district)} />}
          <section className="branch-summary-card"><div className="management-heading"><div><p className="eyebrow">服務廠營運</p><h2>各服務廠行動總表</h2><span>依「久未回廠＋即將過保」待行動數排序；點選服務廠可直接篩選名單，再點一次取消。</span></div>{metrics.branchPerformance.length > branchPreviewCount ? <Button variant="outline" size="sm" className="branch-toggle" onClick={() => setShowAllBranches((v) => !v)}>{showAllBranches ? `只看前 ${branchPreviewCount} 廠` : `顯示全部 ${metrics.branchPerformance.length} 廠`}</Button> : <Building2 />}</div><div className="branch-table-wrap"><table className="branch-table"><thead><tr><th>排名</th><th>服務廠</th><th>管理車輛</th><th>近三月消費</th><th>有消費台數</th><th>有消費台均</th><th>即將過保</th><th>久未回廠</th><th>待行動占比</th></tr></thead><tbody>{visibleBranches.map((branch, index) => { const actions = branch.dormant + branch.expiring; const actionRate = branch.vehicles ? actions / branch.vehicles * 100 : 0; return <tr key={branch.name} className={filters.branch === branch.name ? "active" : ""} onClick={() => updateFilter("branch", filters.branch === branch.name ? "" : branch.name)}><td><span className="table-rank">{String(index + 1).padStart(2, "0")}</span></td><td><strong>{branch.name}</strong></td><td><strong>{numberFormatter.format(branch.vehicles)}</strong><span className="inline-meter"><i style={{ width: `${branch.vehicles / maxBranchVehicles * 100}%` }} /></span></td><td>{currencyFormatter.format(branch.spend)}</td><td><strong>{numberFormatter.format(branch.spendVehicles)}</strong><span className="cell-subtext">消費率 {(branch.vehicles ? branch.spendVehicles / branch.vehicles * 100 : 0).toFixed(1)}%</span></td><td><strong>{currencyFormatter.format(branch.spendVehicles ? branch.spend / branch.spendVehicles : 0)}</strong><span className="cell-subtext">全車台均 {currencyFormatter.format(branch.vehicles ? branch.spend / branch.vehicles : 0)}</span></td><td><span className="metric-warning">{numberFormatter.format(branch.expiring)}</span></td><td><span className="metric-danger">{numberFormatter.format(branch.dormant)}</span></td><td><strong>{actionRate.toFixed(1)}%</strong></td></tr>; })}</tbody></table></div></section>
          <div className="risk-grid"><section className="risk-panel risk-expiring"><div className="risk-heading"><div><p className="eyebrow">保固行動</p><h2>即將過保熱點</h2></div><span>{numberFormatter.format(metrics.expiring)} 台</span></div><p className="risk-description">優先安排保固健檢與未完成維修確認。</p><div className="risk-list">{expiringHotspots.map((branch, index) => <button key={branch.name} onClick={() => { setFilters({ ...emptyFilters, branch: branch.name, warranty: "即將過保" }); }}><span className="risk-index">{index + 1}</span><strong>{branch.name}</strong><span className="risk-bar"><i style={{ width: `${branch.expiring / maxExpiringHotspot * 100}%` }} /></span><b>{numberFormatter.format(branch.expiring)}</b></button>)}</div></section><section className="risk-panel risk-dormant"><div className="risk-heading"><div><p className="eyebrow">流失風險</p><h2>久未回廠熱點</h2></div><span>{numberFormatter.format(metrics.dormant)} 台</span></div><p className="risk-description">優先建立喚回名單並交由原服務專員追蹤。</p><div className="risk-list">{dormantHotspots.map((branch, index) => <button key={branch.name} onClick={() => { setFilters({ ...emptyFilters, branch: branch.name, minDaysSinceVisit: "365" }); }}><span className="risk-index">{index + 1}</span><strong>{branch.name}</strong><span className="risk-bar"><i style={{ width: `${branch.dormant / maxDormantHotspot * 100}%` }} /></span><b>{numberFormatter.format(branch.dormant)}</b></button>)}</div></section></div>
        </section>}
        {activeView === "triangle" && peopleRole === "salesRepresentative" && session && <SalesWorkbench actor={session.actor} onOpenCustomer={setCustomer360} onOpenTasks={() => activateView("tasks")} />}
        {activeView === "triangle" && peopleRole && <PeopleRoster summary={metrics.people ?? null} role={peopleRole} label={peopleRoles.find((item) => item.role === peopleRole)?.label || ""} selected={filters.exactPerson ? filters[peopleRole] : ""} search={peopleSearch} onSearch={setPeopleSearch} sort={peopleSort} onSort={setPeopleSort} onSelect={(name) => selectPerson(peopleRole, name)} />}
        <section className="results-card"><div className="results-header"><div><p className="eyebrow">查詢結果</p><h2>{numberFormatter.format(total)} {resultTitle}</h2></div><div className="results-tools"><span>每頁</span><NativeSelect value={String(pageSize)} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} size="sm"><NativeSelectOption value="25">25</NativeSelectOption><NativeSelectOption value="50">50</NativeSelectOption><NativeSelectOption value="100">100</NativeSelectOption></NativeSelect></div></div>
          <details className="action-definition">
            <summary><span>建議行動定義說明</span><small>依目前資料與規則自動判斷</small></summary>
            <div className="action-definition-body"><p>系統由上而下套用規則；同時符合多項時，只顯示優先順序最高的一項。這是規則型建議，不是 AI 預測機率。</p><ol>{recommendedActionDefinitions.map((item, index) => <li key={item.action}><span>{index + 1}</span><div><strong>{item.action}</strong><small>{item.trigger}</small></div></li>)}</ol></div>
          </details>
          <Table>
            <TableHeader><TableRow><SortableHead parts={[{ label: "識別碼", key: "code" }, { label: "車型" }]} sort={sort} onSort={toggleSort} /><TableHead>客戶屬性／聯絡</TableHead><TableHead>地區</TableHead><SortableHead parts={[{ label: "車齡", key: "vehicleAge" }, { label: "里程", key: "mileage" }]} sort={sort} onSort={toggleSort} /><SortableHead parts={[{ label: "最近回廠", key: "daysSinceVisit" }]} sort={sort} onSort={toggleSort} /><TableHead>{activeView === "triangle" ? "服務金三角" : "服務廠／專員"}</TableHead><SortableHead parts={[{ label: "保固", key: "warrantyDaysLeft" }]} sort={sort} onSort={toggleSort} /><SortableHead parts={[{ label: "消費", key: "spend3m" }, { label: "護照" }]} sort={sort} onSort={toggleSort} /><TableHead className="min-w-[240px]">建議行動</TableHead><TableHead>內容</TableHead></TableRow></TableHeader>
            <TableBody>{records.length ? records.map((v) => <TableRow key={v.id}>
              <TableCell><strong className="plate-number">{v.code}</strong><span className="cell-subtext">{v.model || "車型待確認"}</span></TableCell>
              <TableCell><strong>{v.gender || "類型待確認"}{v.customerAge !== null ? `・${v.customerAge} 歲` : ""}</strong><ContactChannels vehicle={v} /></TableCell>
              <TableCell><span className="location-cell"><MapPin />{v.county || "—"}{v.district ? ` ${v.district}` : ""}</span></TableCell>
              <TableCell><strong>{v.vehicleAge === null ? "—" : `${v.vehicleAge} 年`}</strong><span className="cell-subtext">{v.mileage === null ? "里程待確認" : `${numberFormatter.format(v.mileage)} km`}</span></TableCell>
              <TableCell><strong>{v.lastVisit || "—"}</strong><span className="cell-subtext">{v.daysSinceVisit === null ? "天數待確認" : `${numberFormatter.format(v.daysSinceVisit)} 天前`}</span></TableCell>
              <TableCell><strong>{v.branch || "—"}</strong><span className="cell-subtext">服務專員：{v.advisor || "未指派"}</span>{activeView === "triangle" && <><span className="cell-subtext">技師：{v.technician || "未指派"}</span><span className="cell-subtext triangle-sales">業代：{v.salesRepresentative || "未指派"}</span></>}</TableCell>
              <TableCell><span className={`status-pill ${warrantyClass(v.warrantyStatus)}`}>{v.warrantyStatus}</span><span className="cell-subtext">{v.warrantyExpiry || "到期日待確認"}</span></TableCell>
              <TableCell><strong>{v.spend3m === null ? "—" : currencyFormatter.format(v.spend3m)}</strong><span className="cell-subtext">美容 {currencyFormatter.format(v.beautySpend1y ?? 0)}／年</span><span className="cell-subtext">護照：{v.memberPassport || "—"}</span></TableCell>
              <TableCell><span className="action-text">{v.nextBestAction}</span>{v.doNotContact && <span className="dnc-label">勿擾</span>}</TableCell>
              <TableCell><Button variant="outline" size="sm" className="detail-button" onClick={() => setCustomer360(v.code)}><Eye />客戶 360</Button><button className="crm-link" onClick={() => setSelectedVehicle(v)}>服務彙總</button></TableCell>
            </TableRow>) : <TableRow><TableCell colSpan={10} className="empty-results">{loading ? "正在取得資料…" : "沒有符合條件的資料，請調整篩選條件。"}</TableCell></TableRow>}</TableBody>
          </Table>
          <div className="pagination-bar"><span>第 {page}／{totalPages} 頁</span><div><Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => setPage((v) => Math.max(1, v - 1))}><ChevronLeft />上一頁</Button><Button variant="outline" size="sm" disabled={loading || page >= totalPages} onClick={() => setPage((v) => Math.min(totalPages, v + 1))}>下一頁<ChevronRight /></Button></div></div>
        </section>
      </section>
      </>}
      {crmViews.has(activeView) && (!session ? (sessionError ? null : <Loading label="確認登入身分…" />)
        : activeView === "segments" ? <SegmentsView onOpenCustomer={setCustomer360} onGoImport={() => activateView("admin")} canManage={["company_manager", "branch_manager"].includes(session.actor.role)} />
        : activeView === "opps" ? <OpportunitiesView onOpenCustomer={setCustomer360} />
        : activeView === "tasks" ? <TasksView onOpenCustomer={setCustomer360} canManage={["company_manager", "branch_manager"].includes(session.actor.role)} />
        : activeView === "performance" ? <PerformanceView onOpenCustomer={setCustomer360} units={units} />
        : <AdminView session={session} onSessionChange={() => setSessionVersion((v) => v + 1)} />)}
    </main>
    <Customer360Drawer code={customer360} onClose={() => setCustomer360(null)} onOpenCustomer={setCustomer360} onGoImport={() => { setCustomer360(null); activateView("admin"); }} />
    <Sheet open={selectedVehicle !== null} onOpenChange={(open) => { if (!open) setSelectedVehicle(null); }}>
      <SheetContent className="detail-sheet">
        {selectedVehicle && <>
          <SheetHeader className="detail-sheet-header"><div><p className="eyebrow">CUSTOMER 360 · VEHICLE 360</p><SheetTitle>客戶與車籍完整資料</SheetTitle><SheetDescription>資料基準 {metadata?.asOf || "—"}｜{selectedVehicle.branch || "服務廠待確認"}</SheetDescription></div><span className={`status-pill ${warrantyClass(selectedVehicle.warrantyStatus)}`}>{selectedVehicle.warrantyStatus}</span></SheetHeader>
          <div className="detail-sheet-body">
            <section className="identity-grid"><article className="identity-card owner-card"><div className="identity-card-title"><h3>車主屬性（去識別化）</h3><span>識別碼</span></div><div className="identity-profile"><div className="profile-avatar"><UsersRound /></div><div><h2 className="code-heading">{selectedVehicle.code}<button type="button" className="copy-code" onClick={() => copyCode(selectedVehicle.code)}><Copy />{copiedCode === selectedVehicle.code ? "已複製" : "複製"}</button></h2><p>{selectedVehicle.gender || "身分類型待確認"}｜{selectedVehicle.county || "地區待確認"}{selectedVehicle.district ? ` ${selectedVehicle.district}` : ""}</p></div></div><dl className="identity-list"><div><dt>聯絡管道</dt><dd><ContactChannels vehicle={selectedVehicle} /></dd></div><div><dt>車主年齡</dt><dd>{selectedVehicle.customerAge === null ? "—" : `${selectedVehicle.customerAge} 歲`}</dd></div><div><dt>會員護照</dt><dd>{selectedVehicle.memberPassport || "—"}</dd></div><div><dt>個資授權</dt><dd><span className={selectedVehicle.ownerAuthorization.includes("同意") ? "consent-badge" : "neutral-badge"}>{selectedVehicle.ownerAuthorization || selectedVehicle.contactAuthorized || "待確認"}</span></dd></div><div><dt>勿擾</dt><dd>{selectedVehicle.doNotContact ? "是（暫停聯絡）" : "否"}</dd></div><div><dt>個資查詢</dt><dd>以識別碼至地端資料比對</dd></div></dl></article><article className="identity-card vehicle-card"><div className="identity-card-title"><h3>車輛基本資料</h3><span>{selectedVehicle.model || "車型待確認"}</span></div><div className="identity-profile"><div className="profile-avatar vehicle-avatar"><CarFront /></div><div><h2>{selectedVehicle.model || "車型待確認"}</h2><p>{selectedVehicle.modelCode || "車型代碼待確認"}｜車齡 {selectedVehicle.vehicleAge === null ? "—" : `${selectedVehicle.vehicleAge} 年`}</p></div></div><dl className="identity-list"><div><dt>車型代碼</dt><dd>{selectedVehicle.modelCode || "—"}</dd></div><div><dt>領牌日</dt><dd>{selectedVehicle.registrationDate || "—"}</dd></div><div><dt>最後有效里程</dt><dd>{selectedVehicle.mileage === null ? "—" : `${numberFormatter.format(selectedVehicle.mileage)} km`}</dd></div><div><dt>系統保固狀態</dt><dd><span className={`status-pill ${warrantyClass(selectedVehicle.warrantyStatus)}`}>{selectedVehicle.warrantyStatus}</span></dd></div><div><dt>保固到期日</dt><dd>{selectedVehicle.warrantyExpiry || "—"}</dd></div><div><dt>服務廠／服務專員</dt><dd>{selectedVehicle.branch || "—"}｜{selectedVehicle.advisor || "未指派"}</dd></div><div><dt>指定技師</dt><dd>{selectedVehicle.technician || "未指派"}</dd></div></dl></article></section>
            <section className="detail-section"><h3>消費與回廠</h3><div className="detail-grid"><DetailItem label="近三個月消費" value={currencyFormatter.format(selectedVehicle.spend3m ?? 0)} /><DetailItem label="一年定保次數" value={`${numberFormatter.format(selectedVehicle.maintenanceCount1y ?? 0)} 次`} /><DetailItem label="回廠類別" value={selectedVehicle.returnCategory} /><DetailItem label="定保頻率" value={selectedVehicle.maintenanceFrequency} /><DetailItem label="服務廠" value={selectedVehicle.branch} /><DetailItem label="服務專員／技師" value={`${selectedVehicle.advisor || "未指派"}／${selectedVehicle.technician || "未指派"}`} /></div></section>
            <section className="detail-section"><div className="detail-section-title"><h3>美容消費</h3><span>一年內</span></div><div className="detail-grid detail-summary"><DetailItem label="美容總消費" value={currencyFormatter.format(selectedVehicle.beautySpend1y ?? 0)} /><DetailItem label="美容高消費" value={selectedVehicle.beautyHighSpend} /><DetailItem label="假美容消費（原始分類）" value={currencyFormatter.format(selectedVehicle.fakeBeautySpend1y ?? 0)} /></div><div className="service-grid"><ServiceMetric label="前擋鍍膜" count={selectedVehicle.windshieldCoatingCount1y} spend={selectedVehicle.windshieldCoatingSpend1y} /><ServiceMetric label="車身打蠟" count={selectedVehicle.waxCount1y} spend={selectedVehicle.waxSpend1y} /><ServiceMetric label="車身美容" count={selectedVehicle.bodyBeautyCount1y} spend={selectedVehicle.bodyBeautySpend1y} /><ServiceMetric label="內裝清洗" count={selectedVehicle.interiorCleaningCount1y} spend={selectedVehicle.interiorCleaningSpend1y} /><ServiceMetric label="車身鍍膜" count={selectedVehicle.bodyCoatingCount1y} spend={selectedVehicle.bodyCoatingSpend1y} /></div></section>
            <section className="detail-section"><div className="detail-section-title"><h3>耗材更換</h3><span>一年次數／最後更換日</span></div><div className="service-grid"><ServiceMetric label={`輪胎 · ${selectedVehicle.tireLastChanged || "無日期"}`} count={selectedVehicle.tireChanges1y} /><ServiceMetric label={`電瓶 · ${selectedVehicle.batteryLastChanged || "無日期"}`} count={selectedVehicle.batteryChanges1y} /><ServiceMetric label={`空氣芯 · ${selectedVehicle.airFilterLastChanged || "無日期"}`} count={selectedVehicle.airFilterChanges1y} /><ServiceMetric label={`空調濾網 · ${selectedVehicle.cabinFilterLastChanged || "無日期"}`} count={selectedVehicle.cabinFilterChanges1y} /><ServiceMetric label={`雨刷 · ${selectedVehicle.wiperLastChanged || "無日期"}`} count={selectedVehicle.wiperChanges1y} /><ServiceMetric label={`來令片 · ${selectedVehicle.brakePadLastChanged || "無日期"}`} count={selectedVehicle.brakePadChanges1y} /><ServiceMetric label={`皮帶 · ${selectedVehicle.beltLastChanged || "無日期"}`} count={selectedVehicle.beltChanges1y} /><ServiceMetric label={`火星塞 · ${selectedVehicle.sparkPlugLastChanged || "無日期"}`} count={selectedVehicle.sparkPlugChanges1y} /></div></section>
            <section className="detail-section"><h3>保固與建議</h3><div className="detail-grid"><DetailItem label="保固狀態" value={selectedVehicle.warrantyStatus} /><DetailItem label="保固到期" value={selectedVehicle.warrantyExpiry} /><DetailItem label="剩餘里程" value={selectedVehicle.warrantyKmLeft === null ? "待確認" : `${numberFormatter.format(selectedVehicle.warrantyKmLeft)} km`} /><DetailItem label="建議行動" value={selectedVehicle.nextBestAction} /></div></section>
          </div>
        </>}
      </SheetContent>
    </Sheet>
  </div>;
}
