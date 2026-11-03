# Freshroots Demand Desk

Twice-weekly demand planning for Freshroots (MESA AI-Native Track, Term 2 case — Deepa's 90-day mandate).
Demand Planning was chosen first via the 9 checks; this is the build.

## Run it

```bash
npm start          # http://localhost:3500
npm test           # rules engine + full approval cycle
```

Node 22+. One dependency: `@neondatabase/serverless`.

## Storage

With `DATABASE_URL` in `.env`, everything lives in **Neon Postgres** — database `freshroots_desk` in the
Freshroots Neon project (same project as `freshroots-demand-planning`, separate database). Tables:

- `desk_rule_versions` — every rules version, note, author, which open questions Raghav confirmed
- `desk_runs` — one row per Mon/Thu run: rules version used, data as-of date, data age
- `desk_recommendations` — one row per SKU per run: rule fired, recommended qty, exceptions,
  Raghav's decision/qty/reason, procurement's decision/qty/reason and Zoho PO number
- `desk_datasets` — the current SAP exports (seeded from `data/` on first start; uploads replace them)

Schema is created on startup. Without `DATABASE_URL` the app falls back to `store/db.json` + `data/`.
Tests never touch the real database: they use a temp file, or a throwaway Neon database via `TEST_DATABASE_URL`.

## Live

https://freshroots-demand-desk-gamma.vercel.app — Vercel team `mesa-ced3`, project `freshroots-demand-desk`, region sin1
(next to the Neon database). Sign-in uses the shared desk password (`APP_PASSWORD` in `.env`).

```bash
npx vercel deploy --prod --scope mesa-ced3
```

`api/index.mjs` hands every `/api/*` request to the same handler as the local server; `public/` is served as static files.
Production env vars: `DATABASE_URL`, `APP_PASSWORD`, `SESSION_SECRET`.

## How a cycle works (Mon + Thu)

1. **Data** — drop fresh SAP exports on the Data tab (recognised by column headers). Files live in `data/`.
2. **Start new run** — applies the current rules version: festival uplift first (Oct/Nov/Mar, +25%), then
   high-demand (last 4 wks > 20% above 12-wk avg → 1.5× standard), stockout (< 6 wks cover → reorder now),
   overstock (> 14 wks → pause), perishables 3–4 wks.
3. **Raghav's queue** — exceptions only: new SKUs (< 12 wks history), rule conflicts, week-on-week swings > 30%.
   Overrides need a reason.
4. **Procurement** — approves or rejects every line. Nothing orders itself. Approved lines export as a
   Zoho Inventory PO import CSV, grouped by distributor; the Zoho PO number is recorded back.
5. **Metrics** — data age, override rate, exceptions, and the four kill criteria.

Rules are versioned (Rules tab, Raghav only, change note required). Raghav's two open questions — where the
festival uplift applies, and which rule wins a high-demand/overstock conflict — are settings marked unconfirmed
until he ticks them.

Every decision is stored in `store/db.json`; the audit log CSV per run has rule fired, quantities, overrides and reasons,
procurement action and Zoho PO number.

## Layout

- `public/rules.js` — the rules engine (pure; shared by browser, server and tests)
- `server.mjs` — API + static server
- `public/` — UI
- `data/` — SAP exports and the case brief PDF
