import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../server/store.ts";
import { createApi } from "../supabase/functions/_shared/api.ts";
import {
  newCompany,
  type Company,
  type DeskEvent,
  type Doc,
} from "../supabase/functions/_shared/model.ts";
import {
  filterCompanies,
  inEventFolder,
  isExpired,
} from "../supabase/functions/_shared/event-inbox.ts";
import {
  advanceNewsBatch,
  startNewsBatch,
  type NewsBatch,
} from "../supabase/functions/_shared/news-batch.ts";
import { due } from "../supabase/functions/_shared/engine.ts";
import {
  processArticle,
  runMonitor,
} from "../supabase/functions/_shared/jobs.ts";
import { groupNews } from "../supabase/functions/_shared/screening-policy.ts";
import { assessment, modelResponse } from "./screening-fixtures.ts";
// v3 judges every headline with TypeSafe; these tests are about news searches.
const typesafe = (url: unknown, init?: any) =>
  String(url).includes("api.typesafe.ai")
    ? new Response(JSON.stringify(modelResponse({}, JSON.parse(init.body))))
    : null;
const searches = (fetcher: { mock: { calls: unknown[][] } }) =>
  fetcher.mock.calls.filter((c) => !String(c[0]).includes("api.typesafe.ai"))
    .length;

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
});
const now = Date.parse("2026-09-18T12:00:00Z");
function event(patch: Partial<DeskEvent> = {}): DeskEvent {
  return {
    id: "event",
    companyId: "acme",
    title: "Actual results",
    kind: "news",
    priority: "normal",
    body: "Business evidence",
    url: "",
    publishedAt: "2026-01-01T00:00:00Z",
    discoveredAt: new Date(now - 86400000).toISOString(),
    reviewed: false,
    screening: assessment(),
    ...patch,
  };
}
function doc(e: DeskEvent): Doc<DeskEvent> {
  return {
    id: e.id,
    kind: "event",
    data: e,
    updatedAt: e.discoveredAt,
    version: 1,
  };
}

