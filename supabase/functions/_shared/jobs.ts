import {
  ConflictError,
  defaultSettings,
  pickFields,
  type Company,
  type DeskEvent,
  type Doc,
  type Quote,
  type Settings,
  type Store,
} from "./model.ts";
import { cadenceOf, chicagoParts, due, evaluateRules, hash } from "./engine.ts";
import {
  companyNewsUrl,
  isDefaultNewsFeed,
  newsBucket,
  newsPriority,
  eventPriority,
} from "./news.ts";
import {
  classifyArticle,
  configuration,
  fetchFeed,
  fetchQuotes,
  type Article,
  type Env,
  type Judgment,
} from "./providers.ts";
import {
  enrichArticle,
  discoverPrimary,
  canonicalUrl,
  primaryUrls,
} from "./article-content.ts";
import {
  SCREENING_VERSION,
  LEGACY_SCREENING_VERSION,
  articleAgeDays,
  digestImportance,
  excludedSource,
  groupNews,
  currentAssessment,
  type NewsAssessment,
} from "./screening-policy.ts";
import { ThrottledError } from "./fetch-policy.ts";
import { hasReadableText } from "./news-screening.ts";

// An insert-only write already refuses an existing record; no separate read needed.
export async function addEvent(store: Store, event: DeskEvent) {
  try {
    await store.put("event", event.id, event, 0);
  } catch (error) {
    if (error instanceof ConflictError) return;
    if (!(await store.get("event", event.id, { fields: [] }))) throw error;
  }
}
// The duplicate/coverage comparison reads only these fields of recent company news.
const HISTORY_FIELDS = [
  "id",
  "kind",
  "title",
  "evidence",
  "body",
  "url",
  "publishedAt",
  "discoveredAt",
  "clusterId",
  "screening.version",
  "screening.documentHash",
  "screening.primary",
  "screening.disposition",
  "screening.articleRole",
];
export async function companyHistory(store: Store, companyId: string) {
  return (
    await store.list<DeskEvent>("event", {
      companyId,
      fields: HISTORY_FIELDS,
      limit: 200,
    })
  ).map((d) => d.data);
}
export interface ArticleOptions {
  existingId?: string;
  reprocess?: boolean;
  preferredLookup?: boolean;
  // Caller already confirmed the event does not exist (skips one read).
  assumeNew?: boolean;
  // Recent company news, shared across a run's articles and kept current here.
  history?: DeskEvent[];
  // Judge from what is already stored; never fetch the article again (rescreens).
  noFetch?: boolean;
}
export async function processArticle(
  c: Company,
  article: Article,
  store: Store,
  env: Env,
  options: ArticleOptions = {},
): Promise<DeskEvent> {
  const id = options.existingId || `news-${c.id}-${article.id}`;
  if (!options.assumeNew) {
    const old = await store.get<DeskEvent>("event", id);
    if (old && !options.reprocess) return old.data;
  }
  // Automatic monitoring, manual searches and retries have different job locks.
  // Serialize their shared paid work for an article.
  const key = `article-${id}`,
    lease = await store.claim(key, 600);
  if (!lease) throw new ConflictError();
  try {
    return await processUnlockedArticle(c, article, store, env, options);
  } finally {
    await store.release(key, lease);
  }
}

