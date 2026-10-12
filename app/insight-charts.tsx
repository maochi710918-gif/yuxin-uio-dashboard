"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type WarrantyRow = { name: string; vehicles: number; 保固內: number; 即將過保: number; 已過保: number; 待確認: number };

export type InsightMetrics = {
  total: number;
  spendVehicles: number;
  contactable: number;
  visitMonths: { month: string; vehicles: number }[];
  latestVisit: string;
  visitWeekdays: number[];
  modelMix: { name: string; vehicles: number }[];
  branchWarranty: WarrantyRow[];
  branchWarrantyTotal?: WarrantyRow;
};

// Categorical order validated for the dark surface (scripts/validate_palette.js, worst adjacent CVD ΔE 13.7).
const seriesColors = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)"];
const warrantyStatus = [
  { key: "保固內", color: "var(--status-good)" },
  { key: "即將過保", color: "var(--status-warning)" },
  { key: "已過保", color: "var(--status-critical)" },
  { key: "待確認", color: "var(--status-neutral)" },
] as const;
const weekdayLabels = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];
const fmt = new Intl.NumberFormat("zh-TW");

type TipRow = { label: string; value: string; color?: string };
function TipBox({ title, rows }: { title: string; rows: TipRow[] }) {
  return <div className="viz-tooltip"><strong>{title}</strong>{rows.map((row) => <div key={row.label}>{row.color && <i style={{ background: row.color }} />}<span>{row.label}</span><b>{row.value}</b></div>)}</div>;
}

