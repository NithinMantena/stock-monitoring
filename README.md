# Research Desk

A private stock research notebook and monitoring app for a few hundred researched companies. The approved product plan is in [PRD.md](PRD.md).

**New here, or want to understand how it all works? Read [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)**, a plain-language guide to the whole system: its parts, the nightly and weekly news runs, how an article is judged, limits, and troubleshooting. Programmers should continue with [ARCHITECTURE.md](ARCHITECTURE.md) for the system logic, news pipeline, token use, module map, synchronization, resource budgets and verification results.

Open [Research Desk](https://research-desk-2p0.pages.dev) on any device. Enter `nithin@mantena.com` and choose **Email me a sign-in link**; open the link on the device you want to use.

## What works

- One versioned read/write API for the website, MCP and OpenClaw. See [connection setup](docs/INTEGRATIONS.md) and the [API contract](docs/API.md). Settings includes scoped, expiring/revocable integration credentials and durable background-job history.
- Add a company by name, search its notes, change its status, archive it, and use research groups and tags.
- Edit Markdown notes and a thesis with automatic saves, revision history, device draft recovery, and conflict detection. Background market updates do not overwrite notes.
- Keep personal watch points. TypeSafe screens identity, business significance, attribution, contribution and currentness. Primary evidence and supported additional reporting or analysis become recommended readings. Recaps remain in Coverage; missing or uncertain evidence needs verification. [Screening architecture and thresholds](docs/fundamental-screening-v2.md).
- News & alerts opens as a newest-first inbox. Review clears a development; Save moves it to Saved, where it remains without a time limit. Unsaved unread items age into History 30 days after discovery; returning an item to the inbox starts a fresh 30-day window. Saved/reviewed state survives re-screening, and full exports retain it. While the page is visible it checks for changes every 5 seconds and fetches new news every minute. Each device keeps its own copy of the articles, so reopening the desk downloads only what changed.
- **Search news** takes up to 10 Google News items from each of the last seven UTC calendar days, including today, per selected company, preserving the feed's order within each day. Configured primary sources are also checked. Pause saves the queue, Resume continues it, and Cancel ends it while retaining completed articles. An in-flight article may finish before stopping. Progress and recorded TypeSafe tokens are shown. The saved queue continues on the hosted one-minute scheduler after the page closes, sharing each minute with the scheduled news runs; a large search can take hours. Scheduled runs and the digest have independent schedules.
- Filter articles by keyword, company, publisher, importance and publication dates. Noise/Useful/Reviewed/Save update immediately, save in the background, and roll back visibly if saving fails. Review and save actions cover all stored sources for the same development. Feedback can be undone.
- New companies receive a Google News RSS search with business context for ambiguous names. Refine it in Monitoring → Company news search. Add official IR/regulatory RSS/Atom feeds on explicitly enabled hosts. Accessible public HTTPS publisher pages can be retrieved after destination checks; every redirect is checked. Set `ALLOW_PUBLIC_ARTICLE_HOSTS=false` to require the explicit host list. Netflix, Progressive, Zoom and American Coastal have built-in SEC/IR discovery; other companies can configure primary pages, RSS feeds and a SEC CIK. **Read available text** fetches source text without AI screening. Paywalls, script-only pages and server blocks can prevent extraction; open the publisher link in that case. Reading and screening remain bounded to 120,000 characters.
- Record where an idea came from when adding a company or in its Research tab. Idea source is separate from original import-file provenance and is included in exports.
- **Scheduled news runs happen on the server, with no browser needed.** Every night at 1am Chicago time, a daily run searches the last day (26 hours) for Portfolio and Perpetual-watch companies. Every Friday at 6pm, a weekly sweep searches the last 7 days for every non-paused company, daily companies first. Individual frequency overrides (daily/weekly/paused) apply. Google requests are paced; rate limits (HTTP 429/503) are retried with back-off rather than skipped. Closing prices, the daily snapshot and up to 300 re-screens run once per night. Progress and recent runs appear in News & alerts.
- Price, positive trailing P/E, and baseline-decline rules, with repeat suppression, recovery/rearming, currency checks and discontinuity warnings.
- EODHD daily-close adapter. **A provider key and confirmed instrument mapping are required. P/E and market cap are manual observations in this first version.** No unverified numbers are populated.
- Markdown import preview, duplicate/ambiguity review, preserved originals, conservative rollback, full JSON export/restore, and per-company Markdown export.
- Hosted daily research snapshots, retained for 30 days. These retain companies, notes, rules, settings and original import files. Full manual exports additionally include events, note revisions and quote history.
- Chicago-time daily digest preview and idempotent Resend delivery (configured and delivering at 07:00 as of September 22, 2026). Delivery requires a verified sender, key and `ENABLE_EMAIL_DELIVERY=true`.

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

`.env.production.local`, when configured, makes the production bundle connect to Supabase. `npm run dev` continues to use local SQLite unless development Vite variables are set. With the production bundle built, `npm start` also serves the cloud-connected sign-in page at `http://127.0.0.1:8787`. Local and cloud desks are separate; JSON export/restore moves research between them.

## Hosted project

- Supabase project: **Stock Monitoring**, `tcfricxifanwwzgxgexj`.
- API: `https://tcfricxifanwwzgxgexj.supabase.co/functions/v1/desk`.
- Owner: `nithin@mantena.com`. Requests validate the owner's Supabase session or a scoped integration credential for the v1 API. The public key is not an authorization bypass.
- Function: `desk`. JWT verification at the platform gateway is disabled because the scheduled endpoint uses a separate secret; user JWTs are explicitly verified in the function itself.
- Tables use row-level security. Client roles cannot directly mutate records. Service-only RPCs implement version checks, leases, and atomic AI-budget reservations.
- Postgres cron invokes the worker every minute (job `research-desk-monitor`, schedule `* * * * *`). Each tick reads a small schedule record and does only due work: start or advance the daily/weekly news run (at most 10 articles a minute), advance a manual search or API job, nightly quotes/snapshot/re-screens, and at most one digest per Chicago day after 07:00. Idle minutes read a few hundred bytes. See [ARCHITECTURE.md](ARCHITECTURE.md#egress-and-resource-budgets) for the free-plan egress and CPU budgets.
- Scheduler credentials live in Supabase Vault. TypeSafe and email/data-provider credentials live in Edge Function secrets.

See [DEPLOYMENT.md](DEPLOYMENT.md) for remaining account setup and deployment commands. No paid data subscription was purchased by this implementation.

## Importing the existing research

The original Investment Pitch List has been imported into the hosted website: 257 source sections were consolidated into 245 company records. The existing Progressive and Deckers Outdoors records retained their edits and received their original research notes. Repeated names were combined with all source sections preserved; ambiguous short names are tagged for identity confirmation and their automatic monitoring is paused. The original file remains in private import archives and exports.

For additional files, use Import & backup to preview the entries before importing. A rollback removes untouched imported companies and preserves companies edited after import. The initial hosted import can be reproduced idempotently with `scripts/seed-prepared-import.ts`; it previews by default and applies only with `--apply`.

## Data and cost boundaries

TypeSafe judges text that the app supplies; it does not discover news or retrieve financial data. The server reserves a worst-case request cost before classification and enforces a $5/month default TypeSafe ceiling (configurable up to $10). Settings shows recorded usage, including reservations for failed requests. Provider-side billing remains the source of truth. Numerical prices, dates, schedules and alert arithmetic are computed in code.

Admission policy changes reuse stored judgments without an automatic full AI re-screen. Unchanged article retries and identical canonical content reuse the existing classification. For 247 companies, the manual seven-day scope allows up to 17,290 Google News items; this is a maximum, not a target. `node scripts/diagnose-news.ts` reads hosted counts and usage without model calls. Monthly usage includes all monitoring, retries and manual searches, not just the latest button click.

The $25/month total budget is a target, not an assurance of comprehensive global market/fundamental/news coverage. Choose subscriptions only after verifying actual instrument coverage, valuation fields, and whether personal or business licensing applies. Small companies and non-English news can have significant coverage gaps. A successful feed fetch establishes that the feed responded, not that all material events were found.

## Implementation layout

| Path | Purpose |
| --- | --- |
| `src/main.tsx`, `src/style.css` | Fast browser workspace and company editor |
| `src/news-panel.tsx`, `src/api.ts`, `src/sync.ts` | News UI, request/error handling and incremental synchronization |
| `src/drafts.ts` | Asynchronous IndexedDB recovery for unsynced edits |
| `src/news-cache.ts` | Per-device IndexedDB copy of articles for incremental sync |
| `supabase/functions/_shared/scheduler.ts` | The one-minute scheduler: daily and weekly news runs, nightly chores, digest |
| `supabase/functions/_shared/news-batch.ts` | Run engine for scheduled runs and manual searches (bookmarks, back-off, warnings) |
| `supabase/functions/_shared/fetch-policy.ts` | Google pacing and rate-limit handling, per-run publisher skipping |
| `supabase/functions/_shared` | Shared API, schemas, import logic, monitor, TypeSafe and RSS/EODHD adapters |
| `server` | Local Hono server and SQLite store |
| `supabase/functions/desk` | Authenticated cloud entry point |
| `supabase/migrations` | Private schema, concurrency RPCs, small UI views and snapshots |
| `tests/` | 223 automated checks: alerts, cadence, scheduling, sources, budgets, concurrency, retrieval, import and backup |
| `scripts` | Setup, deployment verification, backups and removable local QA fixtures |

The latest validation and remaining PRD scope are documented in [IMPLEMENTATION.md](IMPLEMENTATION.md).
