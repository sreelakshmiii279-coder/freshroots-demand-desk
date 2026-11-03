import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'freshroots-'));
cpSync(new URL('../data', import.meta.url), join(dir, 'data'), { recursive: true });
process.env.FRESHROOTS_DATA_DIR = join(dir, 'data');
process.env.FRESHROOTS_STORE = join(dir, 'db.json');
// Never touch the real database: file store by default, or a throwaway Neon database if one is given.
process.env.FRESHROOTS_NO_DOTENV = '1';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else delete process.env.DATABASE_URL;
const { default: server, store } = await import('../server.mjs');
test('storage backend', () => console.log(`  storage: ${store.kind}`));

let base;
before(() => new Promise((ok) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; ok(); })));
after(() => server.close());
const call = async (method, path, data) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
  const text = await res.text();
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
};

test('full cycle: run → Raghav reviews exception → procurement approves → PO export', async () => {
  const run = (await call('POST', '/api/runs', { by: 'Test' })).body;
  assert.equal(run.recs.length, 15);
  assert.equal((await call('GET', `/api/state?run=${run.id}`)).body.run.asOf, '2026-10-19');
  const sku1 = run.recs.find((r) => r.skuId === 'SKU001');
  assert.equal(sku1.status, 'raghav');

  // Procurement can't jump the exception queue.
  assert.equal((await call('POST', `/api/runs/${run.id}/recs/SKU001/procurement`, { decision: 'approved' })).status, 400);
  // Override without a reason is refused.
  assert.equal((await call('POST', `/api/runs/${run.id}/recs/SKU001/review`, { decision: 'override', qty: 600 })).status, 400);

  let r = (await call('POST', `/api/runs/${run.id}/recs/SKU001/review`, { decision: 'override', qty: 600, reason: 'Competitor scheme ends W44' })).body;
  assert.equal(r.recs.find((x) => x.skuId === 'SKU001').status, 'procurement');
  assert.equal(r.summary.overrides, 1);

  r = (await call('POST', `/api/runs/${run.id}/recs/SKU001/procurement`, { decision: 'approved' })).body;
  assert.equal(r.recs.find((x) => x.skuId === 'SKU001').finalQty, 600);
  await call('POST', `/api/runs/${run.id}/po-number`, { poNumber: 'PO-00042', skuIds: ['SKU001'] });

  const po = (await call('GET', `/api/runs/${run.id}/po.csv`)).body;
  assert.match(po, /NutriFlow Distributors,Freshroots Mango Drink 200ml,SKU001,600/);
  const log = (await call('GET', `/api/runs/${run.id}/log.csv`)).body;
  assert.match(log, /PO-00042/);
});

test('rule changes are versioned and need a note', async () => {
  assert.equal((await call('POST', '/api/rules', { rules: { swingPct: 40 } })).status, 400);
  const v = (await call('POST', '/api/rules', { rules: { swingPct: 40 }, note: 'Raghav: 30% too noisy' })).body;
  assert.equal(v.version, 2);
  const state = (await call('GET', '/api/state')).body;
  assert.equal(state.rulesHistory.length, 2);
});
