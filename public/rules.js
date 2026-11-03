// Raghav Kulkarni's documented forecasting rules (covers ~80–85% of decisions).
// Pure functions only: no DOM, no fs — the same module runs in the browser, the server and tests.

export const DEFAULT_RULES = {
  shortWindow: 4,               // "last 4 weeks"
  longWindow: 12,               // "12-week average"
  highDemandPct: 20,            // last-4 avg more than 20% above 12-week avg
  highDemandMultiplier: 1.5,
  festivalUpliftPct: 25,        // applied before any threshold check
  minCoverWeeks: 6,             // below → stockout risk
  maxCoverWeeks: 14,            // above → overstock risk
  perishableMinCoverWeeks: 3,
  perishableMaxCoverWeeks: 4,
  swingPct: 30,                 // week-on-week move that sends a SKU to Raghav
  // Open questions for Raghav — defaults until he confirms:
  upliftApplies: 'both',        // 'both' (12-wk and 4-wk) | 'recent' (only the last 4 weeks)
  conflictWinner: 'overstock',  // when high-demand and overstock both fire: 'overstock' | 'high-demand'
};

export const OPEN_QUESTIONS = {
  upliftApplies: 'Does the festival uplift apply to the 12-week average, the last 4 weeks, or both?',
  conflictWinner: 'Which rule wins when high-demand and overstock both fire for the same SKU?',
};

