"use client";
// API payloads from /api/crm/* are rendered as loosely typed records; the server is the source of truth for their shape.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { Info } from "lucide-react";
import { apiGet, fmtMoney, fmtNumber, fmtPct } from "./api";
import { StaffPicker } from "./customer-360";
import { Async, Badge, CodeLink, Drawer, Empty, Panel, useApi } from "./ui";

type Metric = { key: string; label: string; notConnected?: boolean; value: number | null; numerator?: number | null; denominator?: number | null; unit: string; definition: string; denominatorLabel?: string; dateBasis: string; source: string; drill?: string };

function MetricTile({ metric, onDrill }: { metric: Metric; onDrill: (key: string, label: string) => void }) {
  const [open, setOpen] = useState(false);
  const value = metric.notConnected ? "尚未串接" : metric.value === null ? "資料不足" : metric.unit === "%" ? fmtPct(metric.value) : metric.unit === "元" ? fmtMoney(metric.value) : `${fmtNumber(metric.value)}${["筆", "小時", "分"].includes(metric.unit) ? ` ${metric.unit}` : ""}`;
  return <article className="perf-metric">
    <header><span>{metric.label}</span><button className="crm-icon-btn" onClick={() => setOpen(!open)} aria-label={`${metric.label} 定義`}><Info /></button></header>
    <strong>{value}</strong>
    {metric.denominator !== undefined && metric.denominator !== null && <small>{fmtNumber(metric.numerator ?? 0)} ／ {fmtNumber(metric.denominator)} {metric.denominatorLabel ?? ""}</small>}
    {open && <dl><div><dt>定義</dt><dd>{metric.definition}</dd></div>{metric.denominatorLabel && <div><dt>分母</dt><dd>{metric.denominatorLabel}</dd></div>}<div><dt>日期口徑</dt><dd>{metric.dateBasis}</dd></div><div><dt>來源</dt><dd>{metric.source}</dd></div></dl>}
    {metric.drill && <button className="crm-link" onClick={() => onDrill(metric.drill!, metric.label)}>查看編碼明細</button>}
  </article>;
}

