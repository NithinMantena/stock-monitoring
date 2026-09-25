# Hosted setup

The Supabase database, private owner account, TypeSafe integration, and monitoring scheduler have been installed in `tcfricxifanwwzgxgexj`. The other Supabase project was not modified.

## Frontend hosting

**Company size tiers (2026-09-24):** companies now carry `marketCapUsd`, `sizeClass` (micro < $300M, small < $2B, mid < $10B, large < $200B, mega) and official name/listing fields. TypeSafe gets a size-specific description, and the screening policy (`headline-first-policy-3.1.0`) raises the significance bar for large and mega caps and lowers it for micro and small caps (`supabase/functions/_shared/company-size.ts`). Apply the data migration `npx supabase db query --linked --file supabase/migrations/202609240008_market_caps.sql`. It writes the 2026-09-23 market caps from `data/company-market-caps-2026-09-23.csv` onto existing company records by ID and is safe to re-run. Then deploy `desk` and the frontend as below. Regenerate the migration from a newer sheet with `node scripts/market-cap-migration.ts <csv> <as-of date>`.

**Latest rollout (2026-09-24 UTC):** screening v3 (headline-first), manual screen scope, the email-latest-screen button and `supabase/migrations/202609230007_slim_event_reads.sql`. The migration only replaces the `desk_ui_records` view, so it is safe to re-run. Apply it with `npx supabase db query --linked --file supabase/migrations/202609230007_slim_event_reads.sql`, then deploy `desk` and the frontend as below. `scripts/fresh-start-news.ts` (dry run by default; `--apply` backs up, then deletes stored news articles) was used to start screening afresh.

