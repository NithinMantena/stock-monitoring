# How Research Desk works

Updated September 20, 2026. Start here when maintaining the app; use [README.md](README.md) for setup, [API.md](docs/API.md) for the API contract, [INTEGRATIONS.md](docs/INTEGRATIONS.md) for MCP/OpenClaw, and [DEPLOYMENT.md](DEPLOYMENT.md) for deployment. This describes the implemented system, including its limits.

## The purpose

Research Desk is a private company research notebook with scheduled monitoring. You maintain notes, a thesis, watch points, sources, and numerical alert rules. The server discovers articles, retrieves available text, asks TypeSafe for structured judgments, and applies deterministic rules to decide where each development appears. Missing information stays visible as missing.

The software separates three decisions: whether a story concerns the company, whether the underlying development matters, and which available source best represents it. A useful financial release should not disappear merely because its original document is inaccessible or several publishers repeat it.

## Runtime and data flow

```mermaid
flowchart TD
    UI[React browser workspace] --> Client[Shared typed client]
    MCP[Local MCP server: stocks tools] --> Client
    Bot[OpenClaw skill and CLI] --> Client
    Client --> API[Authenticated Hono API v1]
    Cron[Hosted scheduler: every five minutes] --> API
    API --> Store[Versioned document store]
    Store --> Local[Local: SQLite]
    Store --> Cloud[Hosted: Supabase Postgres]
    API --> Discovery[Google News and configured primary sources]
    Discovery --> Retrieval[Available HTML or PDF text]
    Retrieval --> AI[TypeSafe structured judgments]
    AI --> Policy[Admission policy and development grouping]
    Policy --> Store
    Store --> UI
    Store --> Digest[Daily digest when enabled]
```

The frontend is built with React, TypeScript, and Vite. Cloudflare Pages serves the hosted bundle. Supabase runs the authenticated API and scheduled work. Local development uses the same API and domain modules with a Node.js server and SQLite instead. Local and hosted data are separate.

The local server binds to loopback and checks Host/Origin. Hosted requests validate the Supabase owner session or an expiring, scoped integration token. The scheduler uses a separate server secret. Browser and integration clients do not receive the database service key, TypeSafe key, or email key. Postgres row-level security and service-only functions protect storage writes, version checks, work leases, and AI budget reservations.

## One API, three channels

The website, MCP and OpenClaw call the same versioned API. `client/operations.ts` declares typed operations for research, monitoring configuration, developments, jobs, imports and exports. The official MCP SDK turns these into `stocks_*` tools; the OpenClaw CLI accepts the same arguments. The website uses the shared HTTP transport and preserves its owner-only bulk loading/editor compatibility routes. Domain rules stay in `_shared`; integrations never bypass them through database access.

Company writes use optimistic version checks. Notes can be appended without replacing a whole company; individual watch points, rules and feeds can be changed independently. Development feedback updates all existing duplicate members atomically. Required request keys prevent ordinary retry duplication, and an audit trail distinguishes website, MCP and OpenClaw actions. A crash after a domain write but before its response is recorded is reported as uncertain and requires inspection, rather than an automatic retry.

Integration credentials are shown once, hashed at rest, scoped, expiring and revocable in Settings. Starting paid work has a separate permission. Durable jobs enqueue quickly, expose status and support pause/cancel; the server performs bounded units under leases. The local worker runs while the Node server is running, and hosted jobs advance on scheduler ticks. Completed results survive interruption. The website polls small change metadata every five seconds while visible and retains draft conflict handling when another channel edits research.

## Where to change things

