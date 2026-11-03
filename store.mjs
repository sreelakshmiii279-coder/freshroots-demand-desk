// Persistence for the Demand Desk. Neon Postgres when DATABASE_URL is set, else a local JSON file.
// Both stores expose the same async interface, so server.mjs never knows which one it has.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DEFAULT_RULES, DATASETS } from './public/rules.js';

const INITIAL_RULES = { version: 1, rules: DEFAULT_RULES, note: 'Initial version — transcribed from Raghav\'s documented rules.', by: 'System', confirmed: [] };

const readSeed = (dataDir) => Object.fromEntries(Object.entries(DATASETS).map(([key, { file }]) => {
  const path = join(dataDir, file);
  return [key, existsSync(path) ? { file, content: readFileSync(path, 'utf8'), updatedAt: statSync(path).mtime.toISOString() } : null];
}));

// ---------- Neon ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS desk_rule_versions (
     version    int PRIMARY KEY,
     rules      jsonb NOT NULL,
     note       text NOT NULL,
     by_name    text NOT NULL,
     at         timestamptz NOT NULL DEFAULT now(),
     confirmed  text[] NOT NULL DEFAULT '{}'
   )`,
  `CREATE TABLE IF NOT EXISTS desk_runs (
     id             text PRIMARY KEY,
     at             timestamptz NOT NULL DEFAULT now(),
     by_name        text NOT NULL,
     rules_version  int NOT NULL REFERENCES desk_rule_versions(version),
     as_of          date,
     last_week      text,
     festival       boolean NOT NULL,
     data_age_days  int
   )`,
  // One row per recommendation: what the rules said, what Raghav did, what procurement did.
  `CREATE TABLE IF NOT EXISTS desk_recommendations (
     run_id               text NOT NULL REFERENCES desk_runs(id) ON DELETE CASCADE,
     sku_id               text NOT NULL,
     sku_name             text NOT NULL,
     distributor_id       text,
     rule_fired           text NOT NULL,
     action               text NOT NULL,
     recommended_qty      int NOT NULL,
     weeks_of_cover       numeric,
     exceptions           jsonb NOT NULL DEFAULT '[]',
     engine               jsonb NOT NULL,
     raghav_decision      text CHECK (raghav_decision IN ('accept', 'override')),
     raghav_qty           int,
     raghav_reason        text,
     raghav_by            text,
     raghav_at            timestamptz,
     procurement_decision text CHECK (procurement_decision IN ('approved', 'rejected')),
     procurement_qty      int,
     procurement_reason   text,
     procurement_po       text,
     procurement_by       text,
     procurement_at       timestamptz,
     PRIMARY KEY (run_id, sku_id)
   )`,
  `CREATE TABLE IF NOT EXISTS desk_datasets (
     key         text PRIMARY KEY,
     file        text NOT NULL,
     content     text NOT NULL,
     updated_at  timestamptz NOT NULL DEFAULT now()
   )`,
];

const iso = (v) => (v instanceof Date ? v.toISOString() : v);

function rowToRec(r) {
  return {
    ...r.engine,
    review: r.raghav_decision
      ? { decision: r.raghav_decision, qty: r.raghav_qty, reason: r.raghav_reason ?? '', by: r.raghav_by, at: iso(r.raghav_at) }
      : undefined,
    procurement: r.procurement_decision
      ? { decision: r.procurement_decision, qty: r.procurement_qty, reason: r.procurement_reason ?? '', poNumber: r.procurement_po ?? '', by: r.procurement_by, at: iso(r.procurement_at) }
      : undefined,
  };
}

export async function neonStore(url, { dataDir }) {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);
  const q = (text, params = []) => sql.query(text, params);

  for (const stmt of SCHEMA) await q(stmt);
  await q(`INSERT INTO desk_rule_versions (version, rules, note, by_name, confirmed) VALUES (1, $1, $2, $3, '{}') ON CONFLICT DO NOTHING`,
    [JSON.stringify(INITIAL_RULES.rules), INITIAL_RULES.note, INITIAL_RULES.by]);
  for (const [key, seed] of Object.entries(readSeed(dataDir))) {
    if (seed) await q(`INSERT INTO desk_datasets (key, file, content, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [key, seed.file, seed.content, seed.updatedAt]);
  }

  return {
    kind: 'neon',
    async rules() {
      const rows = await q('SELECT * FROM desk_rule_versions ORDER BY version');
      return rows.map((r) => ({ version: r.version, rules: r.rules, note: r.note, by: r.by_name, at: iso(r.at), confirmed: r.confirmed }));
    },
    async addRules(v) {
      const [row] = await q(
        `INSERT INTO desk_rule_versions (version, rules, note, by_name, confirmed)
         SELECT COALESCE(MAX(version), 0) + 1, $1, $2, $3, $4 FROM desk_rule_versions RETURNING *`,
        [JSON.stringify(v.rules), v.note, v.by, v.confirmed]);
      return { version: row.version, rules: row.rules, note: row.note, by: row.by_name, at: iso(row.at), confirmed: row.confirmed };
    },
    async runs() {
      const [runs, recs] = await Promise.all([
        // as_of::text — a bare DATE comes back as local midnight and shifts a day when converted to UTC.
        q('SELECT *, as_of::text AS as_of FROM desk_runs ORDER BY at, id'),
        q('SELECT * FROM desk_recommendations ORDER BY run_id, sku_id'),
      ]);
      const byRun = Map.groupBy(recs, (r) => r.run_id);
      return runs.map((r) => ({
        id: r.id, at: iso(r.at), by: r.by_name, rulesVersion: r.rules_version, asOf: r.as_of,
        lastWeek: r.last_week, festival: r.festival, dataAgeDays: r.data_age_days,
        recs: (byRun.get(r.id) ?? []).map(rowToRec),
      }));
    },
    async addRun(run) {
      const [{ n }] = await q(`SELECT COALESCE(MAX(substring(id from 2)::int), 0) + 1 AS n FROM desk_runs WHERE id ~ '^R[0-9]+$'`);
      const id = `R${String(n).padStart(3, '0')}`;
      await sql.transaction([
        sql`INSERT INTO desk_runs (id, at, by_name, rules_version, as_of, last_week, festival, data_age_days)
            VALUES (${id}, ${run.at}, ${run.by}, ${run.rulesVersion}, ${run.asOf || null}, ${run.lastWeek}, ${run.festival}, ${run.dataAgeDays})`,
        ...run.recs.map((r) => sql`INSERT INTO desk_recommendations
            (run_id, sku_id, sku_name, distributor_id, rule_fired, action, recommended_qty, weeks_of_cover, exceptions, engine)
            VALUES (${id}, ${r.skuId}, ${r.name}, ${r.distributorId}, ${r.rule}, ${r.action}, ${r.qty},
                    ${Number.isFinite(r.cover) ? r.cover : null}, ${JSON.stringify(r.exceptions)}, ${JSON.stringify({ ...r, cover: Number.isFinite(r.cover) ? r.cover : null })})`),
      ]);
      return { ...run, id };
    },
    async saveReview(runId, skuId, v) {
      await q(`UPDATE desk_recommendations SET raghav_decision=$3, raghav_qty=$4, raghav_reason=$5, raghav_by=$6, raghav_at=$7
               WHERE run_id=$1 AND sku_id=$2 AND procurement_decision IS NULL`, [runId, skuId, v.decision, v.qty, v.reason, v.by, v.at]);
    },
    async saveProcurement(runId, skuId, v) {
      await q(`UPDATE desk_recommendations SET procurement_decision=$3, procurement_qty=$4, procurement_reason=$5, procurement_po=$6, procurement_by=$7, procurement_at=$8
               WHERE run_id=$1 AND sku_id=$2`, [runId, skuId, v.decision, v.qty, v.reason, v.poNumber, v.by, v.at]);
    },
    async savePoNumber(runId, skuIds, po) {
      await q(`UPDATE desk_recommendations SET procurement_po=$3 WHERE run_id=$1 AND sku_id = ANY($2) AND procurement_decision='approved'`, [runId, skuIds, po]);
    },
    async datasets() {
      const rows = await q('SELECT * FROM desk_datasets');
      return Object.fromEntries(rows.map((r) => [r.key, { file: r.file, content: r.content, updatedAt: iso(r.updated_at) }]));
    },
    async putDataset(key, content) {
      await q(`INSERT INTO desk_datasets (key, file, content, updated_at) VALUES ($1, $2, $3, now())
               ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`, [key, DATASETS[key].file, content]);
    },
  };
}

