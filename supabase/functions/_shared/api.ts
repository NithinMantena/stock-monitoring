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
    const [companies, events, settings, run, imports, usage, newsBatch, newsRun, schedule] =
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
      ]);
    return c.json({
      companies,
      events,
      newsRun,
      newsRunHistory: schedule?.data.history || [],
      settings: settings?.data || defaultSettings,
      settingsVersion: settings?.version || 0,
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
  api.post("/companies", async (c) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(200),
        status: CompanySchema.shape.status,
        ticker: z.string().max(50).optional(),
        ideaSource: z.string().max(2000).optional(),
      })
      .parse(await c.req.json());
    const company = newCompany(input.name, input.status);
    company.ticker = input.ticker || "";
    company.ideaSource = input.ideaSource || "";
    return c.json(await store.put("company", company.id, company, 0), 201);
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
        ...input.data,
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
          saved: input.saved ?? doc.data.saved ?? false,
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
      })
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