| File or directory | Responsibility |
| --- | --- |
| `src/main.tsx` | Sign-in, navigation, company editor, autosave, settings, imports, monitoring health |
| `src/news-panel.tsx` | News folders, filters, grouped cards, feedback, reader, search controls |
| `src/api.ts` | Browser API requests, session header, timeout and HTTP error handling |
| `client/` | Shared authenticated transport, typed operation catalog and private integration configuration |
| `mcp/`, `bot/`, `openclaw/` | MCP stdio server, Docker setup, OpenClaw CLI and skill |
| `src/integrations-panel.tsx` | Credential administration and durable job history |
| `src/sync.ts` | Version-aware incremental merges and stale batch-response protection |
| `src/drafts.ts` | Device draft recovery through IndexedDB |
| `src/ui.tsx`, `src/style.css` | Shared form/date helpers and responsive presentation |
| `supabase/functions/_shared/model.ts` | Company/settings schemas, event types, document/store contracts |
| `supabase/functions/_shared/api.ts` | Validated routes and orchestration |
| `supabase/functions/_shared/api-v1.ts` | Scoped versioned API, granular writes, pagination, retry ledger and audit |
| `supabase/functions/_shared/integrations.ts`, `job-queue.ts` | Credential lifecycle and durable API jobs |
| `supabase/functions/_shared/news-batch.ts` | Durable manual news search queue and pause/resume/cancel |
| `supabase/functions/_shared/jobs.ts` | Scheduled monitoring, article processing, reuse, retries, digest, snapshots |
| `supabase/functions/_shared/news.ts` | Search URLs, text cleanup, displayed news buckets and priority |
| `supabase/functions/_shared/article-content.ts` | Primary discovery, destination checks, redirects, extraction, text cache |
| `supabase/functions/_shared/news-screening.ts` | TypeSafe state, questions, response validation, chunk aggregation |
| `supabase/functions/_shared/screening-policy.ts` | Admission thresholds, explanations, lead-source ranking and grouping |
| `supabase/functions/_shared/event-inbox.ts` | Folder membership, expiration and company filtering |
| `supabase/functions/_shared/engine.ts` | Cadence, financial arithmetic, rule episodes, safe links and formatting |
| `supabase/functions/_shared/providers.ts` | RSS/Atom, provider configuration and market-data adapter |
| `supabase/functions/_shared/importer.ts`, `restore.ts` | Markdown conversion/export and full backup validation |
| `server/store.ts`, `_shared/supabase-store.ts` | SQLite and Supabase implementations of the same store interface |
| `supabase/functions/desk/index.ts` | Cloud authentication, scheduler authentication and CORS |
| `supabase/migrations` | Database schema, indexes, RPCs, private views and constraints |
| `tests` | Policy, retrieval, inbox, queue, storage and API regressions using fixtures |
| `scripts` | Diagnostics, evaluations, backups, disposable previews and performance checks |

A display-only change usually starts in `news-panel.tsx` or `style.css`. A TypeSafe question change starts in `news-screening.ts`; an admission decision starts in `screening-policy.ts`. Avoid re-reading or rewriting unrelated modules for a focused change. Live evaluation scripts can make paid calls; ordinary tests mock providers.

## Records and safe editing

Every stored document has a kind, ID, JSON data, monotonically increasing version, and update time. Companies contain identity, research, watch points, sources, rules, quote history, and monitoring checkpoints. Events contain the article or alert, provenance, publication/discovery dates, screening evidence, grouping information, and reader state.

Other record kinds hold settings, note revisions, import originals, job attempts/runs, daily snapshots, article cache entries, and the latest manual batch. A company research revision and its `newsRevision` are separate from the storage version. Relevant context changes invalidate screening reuse; background price updates do not turn into user research edits.

Company edits update the browser immediately, save a device draft, and are sent after a debounce. Saves include the expected server version and the original base. If another writer changed unrelated fields, the API merges the changes. Competing edits to the same field return a conflict. Background feed checkpoints and alert episodes are excluded from editable-field comparisons and preserved by the server. Changing a rule's meaning resets its trigger episode. Notes/thesis revisions preserve earlier content.

Event actions also update immediately. While a write is pending, the UI disables conflicting actions for that development. A failed save rolls back with a visible error. Review, Save, Useful, Noise, and Undo apply to all stored members of that development, even when some are outside the current filter. An omitted feedback field preserves existing feedback; explicit `null` clears it.

## Manual Search news

1. The current company selection becomes a saved batch. Only one active manual batch is allowed.
2. For the default Google News feed, the server makes a separate date-bounded search for each of the last seven UTC calendar days, including today. It keeps up to ten returned articles per day per company, preserving feed order. This means up to 70 Google News articles per company; Google determines the returned ranking and coverage. Configured primary sources are checked separately.
3. The batch stores its company position, source position, pending article queue, counts, warnings, and recorded tokens. Work advances in bounded requests and checkpoints after each step.
4. The visible page advances the queue and refreshes progress. Hosted scheduler ticks also advance it, so closing the browser does not cancel it. Local mode needs the app/server to remain available and has no hosted scheduler.
5. Pause preserves the queue; Resume continues it. Cancel ends that search and retains completed events. A current article may finish before the control takes effect. The control is checked before another step starts. Automatic monitoring is independent.

The worker uses a lease to avoid concurrent queue advancement. Each article also has a lease shared by manual, scheduled, and re-screen workers to avoid duplicate paid processing. A crashed worker's lease eventually expires; this can delay retry.

## Discovery, retrieval, and the reader

Google News supplies discovery links and snippets. Configured RSS feeds, IR pages, and SEC discovery provide additional primary material. Netflix, Progressive, Zoom, and American Coastal have built-in primary discovery defaults. Other companies can supply their own sources and SEC CIK. Name/ticker ambiguity still requires appropriate company identity and search context.