export function PerformanceView({ onOpenCustomer, units }: { onOpenCustomer: (code: string) => void; units: { unit_code: string; name: string }[] }) {
  const [filters, setFilters] = useState({ unit: "", staff: "", month: "", origin: "" });
  const [drill, setDrill] = useState<{ key: string; label: string } | null>(null);
  const state = useApi(() => apiGet<any>("/api/crm/metrics", filters), [JSON.stringify(filters)]);
  return <div className="crm-stack">
    <Panel title="主管儀表板與診斷" eyebrow="目前分析範圍會套用到所有指標與下鑽明細" actions={<>
      <select value={filters.unit} onChange={(event) => setFilters({ ...filters, unit: event.target.value })} aria-label="據點"><option value="">全部據點</option>{units.map((unit) => <option key={unit.unit_code} value={unit.unit_code}>{unit.name}</option>)}</select>
      <span className="crm-inline"><StaffPicker value={filters.staff} onChange={(staff) => setFilters({ ...filters, staff })} /></span>
      <input type="month" value={filters.month ? `${filters.month.slice(0, 4)}-${filters.month.slice(5, 7)}` : ""} onChange={(event) => setFilters({ ...filters, month: event.target.value })} aria-label="分派月份" />
      <select value={filters.origin} onChange={(event) => setFilters({ ...filters, origin: event.target.value })} aria-label="商機來源"><option value="">全部商機來源</option>{["手動", "自動化規則", "售後轉介", "匯入"].map((item) => <option key={item}>{item}</option>)}</select>
    </>}>
      <Async state={state}>{(d) => <div className="crm-stack">
        <div className="perf-scope"><Badge tone="info">資料基準日 {d.asOf}</Badge><Badge>今天 {d.today}</Badge>{Object.entries(d.filters).filter(([, value]) => value).map(([key, value]) => <Badge key={key}>{({ unit: "據點", staff: "人員", month: "分派月份", origin: "商機來源" } as Record<string, string>)[key] ?? key}：{String(value)}</Badge>)}</div>
        {Object.entries(d.metrics as Record<string, Metric[]>).map(([group, metrics]) => <section key={group} className="perf-group"><h3>{group}</h3><div className="perf-grid">{metrics.map((metric) => <MetricTile key={metric.key} metric={metric} onDrill={(key, label) => setDrill({ key, label })} />)}</div></section>)}
        <section className="perf-group"><h3>診斷</h3>{d.findings.length ? <div className="perf-findings">{d.findings.map((finding: any) => <article key={finding.title}><strong>{finding.title}</strong><dl><div><dt>事實</dt><dd>{finding.fact}</dd></div><div><dt>推論</dt><dd>{finding.inference}</dd></div><div><dt>建議</dt><dd>{finding.suggestion}</dd></div></dl></article>)}</div> : <Empty label="目前沒有需要注意的事項" />}</section>
        <ul className="perf-notes">{d.notes.map((note: string) => <li key={note}>{note}</li>)}</ul>
      </div>}</Async>
    </Panel>
    <Async state={state}>{(d) => <div className="crm-two">
      <Panel title="營運結果（依交易發生月份）" eyebrow="交易金額與毛利；毛利僅含有成本資料的交易">
        {d.monthly.length ? <table className="crm-table"><thead><tr><th>月份</th><th>交易筆數</th><th>車輛數</th><th>金額</th><th>毛利</th></tr></thead><tbody>{d.monthly.map((row: any) => <tr key={row.month}><td>{row.month}</td><td>{fmtNumber(row.txns)}</td><td>{fmtNumber(row.vehicles)}</td><td>{fmtMoney(row.revenue)}</td><td>{row.margin === null ? "資料不足" : fmtMoney(row.margin)}</td></tr>)}</tbody></table> : <Empty label="尚無交易資料" />}
      </Panel>
      <Panel title="單位與人員差異" eyebrow="依任務分派月份；逾期與「已下載未回傳」優先">
        {d.byOwner.length ? <table className="crm-table"><thead><tr><th>單位</th><th>人員</th><th>分派</th><th>完成</th><th>逾期</th><th>下載未回傳</th></tr></thead><tbody>{d.byOwner.map((row: any) => <tr key={`${row.unit_code}${row.staff_code}`}><td>{row.unit_name ?? row.unit_code ?? "—"}</td><td>{row.staff_name ?? row.staff_code ?? "未指派"}</td><td>{fmtNumber(row.assigned)}</td><td>{fmtNumber(row.completed)}<small className="crm-sub">{row.assigned ? `${(row.completed / row.assigned * 100).toFixed(0)}%` : ""}</small></td><td>{row.overdue ? <Badge tone="bad">{row.overdue}</Badge> : 0}</td><td>{row.exported_not_returned ? <Badge tone="warn">{row.exported_not_returned}</Badge> : 0}</td></tr>)}</tbody></table> : <Empty label="尚無任務" />}
      </Panel>
    </div>}</Async>
    <Async state={state}>{(d) => <div className="crm-two">
      <Panel title="活動成效" eyebrow="關聯成效（無對照組，不代表新增收益）">
        {d.campaigns.length ? <table className="crm-table"><thead><tr><th>活動</th><th>入選</th><th>任務</th><th>完成</th><th>成本</th><th>成交營收</th></tr></thead><tbody>{d.campaigns.map((row: any) => <tr key={row.campaign_code}><td>{row.name}<small className="crm-sub">{row.campaign_code}</small></td><td>{fmtNumber(row.members)}</td><td>{fmtNumber(row.tasks)}</td><td>{fmtNumber(row.completed)}</td><td>{row.cost === null ? "資料不足" : fmtMoney(row.cost)}</td><td>{row.attributed_revenue === null ? "—" : fmtMoney(row.attributed_revenue)}</td></tr>)}</tbody></table> : <Empty label="尚未建立活動" />}
      </Panel>
      <Panel title="資料來源與更新狀態">
        <table className="crm-table"><thead><tr><th>來源</th><th>資料</th><th>優先</th><th>狀態</th><th>最後匯入</th></tr></thead><tbody>{d.sources.map((row: any) => <tr key={row.source_code}><td>{row.name}<small className="crm-sub">{row.source_code}</small></td><td>{row.entity}</td><td>{row.priority}</td><td><Badge tone={row.status === "已串接" ? "good" : "muted"}>{row.status}</Badge></td><td><small>{row.last_imported_at?.slice(0, 16).replace("T", " ") ?? "—"}<br />{row.last_batch_code ?? ""}</small></td></tr>)}</tbody></table>
      </Panel>
    </div>}</Async>
    <Drawer open={Boolean(drill)} title={<>下鑽明細 <span className="crm-muted">｜{drill?.label}</span></>} onClose={() => setDrill(null)} wide>{drill && <DrillTable drillKey={drill.key} filters={filters} onOpenCustomer={onOpenCustomer} />}</Drawer>
  </div>;
}

function DrillTable({ drillKey, filters, onOpenCustomer }: { drillKey: string; filters: Record<string, string>; onOpenCustomer: (code: string) => void }) {
  const state = useApi(() => apiGet<{ rows: Record<string, unknown>[] }>("/api/crm/metrics", { ...filters, drill: drillKey }), [drillKey, JSON.stringify(filters)]);
  return <Async state={state}>{(d) => d.rows.length ? <><p className="crm-muted">顯示 {d.rows.length} 筆（上限 500）；與上方彙總使用相同條件。</p><table className="crm-table"><thead><tr>{Object.keys(d.rows[0]).map((key) => <th key={key}>{key}</th>)}</tr></thead><tbody>{d.rows.map((row, index) => <tr key={index}>{Object.entries(row).map(([key, value]) => <td key={key}>{key === "customer_code" ? <CodeLink code={String(value)} onOpen={onOpenCustomer} /> : String(value ?? "—")}</td>)}</tr>)}</tbody></table></> : <Empty />}</Async>;
}
