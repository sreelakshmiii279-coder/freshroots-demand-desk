import { DATASETS } from './rules.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = (x) => Math.round(x).toLocaleString('en-IN');
const n1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '∞');
const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const day = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let state = null;
let tab = store.get('fr.tab', 'sheet');
let filter = 'all';
let openSku = null;

const role = () => $('#role').value;

async function api(path, opts = {}) {
  const res = await fetch(`/api/${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') { showLogin(); throw new Error('Sign in required'); }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function showLogin() {
  closeDrawer();
  document.body.classList.add('signed-out');
  $('#runMeta').textContent = 'Sign in to continue';
  $('#view').innerHTML = `<form class="card login" id="loginForm">
    <h2>Sign in</h2>
    <p class="muted">Freshroots demand planning desk — for Raghav, procurement and operations.</p>
    <label class="field"><span>Desk password</span><input type="password" name="password" autocomplete="current-password" required autofocus></label>
    <button class="btn primary">Sign in</button>
  </form>`;
  $('#loginForm input').focus();
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = 'toast'; }, err ? 4500 : 2500);
}

async function load(runId = $('#runPick').value || '') {
  state = await api(`state${runId ? `?run=${runId}` : ''}`);
  render();
}

// ---------- labels ----------
const ACTION = {
  'reorder-now': ['Reorder now', 'p-red'],
  reorder: ['Reorder 1.5×', 'p-amber'],
  pause: ['Pause next order', 'p-blue'],
  hold: ['No change', 'p-grey'],
};
const STATUS = {
  raghav: ['With Raghav', 'p-amber'],
  procurement: ['Awaiting procurement', 'p-blue'],
  approved: ['Approved', 'p-green'],
  rejected: ['Rejected', 'p-grey'],
};
const pill = ([label, cls]) => `<span class="pill ${cls}">${esc(label)}</span>`;
const distName = (id) => state.distributors[id] ?? id;

function spark(series, w = 120, h = 30) {
  const ys = series.map((s) => s.units);
  if (!ys.length) return '';
  const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
  const pts = ys.map((y, i) => [(i / Math.max(ys.length - 1, 1)) * (w - 4) + 2, h - 3 - ((y - min) / span) * (h - 6)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const [lx, ly] = pts.at(-1);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${lx}" cy="${ly}" r="2.5" fill="var(--text)"/></svg>`;
}

function coverBar(r) {
  const scale = Math.max(r.maxCover * 1.5, Math.min(r.cover, 30), 1);
  const pct = (v) => Math.min(100, (v / scale) * 100);
  const color = r.stockoutRisk ? 'var(--red)' : r.overstockRisk ? 'var(--blue)' : 'var(--accent)';
  return `<div class="cover" title="${n1(r.cover)} weeks of cover; window ${r.minCover}–${r.maxCover}">
    <span class="num" style="width:38px;text-align:right">${n1(r.cover)}w</span>
    <div class="cover-bar"><div class="cover-band" style="left:${pct(r.minCover)}%;width:${pct(r.maxCover) - pct(r.minCover)}%"></div>
    <div class="cover-dot" style="left:${pct(r.cover)}%;background:${color}"></div></div></div>`;
}

// ---------- header ----------
function renderHeader() {
  const run = state.run;
  const pick = $('#runPick');
  const runs = [...state.metrics.runs].reverse();
  pick.innerHTML = runs.length
    ? runs.map((r) => `<option value="${r.id}">${r.id} · ${when(r.at)}</option>`).join('')
    : '<option value="">No runs yet</option>';
  if (run) pick.value = run.id;
  $('#runMeta').innerHTML = run
    ? `Run ${run.id} by ${esc(run.by)} · ${when(run.at)} · SAP data as of ${day(run.asOf)} (${run.lastWeek}) · rules v${run.rulesVersion}${run.festival ? ' · <b>festival month +' + state.rules.rules.festivalUpliftPct + '%</b>' : ''}`
    : 'No runs yet — start the first one.';
  $('#signOut').hidden = !state.auth;
  $('#cRaghav').textContent = run?.summary.raghavPending || '';
  $('#cProc').textContent = run?.summary.procurementPending || '';
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
}

function render() {
  renderHeader();
  const view = $('#view');
  if (!state.run && !['rules', 'data', 'metrics'].includes(tab)) {
    view.innerHTML = `<div class="card empty"><h2>No run yet</h2>
      <p>A run applies rules v${state.rules.version} to the latest SAP export and builds this cycle's recommendation sheet.</p>
      <button class="btn primary" data-act="new-run">Start the first run</button></div>`;
    return;
  }
  view.innerHTML = { sheet: viewSheet, raghav: viewRaghav, procurement: viewProcurement, metrics: viewMetrics, rules: viewRules, data: viewData }[tab]();
  if (openSku) renderDrawer();
}

// ---------- recommendations ----------
function viewSheet() {
  const { run } = state;
  const s = run.summary;
  const count = (fn) => run.recs.filter(fn).length;
  const ageBad = run.dataAgeDays > state.metrics.dataAgeTargetDays;
  const filters = [
    ['all', `All ${s.total}`],
    ['reorder-now', `Reorder now ${count((r) => r.action === 'reorder-now')}`],
    ['reorder', `Reorder 1.5× ${count((r) => r.action === 'reorder')}`],
    ['pause', `Pause ${count((r) => r.action === 'pause')}`],
    ['hold', `No change ${count((r) => r.action === 'hold')}`],
    ['exceptions', `Exceptions ${s.exceptions}`],
  ];
  const recs = run.recs.filter((r) => filter === 'all' || (filter === 'exceptions' ? r.exceptions.length : r.action === filter));
  return `
  ${ageBad ? `<div class="note warn" style="margin-bottom:16px"><strong>Data is ${run.dataAgeDays} days old</strong> when this run started (target: under ${state.metrics.dataAgeTargetDays}). Load a fresh SAP export on the Data tab before Monday/Thursday runs.</div>` : ''}
  <section class="kpis">
    <div class="card kpi bad"><div class="label">Reorder now (stockout risk)</div><div class="value">${count((r) => r.action === 'reorder-now')}</div><div class="hint">below minimum cover</div></div>
    <div class="card kpi warn"><div class="label">With Raghav</div><div class="value">${s.raghavPending}</div><div class="hint">${s.exceptions} exception${s.exceptions === 1 ? '' : 's'} flagged</div></div>
    <div class="card kpi"><div class="label">Awaiting procurement</div><div class="value">${s.procurementPending}</div><div class="hint">nothing orders itself</div></div>
    <div class="card kpi good"><div class="label">Units approved</div><div class="value">${n0(s.unitsApproved)}</div><div class="hint">${s.approved} line${s.approved === 1 ? '' : 's'} approved</div></div>
  </section>
  <section class="card">
    <div class="card-h">
      <div class="filters">${filters.map(([k, l]) => `<button class="chip${filter === k ? ' on' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>
      <div class="row"><a class="btn small" href="/api/runs/${run.id}/log.csv">Download audit log</a></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>SKU</th><th class="hide-sm">Distributor</th><th class="r">12-wk avg</th><th class="r">Last 4 wks</th><th class="hide-sm">16 weeks</th><th class="r">On hand</th><th>Weeks of cover</th><th>Recommendation</th><th class="r">Qty</th><th>Status</th></tr></thead>
      <tbody>${recs.map((r) => `
        <tr class="click" data-sku="${r.skuId}">
          <td><div class="sku-name">${esc(r.name.replace(/^Freshroots /, ''))}${r.perishable ? '<span class="tag perish">perishable</span>' : ''}</div><div class="sku-id">${r.skuId} · ${esc(r.category)}</div></td>
          <td class="hide-sm">${esc(distName(r.distributorId))}</td>
          <td class="r num">${n1(r.avgLong)}</td>
          <td class="r num" style="color:${r.highDemand ? 'var(--red)' : 'inherit'}">${r.changePct >= 0 ? '+' : ''}${n1(r.changePct)}%</td>
          <td class="hide-sm">${spark(r.series)}</td>
          <td class="r num">${n0(r.onHand)}</td>
          <td>${coverBar(r)}</td>
          <td>${pill(ACTION[r.action])}${r.exceptions.length ? ' <span class="pill p-amber" title="Exception">!</span>' : ''}</td>
          <td class="r num">${r.finalQty !== r.qty ? `<s class="muted">${n0(r.qty)}</s> ` : ''}<b>${n0(r.finalQty)}</b></td>
          <td>${pill(STATUS[r.status])}</td>
        </tr>`).join('') || '<tr><td colspan="10" class="muted">Nothing in this filter.</td></tr>'}
      </tbody></table></div>
  </section>`;
}

// ---------- Raghav ----------
function reviewForm(r) {
  if (r.procurement) return '<p class="muted">Procurement has decided — the line is closed.</p>';
  if (role() !== 'Raghav') return `<p class="muted">Switch to <b>Raghav</b> to review this line.</p>`;
  return `<form class="form-grid" data-review="${r.skuId}">
    <label class="muted" for="q-${r.skuId}">Quantity</label>
    <input id="q-${r.skuId}" name="qty" type="number" min="0" step="1" value="${r.review?.qty ?? r.qty}">
    <label class="muted" for="w-${r.skuId}">Reason</label>
    <textarea id="w-${r.skuId}" name="reason" placeholder="Required if you change the quantity — e.g. launch, distributor scheme, one-off event">${esc(r.review?.reason ?? '')}</textarea>
    <span></span>
    <div class="row"><button class="btn primary" name="decision" value="accept">Accept ${n0(r.qty)}</button><button class="btn" name="decision" value="override">Override</button></div>
  </form>`;
}

function viewRaghav() {
  const recs = state.run.recs.filter((r) => r.status === 'raghav');
  const reviewed = state.run.recs.filter((r) => r.review);
  return `
  <div class="note" style="margin-bottom:16px">The rules cover 80–85% of decisions. These are the rest: new SKUs, rule conflicts and large swings. Every override is logged with its reason. If overrides stay above ${state.metrics.overrideKillPct}% for 4 weeks, the rules get redesigned.</div>
  ${recs.length ? `<div class="queue">${recs.map((r) => `
    <article class="card qcard">
      <div class="card-h"><div><div class="sku-name">${esc(r.name)}</div><div class="sku-id">${r.skuId} · ${esc(distName(r.distributorId))}</div></div>${pill(ACTION[r.action])}</div>
      <div class="card-b">
        <ul class="exc">${r.exceptions.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
        <div class="row">${spark(r.series, 300, 54)}</div>
        <div class="stat-row"><div><span class="muted">On hand</span><b>${n0(r.onHand)}</b></div><div><span class="muted">Cover</span><b>${n1(r.cover)} wk</b></div><div><span class="muted">Window</span><b>${r.minCover}–${r.maxCover}</b></div><div><span class="muted">Std qty</span><b>${n0(r.standardQty)}</b></div></div>
        <ol class="trace">${r.trace.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
        ${reviewForm(r)}
      </div>
    </article>`).join('')}</div>`
    : `<div class="card empty"><h2>Queue clear</h2><p>No exceptions waiting in run ${state.run.id}.</p></div>`}
  ${reviewed.length ? `<section class="card"><div class="card-h"><h3>Reviewed this run</h3></div><div class="table-wrap"><table>
    <thead><tr><th>SKU</th><th>Decision</th><th class="r">Rule qty</th><th class="r">Raghav qty</th><th>Reason</th><th>When</th></tr></thead>
    <tbody>${reviewed.map((r) => `<tr class="click" data-sku="${r.skuId}"><td>${esc(r.name)}</td><td>${pill(r.review.decision === 'override' ? ['Override', 'p-amber'] : ['Accepted', 'p-green'])}</td><td class="r num">${n0(r.qty)}</td><td class="r num">${n0(r.review.qty)}</td><td>${esc(r.review.reason) || '<span class="muted">—</span>'}</td><td class="muted">${when(r.review.at)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
}

// ---------- procurement ----------
function viewProcurement() {
  const { run } = state;
  const pending = run.recs.filter((r) => r.status === 'procurement');
  const approved = run.recs.filter((r) => r.status === 'approved' && r.finalQty > 0);
  const waiting = run.recs.filter((r) => r.status === 'raghav').length;
  const isProc = role() === 'Procurement';
  const byDist = (list) => Object.entries(list.reduce((m, r) => ((m[r.distributorId] ??= []).push(r), m), {})).sort();
  return `
  ${!isProc ? '<div class="note warn" style="margin-bottom:16px">Switch to <b>Procurement</b> to approve lines. Nothing becomes a purchase order without procurement sign-off.</div>' : ''}
  ${waiting ? `<div class="note" style="margin-bottom:16px">${waiting} line${waiting === 1 ? ' is' : 's are'} still with Raghav and will appear here once reviewed.</div>` : ''}
  <section class="card">
    <div class="card-h"><h3>To review · ${pending.length}</h3>
      ${isProc && pending.length ? '<button class="btn" data-act="approve-all">Approve all as recommended</button>' : ''}</div>
    ${pending.length ? `<div class="table-wrap"><table>
      <thead><tr><th>SKU</th><th>Distributor</th><th>Recommendation</th><th>Why</th><th class="r">Qty</th><th></th></tr></thead>
      <tbody>${pending.map((r) => `<tr>
        <td class="click" data-sku="${r.skuId}"><div class="sku-name">${esc(r.name.replace(/^Freshroots /, ''))}</div><div class="sku-id">${r.skuId}${r.review?.decision === 'override' ? ' · Raghav override' : ''}</div></td>
        <td>${esc(distName(r.distributorId))}</td>
        <td>${pill(ACTION[r.action])}</td>
        <td class="muted" style="max-width:340px"><small>${esc(r.review?.reason || r.trace.at(-1))}</small></td>
        <td class="r"><input type="number" min="0" step="1" value="${r.finalQty}" style="width:90px;text-align:right" data-qty="${r.skuId}" ${isProc ? '' : 'disabled'}></td>
        <td><div class="row" style="flex-wrap:nowrap"><button class="btn small primary" data-approve="${r.skuId}" ${isProc ? '' : 'disabled'}>Approve</button><button class="btn small danger" data-reject="${r.skuId}" ${isProc ? '' : 'disabled'}>Reject</button></div></td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="card-b muted">Nothing waiting.</div>'}
  </section>
  <section class="card">
    <div class="card-h"><h3>Approved for purchase orders</h3>
      <a class="btn small${approved.length ? '' : ' disabled'}" href="/api/runs/${run.id}/po.csv" ${approved.length ? '' : 'aria-disabled="true" onclick="return false"'}>Download Zoho PO import (.csv)</a></div>
    ${approved.length ? byDist(approved).map(([d, list]) => `
      <div class="card-b" style="border-bottom:1px solid var(--border)">
        <div class="row" style="margin-bottom:8px"><b>${esc(distName(d))}</b><span class="muted">${list.length} line${list.length === 1 ? '' : 's'} · ${n0(list.reduce((s, r) => s + r.finalQty, 0))} units</span><span class="spacer"></span>
          ${list[0].procurement.poNumber ? `<span class="pill p-green">Zoho PO ${esc(list[0].procurement.poNumber)}</span>` : ''}
          ${isProc ? `<form class="row" data-po="${list.map((r) => r.skuId).join(',')}"><input name="po" placeholder="Zoho PO number" style="width:160px" value="${esc(list[0].procurement.poNumber)}"><button class="btn small">Save</button></form>` : ''}</div>
        <div class="muted"><small>${list.map((r) => `${esc(r.name.replace(/^Freshroots /, ''))} × ${n0(r.finalQty)}`).join(' · ')}</small></div>
      </div>`).join('') : '<div class="card-b muted">No approved lines yet. Approved lines are grouped by distributor, ready to raise in Zoho Inventory.</div>'}
  </section>`;
}

// ---------- metrics ----------
function viewMetrics() {
  const m = state.metrics;
  const last = m.runs.at(-1);
  const backtestNote = 'Needs Raghav\'s past forecasts from SAP (3 years) — not in this sample export.';
  const crit = [
    ['Backtest: rules beat Raghav\'s historical forecast error', 'pending', backtestNote],
    [`Override rate above ${m.overrideKillPct}% for 4 weeks in a row`, m.killOverride ? 'tripped' : m.weekly.length >= 4 ? 'ok' : 'pending', `${m.weekly.length} week${m.weekly.length === 1 ? '' : 's'} of runs logged so far.`],
    ['SAP export automated by day 30', last && last.dataAgeDays <= m.dataAgeTargetDays ? 'ok' : 'watch', last ? `Latest run used data ${last.dataAgeDays} days old (target under ${m.dataAgeTargetDays}).` : 'No runs yet.'],
    ['Error cost down at least 10% vs same quarter last year (2 quarters after go-live)', 'pending', 'Compare stockout + write-off value from SAP each quarter. Baseline ₹28–34L a quarter.'],
  ];
  const critPill = { ok: ['On track', 'p-green'], tripped: ['Tripped — redesign', 'p-red'], watch: ['Watch', 'p-amber'], pending: ['Not measurable yet', 'p-grey'] };
  return `
  <section class="kpis">
    <div class="card kpi ${last && last.dataAgeDays > m.dataAgeTargetDays ? 'bad' : 'good'}"><div class="label">Data age at last run</div><div class="value">${last ? last.dataAgeDays + ' days' : '—'}</div><div class="hint">target under ${m.dataAgeTargetDays} days (was 21–28)</div></div>
    <div class="card kpi ${m.overrideRate > m.overrideKillPct ? 'bad' : 'good'}"><div class="label">Raghav override rate</div><div class="value">${m.runs.length ? n1(m.overrideRate) + '%' : '—'}</div><div class="hint">kill line ${m.overrideKillPct}% for 4 weeks</div></div>
    <div class="card kpi"><div class="label">Exceptions in last run</div><div class="value">${last ? last.exceptions : '—'}</div><div class="hint">of ${last?.total ?? 0} SKUs</div></div>
    <div class="card kpi"><div class="label">Runs logged</div><div class="value">${m.runs.length}</div><div class="hint">target: 2 a week (Mon + Thu)</div></div>
  </section>
  <section class="card"><div class="card-h"><h3>Kill criteria</h3><span class="muted"><small>Stop and redesign if any trips</small></span></div>
    <div class="table-wrap"><table><tbody>${crit.map(([c, s, d]) => `<tr><td><b>${esc(c)}</b><div class="muted"><small>${esc(d)}</small></div></td><td class="r">${pill(critPill[s])}</td></tr>`).join('')}</tbody></table></div></section>
  <section class="card"><div class="card-h"><h3>Weekly</h3></div>
    ${m.weekly.length ? `<div class="table-wrap"><table><thead><tr><th>Week</th><th class="r">Runs</th><th class="r">Recommendations</th><th class="r">Exceptions</th><th class="r">Overrides</th><th class="r">Override rate</th><th class="r">Max data age</th></tr></thead>
    <tbody>${m.weekly.map((w) => `<tr><td>${w.week}</td><td class="r num">${w.runs}${w.runs < 2 ? ' <span class="pill p-amber">below 2</span>' : ''}</td><td class="r num">${w.total}</td><td class="r num">${w.exceptions}</td><td class="r num">${w.overrides}</td><td class="r num" style="color:${w.overrideRate > m.overrideKillPct ? 'var(--red)' : 'inherit'}">${n1(w.overrideRate)}%</td><td class="r num">${w.maxDataAge} d</td></tr>`).join('')}</tbody></table></div>` : '<div class="card-b muted">No runs yet.</div>'}
  </section>
  <section class="card"><div class="card-h"><h3>Outcome and baseline</h3></div><div class="card-b">
    <div class="table-wrap"><table><thead><tr><th>Metric</th><th>Baseline</th><th>Target</th></tr></thead><tbody>
      <tr><td>Demand-planning error cost</td><td>₹28–34L / quarter</td><td>−25% (≈ ₹21–25L) within 2 quarters</td></tr>
      <tr><td>Stockout lost sales</td><td>₹18–22L / quarter</td><td>Tracked quarterly from SAP</td></tr>
      <tr><td>Overstock write-offs (mostly perishables)</td><td>₹10–12L / quarter</td><td>Tracked quarterly from SAP</td></tr>
      <tr><td>Forecast cycle</td><td>Monthly</td><td>Twice a week</td></tr>
      <tr><td>Data age at procurement</td><td>3–4 weeks</td><td>Under 4 days</td></tr>
      <tr><td>Raghav's data work</td><td>~2 days / month</td><td>Exceptions only</td></tr>
    </tbody></table></div></div></section>`;
}

// ---------- rules ----------
const RULE_FIELDS = [
  ['festivalUpliftPct', 'Festival uplift (%)', 'Oct, Nov, Mar — from the calendar file'],
  ['highDemandPct', 'High-demand trigger (%)', 'Last 4 weeks above 12-week average by more than'],
  ['highDemandMultiplier', 'High-demand reorder multiplier', '× standard reorder quantity'],
  ['minCoverWeeks', 'Stockout below (weeks)', 'Standard SKUs'],
  ['maxCoverWeeks', 'Overstock above (weeks)', 'Standard SKUs'],
  ['perishableMinCoverWeeks', 'Perishable minimum (weeks)', 'High-perishability SKUs'],
  ['perishableMaxCoverWeeks', 'Perishable maximum (weeks)', 'High-perishability SKUs'],
  ['shortWindow', 'Recent window (weeks)', ''],
  ['longWindow', 'Average window (weeks)', 'Also the minimum history before a SKU leaves "new"'],
  ['swingPct', 'Large swing for Raghav (%)', 'Week-on-week move that sends a SKU to the exception queue'],
];

function viewRules() {
  const cur = state.rules;
  const r = cur.rules;
  const confirmed = new Set(state.rulesHistory.flatMap((v) => v.confirmed ?? []));
  const canEdit = role() === 'Raghav';
  const diff = (prev, next) => Object.keys(next).filter((k) => prev && prev[k] !== next[k]).map((k) => `${k}: ${prev[k]} → ${next[k]}`).join(' · ');
  const q = (key, options) => `<div class="question${confirmed.has(key) ? ' confirmed' : ''}">
      <p>${confirmed.has(key) ? '✓ Confirmed by Raghav' : 'Open question for Raghav'}: ${esc(state.openQuestions[key])}</p>
      <select name="${key}" ${canEdit ? '' : 'disabled'}>${options.map(([v, l]) => `<option value="${v}"${r[key] === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      ${confirmed.has(key) ? '' : `<label class="row muted"><input type="checkbox" name="confirm" value="${key}" ${canEdit ? '' : 'disabled'}> Raghav confirms this answer</label>`}
    </div>`;
  return `
  <form class="card" id="rulesForm">
    <div class="card-h"><div><h3>Rules v${cur.version}</h3><div class="muted"><small>${esc(cur.note)} — ${esc(cur.by)}, ${when(cur.at)}</small></div></div>
      ${canEdit ? '' : '<span class="muted"><small>Switch to Raghav to change rules</small></span>'}</div>
    <div class="card-b" style="display:flex;flex-direction:column;gap:16px">
      <div class="rules-grid">
        ${q('upliftApplies', [['both', 'Both averages (trend test unaffected)'], ['recent', 'Last 4 weeks only']])}
        ${q('conflictWinner', [['overstock', 'Overstock wins — pause'], ['high-demand', 'High-demand wins — reorder 1.5×']])}
      </div>
      <div class="rules-grid">${RULE_FIELDS.map(([k, label, hint]) => `
        <label class="field"><span><b style="color:var(--text);font-weight:500">${label}</b>${hint ? ` · ${hint}` : ''}</span>
          <input name="${k}" type="number" step="any" min="0" value="${r[k]}" ${canEdit ? '' : 'disabled'}></label>`).join('')}
      </div>
      ${canEdit ? `<label class="field"><span>Change note (required — saved with the new version)</span><textarea name="note" placeholder="What changed and why"></textarea></label>
      <div class="row"><button class="btn primary">Save as v${cur.version + 1}</button><span class="muted"><small>New rules apply from the next run. Past runs keep the version they used.</small></span></div>` : ''}
    </div>
  </form>
  <section class="card"><div class="card-h"><h3>Version history</h3></div><div class="card-b"><ul class="log">
    ${[...state.rulesHistory].reverse().map((v, i, arr) => `<li><b>v${v.version}</b> · ${esc(v.by)} · ${when(v.at)}<div>${esc(v.note)}</div>${arr[i + 1] ? `<p class="diff">${esc(diff(arr[i + 1].rules, v.rules) || 'No value changes')}${v.confirmed?.length ? ` · confirmed: ${v.confirmed.join(', ')}` : ''}</p>` : ''}</li>`).join('')}
  </ul></div></section>`;
}

// ---------- data ----------
function viewData() {
  return `
  <section class="card"><div class="card-h"><h3>SAP exports in use</h3><span class="muted"><small>${state.storage === 'neon' ? 'Stored in Neon Postgres (freshroots_desk)' : 'Local files: freshroots/data'}</small></span></div>
    <div class="table-wrap"><table><thead><tr><th>Dataset</th><th>File</th><th class="r">Rows</th><th>Updated</th></tr></thead>
    <tbody>${state.data.map((d) => `<tr><td>${d.key}</td><td><code>${d.file}</code></td><td class="r num">${d.missing ? '<span class="pill p-red">missing</span>' : d.rows}</td><td class="muted">${d.modified ? when(d.modified) : '—'}</td></tr>`).join('')}</tbody></table></div></section>
  <section class="card"><div class="card-h"><h3>Load a fresh export</h3></div><div class="card-b" style="display:flex;flex-direction:column;gap:12px">
    <p class="muted" style="margin:0">Drop in new CSVs from SAP before each Monday and Thursday run. Each file is recognised by its column headers (${Object.values(DATASETS).map((d) => d.file).join(', ')}) and replaces the current copy.</p>
    <div class="row"><input type="file" id="upload" accept=".csv,text/csv" multiple></div>
  </div></section>`;
}

// ---------- drawer ----------
function renderDrawer() {
  const r = state.run?.recs.find((x) => x.skuId === openSku);
  if (!r) return closeDrawer();
  const events = [
    [state.run.at, `Rule engine (v${state.run.rulesVersion}): ${ACTION[r.action][0]} · ${n0(r.qty)} units`],
    r.review && [r.review.at, `${r.review.by}: ${r.review.decision === 'override' ? `override to ${n0(r.review.qty)}` : 'accepted'}${r.review.reason ? ` — “${r.review.reason}”` : ''}`],
    r.procurement && [r.procurement.at, `${r.procurement.by}: ${r.procurement.decision} ${r.procurement.decision === 'approved' ? n0(r.procurement.qty) : ''}${r.procurement.reason ? ` — “${r.procurement.reason}”` : ''}${r.procurement.poNumber ? ` · Zoho PO ${r.procurement.poNumber}` : ''}`],
  ].filter(Boolean);
  $('#drawerBody').innerHTML = `
    <div class="row"><div><h2>${esc(r.name)}</h2><div class="sku-id">${r.skuId} · ${esc(r.category)} · ${esc(distName(r.distributorId))}${r.perishable ? ' · perishable' : ''}</div></div><span class="spacer"></span><button class="btn small" data-act="close">Close</button></div>
    <div class="row">${pill(ACTION[r.action])} ${pill(STATUS[r.status])}</div>
    <div>${spark(r.series, 470, 80)}<div class="row muted"><small>${r.series[0]?.week ?? ''}</small><span class="spacer"></span><small>${r.series.at(-1)?.week ?? ''}</small></div></div>
    <div class="stat-row"><div><span class="muted">12-wk avg</span><b>${n1(r.avgLong)}</b></div><div><span class="muted">Last 4</span><b>${n1(r.avgShort)}</b></div><div><span class="muted">Expected/wk</span><b>${n1(r.weeklyDemand)}</b></div><div><span class="muted">On hand</span><b>${n0(r.onHand)}</b></div><div><span class="muted">Cover</span><b>${n1(r.cover)} wk</b></div></div>
    <div><h3 style="margin-bottom:6px">Why</h3><ol class="trace">${r.trace.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>
    ${r.exceptions.length ? `<div><h3 style="margin-bottom:6px">Exceptions</h3><ul class="exc">${r.exceptions.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
    <div><h3 style="margin-bottom:6px">Raghav review</h3>${reviewForm(r)}</div>
    <div><h3 style="margin-bottom:6px">Audit trail</h3><ul class="log">${events.map(([at, t]) => `<li><span class="muted">${when(at)}</span><div>${esc(t)}</div></li>`).join('')}</ul></div>`;
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
}
function closeDrawer() {
  openSku = null;
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
}

// ---------- actions ----------
async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.message, true); }
}

async function newRun() {
  await act(async () => {
    const run = await api('runs', { method: 'POST', body: { by: role() } });
    filter = 'all';
    await load(run.id);
  }, 'New run created from the latest SAP export');
}

async function review(skuId, decision, form) {
  const qty = form.qty.value;
  const reason = form.reason.value;
  await act(async () => {
    if (decision === 'accept' && Number(qty) !== state.run.recs.find((r) => r.skuId === skuId).qty) {
      throw new Error('You changed the quantity — use Override and give a reason');
    }
    state.run = await api(`runs/${state.run.id}/recs/${skuId}/review`, { method: 'POST', body: { decision, qty, reason, by: 'Raghav' } });
    await load(state.run.id);
  }, decision === 'override' ? 'Override logged — sent to procurement' : 'Accepted — sent to procurement');
}

async function procure(skuId, decision) {
  const qty = $(`[data-qty="${skuId}"]`)?.value;
  let reason = '';
  if (decision === 'rejected') {
    reason = prompt('Why is this line rejected? (logged)') ?? '';
    if (!reason.trim()) return;
  }
  await act(async () => {
    await api(`runs/${state.run.id}/recs/${skuId}/procurement`, { method: 'POST', body: { decision, qty, reason, by: 'Procurement' } });
    await load(state.run.id);
  }, decision === 'approved' ? 'Approved' : 'Rejected');
}

async function approveAll() {
  const pending = state.run.recs.filter((r) => r.status === 'procurement');
  if (!confirm(`Approve all ${pending.length} lines at their recommended quantities?`)) return;
  await act(async () => {
    for (const r of pending) {
      const qty = $(`[data-qty="${r.skuId}"]`)?.value ?? r.finalQty;
      await api(`runs/${state.run.id}/recs/${r.skuId}/procurement`, { method: 'POST', body: { decision: 'approved', qty, by: 'Procurement' } });
    }
    await load(state.run.id);
  }, `${pending.length} lines approved`);
}

async function saveRules(form) {
  const fd = new FormData(form);
  const rules = {};
  for (const [k] of RULE_FIELDS) rules[k] = fd.get(k);
  rules.upliftApplies = fd.get('upliftApplies');
  rules.conflictWinner = fd.get('conflictWinner');
  await act(async () => {
    await api('rules', { method: 'POST', body: { rules, note: fd.get('note'), confirmed: fd.getAll('confirm'), by: 'Raghav' } });
    await load(state.run?.id ?? '');
  }, 'Rules saved as a new version — they apply from the next run');
}

async function upload(files) {
  for (const f of files) {
    await act(async () => {
      const res = await api('data', { method: 'POST', body: { text: await f.text() } });
      toast(`${f.name} → ${res.file} (${res.rows} rows)`);
    });
  }
  await load(state.run?.id ?? '');
}

// ---------- wiring ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-sku], [data-tab], [data-filter]');
  if (!t) return;
  if (t.dataset.tab) { tab = t.dataset.tab; store.set('fr.tab', tab); closeDrawer(); render(); return; }
  if (t.dataset.filter) { filter = t.dataset.filter; render(); return; }
  if (t.dataset.approve) return procure(t.dataset.approve, 'approved');
  if (t.dataset.reject) return procure(t.dataset.reject, 'rejected');
  const a = t.dataset.act;
  if (a === 'new-run') return newRun();
  if (a === 'approve-all') return approveAll();
  if (a === 'close') return closeDrawer();
  if (t.dataset.sku && !t.closest('form') && t.tagName !== 'BUTTON') { openSku = t.dataset.sku; renderDrawer(); }
});
document.addEventListener('submit', (e) => {
  const f = e.target;
  e.preventDefault();
  if (f.dataset.review) return review(f.dataset.review, e.submitter?.value ?? 'accept', f);
  if (f.id === 'rulesForm') return saveRules(f);
  if (f.id === 'loginForm') {
    return act(async () => {
      await api('login', { method: 'POST', body: { password: f.password.value } });
      document.body.classList.remove('signed-out');
      await load('');
    });
  }
  if (f.dataset.po) {
    return act(async () => {
      await api(`runs/${state.run.id}/po-number`, { method: 'POST', body: { poNumber: f.po.value, skuIds: f.dataset.po.split(',') } });
      await load(state.run.id);
    }, 'Zoho PO number recorded');
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'upload') upload([...e.target.files]);
});
$('#newRun').addEventListener('click', newRun);
$('#signOut').addEventListener('click', async () => { await api('logout', { method: 'POST' }); showLogin(); });
$('#runPick').addEventListener('change', (e) => load(e.target.value));
$('#role').value = store.get('fr.role', 'Raghav');
$('#role').addEventListener('change', () => { store.set('fr.role', role()); render(); });
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

load().catch((e) => { if (document.body.classList.contains('signed-out')) return; $('#view').innerHTML = `<div class="card empty"><h2>Can't reach the server</h2><p>${esc(e.message)}</p><p>Start it with <code>npm start</code> in the freshroots folder.</p></div>`; });
