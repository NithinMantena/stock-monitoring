# Implementation status — 2026-09-17 Chicago

For how the current system works end to end, see [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) (plain language) and [ARCHITECTURE.md](ARCHITECTURE.md) (technical). This file is a dated log of what shipped and how it was verified.

## Headline-first screening (v3) — 2026-09-23

- Rebuilt article screening around what is known about every article: company, headline, publisher, snippet and code-computed age. Text is read when possible and refines the same answers, but is never required. Spec: [docs/fundamental-screening-v3.md](docs/fundamental-screening-v3.md). Research basis: `research/google-rate-limits-2026-09-22` and `research/typesafe-screening-2-2026-09-22`.
- Google article links: a headline pass first. The link is opened once, only if the headline does not rule the article out or it may be major. Refusals, including the `google.com/sorry` redirect that was previously misread as an ordinary unreadable page, are never retried; lookups pause for the rest of a run after two refusals. Direct links are read first. Rescreens never contact Google. Only processing failures are retried.
- Removed the missing-text, missing-context, evidence and contribution verification gates. Added purpose (7-way Choice) and issuer-release questions, the cookbook-style evidence split, a "same development?" Noul for grouping (≥ 0.7, up to 4 candidates), code-checked stale fiscal periods, and lead-source ranking by provenance. Secondary reports of a development now stay relevant under one card. Accept TypeSafe near-tie choices instead of failing the article (about 0.8% of v2 screenings).
- Verified: 238 tests, TypeScript and the production build pass. Live test on 90 real labelled articles ([validation/screening-v3-live.json](validation/screening-v3-live.json)):
  - with Google refusing every lookup: 21 of 23 developments surfaced (v2: 5), and 3–4 articles needed verification (v2: 73);
  - with text: all 23 surfaced, and each became one card.
- Also shipped: a scope for manual screens (companies matching filters, daily companies or all monitored; 1–30 days; 3–20 articles per day), an **Email today's latest screen** button (`POST /digest/latest-run`), and migration `202609230007_slim_event_reads.sql`. The migration makes browser reads omit TypeSafe raw answers, probabilities, comparisons and duplicate evidence. Opening the desk had grown to a 19 MB, 38-second download; after the changes below it is about 1 MB in 4 seconds.
- Deployed 2026-09-24 04:00 UTC: the `desk` function, the migration (applied with `supabase db query --linked --file`) and the frontend. Commit `868c42f` is on branch `screening-v3-headline-first`.
- Fresh start: `scripts/fresh-start-news.ts --apply` saved a full backup (`.local/fresh-start-backup-2026-09-24T04-03-44-247Z.json`, 7,659 records). It then removed all 6,476 stored news articles, 7,478 article-cache records and the rescreen queue. Companies, notes, settings, 931 monitoring alerts and digests were kept. Restore through Import & backup if ever needed.
- Monitoring alerts: the nightly "no price source" check created a new health alert per company every night (931 by Sept 24). It no longer raises an alert. The 931 stored alerts were deleted after a local backup (`.local/health-alerts-backup-2026-09-24T04-11-52-419Z.json`).
- Off-site backups: `GET /export?scope=essential` (companies, revisions, settings, imports, and acted-on articles without stored text or model internals; 0.76 MB live). The private repo `NithinMantena/research-desk-backups` commits it weekly via GitHub Actions (workflow mirrored in `ops/backup-repo/`).

## Log ingestion reduction — 2026-09-25

- **Why:** the Supabase org passed the free plan's 1 GB/month log ingestion (1.27 GB). Every request is logged at ~1–2 KB, so idle polling was the cost: this project ~60 MB/day (the every-minute scheduler, ~1,440 idle calls a day, plus the page's 5-second `/changes` poll), the reading app ~33 MB/day.
- **Scheduler:** `202609250009_gated_scheduler.sql` adds `desk_scheduler_due()`; pg_cron only calls `/scheduled` while a run, manual batch or job is active/queued, while re-screens or tonight's quotes are pending, or every 10th minute. Runs, backup and digest start up to ~10 minutes after their scheduled time; in-progress work is unchanged.
- **Jobs:** `POST /v1/jobs` and resume take the first bounded step in the background (`EdgeRuntime.waitUntil`, hosted only), so `stocks_start_news_search`, `stocks_start_monitoring` and `stocks_analyze_article` start at once. Read/edit tools were never affected.
- **Browser:** `/changes` poll 5 s → 30 s.
- **Validation:** 248 tests, typecheck and build pass. Live: `cron.job_run_details` shows `0 rows` (no HTTP call) on idle minutes after the change.
- **Expected:** ~20–30 MB/day for this project.

