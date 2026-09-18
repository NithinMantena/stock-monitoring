# Implementation status — 2026-09-17 Chicago

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
- Review the staged import before adding its entries to the live company list.

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
