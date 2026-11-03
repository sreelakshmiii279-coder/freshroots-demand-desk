// Freshroots Demand Desk — Node server.
// Serves the UI, runs Raghav's rules over the SAP exports, and keeps the audit trail in Neon (or store/db.json offline).
import { createServer } from 'node:http';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RULES, OPEN_QUESTIONS, DATASETS, parseCsv, toCsv, detectDataset, evaluateAll, daysBetween,
} from './public/rules.js';
import { openStore } from './store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(ROOT, '.env')) && !process.env.FRESHROOTS_NO_DOTENV) process.loadEnvFile(join(ROOT, '.env'));

const PUBLIC = join(ROOT, 'public');
const OVERRIDE_KILL_PCT = 30;
const DATA_AGE_TARGET_DAYS = 4;

const store = await openStore({
  databaseUrl: process.env.DATABASE_URL,
  filePath: process.env.FRESHROOTS_STORE ?? join(ROOT, 'store', 'db.json'),
  dataDir: process.env.FRESHROOTS_DATA_DIR ?? join(ROOT, 'data'),
});
export { store };

async function loadData() {
  const sets = await store.datasets();
  return Object.fromEntries(Object.keys(DATASETS).map((k) => [k, sets[k] ? parseCsv(sets[k].content) : []]));
}

// ---------- domain ----------
function recStatus(rec) {
  if (rec.procurement) return rec.procurement.decision; // 'approved' | 'rejected'
  if (rec.exceptions.length && !rec.review) return 'raghav';
  return 'procurement';
}
const finalQty = (rec) => rec.procurement?.qty ?? rec.review?.qty ?? rec.qty;
const coverText = (c) => (c == null || !Number.isFinite(c) ? '' : c.toFixed(1));

function decorate(run) {
  const recs = run.recs.map((r) => ({ ...r, cover: r.cover ?? Infinity, status: recStatus(r), finalQty: finalQty(r) }));
  return { ...run, recs, summary: summarize(run) };
}

function summarize(run) {
  const total = run.recs.length;
  const count = (fn) => run.recs.filter(fn).length;
  const overrides = count((r) => r.review?.decision === 'override');
  return {
    total,
    exceptions: count((r) => r.exceptions.length),
    raghavPending: count((r) => recStatus(r) === 'raghav'),
    procurementPending: count((r) => recStatus(r) === 'procurement'),
    approved: count((r) => recStatus(r) === 'approved'),
    rejected: count((r) => recStatus(r) === 'rejected'),
    overrides,
    overrideRate: total ? (overrides / total) * 100 : 0,
    unitsApproved: run.recs.filter((r) => recStatus(r) === 'approved').reduce((s, r) => s + finalQty(r), 0),
  };
}

function isoWeek(iso) {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - yearStart) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

function metrics(allRuns) {
  const runs = allRuns.map((r) => ({ id: r.id, at: r.at, asOf: r.asOf, dataAgeDays: r.dataAgeDays, rulesVersion: r.rulesVersion, ...summarize(r) }));
  const weeks = new Map();
  for (const r of runs) {
    const w = isoWeek(r.at);
    const agg = weeks.get(w) ?? { week: w, runs: 0, total: 0, overrides: 0, exceptions: 0, maxDataAge: 0 };
    agg.runs++; agg.total += r.total; agg.overrides += r.overrides; agg.exceptions += r.exceptions;
    agg.maxDataAge = Math.max(agg.maxDataAge, r.dataAgeDays);
    weeks.set(w, agg);
  }
  const weekly = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week))
    .map((w) => ({ ...w, overrideRate: w.total ? (w.overrides / w.total) * 100 : 0 }));
  const last4 = weekly.slice(-4);
  const allOverrides = runs.reduce((s, r) => s + r.overrides, 0);
  const allRecs = runs.reduce((s, r) => s + r.total, 0);
  return {
    runs, weekly,
    overrideRate: allRecs ? (allOverrides / allRecs) * 100 : 0,
    killOverride: last4.length === 4 && last4.every((w) => w.overrideRate > OVERRIDE_KILL_PCT),
    overrideKillPct: OVERRIDE_KILL_PCT,
    dataAgeTargetDays: DATA_AGE_TARGET_DAYS,
  };
}