## Scheduled news runs, Google politeness and egress reduction — 2026-09-22

- **Why:** a 10-company profile showed about 50 s per company, mostly network waits: publisher pages 60%, Google lookups 20%, TypeSafe only 10%. News depended on an open browser tab or 20-second slices every five minutes. The free plan's 5 GB egress was exhausted, mostly by the five-minute scheduler re-reading every stored article. In the cloud, about 9 in 10 recent article lookups had been refused by Google (HTTP 429/503) and saved as unreadable.
- **Schedule:** a one-minute scheduler tick (`scheduler.ts`). A daily run at 1am Chicago covers daily-cadence companies over the last 26 hours. A weekly sweep on Friday at 6pm covers all non-paused companies over 7 days, daily companies first; Saturday's daily run is skipped. Quotes, the snapshot and up to 300 rescreens run nightly. Manual searches and API jobs continue without a browser. Run status and history appear on the News page.
- **Google and publishers:** requests are paced (2 s / 0.6 s) with adaptive slow-down. 429/503 are retried after 1–30 minute back-offs rather than recorded as unreadable, and a step is given up only after 5 refusals. The Google article page is requested directly, cutting 3 Google requests per article to 2. Publisher timeout is 8 s. Publishers that block or time out twice are skipped for the rest of a run.
- **Egress:** projected, id and cluster store reads; nightly chores; the per-slice history cache; fewer run saves; an IndexedDB article cache in the browser; changed-company-only reloads. An idle minute fell from roughly 19 MB per five minutes to about 370 bytes. The estimate is about 0.7–0.8 GB per month.
- **CPU:** at most 10 articles per tick (~80 ms CPU each measured).
- **Validation:** 223 tests (12 new) plus the production build pass. Supabase projection/id/cluster queries were verified read-only against live data. An end-to-end scheduler run on 10 real companies with real Google/TypeSafe: 307 checked, 144 new, no errors, median tick CPU 1.08 s at 15 articles, 15 store calls and ~28 KB read per new article. Deployed: live ticks return HTTP 200 every minute, and the first live rescreen throttle paused rescreens for 30 minutes as designed.
- **Not yet observed in production:** the first scheduled daily run (1am, September 23) and weekly sweep (September 25). Throughput depends on how strongly Google throttles the shared cloud address.

## Filtered manual news searches and inbox — 2026-09-18

- Search news uses the exact selected company IDs from status, research-group, text and individual-company filters. A persisted queue processes all selected companies across bounded requests, rather than the regular monitor's five-company slice. Existing events are deduplicated; no quotes are fetched.
- Manual work has its own lease and leaves regular monitoring timestamps, attempt records, feed success cursors and digest settings unchanged. Browser requests advance the queue; the hosted five-minute scheduler continues it after normal monitoring/digest work if the page closes.
- News & alerts defaults to an unread inbox, ordered by the newest discovered source in a development. Review and Save apply across its stored coverage. Saved items have no age limit; unsaved unread items age into History after 30 days. History supports returning to the inbox. Retention is a display rule, not deletion; exports retain events.
- Save/review/return state survives re-screening. The page refreshes while visible and on return to the tab. Migration `202609180005_news_batches.sql` adds the queue record kind. Regression tests cover filter scope, resumability beyond five companies, scheduling independence, source failures, deduplication, expiry boundaries, saved retention and state persistence.


## Fundamental news screening — 2026-09-18

