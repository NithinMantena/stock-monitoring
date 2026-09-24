import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DatabaseReadError } from "./database-read.ts";
import { z } from "zod";
import { createApi } from "./api.ts";
import {
  CompanySchema,
  ConflictError,
  defaultSettings,
  type Company,
  type DeskEvent,
  type Doc,
  type Store,
} from "./model.ts";
import type { Env } from "./providers.ts";
import { hash, cadenceOf, quoteState } from "./engine.ts";
import {
  scopes,
  ownerActor,
  issueIntegration,
  publicIntegration,
  type Actor,
  type Integration,
  type Scope,
} from "./integrations.ts";
import {
  developmentKey,
  eventGroupKey,
  inEventFolder,
  isExpired,
} from "./event-inbox.ts";
import { groupNews } from "./screening-policy.ts";
import { newsBucket } from "./news.ts";
import {
  type NewsBatch,
  newsBatchSummary,
  startNewsBatch,
  controlNewsBatch,
  advanceNewsBatch,
} from "./news-batch.ts";
import {
  type Job,
  enqueueJob,
  jobSummary,
  controlJob,
  advanceJob,
} from "./job-queue.ts";

export class ApiError extends Error {
  status: 400 | 401 | 403 | 404 | 409;
  code: string;
  constructor(
    status: 400 | 401 | 403 | 404 | 409,
    code: string,
    message: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const version = z.number().int().positive();
const researchKeys = [
  "name",
  "ticker",
  "exchange",
  "currency",
  "status",
  "originalGroup",
  "researchDepth",
  "tags",
  "notes",
  "thesis",
  "passReason",
  "ideaSource",
  "dateFound",
  "lastReviewed",
  "nextReview",
  "targetPrice",
  "archived",
] as const;
const monitoringKeys = [
  "cadence",
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
  "watchPoints",
  "rules",
  "feeds",
  "provider",
  "providerSymbol",
] as const;
export const CompanyPatch = CompanySchema.pick(
  Object.fromEntries(
    [...researchKeys, ...monitoringKeys].map((k) => [k, true]),
  ) as Record<
    (typeof researchKeys)[number] | (typeof monitoringKeys)[number],
    true
  >,
)
  .partial()
  .strict();
const Feedback = z
  .object({
    reviewed: z.boolean().optional(),
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
  .strict();
export const ControlInput = z
  .object({ action: z.enum(["pause", "resume", "cancel"]) })
  .strict();
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
});
function paginate<T extends { id: string }>(
  items: T[],
  query: Record<string, string>,
  compare: (a: T, b: T) => number = (a, b) => a.id.localeCompare(b.id),
) {
  const { limit, cursor } = pageQuery.parse(query);
  const all = items.sort(compare);
  const position = cursor ? all.findIndex((x) => x.id === cursor) : -1;
  if (cursor && position < 0)
    throw new ApiError(
      409,
      "cursor_expired",
      "The list changed. Restart pagination without a cursor.",
    );
  const ordered = all.slice(position + 1);
  return {
    items: ordered.slice(0, limit),
    nextCursor: ordered.length > limit ? ordered[limit - 1].id : null,
    total: items.length,
  };
}
function requireScope(actor: Actor, scope: Scope | "admin") {
  if (!actor.admin && (scope === "admin" || !actor.scopes.includes(scope)))
    throw new ApiError(
      403,
      "insufficient_scope",
      `This operation requires ${scope}.`,
    );
}
const redacted = (d: Doc<DeskEvent>) => {
  const { rawText: _raw, ...data } = d.data;
  return { ...d, data };
};

export function createV1Api(
  store: Store,
  env: Env,
  mode: "local" | "cloud",
  actor: Actor = ownerActor,
) {
  const app = new Hono(),
    legacy = createApi(store, env, mode);
  const forward = (path: string, body?: unknown, method = "POST") =>
    legacy.request(
      path,
      body === undefined
        ? undefined
        : {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
  app.use("*", (c, next) =>
    bodyLimit({
      maxSize: c.req.path === "/restore" ? 100000000 : 2500000,
      onError: (c) =>
        c.json({ error: "Request is too large.", code: "body_limit" }, 413),
    })(c, next),
  );
  app.onError((e, c) =>
    c.json(
      {
        error: e.message,
        code:
          e instanceof ApiError
            ? e.code
            : e instanceof ConflictError
              ? "version_conflict"
              : e instanceof DatabaseReadError
                ? "database_unavailable"
                : "validation_error",
      },
      e instanceof ApiError
        ? e.status
        : e instanceof ConflictError
          ? 409
          : e instanceof DatabaseReadError
            ? e.status
            : 400,
    ),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const path = c.req.path.replace(/^.*?\/v1(?=\/|$)/, "");
    if (path === "/scheduled")
      throw new ApiError(
        403,
        "scheduler_only",
        "Scheduler endpoint is not a client operation.",
      );
    if (c.req.method === "GET") {
      requireScope(
        actor,
        /^(\/export|\/backups)/.test(path)
          ? "backup:read"
          : /^\/(integrations|audit)/.test(path)
            ? "admin"
            : "read",
      );
      await next();
      return;
    }
    const required: Scope | "admin" = path.startsWith("/integrations")
      ? "admin"
      : /^\/companies\/.+\/(notes|watch-points|rules|feeds|quote)$/.test(path)
        ? path.endsWith("/notes")
          ? "research:write"
          : "monitoring:write"
        : path === "/companies"
          ? "research:write"
          : /^\/companies\/[^/]+$/.test(path) && c.req.method === "PATCH"
            ? "read"
            : path.startsWith("/developments/") ||
                /^\/events\/[^/]+$/.test(path)
              ? "news:write"
              : /^\/events\/.+\/content$/.test(path)
                ? "read"
                : path === "/jobs" || path === "/news/batches"
                  ? "jobs:start"
                  : /^\/(jobs|news\/batches)\/.+\/(control|advance)$/.test(path)
                    ? "jobs:control"
                    : path === "/settings"
                      ? "settings:write"
                      : path.startsWith("/import")
                        ? "import:write"
                        : "admin";
    requireScope(actor, required);
    if (/\/advance$/.test(path)) requireScope(actor, "jobs:start");
    // Never store a one-time credential in a replay ledger.
    if (path.startsWith("/integrations")) {
      await next();
      await store.put(
        "audit",
        crypto.randomUUID(),
        {
          actor: actor.id,
          channel: actor.channel,
          method: c.req.method,
          path,
          status: c.res.status,
          at: new Date().toISOString(),
        },
        0,
      );
      return;
    }
    const key = c.req.header("Idempotency-Key");
    if (!key || key.length > 200)
      throw new ApiError(
        400,
        "idempotency_required",
        "Supply an Idempotency-Key of 1–200 characters for every write.",
      );
    const body = await c.req.text();
    if (/\/control$/.test(path) && JSON.parse(body).action === "resume")
      requireScope(actor, "jobs:start");
    const id = await hash(`${actor.id}|${key}`),
      fingerprint = await hash(`${c.req.method}|${path}|${body}`);
    const prior = await store.get<{
      fingerprint: string;
      status?: number;
      body?: string;
    }>("request", id);
    if (prior) {
      if (prior.data.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "idempotency_mismatch",
          "This key was used with different arguments.",
        );
      if (!prior.data.status)
        throw new ApiError(
          409,
          "write_outcome_unknown",
          "This request is pending or its result is uncertain. Inspect current state; do not repeat with a new key.",
        );
      return new Response(prior.data.body, {
        status: prior.data.status,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Replayed": "true",
        },
      });
    }
    try {
      await store.put(
        "request",
        id,
        {
          fingerprint,
          path,
          actor: actor.id,
          channel: actor.channel,
          at: new Date().toISOString(),
        },
        0,
      );
    } catch (e) {
      if (e instanceof ConflictError)
        throw new ApiError(
          409,
          "request_in_progress",
          "This request is already in progress. Reuse its key.",
        );
      throw e;
    }
    await next();
    const responseBody = await c.res.clone().text();
    await store.batch([
      {
        kind: "request",
        id,
        expected: 1,
        data: {
          fingerprint,
          status: c.res.status,
          body: responseBody,
          path,
          actor: actor.id,
          channel: actor.channel,
          at: new Date().toISOString(),
        },
      },
      {
        kind: "audit",
        id,
        expected: 0,
        data: {
          actor: actor.id,
          channel: actor.channel,
          method: c.req.method,
          path,
          status: c.res.status,
          at: new Date().toISOString(),
        },
      },
    ]);
  });
  app.get("/me", (c) =>
    c.json({
      actor: actor.id,
      channel: actor.channel,
      scopes: actor.admin ? [...scopes, "admin"] : actor.scopes,
      apiVersion: "v1",
    }),
  );
  app.get("/changes", async (c) => {
    const cursor = new Date().toISOString();
    const since = z.iso.datetime().parse(c.req.query("since") || cursor);
    return c.json({ cursor, items: await store.changes(since) });
  });
  app.get("/integrations", async (c) =>
    c.json({
      items: (await store.list<Integration>("integration")).map(
        publicIntegration,
      ),
      scopes,
    }),
  );
  app.post("/integrations", async (c) =>
    c.json(await issueIntegration(store, await c.req.json()), 201),
  );
  app.post("/integrations/:id/revoke", async (c) => {
    const doc = await store.get<Integration>("integration", c.req.param("id"));
    if (!doc) throw new ApiError(404, "not_found", "Integration not found.");
    const next = await store.put(
      "integration",
      doc.id,
      { ...doc.data, revokedAt: new Date().toISOString() },
      doc.version,
    );
    return c.json(publicIntegration(next));
  });
  app.get("/audit", async (c) =>
    c.json(paginate(await store.list("audit"), c.req.query())),
  );
  app.get("/companies", async (c) => {
    const q = c.req.query(),
      search = (q.search || "").toLowerCase();
    const docs = (
      await store.list<Company>("company", { summary: true })
    ).filter(
      (d) =>
        (!q.status || d.data.status === q.status) &&
        (q.archived === "true" ? d.data.archived : !d.data.archived) &&
        `${d.data.name} ${d.data.ticker} ${d.data.notes} ${d.data.tags.join(" ")}`
          .toLowerCase()
          .includes(search),
    );
    return c.json(
      paginate(
        docs.map((d) => ({
          id: d.id,
          version: d.version,
          name: d.data.name,
          ticker: d.data.ticker,
          status: d.data.status,
          archived: d.data.archived,
          updatedAt: d.updatedAt,
          url: `${env.APP_URL || "https://research-desk-2p0.pages.dev"}/#company=${encodeURIComponent(d.id)}`,
        })),
        q,
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
    );
  });
  app.get("/companies/:id", async (c) => {
    const doc = await store.get<Company>("company", c.req.param("id"));
    if (!doc) throw new ApiError(404, "not_found", "Company not found.");
    return c.json(doc);
  });
  const patchCompany = async (
    id: string,
    expected: number,
    patch: z.infer<typeof CompanyPatch>,
  ) => {
    const doc = await store.get<Company>("company", id);
    if (!doc) throw new ApiError(404, "not_found", "Company not found.");
    if (doc.version !== expected) throw new ConflictError();
    for (const key of Object.keys(patch))
      requireScope(
        actor,
        researchKeys.includes(key as (typeof researchKeys)[number])
          ? "research:write"
          : "monitoring:write",
      );
    return forward(
      `/companies/${encodeURIComponent(id)}`,
      { version: expected, data: { ...doc.data, ...patch } },
      "PUT",
    );
  };
  app.patch("/companies/:id", async (c) => {
    const input = z
      .object({ version, patch: CompanyPatch })
      .strict()
      .parse(await c.req.json());
    return patchCompany(c.req.param("id"), input.version, input.patch);
  });
  app.post("/companies/:id/notes", async (c) => {
    const input = z
      .object({ version, text: z.string().min(1).max(500000) })
      .strict()
      .parse(await c.req.json());
    const doc = await store.get<Company>("company", c.req.param("id"));
    if (!doc) throw new ApiError(404, "not_found", "Company not found.");
    return patchCompany(doc.id, input.version, {
      notes: [doc.data.notes, input.text].filter(Boolean).join("\n\n"),
    });
  });
  for (const [route, field] of [
    ["watch-points", "watchPoints"],
    ["rules", "rules"],
    ["feeds", "feeds"],
  ] as const)
    app.post(`/companies/:id/${route}`, async (c) => {
      const input = z
        .object({
          version,
          action: z.enum(["upsert", "remove"]),
          id: z.string().min(1).max(100),
          value: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
        .parse(await c.req.json());
      const doc = await store.get<Company>("company", c.req.param("id"));
      if (!doc) throw new ApiError(404, "not_found", "Company not found.");
      const items = doc.data[field].filter((x) => x.id !== input.id);
      if (input.action === "upsert") {
        if (!input.value) throw new Error("An upsert requires value.");
        items.push({ ...input.value, id: input.id } as never);
      }
      return patchCompany(
        doc.id,
        input.version,
        CompanyPatch.parse({ [field]: items }),
      );
    });
  app.get("/events/:id", async (c) => {
    const doc = await store.get<DeskEvent>("event", c.req.param("id"));
    if (!doc) throw new ApiError(404, "not_found", "Article not found.");
    return c.json(redacted(doc));
  });
  app.get("/developments", async (c) => {
    const q = c.req.query(),
      search = (q.search || "").toLowerCase();
    const docs = (
      await store.list<DeskEvent>("event", {
        summary: true,
        companyId: q.companyId,
      })
    ).filter(
      (d) =>
        (!q.folder ||
          inEventFolder(
            d.data,
            z.enum(["inbox", "saved", "history"]).parse(q.folder),
          )) &&
        (!q.bucket || newsBucket(d.data) === q.bucket) &&
        `${d.data.title} ${d.data.body}`.toLowerCase().includes(search),
    );
    return c.json(
      paginate(
        groupNews(docs).map((g) => ({
          id: g.lead.id,
          lead: g.lead,
          coverageCount: g.coverage.length,
        })),
        q,
        (a, b) =>
          b.lead.data.discoveredAt.localeCompare(a.lead.data.discoveredAt) ||
          a.id.localeCompare(b.id),
      ),
    );
  });
  app.get("/developments/:id", async (c) => {
    const lead = await store.get<DeskEvent>("event", c.req.param("id"));
    if (!lead) throw new ApiError(404, "not_found", "Development not found.");
    const members = (
      await store.list<DeskEvent>("event", {
        summary: true,
        companyId: lead.data.companyId,
        cluster: developmentKey(lead),
      })
    ).filter((d) => eventGroupKey(d.data) === eventGroupKey(lead.data));
    return c.json({
      id: lead.id,
      lead: groupNews(members)[0]?.lead,
      coverage: members.map((d) => ({
        id: d.id,
        version: d.version,
        title: d.data.title,
        url: d.data.url,
        publishedAt: d.data.publishedAt,
        reviewed: d.data.reviewed,
        saved: d.data.saved,
      })),
      versions: Object.fromEntries(members.map((d) => [d.id, d.version])),
    });
  });
  app.patch("/developments/:id", async (c) => {
    const input = z
      .object({
        versions: z.record(z.string(), version),
        patch: Feedback,
        scope: z.enum(["article", "development"]).default("development"),
      })
      .strict()
      .parse(await c.req.json());
    const lead = await store.get<DeskEvent>("event", c.req.param("id"));
    if (!lead) throw new ApiError(404, "not_found", "Development not found.");
    const members = (
      await store.list<DeskEvent>("event", {
        companyId: lead.data.companyId,
        cluster: developmentKey(lead),
      })
    ).filter((d) =>
      input.scope === "article"
        ? d.id === lead.id
        : eventGroupKey(d.data) === eventGroupKey(lead.data),
    );
    if (
      members.some((d) => input.versions[d.id] !== d.version) ||
      Object.keys(input.versions).length !== members.length
    )
      throw new ConflictError();
    const writes = members.map((d) => {
      const feedback =
        input.patch.feedback === null
          ? undefined
          : (input.patch.feedback ?? d.data.feedback);
      const data = {
        ...d.data,
        ...input.patch,
        feedback,
        feedbackReason:
          feedback === "noise"
            ? (input.patch.feedbackReason ?? d.data.feedbackReason)
            : undefined,
        inboxAt:
          input.patch.reviewed === false &&
          (d.data.reviewed || isExpired(d.data))
            ? new Date().toISOString()
            : d.data.inboxAt,
      };
      return { kind: "event", id: d.id, expected: d.version, data };
    });
    return c.json({
      items: (await store.batch(writes)).map((d) =>
        redacted(d as Doc<DeskEvent>),
      ),
    });
  });
  app.get("/settings", async (c) =>
    c.json(
      (await store.get("settings", "main")) || {
        id: "main",
        version: 0,
        data: defaultSettings,
      },
    ),
  );
  app.get("/health", async (c) =>
    c.json({
      companies: (await store.list<Company>("company", { summary: true })).map(
        (d) => ({
          id: d.id,
          name: d.data.name,
          cadence: cadenceOf(d.data),
          quotes: quoteState(d.data),
          feeds: d.data.feeds,
          lastNewsCheck: d.data.lastNewsCheck,
        }),
      ),
      usage: await store.usage?.(),
      run: await store.get("run", "latest"),
    }),
  );
  app.get("/jobs", async (c) => {
    const batches = await store.list<NewsBatch>("news_batch");
    const news = [
      ...new Map(
        batches.map((d) => [
          d.data.id,
          { ...newsBatchSummary(d.data)!, type: "news" },
        ]),
      ).values(),
    ];
    return c.json(
      paginate(
        [
          ...news,
          ...(await store.list<Job>("job")).map((d) => jobSummary(d.data)),
        ],
        c.req.query(),
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  });
  app.post("/jobs", async (c) => {
    const input = await c.req.json();
    if (input.type === "news") {
      const p = z
        .object({
          type: z.literal("news"),
          companyIds: z.array(z.string().min(1).max(100)).min(1).max(1000),
          label: z.string().min(1).max(300).default("Integration news search"),
          lookbackDays: z
            .union([z.literal(1), z.literal(7), z.literal(30)])
            .default(7),
        })
        .strict()
        .parse(input);
      return c.json(
        await startNewsBatch(store, { ...p, id: crypto.randomUUID() }),
        202,
      );
    }
    return c.json(await enqueueJob(store, input), 202);
  });
  app.get("/jobs/:id", async (c) => {
    const id = c.req.param("id"),
      latest = await store.get<NewsBatch>("news_batch", "latest");
    const batch =
      latest?.data.id === id
        ? latest
        : await store.get<NewsBatch>("news_batch", id);
    if (batch) return c.json({ ...newsBatchSummary(batch.data), type: "news" });
    const job = await store.get<Job>("job", id);
    if (!job) throw new ApiError(404, "not_found", "Job not found.");
    return c.json(jobSummary(job.data));
  });
  app.post("/jobs/:id/control", async (c) => {
    const { action } = ControlInput.parse(await c.req.json());
    const id = c.req.param("id");
    return c.json(
      (await store.get("job", id))
        ? await controlJob(store, id, action)
        : await controlNewsBatch(store, id, action),
    );
  });
  app.post("/jobs/:id/advance", async (c) => {
    requireScope(actor, "jobs:start");
    const id = c.req.param("id");
    return c.json(
      (await store.get("job", id))
        ? await advanceJob(store, env, id)
        : await advanceNewsBatch(store, env, {
            id,
            maxSteps: 1,
            milliseconds: 20000,
          }),
    );
  });
  // Compatibility endpoints share the same domain implementation, never database bypasses.
  app.all("*", async (c) => {
    const path = c.req.path.replace(/^.*?\/v1(?=\/|$)/, "");
    if (
      !actor.admin &&
      (path === "/bootstrap" || path === "/news/updates" || path === "/events")
    )
      throw new ApiError(
        403,
        "use_paged_api",
        "Use the paginated companies/developments endpoints.",
      );
    const url = new URL(c.req.url);
    url.pathname = path;
    return legacy.fetch(
      new Request(url, {
        method: c.req.method,
        headers: c.req.raw.headers,
        ...(c.req.method === "GET" || c.req.method === "HEAD"
          ? {}
          : { body: await c.req.text() }),
      }),
    );
  });
  return app;
}