async function processUnlockedArticle(
  c: Company,
  article: Article,
  store: Store,
  env: Env,
  options: ArticleOptions,
): Promise<DeskEvent> {
  const id = options.existingId || `news-${c.id}-${article.id}`;
  const existing = await store.get<DeskEvent>("event", id);
  if (existing && !options.reprocess) return existing.data;
  const event: DeskEvent = {
    id,
    companyId: c.id,
    kind: "news",
    title: article.title,
    body: article.text.slice(0, 1000),
    url: article.url,
    publishedAt: article.publishedAt,
    discoveredAt: new Date().toISOString(),
    reviewed: false,
    priority: "possible",
    rawText: article.text,
    classification: { source: article.source, official: article.official },
  };
  const baseAssessment: NewsAssessment = {
    version: SCREENING_VERSION,
    at: new Date().toISOString(),
    disposition: "uncertain",
    reason: "Awaiting fundamental screening.",
    category: "other",
    identity: 0,
    materiality: 0,
    quality: 0,
    addedValue: 0,
    evidenceSufficiency: 0,
    primary: article.official,
    contentDepth: article.contentDepth || "snippet",
    charactersRead: 0,
    availableCharacters: article.text.length,
    retrievalNote: "",
    possibleMajor: false,
    sourceUrl: article.url,
    attempts:
      (existing?.data.screening?.contextRevision === c.newsRevision
        ? existing?.data.screening?.attempts || 0
        : 0) + 1,
    contextRevision: c.newsRevision,
  };
  try {
    const excluded = excludedSource(
      article.source,
      article.url,
      c.excludedNewsSources,
    );
    if (excluded) {
      event.screening = {
        ...baseAssessment,
        disposition: "suppressed",
        reason: "Source excluded by your news preferences.",
        reasonCode: "explicit_exclusion",
        articleRole: "rejected",
        development: { status: "irrelevant" },
      };
      event.priority = "suppressed";
    } else {
      const history = (
        options.history || (await companyHistory(store, c.id))
      ).filter(
        (e) =>
          e.kind === "news" &&
          e.id !== id &&
          (e.screening?.version === SCREENING_VERSION ||
            e.screening?.version === LEGACY_SCREENING_VERSION),
      );
      const terms = new Set(
        article.title.toLowerCase().match(/[a-z0-9]{4,}/g) || [],
      );
      const overlap = (e: DeskEvent) =>
        [
          ...new Set(
            `${e.title} ${e.evidence || ""}`
              .toLowerCase()
              .match(/[a-z0-9]{4,}/g) || [],
          ),
        ].filter((t) => terms.has(t)).length;
      // The same article reached under another feed ID is not "other coverage".
      const sameArticle = (e: DeskEvent) =>
        !!article.url &&
        canonicalUrl(e.url) === canonicalUrl(article.url) &&
        e.title === article.title;
      // Up to four earlier surfaced articles that may report the same
      // development, so repeated coverage (e.g. of one earnings release) joins
      // one development instead of becoming separate cards.
      const surfaced = (e: DeskEvent) =>
        e.screening?.disposition === "relevant" ||
        e.screening?.disposition === "uncertain" ||
        e.screening?.articleRole === "coverage_only";
      const recent = history
        .map((e) => ({ e, overlap: overlap(e) }))
        .filter(
          (item) =>
            item.overlap >= 1 && surfaced(item.e) && !sameArticle(item.e),
        )
        .sort(
          (a, b) =>
            b.overlap - a.overlap ||
            b.e.discoveredAt.localeCompare(a.e.discoveredAt),
        )
        .slice(0, 4)
        .map((item) => item.e);
      // A direct link (company site, SEC, a configured feed) costs Google
      // nothing, so it is read before judging. A Google link is judged from its
      // headline first and opened once, only if the headline has not ruled it
      // out or the development may be major. A refused read changes nothing else.
      let googleLink = false;
      try {
        googleLink = new URL(article.url).hostname === "news.google.com";
      } catch {
        /* no link */
      }
      const read = async () => {
        article = await enrichArticle(c, article, env, store);
        event.url = article.url;
        event.publishedAt = article.publishedAt || event.publishedAt;
        event.classification = {
          source: article.source,
          official: article.official,
        };
        if (!hasReadableText(article)) return false;
        event.rawText = article.text;
        event.body = article.text.slice(0, 1000);
        return true;
      };
      if (
        !hasReadableText(article) &&
        article.url &&
        !options.noFetch &&
        !googleLink
      )
        await read();
      let result: Judgment | undefined;
      let note = "";
      if (!hasReadableText(article)) {
        // 1. Headline pass: everything known without the article text.
        result = await classifyArticle(c, article, env, store, recent);
        const worthOpening =
          result.screening.disposition !== "suppressed" ||
          (result.screening.judgment?.meaningful ?? 0) >= 0.5;
        if (googleLink && !options.noFetch && worthOpening) {
          if (await read()) result = undefined;
          else
            note =
              article.retrievalNote ||
              "Article text unavailable; screened from the headline.";
        } else
          note = options.noFetch
            ? "Re-screened from the stored headline; the article was not fetched again."
            : googleLink
              ? "Screened out from the headline; the article was not opened."
              : article.url
                ? article.retrievalNote ||
                  "Article text unavailable; screened from the headline."
                : "No article link; screened from the headline.";
      }
      const excludedAfterRead = excludedSource(
        article.source,
        article.url,
        c.excludedNewsSources,
      );
      // 2. With text: the same questions, the text as extra evidence.
      if (!result && !excludedAfterRead)
        result = await classifyArticle(c, article, env, store, recent);
      if (result && note) result.screening.retrievalNote = note;
      if (excludedAfterRead) {
        event.screening = {
          ...baseAssessment,
          disposition: "suppressed",
          reason: "Source excluded by your news preferences.",
          reasonCode: "explicit_exclusion",
          articleRole: "rejected",
          development: { status: "irrelevant" },
          sourceUrl: article.url,
        };
        event.priority = "suppressed";
      } else if (result) {
        // The company's own document is the best lead for a development. One
        // alternate primary document, never an unbounded recursive search.
        if (
          !options.preferredLookup &&
          !options.noFetch &&
          !result.screening.primary &&
          baseAssessment.attempts === 1 &&
          primaryUrls(c).length &&
          ["news_report", "coverage_only"].includes(
            result.screening.articleRole || "",
          )
        ) {
          try {
            const lookupKey = `${c.id}-${new Date().toISOString().slice(0, 10)}-${c.newsRevision}`;
            const cached = await store.get<{ articles: Article[] }>(
              "primary_lookup",
              lookupKey,
            );
            const discovered = cached?.data || (await discoverPrimary(c, env));
            if (!cached)
              await store
                .put(
                  "primary_lookup",
                  lookupKey,
                  { articles: discovered.articles },
                  0,
                )
                .catch(() => undefined);
            const alternate = discovered.articles
              .filter((a) => canonicalUrl(a.url) !== canonicalUrl(article.url))
              .map((a) => ({
                a,
                overlap: (
                  a.title.toLowerCase().match(/[a-z0-9]{4,}/g) || []
                ).filter((t) => terms.has(t)).length,
              }))
              .filter((x) => x.overlap >= 3)
              .sort((a, b) => b.overlap - a.overlap)[0]?.a;
            if (alternate) {
              const preferred = await processArticle(c, alternate, store, env, {
                preferredLookup: true,
                history: options.history,
              });
              if (preferred.screening?.articleRole === "primary_reading") {
                recent.unshift(preferred);
                recent.splice(4);
                result = await classifyArticle(c, article, env, store, recent);
              }
            }
          } catch {
            result.screening.retrievalNote +=
              " The company's own matching document could not be established.";
          }
        }
        event.classification = {
          ...event.classification,
          ...result,
          screening: undefined,
        };
        event.screening = {
          ...result.screening,
          attempts: baseAssessment.attempts,
          contextRevision: c.newsRevision,
        };
        event.evidence = result.evidence;
        if (result.evidence) event.body = result.evidence;
        event.matches = result.matches.filter((x) => x.relevance >= 0.7);
        // Several reports of one development stay together: they share a cluster,
        // and the grouped view leads with the best source (screeningRank).
        const match = result.screening.comparisons
          ?.filter((x) => x.relation === "same" && x.probability >= 0.7)
          .sort((a, b) => b.probability - a.probability)[0];
        const matched = recent.find((e) => e.id === match?.id);
        if (matched) event.clusterId = matched.clusterId || matched.id;
        // Reused IR URLs must not collapse different reporting periods or updates.
        const documentHash = result.screening.documentHash;
        const exact = history.find(
          (e) =>
            article.url &&
            canonicalUrl(e.url) === canonicalUrl(article.url) &&
            e.screening?.documentHash === documentHash &&
            e.title === article.title &&
            !!article.publishedAt &&
            e.publishedAt === article.publishedAt,
        );
        if (exact) event.clusterId = exact.clusterId || exact.id;
        event.priority = newsPriority({
          ...result,
          screening: event.screening,
        });
      }
    }
  } catch (error) {
    // Nothing is saved: the caller retries the article after backing off.
    if (error instanceof ThrottledError) throw error;
    const message =
      error instanceof Error ? error.message : "Classification unavailable";
    const budgetDeferred = /TypeSafe.*budget/i.test(message);
    const attempts = (baseAssessment.attempts || 1) - Number(budgetDeferred);
    event.classification = {
      ...event.classification,
      error: message,
    };
    event.body = `Unclassified — review the source. ${event.body}`;
    event.screening = {
      ...baseAssessment,
      attempts,
      reasonCode: "processing_failed",
      articleRole: "pending_verification",
      development: { status: "uncertain" },
      reason: budgetDeferred
        ? "TypeSafe budget unavailable or reached; waiting to retry."
        : attempts < 3
          ? "Screening unavailable; queued for retry."
          : "Screening unavailable after three attempts; review the source.",
      contentDepth: article.contentDepth || "snippet",
      availableCharacters: article.availableCharacters || article.text.length,
      retrievalNote: article.retrievalNote || "",
      retryAfter:
        attempts < 3
          ? new Date(Date.now() + 86400000).toISOString()
          : undefined,
    };
  }
  if (existing) {
    const fresh = (await store.get<DeskEvent>("event", id))!;
    const updated = {
      ...event,
      discoveredAt: fresh.data.discoveredAt,
      reviewed: fresh.data.reviewed,
      saved: fresh.data.saved,
      inboxAt: fresh.data.inboxAt,
      feedback: fresh.data.feedback,
      feedbackReason: fresh.data.feedbackReason,
    };
    await store.put("event", id, updated, fresh.version);
    rememberHistory(options.history, updated);
    return updated;
  }
  await addEvent(store, event);
  rememberHistory(options.history, event);
  return event;
}
function rememberHistory(history: DeskEvent[] | undefined, event: DeskEvent) {
  if (!history) return;
  const at = history.findIndex((e) => e.id === event.id);
  if (at >= 0) history.splice(at, 1);
  history.unshift(pickFields(event, HISTORY_FIELDS));
  history.splice(200);
}