- Default feed now requires fundamental significance and sufficient evidence; secondary articles must also supply substantiated reporting and significant original analysis. Company identity alone no longer admits a story. Calendar notices, routine holdings changes, options chatter and excluded publishers are screened out.
- Jev judges descriptive materiality/quality/added-value scales, supporting evidence and candidate event relationships. Actual results qualify as substantive primary evidence. Model, policy version, context revision, evidence depth, character counts and reasons are retained.
- Accessible HTML and PDF extraction, explicit publisher-host controls and a cached best-effort Google News link resolver. No paywall/challenge bypass. Long text is assessed across bounded chunks up to 120,000 characters. EDGAR SGML wrappers, table cell boundaries and linked financial exhibits are supported.
- Netflix and Progressive have built-in SEC submission/IR discovery. Their scale is set to large using the owner's instruction. Company monitoring provides dated business context, source references, SEC CIK, extra primary sources, enabled publishers and excluded-source preferences. Other companies still need source/scale setup where research context is inadequate.
- One visible development groups matching coverage, prioritizes primary sources, and preserves meaningful subsequent developments separately. Digest grouping uses the same policy; potentially major uncertain items are labeled for verification. Review marks cover the displayed group. Feedback reasons and manual Useful/Noise decisions are preserved when re-screening.
- Default TypeSafe budget raised to $5/month; configured ceilings are bounded at $10. Provider invoices remain authoritative. The scheduled worker processes pending legacy/retry items in bounded batches. Changing screening context queues re-evaluation.
- Migration `202609180004_fundamental_news.sql` adds only the derived article-cache record kind and an event-discovery index; no research data is deleted. A private backup precedes the full production re-screen.
- Validation: unit/integration checks, production build, 10 live synthetic acceptance cases (all passed; not an accuracy benchmark), real Netflix quarterly and Progressive monthly financial-document checks, and browser checks for grouped coverage and group review. Some IR pages return HTTP 403; SEC discovery remains independent. Unavailable or incomplete evidence is visible, not described as fully read.

## Follow-up shipped — 2026-09-18

- Imported the prepared research into production: 243 new companies plus research merged into the two existing records, for 245 total. Consolidated 257 original sections without dropping their notes. Saved a private full export before the import; the original Markdown remains archived. Unresolved short-name identities are tagged and paused for review.
- Fixed a reproduced news-screening bug: scores around 0.10–0.18 were passing into the inbox, while high-identity routine stock stories were suppressed. Identity now gates the main feed; ordinary company news remains available. Uncertain and failed screening has its own view. Manual Useful/Noise overrides the model and can be undone. The same identity policy applies to digests.
- Re-screened 60 existing Progressive articles with the improved identity prompt: 7 company matches, 2 uncertain and 51 screened out or user-marked noise. This is a real stored-news check, not a general recall claim. Narrowed Progressive retrieval to insurance/PGR and added a per-company search override.
- Added keyword, company, publisher, importance, date-range and unread news filters, plus company-scoped full history retrieval. Decoded escaped RSS markup before screening/display and exposed publisher labels.
- Added an editable idea-source field in quick add and Research, preserved separately from import-file provenance and included in Markdown/JSON exports.
- Article feedback uses immediate local updates with a per-article save, conflict/error rollback and Undo. It no longer waits for a full bootstrap reload.
- Login now has one email field and a primary email-link submit button, with loading/error/sent states and Enter-key submission.
- Settings explains the server-held TypeSafe key, pinned `jev-1.13.0`, $0.042/million input tokens, recorded usage and $2 monthly server ceiling. OpenAI Platform keys are not used. Hosting/database account invoices remain outside the app's metering.
- Financial-data setup deferred at the user's request. No provider subscription or key added; email delivery remains disabled.
- Validation: 33 tests, TypeScript checking and the production build pass. Browser checks exercised keyword filtering, Noise removal/Undo, saved idea-source persistence and overflow-free news layout against an isolated in-memory copy. The deployed public login shows the single email form. Live API checks verified 245 companies, original notes/statuses and all prior feedback preserved. A real Progressive refresh completed in about 5.4 seconds, fetched 5 new articles and reported no failures; its resulting views held 10 company-news items, 4 uncertain and 51 screened out/noise. Recorded TypeSafe usage was $0.010594038 across 154 requests at verification time; this is application metering, not a provider invoice.

This is a working first release of the research desk and monitoring pipeline. It is not a claim that every acceptance criterion in the comprehensive PRD has been satisfied.

## Verified

