import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_RULES, evaluateAll, evaluateSku, parseCsv } from '../public/rules.js';

const load = (f) => parseCsv(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const data = {
  skus: load('sku_master.csv'), sales: load('weekly_sales.csv'),
  inventory: load('current_inventory.csv'), calendar: load('calendar.csv'),
};
const sku = (over = {}) => ({ SKU_ID: 'T1', SKU_Name: 'Test', Perishability: 'Low', Standard_Reorder_Qty: '100', Distributor_ID: 'D', ...over });
const flat = (n, units) => Array.from({ length: n }, (_, i) => ({ week: `2026-W${String(i + 10).padStart(2, '0')}`, units }));

test('October 2026 is a festival month', () => {
  const plan = evaluateAll(data);
  assert.equal(plan.asOf, '2026-10-19');
  assert.equal(plan.festival, true);
  assert.equal(plan.lastWeek, '2026-W42');
});

test('SKU001 mango drink: high demand + stockout → reorder 1.5× now, flagged for the W39 jump', () => {
  const r = evaluateAll(data).results.find((x) => x.skuId === 'SKU001');
  assert.equal(r.highDemand, true);
  assert.equal(r.stockoutRisk, true);
  assert.equal(r.action, 'reorder-now');
  assert.equal(r.qty, 750);
  assert.ok(r.exceptions.some((e) => e.startsWith('Large swing')));
});

test('perishables use the 3–4 week window', () => {
  const r = evaluateSku({ sku: sku({ Perishability: 'High' }), sales: flat(12, 100), onHand: 500, festival: false });
  assert.equal(r.minCover, 3);
  assert.equal(r.maxCover, 4);
  assert.equal(r.action, 'pause'); // 5 weeks > 4
});

test('festival uplift applies before thresholds', () => {
  // 650 / 100 = 6.5 weeks (ok); with +25% → 5.2 weeks (stockout)
  const off = evaluateSku({ sku: sku(), sales: flat(12, 100), onHand: 650, festival: false });
  const on = evaluateSku({ sku: sku(), sales: flat(12, 100), onHand: 650, festival: true });
  assert.equal(off.action, 'hold');
  assert.equal(on.action, 'reorder-now');
});

test('conflict goes to Raghav and the winner follows the setting', () => {
  const sales = [...flat(8, 50), ...flat(4, 100).map((s, i) => ({ ...s, week: `2026-W${30 + i}` }))];
  const a = evaluateSku({ sku: sku(), sales, onHand: 5000, festival: false });
  assert.equal(a.conflict, true);
  assert.equal(a.action, 'pause');
  assert.ok(a.exceptions.some((e) => e.startsWith('Rules conflict')));
  const b = evaluateSku({ sku: sku(), sales, onHand: 5000, festival: false, rules: { ...DEFAULT_RULES, conflictWinner: 'high-demand' } });
  assert.equal(b.action, 'reorder');
  assert.equal(b.qty, 150);
});

test('new SKUs with short history are exceptions', () => {
  const r = evaluateSku({ sku: sku(), sales: flat(5, 100), onHand: 800, festival: false });
  assert.ok(r.exceptions.some((e) => e.startsWith('New SKU')));
});
