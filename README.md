# Research Desk

A private stock research notebook and monitoring app for a few hundred researched companies. The approved product plan is in [PRD.md](PRD.md).

## What works

- Add a company by name, search its notes, change its status, archive it, and use research groups and tags.
- Edit Markdown notes and a thesis with automatic saves, revision history, device draft recovery, and conflict detection. Background market updates do not overwrite notes.
- Keep personal watch points. TypeSafe screens each supplied news item for company identity, material events, watch-point relevance, direction, and supporting evidence. Uncertain or failed classifications remain visible.
- New companies receive a broad Google News RSS search. Add official IR/regulatory RSS/Atom feeds on explicitly enabled hosts. The feed supplies headlines/snippets; the app does not scrape full articles or claim complete news coverage.
- Owned and perpetual-watch companies run daily. Other active companies run weekly, with individual overrides. Weekly checks retain a full lookback and preserve publication/discovery dates.
- Price, positive trailing P/E, and baseline-decline rules, with repeat suppression, recovery/rearming, currency checks and discontinuity warnings.
- EODHD daily-close adapter. **A provider key and confirmed instrument mapping are required. P/E and market cap are manual observations in this first version.** No unverified numbers are populated.
- Markdown import preview, duplicate/ambiguity review, preserved originals, conservative rollback, full JSON export/restore, and per-company Markdown export.
- Hosted daily research snapshots, retained for 30 days. These retain companies, notes, rules, settings and original import files. Full manual exports additionally include events, note revisions and quote history.
- Chicago-time daily digest preview and idempotent Resend delivery. **Delivery is off until a verified sender and key are configured.**

## Run locally

Use Node.js 24 or later (native SQLite and TypeScript support):

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. The API binds only to `127.0.0.1:8787`, validates Host and Origin, and stores private data in `.local/desk.sqlite`. It is not exposed as an unauthenticated Internet server. Local monitoring is on demand; automatic scheduling is hosted in Supabase.

Optionally copy `.env.example` to `.env` and fill only the server settings you need. Existing process environment variables work too. Never put a secret in a `VITE_` variable.

```powershell
npm test
npm run check
npm run build
npm run test:api
npm run backup
npm run import:preview
```

`.env.production.local`, when configured, makes the production bundle connect to Supabase. `npm run dev` continues to use local SQLite unless development Vite variables are set. With the production bundle built, `npm start` also serves the cloud-connected sign-in page at `http://127.0.0.1:8787` while permanent static hosting is being configured. Local and cloud desks are separate; JSON export/restore moves research between them.

## Hosted project

- Supabase project: **Stock Monitoring**, `tcfricxifanwwzgxgexj`.
- API: `https://tcfricxifanwwzgxgexj.supabase.co/functions/v1/desk`.
- Owner: `nithin@mantena.com`. Every API request validates a Supabase session and the allowed owner. The public key is not an authorization bypass.
- Function: `desk`. JWT verification at the platform gateway is disabled because the scheduled endpoint uses a separate secret; user JWTs are explicitly verified in the function itself.
- Tables use row-level security. Client roles cannot directly mutate records. Service-only RPCs implement version checks, leases, and atomic AI-budget reservations.
- Postgres cron invokes the worker every five minutes. The worker selects only due companies, resumes bounded batches, and sends at most one digest per Chicago day after 07:00 when enabled.
- Scheduler credentials live in Supabase Vault. TypeSafe and email/data-provider credentials live in Edge Function secrets.

See [DEPLOYMENT.md](DEPLOYMENT.md) for remaining account setup and deployment commands. No paid data subscription was purchased by this implementation.

## Importing the existing research

The original Investment Pitch List is staged privately for review. Open **Import & backup → Review prepared import**. The parser found 257 candidate company sections; 48 require review. Duplicate names are kept separate and flagged. Narrative bullets stay with their company, original research-group headings are retained, and historic valuation notes are never treated as current quotes.

Review checked entries and ambiguous names before committing. The original file is preserved in exports even if an entry is not selected. A rollback removes untouched imported companies and preserves companies edited after import.

## Data and cost boundaries

TypeSafe judges text that the app supplies; it does not discover news or retrieve financial data. The server reserves a worst-case request cost before classification and enforces a $2/month TypeSafe ceiling. Settings shows recorded usage, including reservations for failed requests. Provider-side billing remains the source of truth. Numerical prices, dates, schedules and alert arithmetic are computed in code.

The $25/month total budget is a target, not an assurance of comprehensive global market/fundamental/news coverage. Choose subscriptions only after verifying actual instrument coverage, valuation fields, and whether personal or business licensing applies. Small companies and non-English news can have significant coverage gaps. A successful feed fetch establishes that the feed responded, not that all material events were found.

## Implementation layout

| Path | Purpose |
| --- | --- |
| `src/main.tsx`, `src/style.css` | Fast browser workspace and company editor |
| `src/drafts.ts` | Asynchronous IndexedDB recovery for unsynced edits |
| `supabase/functions/_shared` | Shared API, schemas, import logic, monitor, TypeSafe and RSS/EODHD adapters |
| `server` | Local Hono server and SQLite store |
| `supabase/functions/desk` | Authenticated cloud entry point |
| `supabase/migrations` | Private schema, concurrency RPCs, small UI views and snapshots |
| `tests/core.test.ts` | Alert, cadence, source, budget, concurrency, import and backup checks |
| `scripts` | Setup, deployment verification, backups and removable local QA fixtures |

The latest validation and remaining PRD scope are documented in [IMPLEMENTATION.md](IMPLEMENTATION.md).