Retrieval resolves permitted links, validates redirect destinations, and extracts HTML with Readability or text from PDFs. Explicit host configuration governs feeds and primary pages. Public HTTPS publisher retrieval is enabled by default with destination/DNS checks for newly encountered hosts; private/local addresses are rejected. `ALLOW_PUBLIC_ARTICLE_HOSTS=false` restores strict article host configuration.

Text is cached and bounded to 120,000 characters. Content depth records whether full, partial, supplied, snippet, or unavailable text was used. That label describes the available extraction, not a guarantee that every page of a filing was read. Paywalls, CAPTCHA, JavaScript-only content, server blocking, discovery gaps, and extraction failures can prevent access. The publisher link remains available. The app does not bypass access controls.

**Read available text** uses retrieval/cache only. It does not call TypeSafe or change the event's classification, review state, or feedback.

## TypeSafe screening criteria

The active version is **fundamental-v2**. [The detailed implementation guide](docs/fundamental-screening-v2.md) is the source of truth for its flow, thresholds, evidence requirements and validation limits.

Code handles exclusions, retrieval, provenance, source blocks, budgets, cache keys and grouping. TypeSafe answers five separate core questions about identity, significance, attribution, contribution and currentness. Exact evidence selection and applicable quality/context/extraction guards accompany them. The displayed significance mean ranges from 0 to 4; admission uses probability mass over useful levels rather than a mean-score cutoff.

Primary and secondary reading recommendations are distinct from relevant developments. Secondary recaps remain Coverage; weak or missing evidence goes to Needs verification. No headline-only acceptance or broad options/calendar headline veto runs in v2. Long documents require document-level reconciliation rather than selecting the most positive chunk. Article-quality feedback can apply to one source without dismissing the whole development.

Prompts live in `screening-prompts.ts` and `news-screening.ts`. Code gates live in `fundamental-policy.ts`; compatibility, grouping and ranking remain in `screening-policy.ts`. Existing v1 records await bounded rescreening and preserve reader feedback.

## TypeSafe and token use

Long text is split into chunks of at most roughly 16 KB, up to 30 chunks within the article character limit. Chunks are screened sequentially, one request each. This avoids relying only on the beginning of a long filing, but long articles can require multiple model requests. Invalid responses, timeouts, unavailable credentials, and exhausted budgets remain explicit screening/retry states.

Before each request, the server atomically reserves a worst-case cost. It settles the reservation against returned input-token usage. Failed requests can leave a conservative reservation in the ledger. The configured default ceiling is $5/month, capped at $10; the code's current estimate is $0.042 per million input tokens. Provider invoices remain authoritative.

Sixteen million recorded input tokens are plausible across thousands of articles, repeated context, multiple chunks, and retries; they are not the same as sixteen million article words. The monthly ledger includes manual searches, scheduled checks, and re-screening. It cannot by itself attribute all usage to one button click. At 247 companies, the requested default allows up to 17,290 Google News items plus primary sources. Actual supply and deduplication usually lower the count.

Elapsed time also includes source fetches, sequential screening, database checkpoints, request limits, and waiting between five-minute scheduler ticks. Cost can therefore remain small while completion takes hours. Progress uses completed companies, checked articles, warnings, and recorded tokens to make this visible.

Retries reuse an unchanged classification when article content, provenance, screening version, and company context still match. Identical canonical content can reuse previous judgments. A reused URL with a different title/date is not sufficient evidence that two quarterly releases are the same development. Policy-only display changes can reuse stored judgments without an automatic full paid re-screen.

## Relevant developments, duplicates, and folders

The admission policy combines the model's judgments with source/content depth and user feedback; exact thresholds are in [TypeSafe screening criteria](#typesafe-screening-criteria). Supported primary evidence and substantive secondary reporting can enter Relevant developments. An explicit financial-results headline can qualify through a narrow fallback when the document is unavailable; the UI labels the evidence limitation. Uncertain identity or insufficient evidence generally remains in Needs verification. Noise remains inspectable.

Duplicates are grouped by company and development cluster. The best eligible source leads the card according to `screeningRank`. Additional coverage remains expandable. Grouping does not delete articles. Later updates with new information can remain distinct. Useful overrides screening; Noise suppresses the reader's development until undone.

Inbox holds unsaved, unreviewed events for 30 days after discovery or an explicit return to inbox. Saved has no time limit. History retains reviewed/expired unsaved items. Folders and screening buckets are separate: review status is not a judgment about fundamental importance. Filters operate on the full loaded dataset; the UI renders 50 grouped cards initially and adds 50 at a time.

