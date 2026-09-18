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
import { hash, safeLink } from "./engine.ts";
import { configuration, validateFeedUrl, type Env } from "./providers.ts";
import {
  dailySnapshot,
  digestPreview,
  processArticle,
  runMonitor,
  saveQuoteObservations,
  sendDueDigest,
} from "./jobs.ts";

export function createApi(store: Store, env: Env, mode: "local" | "cloud") {
  const api = new Hono();
  api.use(
    "*",
    bodyLimit({
      maxSize: 2500000,
      onError: (c) => c.json({ error: "File exceeds the 2.5 MB limit." }, 413),
    }),
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
  api.get("/bootstrap", async (c) => {
    const [companies, events, settings, run, imports, usage] =
      await Promise.all([
        store.list<Company>("company", { summary: true }),
        store.list<DeskEvent>("event", { summary: true, limit: 200 }),
        store.get("settings", "main"),
        store.get("run", "latest"),
        store.list<any>("import", { summary: true }),
        store.usage?.() || [],
      ]);
    return c.json({
      companies,
      events: events.slice(0, 1000),
      settings: settings?.data || defaultSettings,
      settingsVersion: settings?.version || 0,
      run: run?.data,
      imports: imports.map((x) => ({
        id: x.id,
        count: x.data.count,
        at: x.data.at,
        rolledBack: x.data.rolledBack,
        draft: x.data.draft,
      })),
      configuration: { ...configuration(env), mode },
      usage,
    });
  });
  api.post("/companies", async (c) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(200),
        status: CompanySchema.shape.status,
        ticker: z.string().max(50).optional(),
      })
      .parse(await c.req.json());
    const company = newCompany(input.name, input.status);
    company.ticker = input.ticker || "";
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
        for (const key of editable) {
          const original = JSON.stringify(input.base[key]);
          const proposed = JSON.stringify(input.data[key]);
          const current = JSON.stringify(old.data[key]);
          if (original === proposed) continue;
          if (original !== current && proposed !== current)
            throw new ConflictError();
          (merged as any)[key] = input.data[key];
        }
        input.data = merged;
      }
      for (const feed of input.data.feeds)
        if (!old.data.feeds.some((f) => f.url === feed.url))
          validateFeedUrl(feed.url, env);
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
          prev.enabled === r.enabled
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
        rules,
        quote: quoteMappingChanged ? null : old.data.quote,
        quoteHistory: quoteMappingChanged ? [] : old.data.quoteHistory,
        quoteError: quoteMappingChanged ? "" : old.data.quoteError,
        lastQuoteCheck: quoteMappingChanged ? "" : old.data.lastQuoteCheck,
        lastNewsCheck: feedsChanged ? "" : old.data.lastNewsCheck,
        createdAt: old.data.createdAt,
        revision: old.data.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      return c.json(await store.put("company", id, value, old.version));
    } finally {
      await store.release(`company-${id}`, lock);
    }
  });
  api.get("/companies/:id/revisions", async (c) =>
    c.json(
      (await store.list<any>("revision"))
        .filter((r) => r.data.companyId === c.req.param("id"))
        .slice(0, 50),
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
        text: z.string().min(1).max(16000),
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
        },
        store,
        env,
      ),
    );
  });
  api.put("/events/:id", async (c) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        reviewed: z.boolean(),
        feedback: z.enum(["useful", "noise"]).optional(),
      })
      .parse(await c.req.json());
    const doc = await store.get<DeskEvent>("event", c.req.param("id"));
    if (!doc || doc.version !== input.version) throw new ConflictError();
    return c.json(
      await store.put(
        "event",
        doc.id,
        { ...doc.data, reviewed: input.reviewed, feedback: input.feedback },
        doc.version,
      ),
    );
  });
  api.get("/events", async (c) => c.json(await store.list<DeskEvent>("event")));
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
  api.post("/scheduled", async (c) => {
    const monitor = await runMonitor(store, env);
    const backup = await dailySnapshot(store);
    const email = await sendDueDigest(store, env);
    return c.json({ monitor, backup, email });
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
    if (previous && !previous.data.rolledBack && previous.data.complete)
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
    // Validate all company/settings records before writing. Restore only missing records, never overwrite newer work.
    for (const record of input.records) {
      if (record.kind === "company")
        record.data = CompanySchema.parse(record.data);
      if (record.kind === "settings")
        record.data = SettingsSchema.parse(record.data);
    }
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