async function createRun(by) {
  const [data, rulesHistory] = await Promise.all([loadData(), store.rules()]);
  const { version, rules } = rulesHistory.at(-1);
  const plan = evaluateAll({ ...data, rules });
  const now = new Date().toISOString();
  return store.addRun({
    at: now, by, rulesVersion: version, asOf: plan.asOf, lastWeek: plan.lastWeek, festival: plan.festival,
    dataAgeDays: plan.asOf ? daysBetween(plan.asOf, now) : null,
    recs: plan.results,
  });
}

async function dataInfo() {
  const sets = await store.datasets();
  return Object.entries(DATASETS).map(([key, { file }]) => (sets[key]
    ? { key, file, rows: parseCsv(sets[key].content).length, modified: sets[key].updatedAt }
    : { key, file, rows: 0, missing: true }));
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const need = (cond, msg) => { if (!cond) throw new HttpError(400, msg); };

// ---------- auth: one shared desk password, signed session cookie ----------
const APP_PASSWORD = process.env.APP_PASSWORD ?? '';
const SESSION_SECRET = process.env.SESSION_SECRET || APP_PASSWORD;
const SESSION_DAYS = 30;
const sign = (exp) => createHmac('sha256', SESSION_SECRET).update(`freshroots:${exp}`).digest('base64url');
const digest = (s) => createHash('sha256').update(String(s)).digest();

function sessionValid(req) {
  if (!APP_PASSWORD) return true; // no password configured → open (local dev, tests)
  const m = /(?:^|;\s*)fr_session=([^;]+)/.exec(req.headers.cookie ?? '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = Buffer.from(sign(exp));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
function sessionCookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `fr_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function body(req) {
  // On Vercel the runtime has already parsed the body; locally we read the stream.
  if (req.body !== undefined) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body ?? {};
    try { return JSON.parse(String(req.body) || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 5e6) throw new HttpError(413, 'Body too large'); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
}
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const csv = (res, name, text) => { res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` }); res.end(text); };