The digest uses the same current policy/explanations and effective priority, with important developments before ordinary ones. It is prepared in America/Chicago time and sent through Resend only when enabled and configured. Delivery is idempotent for that local day.

## Automatic monitoring and numerical alerts

Owned and perpetual-watch companies default to daily monitoring; other active companies default to weekly, with individual overrides. Archived/paused companies are excluded as appropriate. Due-company selection, attempt checkpoints, and worker limits spread work across scheduler runs. Manual news search does not replace those schedules.

Quotes require a configured provider and confirmed instrument mapping. EODHD supplies daily closes; P/E and market capitalization currently require manual observations. Currency, session dates, stale observations, positive P/E, and potential discontinuities are checked in code. Rules include price thresholds, P/E thresholds, and decline from a baseline. A trigger episode suppresses repeats until recovery or a meaningful rule change rearms it. TypeSafe does not compute prices or trigger arithmetic.

## Synchronization and speed

Initial bootstrap supplies research and current inbox/saved events. The first full news update loads history. Later research refreshes use `/bootstrap?events=none`, and news refreshes request only records changed since the previous cursor. The cursor is taken before the read and filtering includes its boundary. Version-aware merges ignore older records, preserve pending actions, and reuse unchanged arrays. Batch responses are ordered by update time so a delayed progress response cannot undo a newer Pause.

Concurrent browser news refreshes share one pending request. Visible pages refresh every minute and after batch progress. Grouping computes source ranks and group timestamps once instead of recalculating them during every comparison. Filter/group calculations are memoized. Postgres already indexes owner/kind/update time; SQLite now indexes kind/update time.

These optimizations reduce repeated network transfers, sorting, rendering, and duplicated work. They do not lower screening thresholds, change the model/prompts, shorten the reading window, or reduce the requested discovery scope.

## Import, backup, and restore

Markdown import first produces a preview with ambiguity/duplicate choices. Original text is retained. Rollback removes untouched imported companies and preserves edited companies. Per-company Markdown export checks HTTP success before downloading.

Full JSON export includes companies, events, note revisions, settings, and import records. Quote history is stored with companies. Hosted daily research snapshots retain companies/research/settings/import originals for 30 days; they are narrower than full exports.

Restore accepts up to 100 MB and 20,000 records, validates the entire file before the first write, rejects inconsistent IDs/invalid rendered shapes, and inserts only missing records. Existing records are skipped. It is not an overwrite/merge tool or a single transaction: a storage failure partway through can leave partial progress, and retry skips already inserted records. Larger archives require a future paged restore path.

## Verification and review results

```powershell
npm run check
npm test
npm run build
npm run benchmark:news
```

The September 19 review passes 71 tests across eight files, including article retrieval, policy fixtures, inbox/queue controls, rule behavior, concurrent article processing, stale merges, feedback clearing, canonical URL reuse, digest ordering, and restore validation. TypeScript also rejects unused locals/parameters.

The benchmark in [validation/code-review-performance.json](validation/code-review-performance.json) compares old and optimized grouping on 12,000 synthetic articles over 21 warm samples. Measured median grouping time fell from about 41.1 ms to 23.7 ms (about 42% less time, 1.7× speed). Lead sources, coverage membership, and group order matched exactly. This measures in-process grouping, not total scan time or network latency.

Browser checks use disposable data: 30 companies and 4,000 articles. They cover desktop and phone layouts, pagination, Save, Useful/Undo, cancellation, article reading, note autosave/Markdown/revision history, and the keyboard-accessible add-company dialog. A monitoring-table overflow found during these checks was fixed. These checks do not establish that every possible UI state is defect-free.

The backend and frontend were deployed and checked with `scripts/verify-review.ts`. The hosted desk had 247 companies and 4,193 events; the next unchanged news refresh returned zero event records, and the lightweight research refresh omitted events. The existing batch remained paused at 740 checked articles. This verification made no paid AI calls and confirmed that the live site served the current production bundle.

To reproduce the disposable preview, run `npm run preview:review`, then in another PowerShell terminal:

```powershell
$env:REVIEW_API_TARGET='http://127.0.0.1:8788'
$env:VITE_SUPABASE_URL=''
$env:VITE_API_URL='/api'
npx vite --host 127.0.0.1 --port 5174
```

The review API uses in-memory fixtures without TypeSafe credentials. Do not substitute production data or run live evaluation scripts when a fixture test can answer the question.

The requested maximum 5% quality loss is treated conservatively: screening configuration and reading/discovery limits were preserved, and grouping output was checked for exact equivalence. There has not been a new statistical measurement of model recall/precision, so no numerical accuracy guarantee is claimed. Future changes to prompts, thresholds, content limits, or candidate selection should be evaluated against a labeled corpus before deployment.