describe("news inbox lifecycle", () => {
  it("keeps newly discovered older publications, expires at 30 days, and retains saved items", () => {
    expect(inEventFolder(event(), "inbox", now)).toBe(true);
    const expired = event({
      discoveredAt: new Date(now - 30 * 86400000).toISOString(),
    });
    expect(isExpired(expired, now - 1)).toBe(false);
    expect(inEventFolder(expired, "inbox", now)).toBe(false);
    expect(inEventFolder(expired, "history", now)).toBe(true);
    expect(inEventFolder({ ...expired, saved: true }, "saved", now)).toBe(true);
    expect(inEventFolder({ ...expired, saved: true }, "history", now)).toBe(
      false,
    );
    expect(inEventFolder(event({ reviewed: true }), "inbox", now)).toBe(false);
    expect(inEventFolder(event({ saved: true }), "inbox", now)).toBe(false);
  });
  it("persists save/review actions, restores an expired item, and preserves these choices during grading", async () => {
    const s = store(),
      c = newCompany("Acme");
    await s.put("company", c.id, c, 0);
    const original = event({
      companyId: c.id,
      saved: true,
      reviewed: true,
      discoveredAt: "2020-01-01T00:00:00Z",
    });
    await s.put("event", original.id, original, 0);
    const api = createApi(s, {}, "local");
    const put = async (body: any) => {
      const r = await api.request("/events/event", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(200);
      return (await r.json()) as Doc<DeskEvent>;
    };
    const kept = await put({ version: 1, reviewed: true });
    expect(kept.data.saved).toBe(true); // Old clients do not erase bookmarks.
    const restored = await put({
      version: kept.version,
      reviewed: false,
      saved: false,
    });
    expect(inEventFolder(restored.data, "inbox")).toBe(true);
    expect(restored.data.discoveredAt).toBe(original.discoveredAt);
    const saved = await put({
      version: restored.version,
      reviewed: true,
      saved: true,
    });
    const regraded = await processArticle(
      c,
      {
        id: original.id,
        title: "Acme to announce financial results",
        text: "",
        url: "",
        publishedAt: "",
        source: "",
        official: true,
      },
      s,
      {},
      { existingId: original.id, reprocess: true },
    );
    expect(regraded.saved).toBe(true);
    expect(regraded.reviewed).toBe(true);
    expect(regraded.inboxAt).toBe(saved.data.inboxAt);
    const bootstrap = (await (await api.request("/bootstrap")).json()) as any;
    expect(bootstrap.events.some((d: any) => d.id === original.id)).toBe(true);
  });
  it("puts a development with new supporting coverage above older cards while retaining the primary lead", () => {
    const groups = groupNews([
      doc(event({ id: "primary", discoveredAt: "2026-09-10T00:00:00Z" })),
      doc(event({ id: "other", discoveredAt: "2026-09-15T00:00:00Z" })),
      doc(
        event({
          id: "analysis",
          clusterId: "primary",
          discoveredAt: "2026-09-18T00:00:00Z",
          screening: assessment({ primary: false }),
        }),
      ),
    ]);
    expect(groups[0].lead.id).toBe("primary");
    expect(groups[0].coverage[0].id).toBe("analysis");
  });
});

describe("manual news batches", () => {
  it("uses the exact company filters, including research group and search", async () => {
    const s = store();
    for (const [name, status, group, archived] of [
      ["Alpha", "perpetual", "US", false],
      ["Beta", "pass", "US", false],
      ["Gamma", "perpetual", "UK", false],
      ["Old Alpha", "perpetual", "US", true],
    ] as const) {
      const c = { ...newCompany(name, status), originalGroup: group, archived };
      await s.put("company", c.id, c, 0);
    }
    const docs = await s.list<Company>("company");
    expect(filterCompanies(docs, { status: "all" })).toHaveLength(3);
    expect(
      filterCompanies(docs, { status: "pass" }).map((d) => d.data.name),
    ).toEqual(["Beta"]);
    expect(
      filterCompanies(docs, {
        status: "perpetual",
        group: "US",
        search: "alpha",
      }).map((d) => d.data.name),
    ).toEqual(["Alpha"]);
    expect(
      filterCompanies(docs, { status: "archived" }).map((d) => d.data.name),
    ).toEqual(["Old Alpha"]);
  });
  it("resumes a whole selected batch beyond five companies without changing automatic due dates, feed cursors, or quote state", async () => {
    const s = store(),
      companies: Company[] = [];
    for (let i = 0; i < 7; i++) {
      const c = newCompany(`Acme ${i}`, "perpetual");
      c.lastNewsCheck = "2026-01-01T00:00:00Z";
      c.lastQuoteCheck = "2026-01-01T00:00:00Z";
      c.feeds[0].lastSuccess = "2026-01-01T00:00:00Z";
      if (i === 0) c.cadence = "paused"; // Explicit manual selection still works.
      await s.put("company", c.id, c, 0);
      companies.push(c);
    }
    const excluded = newCompany("Unselected company");
    await s.put("company", excluded.id, excluded, 0);
    await s.put("run", "latest", { marker: "scheduled run" }, 0);
    await s.put("attempt", companies[0].id, { at: "2026-01-01T00:00:00Z" }, 0);
    const fetcher = vi.fn(
      async () =>
        new Response(
          `<rss><channel><item><guid>calendar</guid><title>Acme to announce financial results</title><link>https://example.com/calendar</link><pubDate>${new Date().toUTCString()}</pubDate><description>Future release date only</description></item></channel></rss>`,
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const id = crypto.randomUUID();
    await startNewsBatch(s, {
      id,
      label: "Selected",
      companyIds: companies.map((c) => c.id),
    });
    const same = await startNewsBatch(s, {
      id,
      label: "Retry",
      companyIds: [excluded.id],
    });
    expect(same.totalCompanies).toBe(7);
    const held = await s.claim("monitor", 120);
    await advanceNewsBatch(
      s,
      { ALLOW_PUBLIC_ARTICLE_HOSTS: "false" },
      { id, maxSteps: 2 },
    );
    expect(
      (await s.get<NewsBatch>("news_batch", "latest"))?.data.pendingArticles,
    ).toHaveLength(1);
    const finished = await advanceNewsBatch(
      s,
      { ALLOW_PUBLIC_ARTICLE_HOSTS: "false" },
      { id, maxSteps: 100 },
    );
    expect(finished.batch?.status).toBe("completed");
    expect(finished.batch?.completedCompanies).toBe(7);
    expect(finished.batch?.added).toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(49); // One search for each company/day.
    for (const c of companies)
      expect((await s.get<Company>("company", c.id))?.data).toEqual(c);
    expect(due(companies[1], companies[1].lastNewsCheck)).toBe(true);
    expect((await s.get("run", "latest"))?.data).toEqual({
      marker: "scheduled run",
    });
    expect((await s.get("attempt", companies[0].id))?.version).toBe(1);
    expect(await s.list("event", { companyId: excluded.id })).toHaveLength(0);
    await s.release("monitor", held!);
    const manualLease = await s.claim("manual-news-batch", 120);
    const automatic = await runMonitor(s, {}, { companyId: companies[1].id });
    expect(automatic.busy).toBe(false);
    expect(automatic.processed).toBe(1);
    await s.release("manual-news-batch", manualLease!);
  });
  it("waits and retries a rate-limited search instead of skipping it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const s = store(),
        c = newCompany("Acme");
      await s.put("company", c.id, c, 0);
      let refusals = 1;
      const fetcher = vi.fn(async (url: string, init?: any) =>
        typesafe(url, init) ??
        (refusals-- > 0
          ? new Response("Unavailable", { status: 503 })
          : new Response(
              `<rss><channel><item><guid>x</guid><title>Acme to announce financial results</title><pubDate>${new Date(now - 3600000).toUTCString()}</pubDate></item></channel></rss>`,
            )),
      );
      vi.stubGlobal("fetch", fetcher);
      const id = crypto.randomUUID();
      const env = {
        ALLOW_PUBLIC_ARTICLE_HOSTS: "false",
        TYPESAFE_API_KEY: "test",
      };
      await startNewsBatch(s, { id, label: "Acme", companyIds: [c.id] });
      const first = await advanceNewsBatch(s, env, { id });
      expect(first.batch).toMatchObject({ status: "running", warningCount: 0 });
      expect(Date.parse(first.batch!.backoffUntil!)).toBeGreaterThan(Date.now());
      // Nothing is fetched again until the back-off has elapsed.
      await advanceNewsBatch(s, env, { id });
      expect(searches(fetcher)).toBe(1);
      vi.setSystemTime(Date.now() + 2 * 60000);
      const done = await advanceNewsBatch(s, env, { id });
      expect(done.batch).toMatchObject({
        status: "completed",
        warningCount: 0,
        added: 1,
      });
      expect(searches(fetcher)).toBe(8); // The refused day, retried, then the other six.
    } finally {
      vi.useRealTimers();
    }
  });
  it("reports a search only after repeated rate limiting, continues, and skips stored articles next run", { timeout: 60000 }, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const s = store(),
        c = newCompany("Acme");
      c.feeds.push({
        ...c.feeds[0],
        id: "second",
        label: "Second feed",
        url: "https://news.google.com/rss/search?q=second",
      });
      await s.put("company", c.id, c, 0);
      const fetcher = vi.fn(async (url: string, init?: any) =>
        typesafe(url, init) ??
        (url.includes("second")
          ? new Response(
              `<rss><channel><item><guid>x</guid><title>Acme to announce financial results</title></item></channel></rss>`,
            )
          : new Response("Unavailable", { status: 503 })),
      );
      vi.stubGlobal("fetch", fetcher);
      const run = async () => {
        const id = crypto.randomUUID();
        await startNewsBatch(s, { id, label: "Acme", companyIds: [c.id] });
        let result;
        for (let slice = 0; slice < 100; slice++) {
          result = await advanceNewsBatch(
            s,
            { ALLOW_PUBLIC_ARTICLE_HOSTS: "false", TYPESAFE_API_KEY: "test" },
            { id },
          );
          if (result.batch?.status !== "running") break;
          vi.setSystemTime(Date.now() + 31 * 60000); // Past the longest back-off.
        }
        return result!;
      };
      expect((await run()).batch).toMatchObject({
        status: "completed",
        warningCount: 7,
        added: 1,
      });
      // Five attempts for each of the seven daily searches, plus the second feed.
      expect(searches(fetcher)).toBe(36);
      expect((await s.get<NewsBatch>("news_batch", "latest"))?.data.warnings[0].message).toMatch(
        /skipped after 5 rate-limited attempts \(HTTP 503\)/,
      );
      expect((await run()).batch).toMatchObject({
        status: "completed",
        warningCount: 7,
        added: 0,
      });
      expect(await s.list("event")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects unknown company IDs and does not replace a running batch", async () => {
    const s = store(),
      c = newCompany("Acme");
    await s.put("company", c.id, c, 0);
    await expect(
      startNewsBatch(s, {
        id: crypto.randomUUID(),
        label: "Bad",
        companyIds: ["missing"],
      }),
    ).rejects.toThrow("existing companies");
    const first = await startNewsBatch(s, {
      id: crypto.randomUUID(),
      label: "First",
      companyIds: [c.id],
    });
    await expect(
      startNewsBatch(s, {
        id: crypto.randomUUID(),
        label: "Second",
        companyIds: [c.id],
      }),
    ).rejects.toThrow("already running");
    await expect(
      advanceNewsBatch(
        s,
        { ALLOW_PUBLIC_ARTICLE_HOSTS: "false" },
        { id: crypto.randomUUID() },
      ),
    ).rejects.toThrow();
    expect((await s.get<NewsBatch>("news_batch", "latest"))?.data.id).toBe(
      first.id,
    );
  });
});