async function findRun(id) {
  const run = (await store.runs()).find((r) => r.id === id);
  if (!run) throw new HttpError(404, `No run ${id}`);
  return run;
}
function findRec(run, skuId) {
  const rec = run.recs.find((r) => r.skuId === skuId);
  if (!rec) throw new HttpError(404, `No ${skuId} in ${run.id}`);
  return rec;
}
const cleanQty = (q) => { const n = Number(q); need(Number.isFinite(n) && n >= 0 && Number.isInteger(n), 'Quantity must be a whole number ≥ 0'); return n; };
const cleanText = (s, max = 500) => String(s ?? '').trim().slice(0, max);

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop 'api'
  const m = req.method;

  if (m === 'POST' && parts[0] === 'login') {
    const { password } = await body(req);
    const ok = APP_PASSWORD && timingSafeEqual(digest(password ?? ''), digest(APP_PASSWORD));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing
      throw new HttpError(401, 'Wrong password');
    }
    const exp = Date.now() + SESSION_DAYS * 86400000;
    res.setHeader('set-cookie', sessionCookie(req, `${exp}.${sign(exp)}`, SESSION_DAYS * 86400));
    return json(res, 200, { ok: true });
  }
  if (m === 'POST' && parts[0] === 'logout') {
    res.setHeader('set-cookie', sessionCookie(req, '', 0));
    return json(res, 200, { ok: true });
  }
  if (!sessionValid(req)) throw new HttpError(401, 'Sign in required');

  if (m === 'GET' && parts[0] === 'state') {
    const runId = url.searchParams.get('run');
    const [runs, rulesHistory, data, info] = await Promise.all([store.runs(), store.rules(), loadData(), dataInfo()]);
    const run = runId ? runs.find((r) => r.id === runId) : runs.at(-1);
    if (runId && !run) throw new HttpError(404, `No run ${runId}`);
    return json(res, 200, {
      rules: rulesHistory.at(-1), rulesHistory, defaults: DEFAULT_RULES, openQuestions: OPEN_QUESTIONS,
      run: run ? decorate(run) : null, metrics: metrics(runs), data: info, storage: store.kind, auth: Boolean(APP_PASSWORD),
      distributors: Object.fromEntries(data.distributors.map((d) => [d.Distributor_ID, d.Distributor_Name])),
      now: new Date().toISOString(),
    });
  }

  if (m === 'POST' && parts[0] === 'runs' && parts.length === 1) {
    const { by } = await body(req);
    return json(res, 201, decorate(await createRun(cleanText(by, 60) || 'Unknown')));
  }

  if (m === 'POST' && parts[0] === 'runs' && parts[2] === 'recs' && parts[4] === 'review') {
    const run = await findRun(parts[1]);
    const rec = findRec(run, parts[3]);
    need(!rec.procurement, 'Procurement has already decided on this line');
    const b = await body(req);
    need(['accept', 'override'].includes(b.decision), 'decision must be accept or override');
    const qty = b.decision === 'override' ? cleanQty(b.qty) : rec.qty;
    const reason = cleanText(b.reason);
    need(b.decision === 'accept' || reason, 'An override needs a reason — it feeds the rule review');
    await store.saveReview(run.id, rec.skuId, { decision: b.decision, qty, reason, by: cleanText(b.by, 60) || 'Raghav', at: new Date().toISOString() });
    return json(res, 200, decorate(await findRun(run.id)));
  }

  if (m === 'POST' && parts[0] === 'runs' && parts[2] === 'recs' && parts[4] === 'procurement') {
    const run = await findRun(parts[1]);
    const rec = findRec(run, parts[3]);
    need(!(rec.exceptions.length && !rec.review), 'Raghav must review this exception first');
    const b = await body(req);
    need(['approved', 'rejected'].includes(b.decision), 'decision must be approved or rejected');
    const reason = cleanText(b.reason);
    need(b.decision === 'approved' || reason, 'Say why this line is rejected');
    await store.saveProcurement(run.id, rec.skuId, {
      decision: b.decision,
      qty: b.decision === 'approved' ? cleanQty(b.qty ?? finalQty(rec)) : 0,
      poNumber: cleanText(b.poNumber, 40), reason, by: cleanText(b.by, 60) || 'Procurement', at: new Date().toISOString(),
    });
    return json(res, 200, decorate(await findRun(run.id)));
  }

  if (m === 'POST' && parts[0] === 'runs' && parts[2] === 'po-number') {
    // Record the Zoho PO number on approved lines after the PO is raised.
    const run = await findRun(parts[1]);
    const b = await body(req);
    const po = cleanText(b.poNumber, 40);
    need(po, 'PO number required');
    await store.savePoNumber(run.id, (b.skuIds ?? []).map(String), po);
    return json(res, 200, decorate(await findRun(run.id)));
  }

  if (m === 'POST' && parts[0] === 'rules') {
    const b = await body(req);
    const note = cleanText(b.note);
    need(note, 'Every rule change needs a note');
    const next = { ...(await store.rules()).at(-1).rules };
    for (const [k, v] of Object.entries(b.rules ?? {})) {
      need(k in DEFAULT_RULES, `Unknown rule ${k}`);
      if (typeof DEFAULT_RULES[k] === 'number') { need(Number.isFinite(Number(v)) && Number(v) >= 0, `${k} must be a number`); next[k] = Number(v); }
      else next[k] = String(v);
    }
    need(['both', 'recent'].includes(next.upliftApplies), 'upliftApplies must be both or recent');
    need(['overstock', 'high-demand'].includes(next.conflictWinner), 'conflictWinner must be overstock or high-demand');
    need(next.perishableMinCoverWeeks < next.perishableMaxCoverWeeks && next.minCoverWeeks < next.maxCoverWeeks, 'Minimum cover must be below maximum');
    const confirmed = (Array.isArray(b.confirmed) ? b.confirmed : []).filter((k) => k in OPEN_QUESTIONS);
    return json(res, 201, await store.addRules({ rules: next, note, by: cleanText(b.by, 60) || 'Raghav', confirmed }));
  }

  if (m === 'POST' && parts[0] === 'data') {
    const b = await body(req);
    const text = String(b.text ?? '').replace(/\r\n/g, '\n');
    const rows = parseCsv(text);
    const key = detectDataset(rows);
    need(key, 'Could not recognise this file — check its column headers match the SAP export');
    await store.putDataset(key, text);
    return json(res, 200, { key, file: DATASETS[key].file, rows: rows.length });
  }

  if (m === 'GET' && parts[0] === 'runs' && parts[2] === 'log.csv') {
    const run = await findRun(parts[1]);
    const rows = decorate(run).recs.map((r) => ({
      run_id: run.id, run_at: run.at, rules_version: run.rulesVersion, data_as_of: run.asOf,
      sku_id: r.skuId, sku_name: r.name, distributor_id: r.distributorId,
      rule_fired: r.rule, action: r.action, recommended_qty: r.qty, weeks_of_cover: coverText(r.cover),
      exceptions: r.exceptions.join(' | '),
      raghav_decision: r.review?.decision ?? '', raghav_qty: r.review?.qty ?? '', raghav_reason: r.review?.reason ?? '',
      procurement_decision: r.procurement?.decision ?? 'pending', procurement_qty: r.procurement?.qty ?? '',
      procurement_reason: r.procurement?.reason ?? '', zoho_po_number: r.procurement?.poNumber ?? '',
    }));
    return csv(res, `freshroots-${run.id}-log.csv`, toCsv(rows, Object.keys(rows[0] ?? { run_id: 1 })));
  }

  if (m === 'GET' && parts[0] === 'runs' && parts[2] === 'po.csv') {
    // Zoho Inventory purchase-order import layout: one line per item, grouped by vendor.
    const run = await findRun(parts[1]);
    const names = Object.fromEntries((await loadData()).distributors.map((d) => [d.Distributor_ID, d.Distributor_Name]));
    const rows = decorate(run).recs
      .filter((r) => r.status === 'approved' && r.finalQty > 0)
      .sort((a, b) => a.distributorId.localeCompare(b.distributorId))
      .map((r) => ({
        'Purchase Order Date': run.at.slice(0, 10), 'Vendor Name': names[r.distributorId] ?? r.distributorId,
        'Item Name': r.name, SKU: r.skuId, 'Quantity Ordered': r.finalQty,
        'Reference#': `${run.id}-${r.distributorId}`, Notes: `Rule: ${r.rule}${r.review?.decision === 'override' ? `; override: ${r.review.reason}` : ''}`,
      }));
    return csv(res, `freshroots-${run.id}-zoho-po.csv`, toCsv(rows, ['Purchase Order Date', 'Vendor Name', 'Item Name', 'SKU', 'Quantity Ordered', 'Reference#', 'Notes']));
  }

  throw new HttpError(404, 'Not found');
}

// Shared request handler: used by the local server below and by Vercel (api/index.mjs).
export async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const path = join(PUBLIC, rel);
    if (!path.startsWith(PUBLIC) || !existsSync(path) || statSync(path).isDirectory()) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(path));
  } catch (err) {
    const status = err.status ?? 500;
    if (status === 500) console.error(err);
    json(res, status, { error: status === 500 ? 'Server error — check the server log' : err.message });
  }
}

const server = createServer(handler);
export default server;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 3500);
  server.listen(port, () => console.log(`Freshroots Demand Desk on http://localhost:${port} · storage: ${store.kind}`));
}