The permanent website is [Research Desk](https://research-desk-2p0.pages.dev), hosted in the Cloudflare Pages project `research-desk`. Open it on any device, enter `nithin@mantena.com`, and choose **Email me a sign-in link**. Open the emailed link on the device where you want to sign in; no password was assigned during setup.

To publish subsequent frontend updates from this workspace:

```powershell
npx wrangler login
npm run build
npx wrangler pages deploy dist --project-name research-desk --branch codex/initial-app
```

The production branch is `codex/initial-app`. Deployment is a direct upload; pushing to GitHub alone does not publish frontend changes. The build needs these **public** values: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_API_URL`. The local `.env.production.local` was prepared from the selected project. No secret belongs in the frontend bundle.

Supabase Auth's Site URL and redirect allowlist now include `https://research-desk-2p0.pages.dev`, and the backend's `APP_ORIGIN` allows this exact origin plus the local development origins. Public signup remains disabled. When changing the hostname:

1. Add its exact HTTPS origin to the Supabase `APP_ORIGIN` secret (alongside local origins if desired).
2. Configure Supabase Auth's Site URL and redirect allowlist to this hostname. Review `npx supabase config diff` before `config push`.
3. Public signup has been disabled for this single-owner desk. The allowed owner account already exists.
4. Test a sign-in link requested from the app, company creation, notes, refresh and sign-out. Do not send a login email automatically without the user requesting it.

## Quote data

Set `EODHD_API_KEY` as an Edge Function secret. Confirm each symbol, exchange and native quote currency before selecting EODHD in the company's Monitoring tab. The adapter retrieves raw daily closes and historical observations for weekly crossing detection. It does not assume that the same subscription includes fundamentals.

The first release supports manual P/E and market-cap observations. Automated global fundamentals remain a coverage/provider decision. Do not buy a higher tier automatically or treat GBP and GBX as interchangeable.

## Daily digest

Configure a Resend account with a verified sender/domain and set:

```dotenv
RESEND_API_KEY=your-server-key
DIGEST_FROM=Research Desk <a-verified-sender@your-domain>
DIGEST_TO=nithin@mantena.com
ENABLE_EMAIL_DELIVERY=true
```

Then enable **Settings & digest → Enable daily digest**. The default hour is 07:00 in `America/Chicago`. Preview the digest first. The sender must pass Resend/domain requirements; possession of an API key alone does not verify a domain. Sending has not been tested against a real recipient in the initial setup.

## Updating the backend

```powershell
npx supabase login
npx supabase link --project-ref tcfricxifanwwzgxgexj
npx supabase functions deploy desk --project-ref tcfricxifanwwzgxgexj --use-api
```

Migrations were initially applied through `supabase db query --linked --file ...`, so do not blindly reapply their non-idempotent policy/constraint creation. Record migration history before adopting a `db push` pipeline. Apply only new reviewed migrations.

`scripts/prepare-cloud.ps1` and `scripts/prepare-cloud.ts` handle approved account/credential setup. They temporarily use powerful credentials in ignored `.local` files. Keep those files private, remove them after setup/testing, and exclude `.local` from any Obsidian/cloud-file synchronization. They must never be committed. Existing environment TypeSafe keys are copied only to the app's server secrets.

The scheduler is `research-desk-monitor`, installed through `scripts/prepare-schedule.ts` and gated by `public.desk_scheduler_due()` (migration `202609250009_gated_scheduler.sql`, which must exist first). It uses a Vault secret and does not depend on GitHub Actions or the user's PC. Inspect recent `net._http_response` status codes and `desk_records` kind `run` to diagnose failures. Disable it with `select cron.unschedule('research-desk-monitor');` when intentionally stopping monitoring.

## Backup and recovery

Daily hosted research snapshots retain 30 days. Use **Import & backup → Download latest daily research snapshot** or a complete manual export. Restore adds missing IDs and preserves existing records; to recover a prior note on an existing company, use its note history. Always keep an off-project export before deleting or replacing the project. In-project snapshots do not protect against deletion of the entire Supabase project.

The off-project copy is automatic: the private repository `NithinMantena/research-desk-backups` runs `.github/workflows/weekly-backup.yml` every Sunday at 06:17 UTC and on demand. It calls `GET /v1/export?scope=essential` with the `DESK_BACKUP_TOKEN` repository secret, an integration token with only the `backup:read` scope and a one-year expiry. It validates the result, then commits `backups/research-desk-YYYY-MM-DD.json.gz` and keeps the newest 26. The workflow source is mirrored in `ops/backup-repo/`. The essential scope contains companies, revisions, settings, imports and every saved, reviewed or feedback-marked article. Stored text and TypeSafe raw answers, probabilities and comparisons are removed. It restores through the normal Restore button. Never put backups in the public `stock-monitoring` repository.

## Sources consulted during implementation

- [TypeSafe API](https://docs.typesafe.ai/api), [choice primitive](https://docs.typesafe.ai/primitives/choice), [evidence cookbook](https://docs.typesafe.ai/cookbooks/citation_check).
- [Supabase scheduling](https://supabase.com/docs/guides/functions/schedule-functions) and installed CLI help/config-diff guidance.
- [Cloudflare Vite deployment](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/).
- EODHD's official API/pricing references and provider tradeoffs are preserved in the approved PRD.

## Fundamental news upgrade

Apply only the new `202609180004_fundamental_news.sql` migration. Set `TYPESAFE_MONTHLY_BUDGET_USD=5`, deploy `desk`, build and deploy the frontend. Additional text-retrieval hosts can be enabled with `ALLOWED_ARTICLE_HOSTS` or per-company publisher settings; private/non-HTTPS destinations are rejected. The model stays pinned to Jev 1.13.0.

`node scripts/upgrade-news-screening.ts` previews a sample without changing live events. `--apply` first saves `.local/before-fundamental-screening.json`, then preserves user feedback while re-screening existing news. It uses four company workers, serializes each company's history, and renews its migration lease. `--limit=N` bounds the migration. Scheduled runs handle any later pending/retry work. Cached article bodies are derived data and are excluded from research exports.

## Manual news batches and inbox

Apply `202609180005_news_batches.sql` before deploying the updated `desk` function and frontend. It adds the derived `news_batch` record kind without changing research or events. No scheduler change is needed: the existing five-minute hosted scheduler resumes the manual queue after regular monitoring and the digest. Browser requests also advance the saved queue in bounded slices. The queue uses its own lease and never writes company monitoring timestamps, automatic attempt records or feed success cursors. The same TypeSafe budget applies to both paths.

Inbox expiry is a view rule, not physical deletion: unsaved unread items leave the inbox after 30 days and remain in History/export. Saved events are retained indefinitely. Re-screening preserves save/review/inbox-return state. Full backups include these event fields; the lightweight daily research snapshot still excludes event history.

## News controls and retrieval update (2026-09-19)

Deploy the `desk` function and the frontend together; no new database migration is required. Existing batches keep their saved queue. New batches use 10 articles per UTC calendar day for seven days. The control endpoint uses optimistic writes independently of the worker lease, so pause/cancel is accepted during an active request; the worker retains finished work and honors the command before another article. A paused batch must be resumed or cancelled before starting a new one.

Public HTTPS article retrieval is enabled by default, with DNS public-address checks for additional hosts and redirect validation. `ALLOW_PUBLIC_ARTICLE_HOSTS=false` restores explicit-host-only behavior. Old host-disabled cache entries are retried. Source exclusions, HTML restrictions, size limits and retrieval timeouts still apply. Article reading never invokes TypeSafe. The admission update does not bump the inference version: existing scores are re-evaluated in code, preserving user feedback and avoiding a costly full re-screen. `scripts/pause-news.ts` is a maintenance fallback that pauses the current batch without deleting progress.
# API v1 rollout — September 20, 2026

The live website and `desk` function now use the shared v1 API. A private research export was saved before migration. The deployed migration is `supabase/migrations/202609200006_shared_api.sql`; it extends record kinds, adds atomic versioned batch writes and excludes integration/request/audit records from direct owner-table reads.

This existing project's older schema changes were applied without a matching Supabase CLI migration history. Do **not** blindly replay every migration with `db push`. For this rollout only the new migration was applied with `supabase db query --linked --file supabase/migrations/202609200006_shared_api.sql`. Reconcile migration history against actual schema before using automatic migration deployment in future.

Verification: 82 automated tests; TypeScript and production build; real local MCP protocol tests; live paginated API reads; live atomic-write rollback; scope enforcement; credential revocation; authentication-error CORS; browser credential creation/revocation on disposable data; mobile layout with no horizontal overflow. The deployed sign-in page loads successfully. No paid AI jobs were started by these verification steps.

MCP is installed as `stock-monitoring-mcp:local` in the existing Docker profile `nithin_mantena`. OpenClaw's skill is installed in the local workspace. Both passed authenticated read-only checks. Their initial credentials expire October 20, 2026, and allow read, research/monitoring/news edits and job pause/cancel. They do not allow paid job starts/resumes, settings changes, backup exports or imports. Manage or replace them in website Settings; see `docs/INTEGRATIONS.md`.

## Fundamental screening v2 (2026-09-22)

The implementation and gate definitions are documented in `docs/fundamental-screening-v2.md`. It uses the existing document store; no new SQL migration is required. Deploy the `desk` function and the Cloudflare frontend together. New discovery uses v2 immediately; existing assessments move through the scheduler's bounded rescreen queue. Old judgments do not count as new-framework approvals. Reader feedback and saved/reviewed state are preserved.

A private local export was taken before rollout. Do not commit `.local`, research working files, account exports, raw model requests, or credentials. The GitHub repository is public. Public validation artifacts contain synthetic cases only.

## Log ingestion reduction (2026-09-25)

The org exceeded the free plan's 1 GB/month log ingestion (1.27 GB by Sept 25; ~60 MB/day from this project, ~33 MB/day from the reading-app project). Supabase logs every request at ~1–2 KB, so idle polling, not data size, was the cost.

- Migration `supabase/migrations/202609250009_gated_scheduler.sql` adds `public.desk_scheduler_due()` and re-points `research-desk-monitor` (via `cron.alter_job`, keeping the Vault credential) to `select net.http_post(...) where public.desk_scheduler_due();`. The cron still fires every minute; the HTTP call happens only while work is in progress or queued, or every 10th minute. Skipped minutes show `0 rows` in `cron.job_run_details` and nothing in `net._http_response`. Applied 2026-09-25 22:43 UTC with `supabase db query --linked -f`.
- `POST /v1/jobs` and resume in `/v1/jobs/{id}/control` run the first bounded step in the background (`EdgeRuntime.waitUntil`), so MCP/API jobs start at once rather than on the next tick.
- The website's `/changes` poll went from 5 s to 30 s.
- Deployed together: migration, `desk` function, frontend.
- To revert the scheduler: `select cron.alter_job(job_id := (select jobid from cron.job where jobname='research-desk-monitor'), command := <the command without the where clause>);`.

## Scheduled news runs and egress reduction (2026-09-22)

Measured on the live project before this change (4.7 days of `pg_stat_statements`): the five-minute scheduler re-read every stored article (about 15–18 MB) for the rescreen check, the full daily backup record (about 660 KB) to test whether it existed, and every company (about 470 KB) for monitoring, 288 times a day. That alone exceeded the free plan's 5 GB monthly egress within days. Open browser tabs added a full company reload every minute and a full article download on every page load.

What runs now (`supabase/functions/_shared/scheduler.ts`; times in `NEWS_SCHEDULE`, `constants.ts`, America/Chicago):

- **Every minute while work is in progress, otherwise every 10 minutes** (since 2026-09-25, see above) the hosted scheduler calls `/scheduled`. An idle call reads one small state record (`run/schedule`), a job-status projection and settings: a few hundred bytes.
- **Daily run, 1am:** daily-cadence companies (portfolio and perpetual watch), articles since the previous run started minus a 2-hour overlap (normally the last 26 hours).
- **Weekly run, Friday 6pm:** every non-paused company, last 7 days, daily companies first. Saturday's daily run is skipped because the weekly run covers it. A missed Friday is caught up after 8 days.
- **Once per night:** closing prices (quotes only; news comes from the runs above), the daily snapshot, and up to 300 rescreens (retries, context changes, policy versions). The rescreen queue is computed once from a projected scan and stored in `run/rescreen-queue`.
- API jobs and a running manual batch progress every minute; the 7am digest goes out on the next 10-minute heartbeat. Manual batches no longer need an open browser tab.
- Each tick processes at most 10 articles (measured ~80 ms CPU each against the 2 s Edge Function allowance) and about 45 seconds of work. Scheduled runs are stored in `news_batch/scheduled`, separate from the manual batch in `news_batch/latest`; the desk shows both.

Google News politeness: searches are spaced 2 s apart and article/link requests 0.6 s apart; each refusal doubles the spacing (up to 20 s / 10 s) and it eases back 5% per success. Article pages are requested with Google's locale parameters, skipping a redirect (two Google requests per article instead of three). A throttled rescreen pauses rescreens for 30 minutes. HTTP 429/503 from Google is a throttle, not a failure: the run waits 1, 3, 10, 20 then 30 minutes and retries the same step. Only after five consecutive refusals is that search reported and skipped. A throttled article is never cached or screened as unreadable. Publishers that return 401/403 or time out twice in a row are skipped for the rest of the run (the article is recorded as unreadable, as before). The publisher timeout is 8 s (10 s for configured and SEC hosts); no successful read in the 2026-09-22 profile took longer.

Egress rules for future code: server scans must use `store.list(kind, { fields: [...] })` projections or `ids`; existence checks use `store.get(kind, id, { fields: [] })`; development members use the `cluster` filter. The browser keeps its articles in IndexedDB (`src/news-cache.ts`) and requests only changes; company data is re-read only for changed companies.

Deployment: no SQL migration (no new record kinds). Deploy `desk` and the frontend together, then make the existing job run every minute: `select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'research-desk-monitor'), schedule := '* * * * *');` (applied 2026-09-22; this keeps the job's Vault credential). A fresh install uses `scripts/prepare-schedule.ts`, which now writes the one-minute schedule. The first tick after deployment writes `run/schedule` and starts with the next night's daily run.
