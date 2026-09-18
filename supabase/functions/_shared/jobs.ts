import {
  ConflictError,
  defaultSettings,
  type Company,
  type DeskEvent,
  type Doc,
  type Quote,
  type Settings,
  type Store,
} from "./model.ts";
import { cadenceOf, chicagoParts, due, evaluateRules, hash } from "./engine.ts";
import {
  classifyArticle,
  configuration,
  fetchFeed,
  fetchQuotes,
  type Article,
  type Env,
} from "./providers.ts";

export async function addEvent(store: Store, event: DeskEvent) {
  if (await store.get("event", event.id)) return;
  try {
    await store.put("event", event.id, event, 0);
  } catch (error) {
    if (!(await store.get("event", event.id))) throw error;
  }
}
export async function processArticle(
  c: Company,
  article: Article,
  store: Store,
  env: Env,
): Promise<DeskEvent> {
  const id = `news-${c.id}-${article.id}`;
  const existing = await store.get<DeskEvent>("event", id);
  if (existing) return existing.data;
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
  try {
    const result = await classifyArticle(c, article, env, store);
    event.classification = { ...event.classification, ...result };
    event.evidence = result.evidence;
    event.matches = result.matches.filter((x) => x.relevance >= 0.35);
    // Low-confidence identities/materiality stay visible. Suppression requires both strong identity and little relevance, or a very clear mismatch.
    const relevant = result.matches.some((x) => x.relevance >= 0.35);
    event.priority =
      result.identity >= 0.7 && result.major >= 0.65 && result.evidence
        ? "major"
        : result.identity < 0.1 ||
            (result.identity >= 0.8 && result.major < 0.15 && !relevant)
          ? "suppressed"
          : "possible";
    if (relevant && event.priority === "suppressed")
      event.priority = "possible";
  } catch (error) {
    event.classification = {
      ...event.classification,
      error:
        error instanceof Error ? error.message : "Classification unavailable",
    };
    event.body = `Unclassified — review the source. ${event.body}`;
  }
  await addEvent(store, event);
  return event;
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
async function updateFreshCompany(
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
  options: { companyId?: string; force?: boolean } = {},
) {
  const lease = await store.claim("monitor", 140);
  if (!lease) return { busy: true, processed: 0 };
  const started = Date.now();
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
    const companies = await store.list<Company>("company", { summary: true });
    const candidates = companies
      .filter(
        ({ data: c }) =>
          (!options.companyId || options.companyId === c.id) &&
          cadenceOf(c) !== "paused" &&
          (options.force ||
            due(c, c.lastQuoteCheck) ||
            due(c, c.lastNewsCheck)),
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
      if (Date.now() - started > 70000 || result.processed >= 5) break;
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
        if (options.force || due(c, c.lastNewsCheck)) {
          const feeds = structuredClone(c.feeds);
          let complete = true;
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
              const articles = await fetchFeed(feed.url, feed.official, env);
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
  if (await store.get("backup", date)) return { created: false };
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
  const cutoff = new Date(now.getTime() - 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  for (const old of await store.list("backup", { summary: true }))
    if (old.id < cutoff) await store.remove("backup", old.id, old.version);
  return { created: true, records: records.length };
}
export async function digestPreview(store: Store, now = new Date()) {
  const companies = await store.list<Company>("company");
  const names = new Map(companies.map((c) => [c.id, c.data.name]));
  const previous = (await store.list<{ deliveredAt?: string }>("digest"))
    .filter((d) => d.data.deliveredAt)
    .sort((a, b) => b.data.deliveredAt!.localeCompare(a.data.deliveredAt!))[0];
  const since =
    previous?.data.deliveredAt ||
    new Date(now.getTime() - 86400000).toISOString();
  const events = (await store.list<DeskEvent>("event"))
    .map((x) => x.data)
    .filter(
      (e) =>
        e.priority !== "suppressed" &&
        e.discoveredAt > since &&
        e.discoveredAt <= now.toISOString(),
    )
    .sort((a, b) =>
      a.kind === "health" && b.kind !== "health"
        ? 1
        : b.priority.localeCompare(a.priority),
    );
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
  const subject = `Research Desk · ${date} · ${events.filter((e) => e.kind !== "health").length} developments`;
  const text = `${subject}\nAmerica/Chicago · Coverage depends on configured sources.\n\n${events.map((e) => `${names.get(e.companyId) || "Company"} — ${e.title}\n${e.evidence || e.body}\n${e.url}\nPublished: ${e.publishedAt || "Unknown"}; discovered: ${e.discoveredAt}`).join("\n\n") || "No new developments from your configured sources."}\n\n${missing.length} companies have a missing source or a monitoring issue.\n${missing
    .slice(0, 30)
    .map((c) => c.data.name)
    .join(", ")}${missing.length > 30 ? "…" : ""}`;
  return {
    date,
    subject,
    text,
    html: `<pre style="white-space:pre-wrap;font:15px/1.6 system-ui">${escapeHtml(text)}</pre>`,
    count: events.length,
    missing: missing.length,
    generatedAt: now.toISOString(),
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
    if (settings.skipEmpty && preview.count === 0 && preview.missing === 0) {
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
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `research-desk-${env.MONITOR_OWNER_ID || "local"}-${key}`,
      },
      body: JSON.stringify({
        from: env.DIGEST_FROM,
        to: [env.DIGEST_TO || "nithin@mantena.com"],
        subject: saved.subject,
        text: saved.text,
        html: saved.html,
      }),
    });
    if (!response.ok)
      throw new Error(`Email delivery returned HTTP ${response.status}.`);
    const receipt = await response.json();
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
