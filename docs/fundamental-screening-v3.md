# Fundamental screening v3 (headline-first)

Implemented September 23, 2026. Supersedes [v2](fundamental-screening-v2.md) as the active policy (`SCREENING_VERSION = "fundamental-v3"`). Stored v2 verdicts still replay under the v2 rules until the nightly rescreen replaces them. For the plain-language version, see [HOW-IT-WORKS.md sections 4–6](HOW-IT-WORKS.md#4-the-journey-of-a-single-news-article).

## Why it changed

Research on real articles ([Google report](../research/google-rate-limits-2026-09-22/REPORT.md), [TypeSafe report 2](../research/typesafe-screening-2-2026-09-22/REPORT.md)) showed four things:

- **v2 filtered almost nothing.** It sent 75–85% of real articles to Needs verification and surfaced 2 of 10 useful developments on a fresh holdout.
- **Its main gates were about setup, not articles:**
  - missing text: 96% of live v2 screenings had none, because Google refuses most article lookups from the hosted server;
  - missing company context: 245 of 247 companies have none;
  - uncertain identity from bare company names without tickers.
- **Google publishes no limits.** Article lookups are refused by network reputation, so retrying is pointless and impolite.
- **Secondary reports of one development were demoted to Coverage** rather than grouped under the development's best source.

v3 keeps v2's structure: typed TypeSafe questions, code-owned rules, primary-source discovery, clustering, feedback, caching and budget. It changes what the decision depends on.

## Flow (`jobs.ts` `processArticle`, `news-screening.ts` `screenArticle`)

1. Explicit source exclusions: unchanged.
2. **Direct links** (company site, SEC, configured feeds; anything not `news.google.com`) are read before judging.
3. **Google links** get a **headline pass** first. It is one TypeSafe request using the company, headline, publisher, snippet (when it adds anything beyond the title) and code-computed days since publication.
4. A Google link is opened **once**, only if the headline pass did not reject it, or if `P(level 3–4) ≥ 0.5`. The attempt uses `enrichArticle`, which never throws for a Google refusal:
   - a 429/503, or any redirect from the lookup to another `*.google.com` host (`/sorry` CAPTCHA, consent), is recorded in `retrievalNote`;
   - `news.google.com` counts as a skipped host after 2 refusals in a run (`fetch-policy.ts` host tracking);
   - a refused lookup is cached like any other failed read, so it is not retried.
5. When text was read, a **text pass** asks the same questions with the opening section (≤ 12,000 bytes, as numbered passages) plus the evidence questions. No multi-chunk reconciliation. The text refines the answers; it is not a gate.
6. Rescreens (`rescreenNews`) use `noFetch`: they judge the stored headline or text and never contact Google. Only `processing_failed` is retried (24 h, up to 3 attempts). Missing text is never retried.

## Questions (`screening-prompts.ts`, `PROMPT_VERSION = "headline-first-3.0.0"`)

| Id | Type | Purpose |
| --- | --- | --- |
| `identity` | Noul with `true`/`false` criteria | Same business, brand or division, or a documented exposure; not a name collision. |
| `significance` | Score 0–4 | Development importance. Unknown scale must not demote an event. |
| `genre` | Choice (7) | `company_disclosure`, `news_report`, `analysis`, `market_commentary`, `investment_opinion`, `legal_solicitation`, `other`. |
| `issuerRelease` | Noul | Issued by the company itself, including verbatim newswire copies. |
| `temporal` | Choice | `current` / `historical` / `unknown`, with `dateFacts` supplied from code. |
| `evidence` + `evidenceExists` | Choice without "none" + Noul | Text pass only (TypeSafe *line-by-line search* pattern). |
| `relation{i}` | Noul | "Same development?" against up to 4 recently surfaced company articles. |
| `relevance{i}` / `direction{i}` | Noul / Choice | Watch points: unchanged. |

Choice answers whose `choice` is within 0.02 of the top rounded probability are accepted; otherwise the arg-max is used. v2 failed about 0.8% of articles on this rounding.

## Rules (`fundamental-policy.ts` `decideScreening`, `POLICY_VERSION_V3`)

Checked in order. `U = P(level 2–4)`, `M = P(level 3–4)`.

1. `identity < 0.2` → rejected `wrong_entity`.
2. `genre.legal_solicitation ≥ 0.6` → rejected `legal_solicitation`.
3. Age > 45 days, `historical ≥ 0.8`, or `staleTitle` → rejected `historical_only`. `staleTitle` means the title names a fiscal period two or more years old, and is computed in code.
4. Undated and `current < 0.5` → `M ≥ 0.5` ? verify `uncertain_currentness` : historical.
5. `identity < 0.8` → `M ≥ 0.5` ? verify `uncertain_identity` : rejected `unclear_identity`.
6. `max(market_commentary, investment_opinion) ≥ 0.6` → `M ≥ 0.2` ? `coverage_only` (`commentary_on_development`) : rejected `commentary`.
7. `M < 0.2` and `U < 0.6` → rejected `immaterial`.
8. `historical ≥ 0.5` → `M ≥ 0.5` ? verify : historical.
9. Relevant development. The role is:
   - `primary_reading` if official or `issuerRelease ≥ 0.8`;
   - `analytical_addition` if `genre.analysis ≥ 0.6`;
   - otherwise `news_report` (new role, disposition relevant).

There is no missing-text, missing-context, missing-evidence or contribution gate. Nothing with `M ≥ 0.5` is ever rejected except as another company, a law-firm advertisement or history. Important = `M ≥ 0.7`.

## Grouping and the updated secondary-source criteria

Without reliable text, "does this secondary article add value?" is judged by **provenance and purpose**, not reading depth:

- Reports of one development share a `clusterId` when `relation ≥ 0.7`, and all stay relevant. The inbox and digest show one card per development via `groupNews`.
- The lead is chosen by `screeningRank`:
  - base score by role: company source 300, news report 150, analysis 140, verify 50, coverage 20;
  - `sourceQuality`: established newsrooms +25, investing-template publishers −20;
  - +10 if the text was read;
  - Useful feedback always wins.
- Analysis pieces appear as additions alongside the lead. Commentary is Coverage only and is never a lead in the Relevant view.
- Duplicates are no longer demoted to Coverage (the v2 `coverageDuplicateOf` path is unused in v3).

## Validation (September 23, 2026)

- 238 automated tests pass. `tests/screening-v3.test.ts` covers the rules, the one-attempt Google flow, the CAPTCHA redirect, the per-run pause, the no-fetch rescreen, direct-link reading, near-tie choices and grouping under the best source. The production build passes.
- Live test: `scripts/evaluate-screening-v3.ts` → [validation/screening-v3-live.json](../validation/screening-v3-live.json).
  - Sample: 90 real articles from the research corpora, all 40 labelled useful (23 developments), 35 noise and 15 ambiguous.
  - Companies were used as they are today: no context, no tickers.
  - Labels are provisional research labels, not the owner's.

| On the same 90 articles | v2 (with text) | v3, Google refuses every lookup | v3, text available |
| --- | ---: | ---: | ---: |
| Developments surfaced (of 23) | 5 | 21 | 23 |
| Developments lost | 0 | 1 | 0 |
| Needs verification | 73 | 3–4 | 1 |
| Noise shown as relevant | 0 | 1 | 3 |
| Relevant articles → development cards | — | 36 → 29 | 46 → 31 |

- **The one development lost with Google refusing** was a ¥267.6bn tender offer whose headline never names the company (Hikari Tsushin). It is only recoverable from the text.
- **Headline-only and with-text routes agreed on 72 of 90 articles.** Almost all differences were headline under-calls that text corrected.
- **Grouping:** with text, every labelled development became exactly one card. Headline-only, two developments split into 3 cards because their headlines alone do not establish the same event.
- **Cost:** about 1,800 input tokens per headline pass and 3,200 per text pass (under 1¢ per 100 articles). Median about 0.2 s per call.

## Operations

- Deploying the Edge Function queues every stored v1/v2 article for rescreen at 300 a night (about 6,400 articles, roughly three weeks). Rescreens make no Google requests.
- Budget: rescreens and screening with text raise TypeSafe spend. Check that `TYPESAFE_MONTHLY_BUDGET_USD` has headroom; the code caps it at $10.