export function parseCsv(text) {
  const rows = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  const [header = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

// Which dataset a CSV is, judged by its header — lets planners drop in fresh SAP exports.
export const DATASETS = {
  sales: { file: 'weekly_sales.csv', cols: ['SKU_ID', 'Week', 'Units_Sold'] },
  skus: { file: 'sku_master.csv', cols: ['SKU_ID', 'SKU_Name', 'Perishability', 'Standard_Reorder_Qty', 'Distributor_ID'] },
  distributors: { file: 'distributor_master.csv', cols: ['Distributor_ID', 'Distributor_Name'] },
  inventory: { file: 'current_inventory.csv', cols: ['SKU_ID', 'Units_On_Hand', 'As_Of_Date'] },
  calendar: { file: 'calendar.csv', cols: ['Year_Month', 'Is_Festival_Month'] },
};

export function detectDataset(rows) {
  if (!rows.length) return null;
  const cols = Object.keys(rows[0]);
  return Object.keys(DATASETS).find((k) => DATASETS[k].cols.every((c) => cols.includes(c))) ?? null;
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (n, d = 1) => Number(n).toFixed(d);

export function isFestivalMonth(calendar, isoDate) {
  const row = calendar.find((r) => r.Year_Month === isoDate.slice(0, 7));
  return row ? String(row.Is_Festival_Month).toUpperCase() === 'TRUE' : false;
}

// Evaluate one SKU: numbers, flags, recommended action, exception reasons and a plain-English trace.
export function evaluateSku({ sku, sales, onHand, festival, rules = DEFAULT_RULES }) {
  const series = [...sales].sort((a, b) => a.week.localeCompare(b.week));
  const units = series.map((s) => s.units);
  const long = units.slice(-rules.longWindow);
  const short = units.slice(-rules.shortWindow);
  const avgLong = avg(long);
  const avgShort = avg(short);
  const uplift = festival ? 1 + rules.festivalUpliftPct / 100 : 1;
  const longUplift = rules.upliftApplies === 'recent' ? 1 : uplift;

  const changePct = avgLong ? ((avgShort - avgLong) / avgLong) * 100 : 0;
  const highDemand = avgShort * uplift > avgLong * longUplift * (1 + rules.highDemandPct / 100);

  const weeklyDemand = avgLong * uplift;
  const cover = weeklyDemand ? onHand / weeklyDemand : Infinity;

  const perishable = String(sku.Perishability).toLowerCase() === 'high';
  const minCover = perishable ? rules.perishableMinCoverWeeks : rules.minCoverWeeks;
  const maxCover = perishable ? rules.perishableMaxCoverWeeks : rules.maxCoverWeeks;
  const stockoutRisk = cover < minCover;
  const overstockRisk = cover > maxCover;
  const conflict = highDemand && overstockRisk;

  const std = Number(sku.Standard_Reorder_Qty) || 0;
  const raised = Math.round(std * rules.highDemandMultiplier);
  const trace = [];

  trace.push(`${rules.longWindow}-week average ${fmt(avgLong)} units/week; last ${rules.shortWindow} weeks ${fmt(avgShort)} (${changePct >= 0 ? '+' : ''}${fmt(changePct)}%).`);
  trace.push(festival
    ? `Festival month: +${rules.festivalUpliftPct}% uplift (applied to ${rules.upliftApplies === 'recent' ? 'the last 4 weeks only' : 'both averages'}) → expected ${fmt(weeklyDemand)} units/week.`
    : `Not a festival month → expected ${fmt(weeklyDemand)} units/week.`);
  trace.push(highDemand
    ? `High demand: recent sales more than ${rules.highDemandPct}% above the ${rules.longWindow}-week average.`
    : `Demand trend within ${rules.highDemandPct}% — no high-demand flag.`);
  trace.push(`${onHand} on hand ÷ ${fmt(weeklyDemand)}/week = ${fmt(cover)} weeks of cover. ${perishable ? 'High-perishability' : 'Standard'} window: ${minCover}–${maxCover} weeks.`);

  let rule, action, qty;
  if (conflict && rules.conflictWinner === 'high-demand') {
    rule = 'high-demand'; action = 'reorder'; qty = raised;
    trace.push(`Conflict: high-demand and overstock both fire. Current setting: high-demand wins → reorder ${qty}.`);
  } else if (overstockRisk) {
    rule = 'overstock'; action = 'pause'; qty = 0;
    trace.push(conflict
      ? `Conflict: high-demand and overstock both fire. Current setting: overstock wins → pause the next order.`
      : `Above ${maxCover} weeks → overstock risk. Pause the next order.`);
  } else if (stockoutRisk) {
    rule = highDemand ? 'stockout+high-demand' : 'stockout';
    action = 'reorder-now'; qty = highDemand ? raised : std;
    trace.push(`Below ${minCover} weeks → stockout risk. Reorder immediately: ${qty} units${highDemand ? ` (${rules.highDemandMultiplier}× standard ${std})` : ' (standard quantity)'}.`);
  } else if (highDemand) {
    rule = 'high-demand'; action = 'reorder'; qty = raised;
    trace.push(`Cover is inside the window but demand is rising → next order at ${qty} units (${rules.highDemandMultiplier}× standard ${std}).`);
  } else {
    rule = 'none'; action = 'hold'; qty = 0;
    trace.push('Cover is inside the window and demand is steady → no change.');
  }

  // Exceptions: the 15–20% Raghav handles on judgment. The system flags them, he decides.
  const exceptions = [];
  if (units.length < rules.longWindow) exceptions.push(`New SKU: only ${units.length} weeks of history (needs ${rules.longWindow}).`);
  if (conflict) exceptions.push('Rules conflict: high-demand and overstock both fire.');
  const recent = units.slice(-(rules.shortWindow + 1));
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const move = prev ? ((recent[i] - prev) / prev) * 100 : 0;
    if (Math.abs(move) > rules.swingPct) {
      const wk = series[series.length - recent.length + i].week;
      exceptions.push(`Large swing: ${move > 0 ? '+' : ''}${fmt(move, 0)}% week-on-week in ${wk} (${prev} → ${recent[i]}).`);
    }
  }

  return {
    skuId: sku.SKU_ID, name: sku.SKU_Name, category: sku.Category, perishable,
    distributorId: sku.Distributor_ID, standardQty: std,
    series, avgLong, avgShort, changePct, uplift, weeklyDemand, onHand, cover,
    minCover, maxCover, highDemand, stockoutRisk, overstockRisk, conflict,
    rule, action, qty, exceptions, trace,
  };
}

export function evaluateAll({ skus, sales, inventory, calendar, rules = DEFAULT_RULES }) {
  const asOf = inventory.map((r) => r.As_Of_Date).filter(Boolean).sort().at(-1) ?? '';
  const festival = asOf ? isFestivalMonth(calendar, asOf) : false;
  const bySku = new Map();
  for (const r of sales) {
    if (!bySku.has(r.SKU_ID)) bySku.set(r.SKU_ID, []);
    bySku.get(r.SKU_ID).push({ week: r.Week, units: Number(r.Units_Sold) || 0 });
  }
  const stock = new Map();
  for (const r of inventory) stock.set(r.SKU_ID, (stock.get(r.SKU_ID) ?? 0) + (Number(r.Units_On_Hand) || 0));
  const results = skus.map((sku) => evaluateSku({
    sku, sales: bySku.get(sku.SKU_ID) ?? [], onHand: stock.get(sku.SKU_ID) ?? 0, festival, rules,
  }));
  const lastWeek = sales.map((r) => r.Week).sort().at(-1) ?? '';
  return { asOf, festival, lastWeek, results };
}

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso.slice(0, 10)) - Date.parse(fromIso.slice(0, 10))) / 86400000);
}