function needsRescreen(e: DeskEvent, newsRevision: number | undefined) {
  return (
    e.kind === "news" &&
    e.feedback !== "noise" &&
    newsRevision !== undefined &&
    (e.screening?.version !== SCREENING_VERSION ||
      e.screening.contextRevision !== newsRevision ||
      (!!e.screening.retryAfter &&
        e.screening.retryAfter <= new Date().toISOString() &&
        (e.screening.attempts || 0) < 3))
  );
}
// A projected scan (a few hundred bytes per article) instead of every stored article.
export async function rescreenCandidates(store: Store, companyId?: string) {
  const revisions = new Map(
    (await store.list<Company>("company", { fields: ["newsRevision"] })).map(
      (d) => [d.id, d.data.newsRevision ?? 1],
    ),
  );
  return (
    await store.list<DeskEvent>("event", {
      companyId,
      fields: [
        "kind",
        "companyId",
        "feedback",
        "discoveredAt",
        "screening.version",
        "screening.contextRevision",
        "screening.retryAfter",
        "screening.attempts",
      ],
    })
  )
    .filter((d) => needsRescreen(d.data, revisions.get(d.data.companyId)))
    .sort((a, b) => b.data.discoveredAt.localeCompare(a.data.discoveredAt))
    .map((d) => d.id);
}
export async function rescreenNews(
  store: Store,
  env: Env,
  options: {
    companyId?: string;
    limit?: number;
    milliseconds?: number;
    // A previously computed queue; ids no longer pending are skipped.
    ids?: string[];
  } = {},
) {
  const lease = await store.claim("news-rescreen", 150);
  if (!lease) return { processed: 0, remaining: 0, busy: true, consumed: 0 };
  const start = Date.now();
  let processed = 0,
    consumed = 0;
  try {
    const pending =
      options.ids || (await rescreenCandidates(store, options.companyId));
    const companies = new Map<string, Company | null>();
    for (const id of pending) {
      if (
        processed >= (options.limit || 10) ||
        Date.now() - start > (options.milliseconds || 30000)
      )
        break;
      consumed++;
      const e = (await store.get<DeskEvent>("event", id))?.data;
      if (!e) continue;
      if (!companies.has(e.companyId))
        companies.set(
          e.companyId,
          (await store.get<Company>("company", e.companyId))?.data || null,
        );
      const company = companies.get(e.companyId);
      if (!company || !needsRescreen(e, company.newsRevision)) continue;
      await processArticle(
        company,
        {
          id: e.id,
          title: e.title,
          text: e.rawText || e.body,
          url: e.url,
          publishedAt: e.publishedAt,
          source: String(e.classification?.source || ""),
          official: e.classification?.official === true,
          contentDepth: e.screening?.contentDepth || "snippet",
        },
        store,
        env,
        { reprocess: true, existingId: e.id, noFetch: true },
      );
      processed++;
    }
    return {
      processed,
      remaining: Math.max(0, pending.length - consumed),
      busy: false,
      consumed,
    };
  } finally {
    await store.release("news-rescreen", lease);
  }
}
export async function healthEvent(
  store: Store,
  c: Company,
  message: string,
  now = new Date(),
) {
  const id =
    "health-" + (await hash(`${c.id}|${message}|${chicagoParts(now).date}`));
  await addEvent(store, {
    id,
    companyId: c.id,
    kind: "health",
    priority: "possible",
    title: "Monitoring needs attention",
    body: message,
    url: "",
    publishedAt: now.toISOString(),
    discoveredAt: now.toISOString(),
    reviewed: false,
  });
}
export async function saveQuoteObservations(
  store: Store,
  doc: Doc<Company>,
  observations: Quote[],
  now = new Date(),
) {
  const c = doc.data;
  const latest = [...observations]
    .sort((a, b) => a.session.localeCompare(b.session))
    .at(-1);
  if (!latest) return doc;
  const tooOld =
    now.getTime() - new Date(latest.session + "T00:00:00Z").getTime() >
    10 * 86400000;
  // A large discontinuity may be a split, currency issue or real drawdown; require review before numerical alerts.
  const sorted = [...observations].sort((a, b) =>
    a.session.localeCompare(b.session),
  );
  const suspicious = sorted.some((q, i) => {
    const prior = i
      ? sorted[i - 1]
      : c.quote && c.quote.session < q.session
        ? c.quote
        : null;
    return (
      prior && (q.price / prior.price < 0.55 || q.price / prior.price > 1.8)
    );
  });
  const eligible =
    tooOld || suspicious ? [] : c.lastQuoteCheck ? observations : [latest];
  const evaluated = evaluateRules(c, eligible, now);
  for (const event of evaluated.events) await addEvent(store, event);
  const history = [
    ...new Map(
      [...c.quoteHistory, ...observations].map((q) => [q.session, q]),
    ).values(),
  ]
    .sort((a, b) => a.session.localeCompare(b.session))
    .slice(-400);
  const quoteError = tooOld
    ? "Provider returned an old close; numerical alerts withheld."
    : suspicious
      ? "Large price discontinuity; check corporate actions and currency. Numerical alerts withheld."
      : "";
  if (quoteError) await healthEvent(store, c, quoteError, now);
  return store.put(
    "company",
    c.id,
    {
      ...c,
      quote: !c.quote || latest.session >= c.quote.session ? latest : c.quote,
      quoteHistory: history,
      rules: evaluated.rules,
      lastQuoteCheck: now.toISOString(),
      quoteError,
    },
    doc.version,
  );
}
export async function updateFreshCompany(
  store: Store,
  id: string,
  fn: (doc: Doc<Company>) => Promise<Doc<Company>>,
) {
  const lock = await store.claim(`company-${id}`, 20);
  if (!lock) throw new ConflictError();
  try {
    const doc = await store.get<Company>("company", id);
    if (!doc) throw new Error("Company no longer exists.");
    return await fn(doc);
  } finally {
    await store.release(`company-${id}`, lock);
  }
}
export async function runMonitor(
  store: Store,
  env: Env,
  options: {
    companyId?: string;
    force?: boolean;
    // Scheduled news comes from the nightly news runs; the scheduler checks quotes only.
    news?: boolean;
    maxCompanies?: number;
    milliseconds?: number;
  } = {},
) {
  const lease = await store.claim("monitor", 140);
  if (!lease) return { busy: true, processed: 0 };
  const started = Date.now();
  const checkNews = options.news ?? true;
  const result = {
    busy: false,
    processed: 0,
    articles: 0,
    failures: 0,
    remaining: 0,
    startedAt: new Date().toISOString(),
    finishedAt: "",
  };
  try {
    // Selection needs only schedule fields; each chosen company is read in full below.
    const companies = (
      await store.list<Company>("company", {
        fields: [
          "status",
          "cadence",
          "archived",
          "lastQuoteCheck",
          "lastNewsCheck",
        ],
      })
    ).map((d) => ({ ...d, data: { ...d.data, id: d.id } as Company }));
    const candidates = companies
      .filter(
        ({ data: c }) =>
          (!options.companyId || options.companyId === c.id) &&
          cadenceOf(c) !== "paused" &&
          (options.force ||
            due(c, c.lastQuoteCheck) ||
            (checkNews && due(c, c.lastNewsCheck))),
      )
      .sort(
        (a, b) =>
          Math.min(
            Date.parse(a.data.lastNewsCheck) || 0,
            Date.parse(a.data.lastQuoteCheck) || 0,
          ) -
          Math.min(
            Date.parse(b.data.lastNewsCheck) || 0,
            Date.parse(b.data.lastQuoteCheck) || 0,
          ),
      );
    for (const candidate of candidates) {
      if (
        Date.now() - started > (options.milliseconds ?? 70000) ||
        result.processed >= (options.maxCompanies ?? 5)
      )
        break;
      const attempt = await store.get<{ at: string }>("attempt", candidate.id);
      if (
        !options.force &&
        attempt &&
        Date.now() - Date.parse(attempt.data.at) < 3600000
      )
        continue;
      await store.put(
        "attempt",
        candidate.id,
        { at: new Date().toISOString() },
        attempt?.version || 0,
      );
      try {
        let doc = (await store.get<Company>("company", candidate.id))!;
        let c = doc.data;
        if (options.force || due(c, c.lastQuoteCheck)) {
          try {
            if (c.provider === "none") {
              await healthEvent(
                store,
                c,
                "No quote source configured. Prices and valuation alerts are not being monitored.",
              );
              doc = await updateFreshCompany(store, c.id, (latest) =>
                store.put(
                  "company",
                  c.id,
                  { ...latest.data, lastQuoteCheck: new Date().toISOString() },
                  latest.version,
                ),
              );
            } else {
              const quotes = await fetchQuotes(c, env);
              doc = await updateFreshCompany(store, c.id, (latest) =>
                latest.data.provider === c.provider &&
                latest.data.providerSymbol === c.providerSymbol &&
                latest.data.currency === c.currency
                  ? saveQuoteObservations(store, latest, quotes)
                  : Promise.resolve(latest),
              );
            }
          } catch (error) {
            result.failures++;
            const message =
              error instanceof Error ? error.message : "Quote refresh failed";
            doc = await updateFreshCompany(store, c.id, (latest) =>
              store.put(
                "company",
                c.id,
                { ...latest.data, quoteError: message },
                latest.version,
              ),
            );
            await healthEvent(store, c, message);
          }
        }
        c = doc.data;
        if (checkNews && (options.force || due(c, c.lastNewsCheck))) {
          const primary = await discoverPrimary(c, env);
          for (const message of primary.errors)
            await healthEvent(store, c, message);
          let primaryComplete = true;
          for (const article of primary.articles) {
            if (Date.now() - started > 65000) {
              primaryComplete = false;
              break;
            }
            if (await store.get("event", `news-${c.id}-${article.id}`))
              continue;
            await processArticle(c, article, store, env);
            result.articles++;
          }
          const feeds = structuredClone(c.feeds);
          let complete = primaryComplete;
          if (!feeds.length)
            await healthEvent(
              store,
              c,
              "No news sources configured. Add an official investor-relations feed and a broader news feed to begin monitoring.",
            );
          for (const feed of feeds) {
            if (Date.now() - started > 80000) {
              complete = false;
              break;
            }
            try {
              const articles = await fetchFeed(
                isDefaultNewsFeed(feed) ? companyNewsUrl(c) : feed.url,
                feed.official,
                env,
              );
              const since = feed.lastSuccess
                ? Date.parse(feed.lastSuccess) - 2 * 86400000
                : Date.now() - (cadenceOf(c) === "weekly" ? 9 : 3) * 86400000;
              const dated = articles
                .filter((a) => a.publishedAt)
                .map((a) => Date.parse(a.publishedAt));
              if (!dated.length || Math.min(...dated) > since)
                await healthEvent(
                  store,
                  c,
                  `Feed coverage may not span the full monitoring interval: ${feed.label}. Only supplied feed items can be checked.`,
                );
              for (const article of articles.filter(
                (a) => !a.publishedAt || Date.parse(a.publishedAt) >= since,
              )) {
                if (Date.now() - started > 85000) {
                  complete = false;
                  break;
                }
                if (await store.get("event", `news-${c.id}-${article.id}`))
                  continue;
                await processArticle(c, article, store, env);
                result.articles++;
              }
              if (complete) {
                feed.lastSuccess = new Date().toISOString();
                feed.error = "";
              }
            } catch (error) {
              complete = false;
              result.failures++;
              feed.error =
                error instanceof Error ? error.message : "Feed failed";
              await healthEvent(store, c, `${feed.label}: ${feed.error}`);
            }
          }
          await updateFreshCompany(store, c.id, (latest) => {
            const mergedFeeds = latest.data.feeds.map((f) => {
              const checked = feeds.find(
                (x) => x.id === f.id && x.url === f.url,
              );
              return checked
                ? {
                    ...f,
                    lastSuccess: checked.lastSuccess,
                    error: checked.error,
                  }
                : f;
            });
            const allChecked =
              complete &&
              mergedFeeds.every((f) =>
                feeds.some((x) => x.id === f.id && x.url === f.url),
              );
            return store.put(
              "company",
              c.id,
              {
                ...latest.data,
                feeds: mergedFeeds,
                lastNewsCheck: allChecked
                  ? new Date().toISOString()
                  : latest.data.lastNewsCheck,
              },
              latest.version,
            );
          });
        }
        result.processed++;
      } catch (error) {
        result.failures++;
        await healthEvent(
          store,
          candidate.data,
          error instanceof Error ? error.message : "Monitoring interrupted.",
        );
      }
    }
    result.remaining = Math.max(0, candidates.length - result.processed);
    result.finishedAt = new Date().toISOString();
    const previous = await store.get("run", "latest");
    await store.put("run", "latest", result, previous?.version || 0);
    return result;
  } finally {
    await store.release("monitor", lease);
  }
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (x) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        x
      ]!,
  );
