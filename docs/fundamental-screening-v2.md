# Fundamental screening v2

The application distinguishes useful business developments from articles worth reading. Primary documents require current, attributable business evidence. Secondary articles must also contribute useful original reporting or supported analysis. Recaps preserve the development in Coverage, without becoming reading recommendations.

## Processing flow

1. Apply explicit reader source exclusions. Never reject an article solely because the headline mentions options, a calendar, a recommendation or a price move.
2. Retrieve the article through the existing public-URL checks. Resolve publisher links, preserve paragraph/table-row boundaries, and retrieve bounded primary exhibits. Primary provenance comes from configured issuer origins and recognized regulator origins, not article claims. Supplied text is an explicit trusted ingestion mode.
3. Missing text goes directly to verification, without a paid classification call. Retrieval failures get at most three attempts in total. A secondary recap or missing secondary body can trigger one alternate primary-document candidate; primary discovery is cached per company/day/context revision. A lexical candidate match never establishes that the documents describe the same development.
4. Supply company identity, business scale/context, context source/date, financial observation date, current evaluation date, up to three related prior articles, and a candidate primary reference when available. Missing context stays unknown. No market-cap-to-contract shortcut or invented denominator is used.
5. Batch five core TypeSafe judgments: identity, significance, attribution, contribution, and currentness. Add exact evidence selection; secondary reporting/analysis quality; context dependency when context is absent/stale; and title/body alignment when extraction supplies a different document title. Watch-point questions and candidate document relations use the same call.
6. Validate answer types, allowed choices, distributions, score bounds and source-block membership. Store raw judgments separately from the admission policy. Invalid output and service outages remain processing failures.
7. Read long documents in bounded sections with two workers. Collect exact supporting and qualifying passages plus section context. A second document-level call reconciles explicit corrections and contradictions. Missing exhibits, incomplete text, an oversized reconciliation set, or unresolved conflict go to verification. No highest-scoring-chunk acceptance rule remains.
8. Apply the gates below in code. Persist development status, article role, reason code, reading coverage, evidence, model answers and version identifiers.
9. Link duplicates/analysis only at a relation probability of at least 0.85. Later outcomes/corrections link to the history without collapsing into the original event. Reused URLs only receive an exact link when content/provenance/date fingerprints agree. Primary reading leads a group; additional worthwhile analysis stays visible.
10. Present Relevant, Needs verification, Coverage, and Screened out views. The source's own selected passage supplies the excerpt. Poor-source/duplicate/no-new-information feedback applies to one article; ordinary review/save and irrelevant-event feedback can apply to the development.

## Gates and score semantics

Significance has five levels, indexed **0–4**: no useful business evidence, immaterial/routine, useful core evidence, meaningful change to economics/risk, and transformation of control/survival/core business. Its displayed mean is `sum(level * probability)`. The API rounds scores and probabilities independently; validation allows up to 0.06 rounding discrepancy and retains the returned answers for audit.

Admission does **not** mean “score above 2.” Code uses probability mass:

| Signal | Reading gate |
| --- | --- |
| Company connection | `P(identity) >= 0.80` |
| Useful business evidence | `P(level 2, 3 or 4) >= 0.75` |
| Attributable information | `P(attributed) >= 0.75`, plus a valid source-body passage |
| Current relevance | `P(current) >= 0.70` and `P(historical) < 0.20` |
| Secondary contribution | `P(incremental) >= 0.70` |
| Secondary quality | `P(adequate reporting/analysis) >= 0.75` |

Extraction and completeness checks run before content rejections. Decisive wrong entity (`<0.20` identity), historical information (`>=0.80`), immaterial content (`<0.20` useful mass), and unsupported assertions (`>=0.80`) are rejected. An intact calendar can be rejected without requiring a business quotation. Borderline judgments remain visible for verification. Missing context blocks admission only when its dependency judgment is at least 0.50.

An eligible development with `P(level 3 or 4) >= 0.70` is Important. Attributable potential significance (`>=0.20` meaningful mass) can retain a verification item in the digest. A watch-point match never rescues failed identity, source or evidence gates.

`coverage_only` is distinct from `irrelevant`: a recap may describe a relevant event while failing the article recommendation test. Its preferred-source requirement stays visible until a matching primary reading is established.

## Storage, migration and operations

No database schema migration is needed: the existing versioned document store supports the additional assessment fields and derived `screening_cache`/`primary_lookup` records. The model remains pinned to `jev-1.13.0`; the existing model budget is enforced. The cache key includes the exact serialized evidence/state, company revision, evaluation day, model, extraction version and questions. Policy version is separate so admission thresholds can replay without inference.

Existing v1 assessments are not silently treated as v2 judgments. New discovery uses v2 immediately. The existing five-minute scheduler rescreens bounded batches of old records, preserving feedback, saved status and review history. Manual searches retain pause/resume/cancel behavior. Legacy policy helpers remain for compatibility with stored v1-era structures; v2 assessments use the new signal policy.

Verification is a human review path. This release does not add an unconfigured general-purpose LLM or claim to resolve unreadable/paywalled source evidence. Structured numeric ratio extraction and larger reader-labeled calibration remain future extensions; current scale context is supplied explicitly through company research settings.

## Validation

- 105 automated tests passed, including v2 gates, malformed output, corrections, cache invalidation, failures and article-scoped feedback.
- Production TypeScript/Vite build passed.
- Live TypeSafe integration regression on 24 previously evaluated synthetic cases: 22 matched the prior labels; the two disagreements became verification items, with no false reading recommendation. The run used 36,722 input tokens (about $0.00154 at the configured input estimate). This is regression evidence, not independent holdout accuracy or reader-labeled precision/recall.
- The first integration pass exposed over-broad extraction checks and overly narrow quality wording. The corrected workflow uses conditional metadata alignment, explicit primary provenance, and quality criteria that accept supported original reporting as well as analysis. Typed answer rounding is also handled explicitly.
- A disposable browser preview verified primary reading with visible additional analysis, separate recap coverage, and article-specific dismissal.

Use `npm test` and `npm run build` for offline validation. `node scripts/evaluate-framework-v2.ts` runs the synthetic live regression using the included synthetic fixtures when a server-side TypeSafe key is available; it is intentionally not part of ordinary tests. Live raw responses and real account backups belong only in ignored local storage.