function Gauge({ label, value, total, detail }: { label: string; value: number; total: number; detail: string }) {
  const ratio = total ? Math.min(1, value / total) : 0;
  const r = 70, cx = 90, cy = 86, end = Math.PI * (1 - ratio);
  const x = cx + r * Math.cos(end), y = cy - r * Math.sin(end);
  return <figure className="gauge" title={`${label} ${(ratio * 100).toFixed(1)}%（${fmt.format(value)}／${fmt.format(total)} 台）`}>
    <svg viewBox="0 0 180 100" role="img" aria-label={`${label} ${(ratio * 100).toFixed(1)}%`}>
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} className="gauge-track" />
      {ratio > 0 && <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`} className="gauge-fill" />}
      <text x={cx} y={cy - 14} textAnchor="middle" className="gauge-value">{(ratio * 100).toFixed(1)}%</text>
      <text x={cx - r} y={cy + 13} textAnchor="middle" className="gauge-scale">0%</text>
      <text x={cx + r} y={cy + 13} textAnchor="middle" className="gauge-scale">100%</text>
    </svg>
    <figcaption><strong>{label}</strong><span>{detail}</span></figcaption>
  </figure>;
}

function WarrantyRowView({ row, label, total, active, dimmed, onClick }: { row: WarrantyRow; label: string; total?: boolean; active?: boolean; dimmed?: boolean; onClick?: () => void }) {
  const share = (key: (typeof warrantyStatus)[number]["key"]) => (row.vehicles ? (row[key] / row.vehicles) * 100 : 0);
  const title = `${row.name}｜${fmt.format(row.vehicles)} 台\n${warrantyStatus.map((item) => `${item.key} ${fmt.format(row[item.key])} 台（${share(item.key).toFixed(1)}%）`).join("\n")}`;
  const Tag = onClick ? "button" : "div";
  return <Tag type={onClick ? "button" : undefined} className={`wtable-row ${total ? "is-total" : ""} ${active ? "is-active" : ""} ${dimmed ? "is-dimmed" : ""}`} onClick={onClick} title={title} aria-pressed={onClick ? Boolean(active) : undefined}>
    <span className="wt-name">{label}</span>
    <span className="wt-count">{fmt.format(row.vehicles)}</span>
    <span className="wt-stack" aria-hidden="true">{warrantyStatus.map((item) => share(item.key) > 0 ? <i key={item.key} style={{ width: `${share(item.key)}%`, background: item.color }} /> : null)}</span>
    <span className="wt-pct wt-good">{share("保固內").toFixed(0)}%</span>
    <span className="wt-pct wt-warn"><b>{fmt.format(row.即將過保)}</b><small>{share("即將過保").toFixed(1)}%</small></span>
    <span className="wt-pct wt-bad">{share("已過保").toFixed(0)}%</span>
  </Tag>;
}

export function InsightCharts({ metrics, modelOrder, activeBranch, activeModel, onBranch, onModel }: { metrics: InsightMetrics; modelOrder: string[]; activeBranch: string; activeModel: string; onBranch: (branch: string) => void; onModel: (model: string) => void }) {
  const months = metrics.visitMonths.map((item) => ({ ...item, label: `${Number(item.month.slice(5))}月` }));
  const peakMonth = months.reduce((best, item) => (item.vehicles > (best?.vehicles ?? -1) ? item : best), months[0]);
  const weekdays = metrics.visitWeekdays.map((vehicles, index) => ({ label: weekdayLabels[index], vehicles }));
  const weekdayTotal = Math.max(1, weekdays.reduce((sum, item) => sum + item.vehicles, 0));
  const peakWeekday = Math.max(...metrics.visitWeekdays);
  const modelTotal = Math.max(1, metrics.modelMix.reduce((sum, item) => sum + item.vehicles, 0));
  // Color follows the model, not its rank in the current filter: slots come from the global model order.
  const modelColor = (name: string) => { const slot = modelOrder.indexOf(name); return slot >= 0 && slot < seriesColors.length ? seriesColors[slot] : "var(--viz-other)"; };
  const branchRows = metrics.branchWarranty.map((branch) => ({ ...branch, short: branch.name.replace(/廠$/, "") }));

  return <section className="insight-grid">
    <article className="viz-card viz-trend">
      <header><p className="eyebrow">回廠趨勢</p><h2>最後回廠月份分布</h2><span>每台車以最近一次回廠計｜資料最後工單日 {metrics.latestVisit || "—"}</span></header>
      <div className="viz-body"><ResponsiveContainer width="100%" height={220}>
        <AreaChart data={months} margin={{ top: 22, right: 12, left: 0, bottom: 0 }}>
          <defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--viz-1)" stopOpacity={0.45} /><stop offset="100%" stopColor="var(--viz-1)" stopOpacity={0.02} /></linearGradient></defs>
          <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--viz-axis)", fontSize: 12 }} />
          <YAxis width={44} tickLine={false} axisLine={false} tick={{ fill: "var(--viz-axis)", fontSize: 11 }} tickFormatter={(value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value)} />
          <Tooltip cursor={{ stroke: "var(--viz-axis)", strokeDasharray: "3 3" }} content={({ active, payload }) => active && payload?.length ? <TipBox title={String(payload[0].payload.month)} rows={[{ label: "最後回廠", value: `${fmt.format(Number(payload[0].value))} 台`, color: "var(--viz-1)" }]} /> : null} />
          <Area isAnimationActive={false} type="monotone" dataKey="vehicles" stroke="var(--viz-1)" strokeWidth={2} fill="url(#trendFill)" dot={{ r: 3, fill: "var(--viz-1)", stroke: "var(--viz-surface)", strokeWidth: 2 }} activeDot={{ r: 5, stroke: "var(--viz-surface)", strokeWidth: 2 }}>
            <LabelList dataKey="vehicles" content={({ x, y, value, index }) => months[Number(index)] === peakMonth ? <text x={Number(x)} y={Number(y) - 10} textAnchor="middle" className="viz-direct-label">{fmt.format(Number(value))}</text> : null} />
          </Area>
        </AreaChart>
      </ResponsiveContainer></div>
    </article>

    <article className="viz-card viz-weekday">
      <header><p className="eyebrow">回廠節奏</p><h2>最後回廠星期分布</h2><span>金色為尖峰日，供邀約與排班參考</span></header>
      <div className="viz-body"><ResponsiveContainer width="100%" height={220}>
        <BarChart data={weekdays} margin={{ top: 22, right: 6, left: 6, bottom: 0 }} barCategoryGap="22%">
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--viz-axis)", fontSize: 12 }} />
          <YAxis hide />
          <Tooltip cursor={{ fill: "var(--viz-hover)" }} content={({ active, payload }) => active && payload?.length ? <TipBox title={String(payload[0].payload.label)} rows={[{ label: "車輛", value: `${fmt.format(Number(payload[0].value))} 台` }, { label: "占比", value: `${(Number(payload[0].value) / weekdayTotal * 100).toFixed(1)}%` }]} /> : null} />
          <Bar isAnimationActive={false} dataKey="vehicles" radius={[4, 4, 0, 0]}>
            {weekdays.map((item) => <Cell key={item.label} fill={item.vehicles === peakWeekday ? "var(--viz-2)" : "var(--viz-1)"} />)}
            <LabelList dataKey="vehicles" position="top" className="viz-direct-label" formatter={(value: unknown) => `${(Number(value) / weekdayTotal * 100).toFixed(0)}%`} />
          </Bar>
        </BarChart>
      </ResponsiveContainer></div>
    </article>

    <article className="viz-card viz-gauges">
      <header><p className="eyebrow">經營儀表</p><h2>消費與聯絡覆蓋</h2><span>目前篩選車輛的比例</span></header>
      <div className="gauge-pair">
        <Gauge label="近三月有消費" value={metrics.spendVehicles} total={metrics.total} detail={`${fmt.format(metrics.spendVehicles)} 台`} />
        <Gauge label="可聯絡車主" value={metrics.contactable} total={metrics.total} detail={`${fmt.format(metrics.contactable)} 台`} />
      </div>
    </article>

    <article className="viz-card viz-models">
      <header><p className="eyebrow">車型</p><h2>車型系列占比</h2><span>點選車型可篩選名單</span></header>
      <div className="model-mix">
        <div className="model-donut"><ResponsiveContainer width="100%" height={190}>
          <PieChart>
            <Tooltip content={({ active, payload }) => active && payload?.length ? <TipBox title={String(payload[0].name)} rows={[{ label: "車輛", value: `${fmt.format(Number(payload[0].value))} 台` }, { label: "占比", value: `${(Number(payload[0].value) / modelTotal * 100).toFixed(1)}%` }]} /> : null} />
            <Pie isAnimationActive={false} data={metrics.modelMix} dataKey="vehicles" nameKey="name" innerRadius="62%" outerRadius="92%" paddingAngle={1.5} stroke="var(--viz-surface)" strokeWidth={2} cursor="pointer" onClick={(data: { name?: string }) => data.name && data.name !== "其他" && onModel(activeModel === data.name ? "" : data.name)}>
              {metrics.modelMix.map((item) => <Cell key={item.name} fill={modelColor(item.name)} fillOpacity={!activeModel || activeModel === item.name ? 1 : 0.35} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer><div className="model-donut-center"><strong>{fmt.format(modelTotal)}</strong><span>台</span></div></div>
        <ul className="model-legend">{metrics.modelMix.map((item) => <li key={item.name}><button type="button" disabled={item.name === "其他"} className={activeModel === item.name ? "active" : ""} onClick={() => onModel(activeModel === item.name ? "" : item.name)}><i style={{ background: modelColor(item.name) }} /><span>{item.name}</span><b>{(item.vehicles / modelTotal * 100).toFixed(1)}%</b><small>{fmt.format(item.vehicles)}</small></button></li>)}</ul>
      </div>
    </article>

    <article className="viz-card viz-branch-warranty">
      <header className="viz-head-row"><div><p className="eyebrow">服務廠 × 保固</p><h2>裕信全體與各服務廠保固結構</h2><span>比例以各廠自身車輛數計算；點選服務廠可篩選名單，再點一次取消</span></div></header>
      <div className="wb-legend">{warrantyStatus.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.key}</span>)}</div>
      <div className="wtable" aria-label="各服務廠保固結構">
        {metrics.branchWarrantyTotal && <WarrantyRowView row={metrics.branchWarrantyTotal} label="裕信全體" total />}
        <div className="wtable-body">{[0, 1].map((column) => <div key={column} className={`wtable-head ${column ? "is-second" : ""}`} aria-hidden="true"><span>據點</span><span>車輛</span><span>保固結構</span><span>保固內</span><span>即將過保</span><span>已過保</span></div>)}{branchRows.map((row) => <WarrantyRowView key={row.name} row={row} label={row.short} active={activeBranch === row.name} dimmed={Boolean(activeBranch) && activeBranch !== row.name} onClick={() => onBranch(activeBranch === row.name ? "" : row.name)} />)}</div>
      </div>
    </article>

  </section>;
}