export async function dailySnapshot(store: Store, now = new Date()) {
  const date = chicagoParts(now).date;
  if (await store.get("backup", date, { fields: [] }))
    return { created: false };
  const records = (
    await Promise.all([
      store.list<Company>("company", { summary: true }),
      store.list("settings"),
      store.list("import"),
    ])
  ).flat();
  await store.put(
    "backup",
    date,
    {
      format: "research-desk",
      version: 1,
      exportedAt: now.toISOString(),
      records,
      recordCount: records.length,
    },
    0,
  );
  const cutoff = new Date(now.getTime() - 29 * 86400000)
    .toISOString()
    .slice(0, 10);
  for (const old of await store.list("backup", { fields: [] }))
    if (old.id < cutoff) await store.remove("backup", old.id, old.version);
  return { created: true, records: records.length };
}
// The morning email carries the most important developments; the rest stay in the
// desk inbox rather than making the email unreadable.
export const DIGEST_DEVELOPMENT_LIMIT = 20;

// Only developments with a member discovered since `since` can appear in a digest.
// Find them from a small index, then read those groups' members in full.
async function recentDevelopments(store: Store, since: string, until: string) {
  const index = await store.list<DeskEvent>("event", {
    fields: ["kind", "companyId", "clusterId", "discoveredAt"],
  });
  const key = (d: Doc<DeskEvent>) =>
    d.data.kind === "news"
      ? `${d.data.companyId}:${d.data.clusterId || d.id}`
      : d.id;
  const recent = new Set(
    index
      .filter(
        (d) => d.data.discoveredAt > since && d.data.discoveredAt <= until,
      )
      .map(key),
  );
  const ids = index.filter((d) => recent.has(key(d))).map((d) => d.id);
  // Keep the store's order (newest first, then id) so ties group identically.
  return (await store.list<DeskEvent>("event", { ids, summary: true })).sort(
    (a, b) =>
      b.data.discoveredAt.localeCompare(a.data.discoveredAt) ||
      a.id.localeCompare(b.id),
  );
}
// `window` limits the digest to developments found in one period, e.g. one
// news run (the "email this screen" button); otherwise it covers everything
// since the last delivered digest.
export async function digestPreview(
  store: Store,
  now = new Date(),
  window?: { since: string; until?: string; title?: string },
) {
  const companies = await store.list<Company>("company", { summary: true });
  const names = new Map(companies.map((c) => [c.id, c.data.name]));
  const previous = window
    ? undefined
    : (
        await store.list<{ deliveredAt?: string }>("digest", {
          fields: ["deliveredAt"],
        })
      )
        .filter((d) => d.data.deliveredAt)
        .sort((a, b) =>
          b.data.deliveredAt!.localeCompare(a.data.deliveredAt!),
        )[0];
  const since =
    window?.since ||
    previous?.data.deliveredAt ||
    new Date(now.getTime() - 86400000).toISOString();
  const until = window?.until || now.toISOString();
  const eligible = (await recentDevelopments(store, since, until)).filter(
    ({ data: e }) =>
      e.discoveredAt <= until &&
      (e.kind === "health" ||
        newsBucket(e) === "relevant" ||
        (newsBucket(e) === "uncertain" && e.screening?.possibleMajor)),
  );
  const ranked = groupNews(eligible)
    .filter((g) =>
      [g.lead, ...g.coverage].some((d) => d.data.discoveredAt > since),
    )
    .map((g) => ({
      ...g.lead.data,
      screening: currentAssessment(g.lead.data, now),
      priority: eventPriority(g.lead.data),
      coverage: g.coverage.slice(0, 3).map((d) => d.data.url),
      importance: digestImportance(g.lead.data, now),
    }));
  const developments = ranked
    .filter((e) => e.kind !== "health")
    .sort((a, b) => b.importance - a.importance);
  const alerts = ranked.filter((e) => e.kind === "health");
  const featured = developments.slice(0, DIGEST_DEVELOPMENT_LIMIT);
  const remainder = developments.slice(DIGEST_DEVELOPMENT_LIMIT);
  const missing = companies.filter(
    (c) =>
      !c.data.archived &&
      cadenceOf(c.data) !== "paused" &&
      (!c.data.feeds.length ||
        c.data.provider === "none" ||
        c.data.feeds.some((f) => f.error) ||
        c.data.quoteError),
  );
  const date = chicagoParts(now).date;
  const majors = featured.filter((e) => e.priority === "major").length;
  const prefix = window?.title ? `Research Desk · ${window.title}` : "Research Desk";
  const subject = developments.length
    ? `${prefix} · ${date} · ${developments.length} development${developments.length === 1 ? "" : "s"}${majors ? ` · ${majors} important` : ""}`
    : `${prefix} · ${date} · nothing new`;

  const company = (e: (typeof featured)[number]) =>
    names.get(e.companyId) || "Company";
  const dateLabel = (e: (typeof featured)[number]) => {
    const age = articleAgeDays(e.publishedAt, now);
    if (age === null) return "date unknown";
    if (age < 1) return "today";
    const days = Math.round(age);
    return days === 1 ? "yesterday" : `${days} days ago`;
  };
  const verdict = (e: (typeof featured)[number]) =>
    e.screening?.disposition === "uncertain"
      ? "NEEDS VERIFICATION"
      : e.priority === "major"
        ? "IMPORTANT"
        : "";

  const textEntry = (e: (typeof featured)[number], n: number) =>
    [
      `${n}. ${company(e)} — ${e.title}`,
      `   ${[verdict(e), e.screening?.reason].filter(Boolean).join(" · ")}`,
      `   ${(e.evidence || e.body || "").slice(0, 400).trim()}`,
      `   ${e.url}`,
      `   Published ${dateLabel(e)}${e.screening?.primary ? " · company source" : ""}`,
      e.coverage.length ? `   Also covered: ${e.coverage.join(" ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

  const text = [
    subject,
    `America/Chicago · ${date} · coverage depends on your configured sources.`,
    "",
    developments.length
      ? `TOP ${featured.length} OF ${developments.length}`
      : "",
    featured.map((e, i) => textEntry(e, i + 1)).join("\n\n") ||
      "No new developments from your configured sources.",
    remainder.length
      ? `\n${remainder.length} further development${remainder.length === 1 ? "" : "s"} not shown; open the desk inbox to review them.`
      : "",
    alerts.length
      ? `\nMONITORING ALERTS (${alerts.length})\n${alerts
          .slice(0, 10)
          .map((e) => `- ${company(e)}: ${e.title}`)
          .join(
            "\n",
          )}${alerts.length > 10 ? `\n- and ${alerts.length - 10} more` : ""}`
      : "",
    missing.length
      ? `\nCOVERAGE GAPS\n${missing.length} companies have a missing source or a monitoring issue: ${missing
          .slice(0, 12)
          .map((c) => c.data.name)
          .join(
            ", ",
          )}${missing.length > 12 ? `, and ${missing.length - 12} more` : ""}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const htmlEntry = (e: (typeof featured)[number]) => {
    const mark = verdict(e);
    return `<li style="margin:0 0 20px">
<div style="font-size:13px;color:#666">${escapeHtml(company(e))} · published ${escapeHtml(dateLabel(e))}${e.screening?.primary ? " · company source" : ""}</div>
<div style="font-size:16px;font-weight:600;margin:2px 0 4px"><a href="${escapeHtml(e.url)}" style="color:#12492f;text-decoration:none">${escapeHtml(e.title)}</a></div>
${mark ? `<div style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.05em;padding:2px 6px;border-radius:3px;background:${mark === "IMPORTANT" ? "#12492f;color:#fff" : "#fde68a;color:#78350f"}">${mark}</div> ` : ""}
<div style="font-size:13px;color:#444;margin:4px 0">${escapeHtml(e.screening?.reason || "")}</div>
<div style="font-size:14px;color:#222">${escapeHtml((e.evidence || e.body || "").slice(0, 400).trim())}</div>
${e.coverage.length ? `<div style="font-size:12px;color:#666;margin-top:4px">Also covered: ${e.coverage.map((u) => `<a href="${escapeHtml(u)}" style="color:#666">${escapeHtml(new URL(u).hostname.replace(/^www\./, ""))}</a>`).join(" · ")}</div>` : ""}
</li>`;
  };
  const section = (title: string, body: string) =>
    `<h2 style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#666;border-bottom:1px solid #e5e5e5;padding-bottom:6px;margin:28px 0 14px">${escapeHtml(title)}</h2>${body}`;
  const html = `<div style="max-width:640px;margin:0 auto;padding:24px;font:15px/1.6 -apple-system,system-ui,'Segoe UI',sans-serif;color:#222">
<div style="font-size:20px;font-weight:700">Research Desk</div>
${window?.title ? `<div style="font-size:14px;color:#444">${escapeHtml(window.title)}</div>` : ""}
<div style="font-size:14px;color:#222;margin-top:2px">${escapeHtml(
    developments.length
      ? `${developments.length} development${developments.length === 1 ? "" : "s"}${majors ? `, ${majors} important` : ""}`
      : "Nothing new from your configured sources",
  )}</div>
<div style="font-size:13px;color:#666;margin-top:2px">${escapeHtml(date)} · America/Chicago · coverage depends on your configured sources.</div>
${
  featured.length
    ? section(
        `Top ${featured.length} of ${developments.length}`,
        `<ol style="padding-left:20px;margin:0">${featured.map(htmlEntry).join("")}</ol>` +
          (remainder.length
            ? `<div style="font-size:13px;color:#666">${remainder.length} further development${remainder.length === 1 ? "" : "s"} not shown; open the desk inbox to review them.</div>`
            : ""),
      )
    : section(
        "Developments",
        `<div style="color:#666">No new developments from your configured sources.</div>`,
      )
}
${
  alerts.length
    ? section(
        `Monitoring alerts (${alerts.length})`,
        `<ul style="padding-left:20px;margin:0;font-size:14px">${alerts
          .slice(0, 10)
          .map(
            (e) =>
              `<li><b>${escapeHtml(company(e))}:</b> ${escapeHtml(e.title)}</li>`,
          )
          .join(
            "",
          )}</ul>${alerts.length > 10 ? `<div style="font-size:13px;color:#666">and ${alerts.length - 10} more</div>` : ""}`,
      )
    : ""
}
${
  missing.length
    ? section(
        "Coverage gaps",
        `<div style="font-size:14px;color:#444"><b>${missing.length}</b> companies have a missing source or a monitoring issue: ${escapeHtml(
          missing
            .slice(0, 12)
            .map((c) => c.data.name)
            .join(", "),
        )}${missing.length > 12 ? `, and ${missing.length - 12} more` : ""}.</div>`,
      )
    : ""
}
</div>`;
  return {
    date,
    subject,
    text,
    html,
    count: developments.length,
    shown: featured.length,
    alerts: alerts.length,
    missing: missing.length,
    generatedAt: now.toISOString(),
  };
}
async function deliverEmail(
  env: Env,
  email: { subject: string; text: string; html: string },
  idempotencyKey: string,
) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from: env.DIGEST_FROM,
      to: [env.DIGEST_TO || "nithin@mantena.com"],
      subject: email.subject,
      text: email.text,
      html: email.html,
    }),
  });
  if (!response.ok)
    throw new Error(`Email delivery returned HTTP ${response.status}.`);
  return (await response.json()) as { id?: string };
}