- Permanent Cloudflare Pages website: [Research Desk](https://research-desk-2p0.pages.dev). Its login page loads in the browser; Supabase sign-in redirects and backend origin allowlist use this hostname. Actual sign-in email delivery remains for the owner to exercise from the login page.
- Startup reliability follow-up: the reported database read failure could not be reproduced; 12 consecutive authenticated startup checks from the hosted origin succeeded, and six recent scheduled runs returned HTTP 200. Database reads now retry transient connection/server errors up to three attempts, log only operation/error-code/status diagnostics, and preserve permanent failures. Loading errors clear on retry independently of unsaved-edit errors. Four additional regression tests cover recovery, permanent errors, retry limits and HTTP 503 responses; 23 tests pass in total.
- TypeScript compilation and production build pass. Initial production JavaScript is 135.92 KB compressed; formatted-note rendering loads separately (35.11 KB compressed).
- 19 automated checks pass: Chicago/DST cadence, weekly frequency, historical price crossings, repeat suppression and rearming, wrong-currency/future/invalid-P/E rejection, suspicious price discontinuities, optimistic concurrency, atomic budgets/leases, note export/restore, original import preservation, duplicate import prevention, RSS/Atom parsing, feed URL restrictions, validated model answers, visible classification failures, and safe disabled email behavior, and restoring daily research snapshots with normalized schema defaults.
- Real cloud API rejects unauthenticated calls. Anonymous database reads cannot access private records.
- A tiny synthetic live request to TypeSafe `jev-1.13.0` classified an earnings warning as important and selected supporting evidence. Synthetic cloud company/event records were removed afterward. This proves connectivity and typed integration, not real-world recall or calibration.
- Live TypeSafe evaluation on 12 hand-written synthetic cases surfaced all 9 material cases, matched all 4 watch-point cases and all 3 directional expectations, and retained one incidental story for review. No model errors. Median request 205 ms, slowest/p95 537 ms; 11,945 input tokens, estimated cost $0.00050169. These are fixture results, not measured real-universe recall. Full results: `validation/news-evaluation.json`; reproduce with `node scripts/evaluate-news.ts`.
- Hosted scheduler is active and returned HTTP 200. It checks due companies every five minutes; it does not refresh every company that often.
- Browser-created company, note editing, tab switching and reload retained the saved notes.
- A 501-company local fixture returned the entire warm bootstrap in **38.2 ms p95** across 30 samples (1,506,769 bytes, median 23.49 ms). This measures the local API and response transfer, not browser paint time or remote latency. Browser search reduced the 501 entries to the exact requested company.
- The original 1,681-line research file is staged locally and in private Supabase storage. The reviewed parser identifies 257 sections, flags 48 ambiguous/duplicate entries, and keeps narrative bullets attached. No final user import has been committed.

## Setup still required

- Market-data credentials, instrument mapping/coverage validation, and a decision on affordable automatic P/E/market-cap data. No market subscription purchased.
- Resend key and verified sender; activate and test Chicago-time daily email. No real email sent.
- Confirm ambiguous company identities where tagged; their research is already imported.

## Further PRD work

- Representative real-news evaluation across the user's international small-cap universe; measure missed material events and false positives before relying on screening.
- More official IR/regulatory sources and coverage validation per important company; the automatic broad feed is only a starting source.
- Automated symbol resolution with explicit exchange/currency confirmation, corporate-action data, and affordable fundamental metrics.
- Richer event clustering across publishers, multi-article evidence, reclassification against changed watch points, and explicit versioned model evaluation.
- Exhaustive hosted/mobile/offline/conflict/load testing and actual browser interaction percentiles against the PRD speed targets.
- Expanded event-history pagination, retention/storage monitoring, off-project encrypted backups, and a practiced full disaster recovery run.
- Optional migration of the old app's actual Drive `data.json`; the supplied HTML does not contain that data.

The initial release intentionally shows missing data, uncertain news and incomplete coverage instead of filling those gaps with model guesses.

The implementation is published to the private GitHub repository [NithinMantena/stock-monitoring](https://github.com/NithinMantena/stock-monitoring) on `codex/initial-app`. Secrets, local databases and full imported research files are excluded from Git. Temporary service-role and scheduler-secret setup files were removed after verification; production secrets remain in Supabase.