// ---------- local JSON file ----------
export function fileStore(path, { dataDir }) {
  const load = () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { rules: [{ ...INITIAL_RULES, at: new Date().toISOString() }], runs: [] });
  const save = (db) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(db, null, 2));
    renameSync(`${path}.tmp`, path);
  };
  const edit = (fn) => { const db = load(); const out = fn(db); save(db); return out; };
  const rec = (db, runId, skuId) => db.runs.find((r) => r.id === runId)?.recs.find((r) => r.skuId === skuId);
  save(load());

  return {
    kind: 'file',
    async rules() { return load().rules; },
    async addRules(v) {
      return edit((db) => { const next = { ...v, version: db.rules.at(-1).version + 1, at: new Date().toISOString() }; db.rules.push(next); return next; });
    },
    async runs() { return load().runs; },
    async addRun(run) {
      return edit((db) => {
        const n = db.runs.reduce((m, r) => Math.max(m, Number(r.id.slice(1)) || 0), 0) + 1;
        const saved = { ...run, id: `R${String(n).padStart(3, '0')}` };
        db.runs.push(saved);
        return saved;
      });
    },
    async saveReview(runId, skuId, v) { edit((db) => { rec(db, runId, skuId).review = v; }); },
    async saveProcurement(runId, skuId, v) { edit((db) => { rec(db, runId, skuId).procurement = v; }); },
    async savePoNumber(runId, skuIds, po) {
      edit((db) => { for (const id of skuIds) { const r = rec(db, runId, id); if (r?.procurement?.decision === 'approved') r.procurement.poNumber = po; } });
    },
    async datasets() { return Object.fromEntries(Object.entries(readSeed(dataDir)).filter(([, v]) => v)); },
    async putDataset(key, content) { writeFileSync(join(dataDir, DATASETS[key].file), content); },
  };
}

export async function openStore({ databaseUrl, filePath, dataDir }) {
  return databaseUrl ? neonStore(databaseUrl, { dataDir }) : fileStore(filePath, { dataDir });
}
