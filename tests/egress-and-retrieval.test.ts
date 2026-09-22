import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../server/store.ts";
import {
  newCompany,
  type Company,
  type DeskEvent,
} from "../supabase/functions/_shared/model.ts";
import {
  enrichArticle,
  fetchDocument,
} from "../supabase/functions/_shared/article-content.ts";
import {
  beginHostTracking,
  configurePacing,
  currentPacing,
  endHostTracking,
  restorePacing,
  slowDown,
  speedUp,
  ThrottledError,
} from "../supabase/functions/_shared/fetch-policy.ts";
import {
  advanceNewsBatch,
  startScheduledRun,
} from "../supabase/functions/_shared/news-batch.ts";

const stores: LocalStore[] = [];
const store = () => {
  const s = new LocalStore(":memory:");
  stores.push(s);
  return s;
};
afterEach(() => {
  for (const s of stores) s.db.close();
  stores.length = 0;
  vi.unstubAllGlobals();
  endHostTracking();
});

describe("projected reads", () => {
  it("returns only requested fields, checks existence, and selects by id or development", async () => {
    const s = store();
    const e = (id: string, patch: Partial<DeskEvent> = {}): DeskEvent => ({
      id,
      companyId: "acme",
      kind: "news",
      title: `Title ${id}`,
      body: "body",
      url: "",
      publishedAt: "",
      discoveredAt: `2026-09-2${id.length}T00:00:00Z`,
      reviewed: false,
      priority: "normal",
      rawText: "x".repeat(5000),
      ...patch,
    });
    await s.put("event", "lead", e("lead"), 0);
    await s.put("event", "cover", e("cover", { clusterId: "lead" }), 0);
    await s.put("event", "other", e("other"), 0);
    const slim = await s.list<DeskEvent>("event", { fields: ["title", "screening.version"] });
    expect(slim.map((d) => d.data)).toContainEqual({ title: "Title lead" });
    expect(JSON.stringify(slim)).not.toContain("xxxxx");
    expect((await s.get("event", "lead", { fields: [] }))?.data).toEqual({});
    expect(await s.get("event", "missing", { fields: [] })).toBeNull();
    expect((await s.list("event", { ids: ["other", "lead"] })).map((d) => d.id).sort()).toEqual(["lead", "other"]);
    expect(await s.list("event", { ids: [] })).toEqual([]);
    expect(
      (await s.list("event", { companyId: "acme", cluster: "lead" })).map((d) => d.id).sort(),
    ).toEqual(["cover", "lead"]);
  });
});

describe("publisher retrieval policy", () => {
  const hosts = new Set(["news.google.com", "blocked.example.com"]);
  it("skips a publisher for the rest of a run after two refusals, but not outside a run", async () => {
    const fetcher = vi.fn(async () => new Response("no", { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    const read = () =>
      fetchDocument("https://blocked.example.com/a", hosts, {}).catch((e) => e.message);
    beginHostTracking();
    await read();
    await read();
    expect(await read()).toMatch(/Skipped: blocked\.example\.com/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    endHostTracking();
    await read();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("requests Google's article page directly instead of through its redirect", async () => {
    const fetcher = vi.fn(async () => new Response("<html></html>"));
    vi.stubGlobal("fetch", fetcher);
    const c = newCompany("Acme");
    const article = await enrichArticle(
      c,
      {
        id: "a",
        title: "Acme news",
        text: "",
        url: "https://news.google.com/rss/articles/CBMiABC?oc=5",
        publishedAt: "",
        source: "",
        official: false,
      },
      {},
      store(),
    );
    const first = new URL(String((fetcher.mock.calls[0] as unknown[])[0]));
    expect(first.pathname).toBe("/rss/articles/CBMiABC");
    expect(Object.fromEntries(first.searchParams)).toEqual({
      oc: "5",
      hl: "en-US",
      gl: "US",
      ceid: "US:en",
    });
    expect(article.retrievalNote).toMatch(/did not expose the publisher link/);
  });
  it("slows Google requests after a refusal and eases back afterwards", () => {
    configurePacing({ search: 1000, page: 500 });
    try {
      slowDown();
      slowDown();
      expect(currentPacing()).toEqual({ search: 4000, page: 2000 });
      speedUp();
      expect(currentPacing()).toEqual({ search: 3800, page: 1900 });
      for (let i = 0; i < 10; i++) slowDown();
      expect(currentPacing()).toEqual({ search: 20000, page: 10000 });
      restorePacing();
      expect(currentPacing()).toEqual({ search: 1000, page: 500 });
      restorePacing({ search: 6000, page: 100 });
      expect(currentPacing()).toEqual({ search: 6000, page: 500 });
    } finally {
      configurePacing({ search: 0, page: 0 });
    }
  });
  it("reports Google rate limiting as throttling, not as an unreadable article", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    await expect(
      fetchDocument("https://news.google.com/rss/articles/abc", hosts, {}),
    ).rejects.toBeInstanceOf(ThrottledError);
  });
});

describe("scheduled run bookkeeping", () => {
  it("raises one alert per failing source and keeps the company's news clock until it succeeds", async () => {
    const s = store(),
      c = newCompany("Acme", "owned");
    c.lastNewsCheck = "2026-01-01T00:00:00Z";
    await s.put("company", c.id, c, 0);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    await startScheduledRun(s, {
      schedule: "daily",
      companyIds: [c.id],
      since: new Date(Date.now() - 26 * 3600000).toISOString(),
    });
    const done = await advanceNewsBatch(s, {}, { slot: "scheduled" });
    expect(done.batch).toMatchObject({ status: "completed", warningCount: 2 });
    const alerts = (await s.list<DeskEvent>("event")).filter((d) => d.data.kind === "health");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].data.body).toMatch(/HTTP 404.*\(and 1 more\)/);
    const saved = (await s.get<Company>("company", c.id))!.data;
    expect(saved.lastNewsCheck).toBe("2026-01-01T00:00:00Z");
    expect(saved.feeds[0].error).toMatch(/HTTP 404/);
  });
});