// The "email this screen" button: developments found by one news run.
export async function sendRunEmail(
  store: Store,
  env: Env,
  run: {
    id: string;
    label: string;
    status: string;
    createdAt: string;
    finishedAt?: string;
  },
  now = new Date(),
) {
  if (!configuration(env).email)
    throw new Error("Email delivery is not configured on the server.");
  const preview = await digestPreview(store, now, {
    since: run.createdAt,
    until: run.finishedAt || now.toISOString(),
    title: `${run.label}${run.status === "running" ? " (still running)" : ""}`,
  });
  // A key per run and minute: a double click sends once; a later click resends.
  const receipt = await deliverEmail(
    env,
    preview,
    `research-desk-run-${run.id}-${now.toISOString().slice(0, 16)}`,
  );
  return {
    sent: true,
    subject: preview.subject,
    developments: preview.count,
    providerId: receipt.id,
  };
}

export async function sendDueDigest(store: Store, env: Env, now = new Date()) {
  const settings =
    (await store.get<Settings>("settings", "main"))?.data || defaultSettings;
  if (
    !settings.digestEnabled ||
    !configuration(env).email ||
    chicagoParts(now).hour < settings.digestHour
  )
    return { sent: false, reason: "Disabled, unconfigured, or not due." };
  const key = chicagoParts(now).date;
  const existing = await store.get<{
    deliveredAt?: string;
    status?: string;
    attemptedAt?: string;
  }>("digest", key);
  if (existing?.data.deliveredAt || existing?.data.status === "skipped")
    return { sent: false, reason: "Already delivered or skipped today." };
  // Resend retains idempotency keys for 24 hours. Never retry an ambiguous send outside that window.
  if (
    existing?.data.attemptedAt &&
    now.getTime() - Date.parse(existing.data.attemptedAt) >= 23 * 3600000
  )
    return { sent: false, reason: "Old ambiguous delivery requires review." };
  const lease = await store.claim("digest", 60);
  if (!lease) return { sent: false, reason: "Digest already running." };
  try {
    const preview = await digestPreview(store, now);
    if (
      settings.skipEmpty &&
      preview.count === 0 &&
      preview.alerts === 0 &&
      preview.missing === 0
    ) {
      await store.put(
        "digest",
        key,
        { status: "skipped", generatedAt: preview.generatedAt },
        existing?.version || 0,
      );
      return { sent: false, reason: "Empty digest skipped." };
    }
    const pending =
      existing ||
      (await store.put(
        "digest",
        key,
        { status: "pending", attemptedAt: now.toISOString(), preview },
        0,
      ));
    const saved = (pending.data as any).preview || preview;
    const receipt = await deliverEmail(
      env,
      saved,
      `research-desk-${env.MONITOR_OWNER_ID || "local"}-${key}`,
    );
    await store.put(
      "digest",
      key,
      {
        status: "sent",
        deliveredAt: saved.generatedAt,
        sentAt: now.toISOString(),
        providerId: receipt.id,
      },
      pending.version,
    );
    return { sent: true };
  } finally {
    await store.release("digest", lease);
  }
}
