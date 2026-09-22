import { afterEach, expect, it, vi } from "vitest";
import { LocalStore } from "../server/store.ts";
import { createApi } from "../supabase/functions/_shared/api.ts";
import {
  newCompany,
  RuleSchema,
  type Company,
  type DeskEvent,
} from "../supabase/functions/_shared/model.ts";
import {
  processArticle,
  digestPreview,
} from "../supabase/functions/_shared/jobs.ts";
import { assessment, modelResponse } from "./screening-fixtures.ts";
import { reviewFixture } from "./review-fixtures.ts";
import { mergeDocuments, latestBatch } from "../src/sync.ts";
import { api as clientApi, apiText } from "../src/api.ts";
const stores: LocalStore[] = [];
const store = () => {
  const s = new LocalStore(":memory:");
  stores.push(s);
  return s;
};
afterEach(() => {
  stores.forEach((s) => s.db.close());
  stores.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const request = (
  app: ReturnType<typeof createApi>,
  path: string,
  body: unknown,
  method = "POST",
) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
// Dates are relative to now: the ingestion age limit would otherwise suppress a
// fixed past date once the calendar moves past it.
const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86400000).toISOString();
const article = {
  id: "a",
  title: "Acme reports Q1 financial results",
  text: "Revenue grew 10% to $100 million.",
  url: "https://example.com/results",
  publishedAt: daysAgo(3),
  source: "Acme",
  official: true,
  contentDepth: "supplied" as const,
};

it("loads only changed news, including writes exactly on the cursor boundary", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T00:00:00Z"));
  const s = store(),
    app = createApi(s, {}, "local"),
    { events } = reviewFixture(2);
  for (const e of events) await s.put("event", e.id, e.data, 0);
  vi.setSystemTime(new Date("2026-09-19T00:01:00Z"));
  const initial = await (await app.request("/news/updates")).json();
  await s.put("event", events[0].id, { ...events[0].data, saved: true }, 1);
  const next = await (
    await app.request(`/news/updates?since=${initial.cursor}`)
  ).json();
  expect(next.events).toHaveLength(1);
  expect(next.events[0].data.saved).toBe(true);
  expect((await app.request("/news/updates?since=not-a-date")).status).toBe(
    400,
  );
  const read = vi.spyOn(s, "list");
  const light = await (await app.request("/bootstrap?events=none")).json();
  expect(light.events).toEqual([]);
  expect(read.mock.calls.some(([kind]) => kind === "event")).toBe(false);
});

it("keeps newer documents and controls when stale responses arrive", () => {
  const old = reviewFixture(1).events[0],
    latest = { ...old, version: 3, data: { ...old.data, saved: true } };
  const current = [latest];
  expect(mergeDocuments(current, [old])).toBe(current);
  const batch = {
    id: "b",
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T01:00:00Z",
    status: "paused",
  } as any;
  expect(
    latestBatch(batch, {
      ...batch,
      updatedAt: "2026-09-19T00:59:00Z",
      status: "running",
    }),
  ).toBe(batch);
});

it("does not clear reader feedback on a review-only update and clears it explicitly", async () => {
  const s = store(),
    app = createApi(s, {}, "local"),
    e = reviewFixture(1).events[0];
  await s.put(
    "event",
    e.id,
    { ...e.data, feedback: "noise", feedbackReason: "duplicate" },
    0,
  );
  const saved = await (
    await request(
      app,
      `/events/${e.id}`,
      { version: 1, reviewed: true, saved: true },
      "PUT",
    )
  ).json();
  expect(saved.data.feedback).toBe("noise");
  const cleared = await (
    await request(
      app,
      `/events/${e.id}`,
      { version: 2, reviewed: false, feedback: null },
      "PUT",
    )
  ).json();
  expect(cleared.data.feedback).toBeUndefined();
  expect(cleared.data.feedbackReason).toBeUndefined();
});

