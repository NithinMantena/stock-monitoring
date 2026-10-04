import { normalizeSize } from "./company-size.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DatabaseReadError } from "./database-read.ts";
import { z, ZodError } from "zod";
import {
  CompanySchema,
  ConflictError,
  QuoteSchema,
  SettingsSchema,
  defaultSettings,
  newCompany,
  type Company,
  type DeskEvent,
  type Doc,
  type Store,
} from "./model.ts";
import {
  candidateToCompany,
  markdownExport,
  parseInvestmentMarkdown,
} from "./importer.ts";
import { chicagoParts, hash, safeLink } from "./engine.ts";
import { companyNewsUrl, isDefaultNewsFeed } from "./news.ts";
import { configuration, validateFeedUrl, type Env } from "./providers.ts";
import {
  contentHosts,
  validateContentUrl,
  enrichArticle,
} from "./article-content.ts";
import { MAX_ARTICLE_CHARS } from "./screening-policy.ts";
import { inEventFolder, isExpired } from "./event-inbox.ts";
import {
  LIBRARY_ID,
  LibrarySchema,
  applySavePatch,
  defaultLibrary,
  eventLists,
  normalizeTag,
  sameTag,
} from "./library.ts";
import { validateRestoreRecords } from "./restore.ts";
import {
  advanceNewsBatch,
  startNewsBatch,
  controlNewsBatch,
  readBatchSummary,
} from "./news-batch.ts";
import {
  digestPreview,
  sendRunEmail,
  processArticle,
  runMonitor,
  rescreenNews,
  saveQuoteObservations,
} from "./jobs.ts";
import { scheduleState, tick } from "./scheduler.ts";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export function createApi(store: Store, env: Env, mode: "local" | "cloud") {
  const api = new Hono();
  const normalLimit = bodyLimit({
    maxSize: 2500000,
    onError: (c) => c.json({ error: "File exceeds the 2.5 MB limit." }, 413),
  });
  const backupLimit = bodyLimit({
    maxSize: 100000000,
    onError: (c) =>
      c.json({ error: "Backup exceeds the 100 MB restore limit." }, 413),
  });
  api.use("*", (c, next) =>
    c.req.path.endsWith("/restore")
      ? backupLimit(c, next)
      : normalLimit(c, next),
  );
  api.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof ZodError
            ? error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; ")
            : error.message || "Request failed",
      },
      error instanceof ConflictError
        ? 409
        : error instanceof DatabaseReadError
          ? error.status
          : 400,
    ),
  );
  // Inbox and saved items only: select them from a small index, then read those.
  const inboxEvents = async () => {
    const index = await store.list<DeskEvent>("event", {
      fields: ["reviewed", "saved", "inboxAt", "discoveredAt"],
    });
    const ids = index
      .filter((d) => inEventFolder(d.data, "inbox") || d.data.saved)
      .map((d) => d.id);
    return (await store.list<DeskEvent>("event", { ids, summary: true })).sort(
      (a, b) =>
        b.data.discoveredAt.localeCompare(a.data.discoveredAt) ||
        a.id.localeCompare(b.id),
    );
  };
  api.get("/bootstrap", async (c) => {
    const companiesSince = c.req.query("companiesSince");
    if (companiesSince) z.iso.datetime().parse(companiesSince);
    const [companies, events, settings, run, imports, usage, newsBatch, newsRun, schedule, library] =
      await Promise.all([
        // Browsers ask for changed companies only after an edit elsewhere.
        store.list<Company>("company", {
          summary: true,
          updatedSince: companiesSince,
        }),
        c.req.query("events") === "none" ? [] : inboxEvents(),
        store.get("settings", "main"),
        store.get("run", "latest"),
        store.list<any>("import", { summary: true }),
        store.usage?.() || [],
        readBatchSummary(store, "latest"),
        readBatchSummary(store, "scheduled"),
        scheduleState(store),
        store.get<unknown>("settings", LIBRARY_ID),
      ]);
    return c.json({
      companies,
      events,
      newsRun,
      newsRunHistory: schedule?.data.history || [],
      settings: settings?.data || defaultSettings,
      settingsVersion: settings?.version || 0,
      library: library ? LibrarySchema.parse(library.data) : defaultLibrary(),
      libraryVersion: library?.version || 0,
      run: run?.data,
      imports: imports
        .filter((x) => !x.data.importedBatch)
        .map((x) => ({
          id: x.id,
          count: x.data.count,
          at: x.data.at,
          rolledBack: x.data.rolledBack,
          draft: x.data.draft,
        })),
      configuration: { ...configuration(env), mode },
      usage,
      newsBatch,
    });
  });
  const NewCompanyInput = z.object({
    name: z.string().trim().min(1).max(200),
    status: CompanySchema.shape.status,
    ticker: z.string().max(50).optional(),
    ideaSource: z.string().max(2000).optional(),
    // Either a size tier or a market cap (USD); a market cap wins.
    sizeClass: CompanySchema.shape.sizeClass.optional(),
    marketCapUsd: z.number().positive().finite().nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  });
  const buildCompany = (input: z.infer<typeof NewCompanyInput>) => {
    let company = newCompany(input.name, input.status);
    company.ticker = input.ticker || "";
    company.ideaSource = input.ideaSource || "";
    for (const raw of input.tags || []) {
      const tag = normalizeTag(raw);
      if (tag && !company.tags.some((t) => sameTag(t, tag))) company.tags.push(tag);
    }
    if (input.marketCapUsd) {
      company.marketCapUsd = input.marketCapUsd;
      company.marketCapAsOf = new Date().toISOString().slice(0, 10);
      company.sizeSource = "market_cap";
    } else if (input.sizeClass && input.sizeClass !== "unknown") {
      company.sizeClass = input.sizeClass;
      company.sizeSource = "manual";
    }
    return normalizeSize(company);
  };
  api.post("/companies", async (c) => {
    const company = buildCompany(NewCompanyInput.parse(await c.req.json()));
    return c.json(await store.put("company", company.id, company, 0), 201);
  });
  // The add-companies window: every company in one atomic write.
  api.post("/companies/bulk", async (c) => {
    const { companies } = z
      .object({ companies: z.array(NewCompanyInput).min(1).max(200) })
      .parse(await c.req.json());
    const built = companies.map(buildCompany);
    const saved = await store.batch(
      built.map((data) => ({ kind: "company", id: data.id, data, expected: 0 })),
    );
    return c.json({ companies: saved }, 201);
  });
  api.put("/companies/:id", async (c) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        data: CompanySchema,
        base: CompanySchema.optional(),
      })
      .parse(await c.req.json());
    const id = c.req.param("id");
    if (input.data.id !== id) throw new Error("Company ID mismatch.");
    const lock = await store.claim(`company-${id}`, 30);
    if (!lock) throw new ConflictError();
    try {
      const old = await store.get<Company>("company", id);
      if (!old) throw new ConflictError();
      if (old.version !== input.version) {
        if (!input.base) throw new ConflictError();
        const editable = [
          "name",
          "ticker",
          "exchange",
          "currency",
          "status",
          "cadence",
          "originalGroup",
          "researchDepth",
          "tags",
          "notes",
          "thesis",
          "passReason",
          "source",
          "ideaSource",
          "newsQuery",
          "businessScale",
          "sizeClass",
          "sizeSource",
          "marketCapUsd",
          "marketCapAsOf",
          "officialName",
          "country",
          "businessContext",
          "contextAsOf",
          "contextSource",
          "primarySources",
          "secCik",
          "articleHosts",
          "excludedNewsSources",
          "dateFound",
          "lastReviewed",
          "nextReview",
          "targetPrice",
          "archived",
          "watchPoints",
          "rules",
          "feeds",
          "provider",
          "providerSymbol",
        ] as const;
        const merged = { ...old.data };
        // Background checkpoints are not user edits. Compare only editable
        // fields; the server reapplies current feed/rule state below.
        const comparable = (
          company: Company,
          key: (typeof editable)[number],
        ) => {
          if (key === "feeds")
            return company.feeds.map(({ id, url, label, official }) => ({
              id,
              url,
              label,
              official,
            }));
          if (key === "rules")
            return company.rules.map(
              ({
                id,
                metric,
                threshold,
                currency,
                baseline,
                enabled,
                basis,
              }) => ({
                id,
                metric,
                threshold,
                currency,
                baseline,
                enabled,
                basis,
              }),
            );
          return company[key];
        };
        for (const key of editable) {
          const original = JSON.stringify(comparable(input.base, key));
          const proposed = JSON.stringify(comparable(input.data, key));
          const current = JSON.stringify(comparable(old.data, key));
          if (original === proposed) continue;
          if (original !== current && proposed !== current)
            throw new ConflictError();
          (merged as any)[key] = input.data[key];
        }
        input.data = merged;
      }
      input.data.feeds = input.data.feeds.map((feed) =>
        isDefaultNewsFeed(feed)
          ? {
              ...feed,
              label: "Google News · company news",
              url: companyNewsUrl(input.data),
            }
          : feed,
      );
      for (const feed of input.data.feeds)
        if (!old.data.feeds.some((f) => f.url === feed.url))
          validateFeedUrl(feed.url, env);
      for (const url of input.data.primarySources)
        validateContentUrl(url, contentHosts(input.data, env));
      if (
        old.data.notes !== input.data.notes ||
        old.data.thesis !== input.data.thesis
      )
        await store
          .put(
            "revision",
            `${id}-${old.version}`,
            {
              companyId: id,
              notes: old.data.notes,
              thesis: old.data.thesis,
              at: old.updatedAt,
            },
            0,
          )
          .catch(async (e) => {
            if (!(await store.get("revision", `${id}-${old.version}`))) throw e;
          });
      // Server-maintained quotes, checkpoints and rule episodes cannot be overwritten by a stale browser copy.
      const rules = input.data.rules.map((r) => {
        const prev = old.data.rules.find((x) => x.id === r.id);
        return prev &&
          prev.metric === r.metric &&
          prev.threshold === r.threshold &&
          prev.currency === r.currency &&
          prev.baseline === r.baseline &&
          prev.enabled === r.enabled &&
          prev.basis === r.basis
          ? {
              ...r,
              triggered: prev.triggered,
              episode: prev.episode,
              lastSession: prev.lastSession,
              lastFingerprint: prev.lastFingerprint,
            }
          : {
              ...r,
              triggered: false,
              episode: (prev?.episode || 0) + 1,
              lastSession: "",
              lastFingerprint: "",
            };
      });
      const quoteMappingChanged =
        old.data.provider !== input.data.provider ||
        old.data.providerSymbol !== input.data.providerSymbol ||
        old.data.currency !== input.data.currency;
      const feedsChanged =
        JSON.stringify(old.data.feeds.map((f) => [f.id, f.url])) !==
        JSON.stringify(input.data.feeds.map((f) => [f.id, f.url]));
      const value: Company = {
        ...normalizeSize(input.data),
        feeds: input.data.feeds.map((feed) => {
          const prior = old.data.feeds.find(
            (f) => f.id === feed.id && f.url === feed.url,
          );
          return {
            ...feed,
            lastSuccess: prior?.lastSuccess || "",
            error: prior?.error || "",
          };
        }),
        rules,
        quote: quoteMappingChanged ? null : old.data.quote,
        quoteHistory: quoteMappingChanged ? [] : old.data.quoteHistory,
        quoteError: quoteMappingChanged ? "" : old.data.quoteError,
        lastQuoteCheck: quoteMappingChanged ? "" : old.data.lastQuoteCheck,
        lastNewsCheck: feedsChanged ? "" : old.data.lastNewsCheck,
        createdAt: old.data.createdAt,
        revision: old.data.revision + 1,
        newsRevision:
          old.data.newsRevision +
          ([
            "name",
            "ticker",
            "exchange",
            "thesis",
            "watchPoints",
            "businessScale",
            "sizeClass",
            "marketCapUsd",
            "officialName",
            "businessContext",
            "contextAsOf",
            "contextSource",
            "primarySources",
            "articleHosts",
            "excludedNewsSources",
          ].some(
            (key) =>
              JSON.stringify((old.data as any)[key]) !==
              JSON.stringify((input.data as any)[key]),
          )
            ? 1
            : 0),
        updatedAt: new Date().toISOString(),
      };
      return c.json(await store.put("company", id, value, old.version));
    } finally {
      await store.release(`company-${id}`, lock);
    }
  });
  api.get("/companies/:id/revisions", async (c) =>
    c.json(
      await store.list<any>("revision", {
        companyId: c.req.param("id"),
        limit: 50,
      }),
    ),
  );
  api.get("/companies/:id/markdown", async (c) => {
    const doc = await store.get<Company>("company", c.req.param("id"));
    if (!doc) return c.notFound();
    return c.text(markdownExport(doc.data));
  });
  api.post("/companies/:id/quote", async (c) => {
    const input = z
      .object({ version: z.number().int().positive(), quote: QuoteSchema })
      .parse(await c.req.json());
    const id = c.req.param("id");
    const lock = await store.claim(`company-${id}`, 30);
    if (!lock) throw new ConflictError();
    try {
      const doc = await store.get<Company>("company", id);
      if (!doc || doc.version !== input.version) throw new ConflictError();
      if (input.quote.session > new Date().toISOString().slice(0, 10))
        throw new Error("The session date is in the future.");
      if (doc.data.currency && input.quote.currency !== doc.data.currency)
        throw new Error("Quote currency differs from the company currency.");
      return c.json(
        await saveQuoteObservations(store, doc, [
          {
            ...input.quote,
            source: "Manual",
            fetchedAt: new Date().toISOString(),
          },
        ]),
      );
    } finally {
      await store.release(`company-${id}`, lock);
    }
  });
  api.post("/companies/:id/analyze", async (c) => {
    const input = z
      .object({
        title: z.string().min(1).max(1000),
        text: z.string().min(1).max(MAX_ARTICLE_CHARS),
        url: z.string().max(2000).default(""),
        publishedAt: z.string().max(40).default(""),
      })
      .parse(await c.req.json());
    const doc = await store.get<Company>("company", c.req.param("id"));
    if (!doc) return c.notFound();
    return c.json(
      await processArticle(
        doc.data,
        {
          ...input,
          id: await hash(`${input.title}|${input.text}|${input.url}`),
          url: safeLink(input.url),
          source: "Manually supplied article",
          official: false,
          contentDepth: "supplied",
        },
        store,
        env,
      ),
    );
  });
  api.post("/events/:id/content", async (c) => {
    const doc = await store.get<DeskEvent>("event", c.req.param("id"));
    if (!doc || doc.data.kind !== "news")
      return c.json({ error: "Article not found." }, 404);
    const e = doc.data;
    const company = await store.get<Company>("company", e.companyId);
    if (!company) return c.json({ error: "Company not found." }, 404);
    const article = await enrichArticle(
      company.data,
      {
        id: e.id,
        title: e.title,
        url: e.url,
        text: e.rawText || e.body,
        publishedAt: e.publishedAt,
        source: String(e.classification?.source || ""),
        official: e.classification?.official === true,
        contentDepth: e.screening?.contentDepth || "snippet",
      },
      env,
      store,
    );
    // Reading does not invoke TypeSafe or alter review/feedback/classification.
    return c.json({
      text: article.text,
      url: article.url,
      contentDepth: article.contentDepth,
      note: article.retrievalNote,
    });
  });
  api.put("/events/:id", async (c) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        reviewed: z.boolean(),
        saved: z.boolean().optional(),
        feedback: z.enum(["useful", "noise"]).nullable().optional(),
        feedbackReason: z
          .enum([
            "too_minor",
            "wrong_company",
            "poor_source",
            "duplicate",
            "no_new_information",
            "other",
          ])
          .optional(),
      })
      .parse(await c.req.json());
    const doc = await store.get<DeskEvent>("event", c.req.param("id"));
    if (!doc || doc.version !== input.version) throw new ConflictError();
    const feedback =
      input.feedback === undefined
        ? doc.data.feedback
        : input.feedback || undefined;
    return c.json(
      await store.put(
        "event",
        doc.id,
        {
          ...doc.data,
          reviewed: input.reviewed,
          ...applySavePatch(
            { saved: doc.data.saved ?? false, lists: doc.data.lists },
            { saved: input.saved },
          ),
          inboxAt:
            !input.reviewed && (doc.data.reviewed || isExpired(doc.data))
              ? new Date().toISOString()
              : doc.data.inboxAt,
          feedback,
          feedbackReason:
            feedback === "noise"
              ? (input.feedbackReason ?? doc.data.feedbackReason)
              : undefined,
        },
        doc.version,
      ),
    );
  });
  api.get("/events", async (c) =>
    c.json(
      await store.list<DeskEvent>("event", {
        summary: true,
        companyId: c.req.query("companyId") || undefined,
      }),
    ),
  );
  api.get("/news/updates", async (c) => {
    const since = c.req.query("since");
    if (since) z.iso.datetime().parse(since);
    // Take the cursor before reading. Inclusive timestamp filtering avoids losing
    // writes committed while a refresh is in flight or sharing its timestamp.
    const cursor = new Date().toISOString();
    const [events, batch, newsRun] = await Promise.all([
      store.list<DeskEvent>("event", { summary: true, updatedSince: since }),
      readBatchSummary(store, "latest"),
      readBatchSummary(store, "scheduled", { warnings: false }),
    ]);
    return c.json({ events, batch, newsRun, cursor });
  });
  api.put("/settings", async (c) => {
    const input = z
      .object({ version: z.number().int().nonnegative(), data: SettingsSchema })
      .parse(await c.req.json());
    return c.json(
      await store.put("settings", "main", input.data, input.version),
    );
  });
  // Saved lists and the tag catalogue. Removing a list takes its articles out of
  // it; an article left in no list is no longer saved.
  api.put("/library", async (c) => {
    const input = z
      .object({ version: z.number().int().nonnegative(), data: LibrarySchema })
      .parse(await c.req.json());
    const old = await store.get<unknown>("settings", LIBRARY_ID);
    if ((old?.version || 0) !== input.version) throw new ConflictError();
    const before = old ? LibrarySchema.parse(old.data) : defaultLibrary();
    const kept = new Set(input.data.lists.map((l) => l.id));
    const removed = before.lists.filter((l) => !kept.has(l.id)).map((l) => l.id);
    const data = {
      ...input.data,
      tags: [
        ...new Map(
          input.data.tags
            .map(normalizeTag)
            .filter(Boolean)
            .map((t) => [t.toLowerCase(), t]),
        ).values(),
      ],
    };
    const saved = await store.put("settings", LIBRARY_ID, data, input.version);
    if (removed.length) {
      const index = await store.list<DeskEvent>("event", {
        fields: ["saved", "lists"],
      });
      const affected = index
        .filter((d) => eventLists(d.data).some((id) => removed.includes(id)))
        .map((d) => d.id);
      for (let i = 0; i < affected.length; i += 50) {
        const docs = await store.list<DeskEvent>("event", {
          ids: affected.slice(i, i + 50),
        });
        await store.batch(
          docs.map((d) => ({
            kind: "event",
            id: d.id,
            expected: d.version,
            data: applySavePatch(d.data, {
              lists: eventLists(d.data).filter((id) => !removed.includes(id)),
            }),
          })),
        );
      }
    }
    return c.json({ library: data, version: saved.version });
  });
  // Rewrites tags on many companies at once. Companies are read and written in
  // chunks with one atomic versioned batch each (two round trips per chunk, not
  // four per company). A chunk that hits a concurrent edit falls back to
  // per-company writes so only the edited companies are reported as failed.
  const retag = async (
    ids: string[],
    change: (tags: string[]) => string[],
  ) => {
    const updated: { id: string; version: number; tags: string[]; updatedAt: string }[] = [];
    const failed: string[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const docs = await store.list<Company>("company", { ids: chunk });
      const byId = new Map(docs.map((d) => [d.id, d]));
      const now = new Date().toISOString();
      const writes: { kind: string; id: string; data: Company; expected: number }[] = [];
      for (const id of chunk) {
        const old = byId.get(id);
        if (!old) {
          failed.push(id);
          continue;
        }
        const tags = change(old.data.tags);
        if (JSON.stringify(tags) === JSON.stringify(old.data.tags)) {
          updated.push({ id, version: old.version, tags, updatedAt: old.updatedAt });
          continue;
        }
        if (tags.length > 50) {
          failed.push(id);
          continue;
        }
        writes.push({
          kind: "company",
          id,
          expected: old.version,
          data: { ...old.data, tags, revision: old.data.revision + 1, updatedAt: now },
        });
      }
      if (!writes.length) continue;
      try {
        const saved = (await store.batch(writes)) as Doc<Company>[];
        for (const doc of saved)
          updated.push({
            id: doc.id,
            version: doc.version,
            tags: doc.data.tags,
            updatedAt: doc.updatedAt,
          });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        for (const w of writes) {
          try {
            const doc = await store.put("company", w.id, w.data, w.expected);
            updated.push({ id: doc.id, version: doc.version, tags: w.data.tags, updatedAt: doc.updatedAt });
          } catch (inner) {
            if (!(inner instanceof ConflictError)) throw inner;
            failed.push(w.id);
          }
        }
      }
    }
    return { updated, failed };
  };
  // Bulk tagging from the tag window: add and remove one tag across companies.
  api.post("/companies/tags", async (c) => {
    const input = z
      .object({
        tag: z.string().trim().min(1).max(80),
        add: z.array(z.string().min(1).max(100)).max(1000).default([]),
        remove: z.array(z.string().min(1).max(100)).max(1000).default([]),
      })
      .parse(await c.req.json());
    const tag = normalizeTag(input.tag);
    const removing = [...new Set(input.remove)];
    const adding = [...new Set(input.add)].filter((id) => !removing.includes(id));
    const added = await retag(adding, (tags) =>
      // A company that already has the tag keeps its spelling.
      tags.some((t) => sameTag(t, tag))
        ? tags
        : [...tags.filter((t) => t.trim()), tag],
    );
    const removed = await retag(removing, (tags) =>
      tags.filter((t) => t.trim() && !sameTag(t, tag)),
    );
    return c.json({
      tag,
      updated: [...added.updated, ...removed.updated],
      failed: [...added.failed, ...removed.failed],
    });
  });
  // Renames a tag everywhere: on every company and in the tag catalogue. When
  // the new name is another existing tag, the two merge into one.
  api.post("/companies/tags/rename", async (c) => {
    const input = z
      .object({
        from: z.string().trim().min(1).max(80),
        to: z.string().trim().min(1).max(80),
      })
      .parse(await c.req.json());
    const from = normalizeTag(input.from),
      to = normalizeTag(input.to);
    const index = await store.list<Company>("company", { fields: ["tags"] });
    const ids = index
      .filter((d) => (d.data.tags || []).some((t) => sameTag(t, from)))
      .map((d) => d.id);
    const result = await retag(ids, (tags) => {
      const out: string[] = [];
      for (const t of tags) {
        const next = sameTag(t, from) ? to : t;
        if (next.trim() && !out.some((x) => sameTag(x, next))) out.push(next);
      }
      return out;
    });
    const old = await store.get<unknown>("settings", LIBRARY_ID);
    const library = old ? LibrarySchema.parse(old.data) : defaultLibrary();
    const next = {
      ...library,
      tags: [
        ...library.tags.filter((t) => !sameTag(t, from) && !sameTag(t, to)),
        to,
      ],
    };
    const saved = await store.put("settings", LIBRARY_ID, next, old?.version || 0);
    return c.json({ from, to, ...result, library: next, libraryVersion: saved.version });
  });
  api.post("/monitor", async (c) => {
    const input = z
      .object({ companyId: z.string().optional() })
      .parse(await c.req.json());
    return c.json(
      await runMonitor(store, env, { ...input, force: !!input.companyId }),
    );
  });
  // Called every minute by the hosted scheduler; see scheduler.ts for the plan.
  api.post("/scheduled", async (c) => c.json(await tick(store, env)));
  api.post("/news/batches", async (c) => {
    const input = z
      .object({
        id: z.uuid(),
        companyIds: z.array(z.string().min(1).max(100)).min(1).max(1000),
        label: z.string().trim().min(1).max(300),
        // A manual screen's scope: days searched and articles kept per day.
        lookbackDays: z.number().int().min(1).max(30).default(7),
        articleLimit: z.number().int().min(1).max(20).default(10),
        // Optional exact publication window (UTC dates, inclusive); replaces lookbackDays.
        from: day.optional(),
        to: day.optional(),
      })
      .refine((x) => !x.from === !x.to, "Give both a start and an end date.")
      .parse(await c.req.json());
    return c.json(await startNewsBatch(store, input));
  });
  api.post("/news/batches/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "cancel"]) })
      .parse(await c.req.json());
    return c.json(await controlNewsBatch(store, c.req.param("id"), action));
  });
  api.post("/news/batches/:id/advance", async (c) =>
    c.json(
      await advanceNewsBatch(store, env, {
        id: c.req.param("id"),
        milliseconds: 25000,
      }),
    ),
  );
  api.post("/news/rescreen", async (c) => {
    const input = z
      .object({
        companyId: z.string().optional(),
        limit: z.number().int().min(1).max(30).default(10),
      })
      .parse(await c.req.json());
    return c.json(
      await rescreenNews(store, env, { ...input, milliseconds: 45000 }),
    );
  });
  api.get("/backups", async (c) =>
    c.json(await store.list("backup", { summary: true })),
  );
  api.get("/backups/:id", async (c) => {
    const doc = await store.get("backup", c.req.param("id"));
    if (!doc) return c.notFound();
    return c.json(doc.data);
  });
  api.get("/digest", async (c) => c.json(await digestPreview(store)));
  // Emails the developments found by today's most recent screen (manual or scheduled).
  api.post("/digest/latest-run", async (c) => {
    const now = new Date();
    const today = chicagoParts(now).date;
    const runs = (
      await Promise.all([
        readBatchSummary(store, "latest", { warnings: false }),
        readBatchSummary(store, "scheduled", { warnings: false }),
      ])
    )
      .filter((r) => r && chicagoParts(new Date(r.createdAt)).date === today)
      .sort((a, b) => b!.createdAt.localeCompare(a!.createdAt));
    if (!runs[0])
      return c.json({ error: "No news screen has run today." }, 404);
    return c.json(await sendRunEmail(store, env, runs[0], now));
  });
  api.post("/import/preview", async (c) => {
    const input = z
      .object({ source: z.string().min(1).max(2000000) })
      .parse(await c.req.json());
    return c.json(parseInvestmentMarkdown(input.source));
  });
  api.get("/import/:id/preview", async (c) => {
    const doc = await store.get<any>("import", c.req.param("id"));
    if (!doc) return c.notFound();
    return c.json(parseInvestmentMarkdown(doc.data.source));
  });
  api.post("/import/commit", async (c) => {
    const input = z
      .object({
        source: z.string().min(1).max(2000000),
        selections: z
          .array(
            z.object({
              id: z.string(),
              name: z.string().trim().min(1).max(200),
              status: CompanySchema.shape.status,
            }),
          )
          .max(1000),
      })
      .parse(await c.req.json());
    const fingerprint = await hash(input.source);
    const batch = `import-${fingerprint.slice(0, 24)}`;
    const previous = await store.get<any>("import", batch);
    const matchingImport = (
      await store.list<any>("import", { summary: true })
    ).find(
      (d) =>
        d.data.fingerprint === fingerprint &&
        d.data.complete &&
        !d.data.rolledBack,
    );
    if (
      (previous && !previous.data.rolledBack && previous.data.complete) ||
      matchingImport
    )
      throw new Error(
        "This source was already imported. Roll back that batch before reimporting.",
      );
    const preview = parseInvestmentMarkdown(input.source);
    const byId = new Map(preview.candidates.map((x) => [x.id, x]));
    const archive =
      previous ||
      (await store.put(
        "import",
        batch,
        {
          source: input.source,
          fingerprint,
          at: new Date().toISOString(),
          selections: input.selections,
          count: 0,
          complete: false,
        },
        0,
      ));
    let count = 0;
    for (const selected of input.selections) {
      const item = byId.get(selected.id);
      if (!item) throw new Error("Import selection does not match source.");
      const company = candidateToCompany(
        { ...item, name: selected.name, status: selected.status },
        batch,
      );
      company.id = `${batch}-${selected.id}`;
      if (!(await store.get("company", company.id)))
        await store.put("company", company.id, company, 0);
      count++;
    }
    await store.put(
      "import",
      batch,
      {
        source: input.source,
        fingerprint,
        at: archive.data.at,
        selections: input.selections,
        count,
        complete: true,
        rolledBack: false,
      },
      archive.version,
    );
    return c.json({ batch, count, preservedOriginal: true });
  });
  api.post("/import/:id/rollback", async (c) => {
    const batch = await store.get<any>("import", c.req.param("id"));
    if (!batch) return c.notFound();
    const docs = (await store.list<Company>("company")).filter(
      (x) => x.data.importBatch === batch.id,
    );
    const untouched = docs.filter((d) => d.data.revision === 1);
    for (const doc of untouched)
      await store.remove("company", doc.id, doc.version);
    await store.put(
      "import",
      batch.id,
      {
        ...batch.data,
        rolledBack: true,
        preservedEdited: docs.length - untouched.length,
      },
      batch.version,
    );
    return c.json({
      removed: untouched.length,
      preservedEdited: docs.length - untouched.length,
    });
  });
  api.get("/export", async (c) => {
    // ?scope=essential (weekly off-site backups): everything you wrote, plus only
    // the articles you acted on, without stored text or model internals. Other
    // articles can be screened again; this keeps backups small and restorable.
    if (c.req.query("scope") === "essential") {
      const kinds = ["company", "revision", "settings", "import"];
      const index = await store.list<DeskEvent>("event", {
        fields: ["saved", "feedback", "reviewed"],
      });
      const ids = index
        .filter((d) => d.data.saved || d.data.feedback || d.data.reviewed)
        .map((d) => d.id);
      const events = (await store.list<DeskEvent>("event", { ids })).map(
        (d) => {
          const data: any = structuredClone(d.data);
          delete data.rawText;
          if (data.screening) {
            delete data.screening.rawAnswers;
            delete data.screening.probabilities;
            delete data.screening.comparisons;
          }
          return { ...d, data };
        },
      );
      return c.json({
        format: "research-desk",
        version: 1,
        scope: "essential",
        exportedAt: new Date().toISOString(),
        records: [
          ...(await Promise.all(kinds.map((k) => store.list(k)))).flat(),
          ...events,
        ],
      });
    }
    const kinds = ["company", "event", "revision", "settings", "import"];
    const records = (await Promise.all(kinds.map((k) => store.list(k)))).flat();
    return c.json({
      format: "research-desk",
      version: 1,
      exportedAt: new Date().toISOString(),
      records,
    });
  });
  api.post("/restore", async (c) => {
    const input = z
      .object({
        format: z.literal("research-desk"),
        version: z.literal(1),
        records: z
          .array(
            z.object({
              kind: z.enum([
                "company",
                "event",
                "revision",
                "settings",
                "import",
              ]),
              id: z.string().max(200),
              data: z.unknown(),
            }),
          )
          .max(20000),
      })
      .parse(await c.req.json());
    input.records = validateRestoreRecords(
      input.records,
    ) as typeof input.records;
    let restored = 0;
    for (const record of input.records)
      if (!(await store.get(record.kind, record.id))) {
        await store.put(record.kind, record.id, record.data, 0);
        restored++;
      }
    return c.json({ restored, skipped: input.records.length - restored });
  });
  return api;
}
