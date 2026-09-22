import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../server/store.ts";
import {
  newCompany,
  type DeskEvent,
} from "../supabase/functions/_shared/model.ts";
import {
  startNewsBatch,
  advanceNewsBatch,
  controlNewsBatch,
  type NewsBatch,
} from "../supabase/functions/_shared/news-batch.ts";
import {
  DIGEST_DEVELOPMENT_LIMIT,
  digestPreview,
  processArticle,
} from "../supabase/functions/_shared/jobs.ts";
import {
  currentAssessment,
  decideNews,
  exemptFromAgeLimit,
  groupNews,
  obviousNoise,
  reportsResults,
  staleDevelopment,
  staleTitlePeriod,
} from "../supabase/functions/_shared/screening-policy.ts";
import {
  newsBucket,
  newsSearchDays,
} from "../supabase/functions/_shared/news.ts";
import { createApi } from "../supabase/functions/_shared/api.ts";
import { assessment, modelResponse } from "./screening-fixtures.ts";
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
});

describe("news controls and daily bounds", () => {
  it("persists pause during a fetch, resumes its exact queue, and cancels without losing articles", async () => {
    const s = store(),
      c = newCompany("Acme");
    await s.put("company", c.id, c, 0);
    const batch = await startNewsBatch(s, {
      id: crypto.randomUUID(),
      companyIds: [c.id],
      label: "Acme",
    });
    const fetcher = vi.fn(async () => {
      await controlNewsBatch(s, batch.id, "pause");
      return new Response(
        `<rss><channel><item><title>Acme to announce financial results</title><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`,
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const paused = await advanceNewsBatch(
      s,
      { ALLOW_PUBLIC_ARTICLE_HOSTS: "false" },
      { id: batch.id },
    );
    expect(paused.batch?.status).toBe("paused");
    expect(
      (await s.get<NewsBatch>("news_batch", "latest"))?.data.pendingArticles,
    ).toHaveLength(1);
    await expect(
      startNewsBatch(s, {
        id: crypto.randomUUID(),
        companyIds: [c.id],
        label: "Another",
      }),
    ).rejects.toThrow("paused");
    await advanceNewsBatch(s, {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    await controlNewsBatch(s, batch.id, "resume");
    expect(
      (
        await advanceNewsBatch(
          s,
          { ALLOW_PUBLIC_ARTICLE_HOSTS: "false" },
          { maxSteps: 1 },
        )
      ).batch?.added,
    ).toBe(1);
    await controlNewsBatch(s, batch.id, "cancel");
    expect((await advanceNewsBatch(s, {})).batch?.status).toBe("cancelled");
    expect(await s.list("event")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await controlNewsBatch(s, batch.id, "resume")).status).toBe(
      "cancelled",
    );
    await expect(controlNewsBatch(s, "stale-id", "cancel")).rejects.toThrow();
    await startNewsBatch(s, {
      id: crypto.randomUUID(),
      companyIds: [c.id],
      label: "New search",
    });
  });
  it("preserves cancel while an AI call finishes and does not start the next article", async () => {
    const s = store(),
      c = newCompany("Acme");
    await s.put("company", c.id, c, 0);
    const batch = await startNewsBatch(s, {
      id: crypto.randomUUID(),
      companyIds: [c.id],
      label: "Acme",
    });
    const doc = (await s.get<NewsBatch>("news_batch", "latest"))!;
    const article = {
      id: "a",
      title: "Acme reports quarterly financial results",
      text: "Revenue rose 10% to $100 million.",
      url: "",
      source: "Acme",
      publishedAt: "",
      official: true,
      contentDepth: "supplied" as const,
    };
    await s.put(
      "news_batch",
      "latest",
      { ...doc.data, pendingArticles: [article, { ...article, id: "b" }] },
      doc.version,
    );
    const fetcher = vi.fn(async () => {
      await controlNewsBatch(s, batch.id, "cancel");
      return new Response(JSON.stringify(modelResponse()));
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await advanceNewsBatch(s, { TYPESAFE_API_KEY: "test" });
    expect(result.batch).toMatchObject({
      status: "cancelled",
      added: 1,
      checked: 1,
      tokens: 400,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await s.list("event")).toHaveLength(1);
  });
  it("takes only the first ten results from each of seven separate daily searches", async () => {
    const s = store(),
      c = newCompany("Acme");
    await s.put("company", c.id, c, 0);
    const batch = await startNewsBatch(s, {
      id: crypto.randomUUID(),
      companyIds: [c.id],
      label: "Acme",
    });
    const dates: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const q = new URL(url).searchParams.get("q")!;
        const day = q.match(/after:(\d{4}-\d{2}-\d{2})/)![1];
        dates.push(day);
        return new Response(
          `<rss><channel>${Array.from({ length: 15 }, (_, i) => `<item><title>Acme to announce financial results ${i}</title><link>https://example.com/${day}/${i}</link><pubDate>${day}T01:00:00Z</pubDate></item>`).join("")}</channel></rss>`,
        );
      }),
    );
    const result = await advanceNewsBatch(
      s,
      { ALLOW_PUBLIC_ARTICLE_HOSTS: "false" },
      { maxSteps: 100 },
    );
    expect(dates).toEqual(newsSearchDays(batch.createdAt));
    expect(result.batch).toMatchObject({
      status: "completed",
      added: 70,
      checked: 70,
    });
    const events = await s.list<DeskEvent>("event");
    expect(events.every((d) => Number(d.data.url.split("/").at(-1)) < 10)).toBe(
      true,
    );
  });
});

describe("reported developments and duplicate recovery", () => {
  it("recovers saved secondary duplicates without model calls and labels limited evidence", () => {
    const e: DeskEvent = {
      id: "a",
      companyId: "zoom",
      title: "Zoom reports Q3 financial results",
      body: "",
      url: "",
      kind: "news",
      priority: "suppressed",
      publishedAt: "",
      discoveredAt: "",
      reviewed: false,
      screening: assessment({
        category: "other",
        disposition: "suppressed",
        primary: false,
        materiality: 1,
        quality: 1,
        addedValue: 0,
        evidenceSufficiency: 0.2,
        contentDepth: "snippet",
      }),
    };
    expect(newsBucket(e)).toBe("relevant");
    expect(currentAssessment(e)?.reason).toContain("headline/snippet only");
    expect(newsBucket({ ...e, feedback: "noise" })).toBe("suppressed");
    expect(
      newsBucket({ ...e, screening: { ...e.screening!, identity: 0.1 } }),
    ).toBe("suppressed");
    const doc = (data: DeskEvent) => ({
      id: data.id,
      data,
      kind: "event",
      version: 1,
      updatedAt: "",
    });
    const better = {
      ...e,
      id: "b",
      clusterId: "a",
      screening: assessment({ primary: false, quality: 2, addedValue: 1 }),
    };
    const grouped = groupNews([doc(e), doc(better)]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].lead.id).toBe("b");
    expect(grouped[0].coverage).toHaveLength(1);
    expect(reportsResults("Zoom will announce Q3 financial results")).toBe(
      false,
    );
    expect(reportsResults("Zoom Q3 earnings preview")).toBe(false);
    expect(
      newsBucket({
        ...e,
        title: "Adobe launches a new Photoshop feature",
        screening: { ...e.screening!, category: "results" },
      }),
    ).toBe("uncertain");
    expect(
      decideNews(
        assessment({ primary: false, category: "research", addedValue: 0 }),
      ).disposition,
    ).toBe("suppressed");
  });
  it("does not pay again for unchanged text on a retry", async () => {
    const s = store(),
      c = newCompany("Acme");
    const article = {
      id: "a",
      title: "Acme financial results",
      text: "Revenue rose 10%.",
      url: "",
      publishedAt: "",
      source: "Acme",
      official: true,
      contentDepth: "supplied" as const,
    };
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(modelResponse())),
    );
    vi.stubGlobal("fetch", fetcher);
    const first = await processArticle(c, article, s, {
      TYPESAFE_API_KEY: "test",
    });
    await processArticle(
      c,
      article,
      s,
      { TYPESAFE_API_KEY: "test" },
      { existingId: first.id, reprocess: true },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reads supplied text through the API without an AI call", async () => {
    const s = store(),
      c = newCompany("Acme");
    await s.put("company", c.id, c, 0);
    await s.put(
      "event",
      "article",
      {
        id: "article",
        companyId: c.id,
        kind: "news",
        title: "Results",
        rawText: "The available article.",
        url: "",
        screening: assessment({ contentDepth: "supplied" }),
      },
      0,
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await createApi(s, {}, "local").request(
      "/events/article/content",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "The available article.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reuses an identical canonical article reached under a different feed ID", async () => {
    const s = store(),
      c = newCompany("Acme");
    const article = {
      id: "a",
      title: "Acme reports quarterly financial results",
      text: "Revenue grew 10% to $100 million.",
      url: "https://example.com/results",
      publishedAt: "2026-09-19T00:00:00Z",
      source: "Acme",
      official: true,
      contentDepth: "supplied" as const,
    };
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(modelResponse())),
    );
    vi.stubGlobal("fetch", fetcher);
    const first = await processArticle(c, article, s, {
      TYPESAFE_API_KEY: "test",
    });
    const second = await processArticle(c, { ...article, id: "b" }, s, {
      TYPESAFE_API_KEY: "test",
    });
    expect(second.clusterId).toBe(first.id);
    expect(second.classification?.tokens).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("recency and commentary screening", () => {
  const newsEvent = (patch: Partial<DeskEvent> = {}): DeskEvent => ({
    id: "e1",
    companyId: "c1",
    title: "Acme reports Q3 financial results",
    body: "Revenue grew.",
    url: "https://example.com/a",
    kind: "news",
    priority: "normal",
    publishedAt: new Date(Date.now() - 86400000).toISOString(),
    discoveredAt: new Date().toISOString(),
    reviewed: false,
    screening: assessment(),
    classification: { source: "Example Wire" },
    ...patch,
  });

  it("rejects pundit, recommendation and price-target headlines", () => {
    expect(obviousNoise("Jim Cramer says he is worried about Uber")).toContain(
      "pundit",
    );
    expect(obviousNoise("Should you buy Acme stock right now?")).toContain(
      "recommendation",
    );
    expect(obviousNoise("3 reasons to buy Acme today")).toContain(
      "recommendation",
    );
    expect(obviousNoise("Analyst raises Acme price target to $90")).toContain(
      "price-target",
    );
  });

  it("keeps a real development that a pundit format merely wraps", () => {
    expect(
      obviousNoise("Jim Cramer on Acme after it acquires Beta Corp"),
    ).toBeNull();
    expect(
      obviousNoise("Should you buy Acme after the SEC investigation?"),
    ).toBeNull();
    expect(obviousNoise("Acme reports Q3 financial results")).toBeNull();
  });

  it("suppresses stale developments and exempts baseline SEC filings", () => {
    expect(
      staleDevelopment(new Date(Date.now() - 200 * 86400000).toISOString()),
    ).toBe(true);
    expect(
      staleDevelopment(new Date(Date.now() - 5 * 86400000).toISOString()),
    ).toBe(false);
    // An undated item cannot be judged on age alone; the model answers that.
    expect(staleDevelopment("")).toBe(false);
    expect(exemptFromAgeLimit("SEC EDGAR")).toBe(true);
    expect(exemptFromAgeLimit("Example Wire")).toBe(false);
  });

  it("re-applies title and age policy to already-screened events without a model call", () => {
    const old = newsEvent({
      publishedAt: new Date(Date.now() - 400 * 86400000).toISOString(),
    });
    expect(currentAssessment(old)?.disposition).toBe("suppressed");
    expect(currentAssessment(old)?.reason).toContain("days ago");
    expect(newsBucket(old)).toBe("suppressed");

    const pundit = newsEvent({ title: "Jim Cramer says Acme worries him" });
    expect(newsBucket(pundit)).toBe("suppressed");

    const filing = newsEvent({
      publishedAt: new Date(Date.now() - 400 * 86400000).toISOString(),
      classification: { source: "SEC EDGAR" },
    });
    expect(currentAssessment(filing)?.disposition).toBe("relevant");
  });

  it("does not promote a results headline with no retrievable text from a third party", () => {
    const base = {
      ...assessment({
        category: "other",
        primary: false,
        contentDepth: "snippet" as const,
        materiality: 1,
        quality: 0,
        addedValue: 0,
        evidenceSufficiency: 0.2,
        availableCharacters: 0,
        charactersRead: 0,
      }),
      reportedResults: true,
    };
    expect(decideNews(base).disposition).toBe("uncertain");
    // The company's own release still stands on its headline.
    expect(decideNews({ ...base, primary: true }).disposition).toBe("relevant");
    // So does a third party with actual retrieved text.
    expect(decideNews({ ...base, availableCharacters: 900 }).disposition).toBe(
      "relevant",
    );
  });
});

describe("digest composition", () => {
  it("caps the email at the top developments, ranks by importance and separates alerts", async () => {
    const s = store();
    const c = newCompany("Acme");
    await s.put("company", c.id, c, 0);
    const at = new Date();
    for (let i = 0; i < 25; i++) {
      const id = `n${String(i).padStart(2, "0")}`;
      await s.put(
        "event",
        id,
        {
          id,
          companyId: c.id,
          kind: "news",
          title: `Development ${i}`,
          body: "Body",
          url: `https://example.com/${i}`,
          publishedAt: new Date(at.getTime() - 3600000).toISOString(),
          discoveredAt: at.toISOString(),
          reviewed: false,
          priority: "normal",
          clusterId: id,
          // Ascending materiality: the last item must lead the email.
          screening: assessment({ materiality: 1.9 + i * 0.04 }),
        },
        0,
      );
    }
    await s.put(
      "event",
      "alert",
      {
        id: "alert",
        companyId: c.id,
        kind: "health",
        title: "Feed returned HTTP 503",
        body: "",
        url: "",
        publishedAt: at.toISOString(),
        discoveredAt: at.toISOString(),
        reviewed: false,
        priority: "possible",
      },
      0,
    );
    const digest = await digestPreview(s, at);
    expect(digest.count).toBe(25);
    expect(digest.shown).toBe(DIGEST_DEVELOPMENT_LIMIT);
    expect(digest.alerts).toBe(1);
    expect(digest.text).toContain("TOP 20 OF 25");
    expect(digest.text).toContain("5 further developments not shown");
    // Highest materiality leads; the weakest five are dropped entirely.
    expect(digest.text.indexOf("Development 24")).toBeLessThan(
      digest.text.indexOf("Development 20"),
    );
    expect(digest.text).not.toContain("Development 0 ");
    expect(digest.text).toContain("MONITORING ALERTS (1)");
    expect(digest.html).toContain("Feed returned HTTP 503");
  });

  it("omits a stale development from the email without a model call", async () => {
    const s = store();
    const c = newCompany("Acme");
    await s.put("company", c.id, c, 0);
    const at = new Date();
    for (const [id, days] of [
      ["fresh", 1],
      ["ancient", 500],
    ] as const)
      await s.put(
        "event",
        id,
        {
          id,
          companyId: c.id,
          kind: "news",
          title: `${id} results release`,
          body: "Body",
          url: `https://example.com/${id}`,
          publishedAt: new Date(at.getTime() - days * 86400000).toISOString(),
          discoveredAt: at.toISOString(),
          reviewed: false,
          priority: "normal",
          clusterId: id,
          screening: assessment(),
        },
        0,
      );
    const digest = await digestPreview(s, at);
    expect(digest.text).toContain("fresh results release");
    expect(digest.text).not.toContain("ancient results release");
    expect(digest.count).toBe(1);
  });
});

describe("undated archive releases", () => {
  const now = new Date("2026-09-21T12:00:00Z");
  it("reads the reporting period from the title when the feed supplies no date", () => {
    // The exact titles the Zoom investor-relations archive supplied.
    expect(
      staleTitlePeriod(
        "Zoom: Zoom Reports Financial Results for the First Quarter of Fiscal Year 2022",
        now,
      ),
    ).toBe(true);
    expect(
      staleTitlePeriod(
        "Zoom: CORRECTION - Zoom Reports Financial Results for the Second Quarter of Fiscal Year 2022",
        now,
      ),
    ).toBe(true);
    // The current and previous fiscal years stay: an annual report lands late.
    expect(
      staleTitlePeriod("Acme reports results for fiscal year 2026", now),
    ).toBe(false);
    expect(
      staleTitlePeriod("Acme reports results for fiscal year 2025", now),
    ).toBe(false);
    expect(staleTitlePeriod("Acme Q3 2026 earnings", now)).toBe(false);
    // No period named at all is not evidence of age.
    expect(staleTitlePeriod("Acme reports quarterly results", now)).toBe(false);
    // A four-digit number that is not a reporting period must not trigger it.
    expect(staleTitlePeriod("Acme wins a $2019 million contract", now)).toBe(
      false,
    );
  });

  it("suppresses an undated archive release already stored in the inbox", () => {
    const e: DeskEvent = {
      id: "zoom-old",
      companyId: "zoom",
      title:
        "Zoom: Zoom Reports Financial Results for the First Quarter of Fiscal Year 2022",
      body: "",
      url: "https://investors.zoom.us/news-releases/x",
      kind: "news",
      priority: "normal",
      publishedAt: "",
      discoveredAt: now.toISOString(),
      reviewed: false,
      screening: assessment({ contentDepth: "snippet", primary: true }),
      classification: { source: "investors.zoom.us" },
    };
    expect(currentAssessment(e, now)?.disposition).toBe("suppressed");
    expect(currentAssessment(e, now)?.reason).toContain("past period");
    expect(newsBucket(e)).toBe("suppressed");
  });
});