it("prevents duplicate paid work across workers", async () => {
  const s = store(),
    c = newCompany("Acme");
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn(async () => {
    entered();
    await blocked;
    return new Response(JSON.stringify(modelResponse()));
  });
  vi.stubGlobal("fetch", fetcher);
  const first = processArticle(c, article, s, { TYPESAFE_API_KEY: "test" });
  await started;
  await expect(
    processArticle(c, article, s, { TYPESAFE_API_KEY: "test" }),
  ).rejects.toThrow("changed elsewhere");
  release();
  await first;
  await processArticle(c, article, s, { TYPESAFE_API_KEY: "test" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await s.list("event")).toHaveLength(1);
});

it("keeps new quarters at reused URLs separate and does not reuse changed provenance", async () => {
  const s = store(),
    c = newCompany("Acme");
  const fetcher = vi.fn(async (_url, init) => {
    const questions = JSON.parse(init.body).questions;
    const relations = Object.fromEntries(
      Object.keys(questions)
        .filter((k) => k.startsWith("relation"))
        .map((k) => [
          k,
          {
            type: "choice",
            choice: "unrelated",
            probabilities: { unrelated: 1 },
          },
        ]),
    );
    return new Response(
      JSON.stringify(modelResponse(relations, JSON.parse(init.body))),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  await processArticle(c, article, s, { TYPESAFE_API_KEY: "test" });
  const later = await processArticle(
    c,
    {
      ...article,
      id: "b",
      title: "Acme reports Q2 financial results",
      publishedAt: daysAgo(1),
    },
    s,
    { TYPESAFE_API_KEY: "test" },
  );
  expect(later.clusterId).toBeUndefined();
  const changed = await processArticle(
    c,
    { ...article, id: "c", official: false },
    s,
    { TYPESAFE_API_KEY: "test" },
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(changed.classification?.official).toBe(false);
});

it("preserves feed cursors, invalidates changed identity and resets a changed P/E basis", async () => {
  const s = store(),
    app = createApi(s, {}, "local"),
    c = newCompany("Acme");
  c.feeds[0].lastSuccess = "2026-09-19T00:00:00Z";
  c.rules = [
    RuleSchema.parse({
      id: "pe",
      metric: "pe",
      threshold: 10,
      currency: "USD",
      triggered: true,
      episode: 2,
    }),
  ];
  await s.put("company", c.id, c, 0);
  const response = await request(
    app,
    `/companies/${c.id}`,
    {
      version: 1,
      data: {
        ...c,
        name: "Acme Holdings",
        feeds: c.feeds.map((f) => ({ ...f, lastSuccess: "" })),
        rules: c.rules.map((r) => ({ ...r, basis: "Forward P/E" })),
      },
    },
    "PUT",
  );
  expect(response.status).toBe(200);
  const saved = (await response.json()).data as Company;
  expect(saved.feeds[0].lastSuccess).toBe(""); // Renaming changed the default search URL.
  expect(saved.newsRevision).toBe(c.newsRevision + 1);
  expect(saved.rules[0].triggered).toBe(false);
  expect(saved.rules[0].episode).toBe(3);
  const current = (await s.get<Company>("company", c.id))!;
  current.data.feeds[0].lastSuccess = "2026-09-19T01:00:00Z";
  await s.put("company", c.id, current.data, current.version);
  const again = await request(
    app,
    `/companies/${c.id}`,
    {
      version: 3,
      data: {
        ...current.data,
        notes: "Edited",
        feeds: current.data.feeds.map((f) => ({ ...f, lastSuccess: "" })),
      },
    },
    "PUT",
  );
  expect((await again.json()).data.feeds[0].lastSuccess).toBe(
    "2026-09-19T01:00:00Z",
  );
});

it("merges user feed and rule edits past background checkpoints without losing monitor state", async () => {
  const s = store(),
    app = createApi(s, {}, "local"),
    c = newCompany("Acme");
  c.feeds = [
    {
      id: "official",
      url: "https://www.sec.gov/feed",
      label: "Official",
      official: true,
      lastSuccess: "",
      error: "",
    },
  ];
  c.rules = [
    RuleSchema.parse({
      id: "price",
      metric: "price",
      threshold: 10,
      currency: "USD",
    }),
  ];
  await s.put("company", c.id, c, 0);
  await s.put(
    "company",
    c.id,
    {
      ...c,
      feeds: c.feeds.map((f) => ({
        ...f,
        lastSuccess: "2026-09-19T01:00:00Z",
      })),
      rules: c.rules.map((r) => ({ ...r, triggered: true, episode: 2 })),
    },
    1,
  );
  const response = await request(
    app,
    `/companies/${c.id}`,
    {
      version: 1,
      base: c,
      data: {
        ...c,
        feeds: c.feeds.map((f) => ({ ...f, label: "SEC filings" })),
        rules: c.rules.map((r) => ({ ...r, threshold: 12 })),
      },
    },
    "PUT",
  );
  expect(response.status).toBe(200);
  const saved = (await response.json()).data;
  expect(saved.feeds[0]).toMatchObject({
    label: "SEC filings",
    lastSuccess: "2026-09-19T01:00:00Z",
  });
  expect(saved.rules[0]).toMatchObject({
    threshold: 12,
    triggered: false,
    episode: 3,
  });
  const conflict = await request(
    app,
    `/companies/${c.id}`,
    {
      version: 1,
      base: c,
      data: {
        ...c,
        feeds: c.feeds.map((f) => ({ ...f, label: "Competing edit" })),
      },
    },
    "PUT",
  );
  expect(conflict.status).toBe(409);
});

it("sorts major developments first and uses current explanations in the digest", async () => {
  const s = store(),
    c = newCompany("Acme"),
    at = new Date();
  await s.put("company", c.id, c, 0);
  for (const [id, materiality] of [
    ["ordinary", 2],
    ["major", 3],
  ] as const) {
    const e = reviewFixture(1).events[0].data;
    await s.put(
      "event",
      id,
      {
        ...e,
        id,
        companyId: c.id,
        clusterId: id,
        discoveredAt: at.toISOString(),
        screening: assessment({ materiality }),
      },
      0,
    );
  }
  const digest = await digestPreview(s, at);
  expect(digest.count).toBe(2);
  // Use unique source text to verify ordering, independent of opaque IDs.
  const major = (await s.get<DeskEvent>("event", "major"))!;
  await s.put(
    "event",
    "major",
    { ...major.data, title: "Major development" },
    major.version,
  );
  const ordinary = (await s.get<DeskEvent>("event", "ordinary"))!;
  await s.put(
    "event",
    "ordinary",
    { ...ordinary.data, title: "Ordinary development" },
    ordinary.version,
  );
  const ordered = await digestPreview(s, at);
  expect(ordered.text.indexOf("Major development")).toBeLessThan(
    ordered.text.indexOf("Ordinary development"),
  );
});

it("validates all restore records before writing and supports exports larger than 2.5 MB", async () => {
  const s = store(),
    app = createApi(s, {}, "local"),
    c = newCompany("Acme");
  const valid = { kind: "company", id: c.id, data: c };
  const restore = (records: unknown[]) =>
    request(app, "/restore", { format: "research-desk", version: 1, records });
  expect(
    (await restore([valid, { kind: "event", id: "broken", data: {} }])).status,
  ).toBe(400);
  expect(await s.list("company")).toHaveLength(0);
  expect((await restore([{ ...valid, id: "wrong-id" }])).status).toBe(400);
  const large = Array.from({ length: 7 }, (_, i) => {
    const data = { ...c, id: `large-${i}`, notes: "x".repeat(400000) };
    return { kind: "company", id: data.id, data };
  });
  const response = await restore(large);
  expect(response.status).toBe(200);
  expect((await response.json()).restored).toBe(7);
});

it("shows a useful network error instead of a JSON parsing error or downloading an error page", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response("<html>Unavailable</html>", { status: 502 }),
    ),
  );
  await expect(clientApi("/bootstrap")).rejects.toThrow(
    "temporarily unavailable (502)",
  );
  await expect(apiText("/companies/a/markdown")).rejects.toThrow(
    "temporarily unavailable",
  );
});
