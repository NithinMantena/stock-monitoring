import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../server/store.ts";
import {
  newCompany,
  type DeskEvent,
  type Doc,
} from "../supabase/functions/_shared/model.ts";
import {
  decideNews,
  obviousNoise,
  groupNews,
  excludedSource,
} from "../supabase/functions/_shared/screening-policy.ts";
import {
  articleChunks,
  buildScreeningRequest,
  screenArticle,
} from "../supabase/functions/_shared/news-screening.ts";
import {
  extractHtml,
  validateContentUrl,
  fetchDocument,
} from "../supabase/functions/_shared/article-content.ts";
import {
  processArticle,
  digestPreview,
} from "../supabase/functions/_shared/jobs.ts";
import { newsBucket } from "../supabase/functions/_shared/news.ts";
import { configuration } from "../supabase/functions/_shared/providers.ts";
import { assessment, modelResponse } from "./screening-fixtures.ts";
afterEach(() => vi.unstubAllGlobals());
const article = {
  id: "a",
  title: "Netflix actual quarterly financial results",
  text: "Revenue grew 15 percent while operating margins expanded.",
  url: "",
  source: "Netflix IR",
  publishedAt: "2026-09-18T01:00:00Z",
  official: true,
  contentDepth: "supplied" as const,
};

describe("fundamental admission policy", () => {
  it("excludes dates, small-holder changes and options but retains substantive exceptions", () => {
    for (const title of [
      "Netflix to Announce Third Quarter 2026 Financial Results",
      "Netflix sees unusual options activity",
      "Wealth Advisors LLC Increases Stake in Netflix",
    ])
      expect(obviousNoise(title)).toBeTruthy();
    for (const title of [
      "Netflix releases actual third quarter results",
      "Activist increases stake and seeks board control",
      "Netflix delays financial results amid accounting investigation",
    ])
      expect(obviousNoise(title)).toBeNull();
    expect(decideNews(assessment({ category: "calendar" })).disposition).toBe(
      "suppressed",
    );
    expect(
      decideNews(assessment({ category: "results", materiality: 1.5 }))
        .disposition,
    ).toBe("relevant");
  });
  it("does not let primary provenance or good writing rescue immaterial news", () => {
    expect(
      decideNews(
        assessment({ category: "operating", materiality: 1, quality: 3 }),
      ).disposition,
    ).toBe("suppressed");
    expect(
      decideNews(assessment({ primary: false, quality: 0, addedValue: 3 }))
        .disposition,
    ).toBe("suppressed");
    expect(
      decideNews(assessment({ primary: false, quality: 3, addedValue: 1 }))
        .disposition,
    ).toBe("relevant");
    expect(
      decideNews(assessment({ primary: false, category: "research" }))
        .disposition,
    ).toBe("relevant");
  });
  it("keeps snippets and unsupported legal headlines out of vetted developments", () => {
    expect(
      decideNews(assessment({ category: "legal", contentDepth: "snippet" }))
        .disposition,
    ).toBe("uncertain");
    expect(
      decideNews(assessment({ evidenceSufficiency: 0.3 })).disposition,
    ).toBe("uncertain");
    expect(
      excludedSource(
        "24/7 Wall St.",
        "https://news.google.com/rss/articles/a",
        ["24/7 Wall St."],
      ),
    ).toBe(true);
  });
  it("uses a $5 default while respecting an explicitly lower or higher configured cap", () => {
    expect(configuration({}).modelBudget).toBe(5);
    expect(
      configuration({ TYPESAFE_MONTHLY_BUDGET_USD: "0" }).modelBudget,
    ).toBe(0);
    expect(
      configuration({ TYPESAFE_MONTHLY_BUDGET_USD: "10" }).modelBudget,
    ).toBe(10);
  });
});

describe("evidence and ingestion", () => {
  it("extracts the body without executing scripts or passing navigation as evidence", () => {
    const body =
      "Revenue rose as premium rates exceeded claims inflation. ".repeat(40);
    const extracted = extractHtml(
      `<html><head><title>Actual results</title></head><body><nav>Buy options now</nav><article><h1>Actual results</h1><p>${body}</p></article><script>secret()</script></body></html>`,
      "https://ir.netflix.net/result",
    );
    expect(extracted.text).toContain("Revenue rose");
    expect(extracted.text).not.toContain("secret()");
    expect(
      extractHtml(
        '<script type="application/ld+json">{"isAccessibleForFree":false}</script><article>Private story</article>',
        "https://www.ft.com/a",
      ).text,
    ).toBe("");
    const filing = extractHtml(
      "<DOCUMENT><TYPE>EX-99<TEXT><html><body><table><tr><th>Revenue</th><td>12,000</td></tr><tr><th>Profit</th><td>3,000</td></tr></table></body></html></TEXT></DOCUMENT>",
      "https://www.sec.gov/Archives/edgar/data/1/ex99.htm",
    );
    expect(filing.text).toContain("Revenue | 12,000");
    expect(filing.text).toContain("Profit | 3,000");
  });
  it("rejects private destinations and validates each redirect independently", async () => {
    const hosts = new Set(["ir.netflix.net", "127.0.0.1"]);
    expect(() => validateContentUrl("https://127.0.0.1/", hosts)).toThrow();
    expect(() =>
      validateContentUrl("https://ir.netflix.net.evil.test/a", hosts),
    ).toThrow();
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      fetchDocument("https://ir.netflix.net/a", hosts, {}),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reads evidence beyond 16,000 characters and respects both model context limits", async () => {
    const s = new LocalStore(":memory:");
    try {
      const requests: any[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_u, init) => {
          requests.push(JSON.parse(init.body));
          return new Response(
            JSON.stringify(modelResponse({}, JSON.parse(init.body))),
          );
        }),
      );
      const long = "Actual business evidence and financial context. ".repeat(
        1500,
      );
      const result = await screenArticle(
        newCompany("Netflix"),
        { ...article, text: long },
        { TYPESAFE_API_KEY: "test" },
        s,
      );
      expect(requests.length).toBeGreaterThan(1);
      expect(result.screening.charactersRead).toBe(long.trim().length);
      expect(requests.map((r) => JSON.stringify(r.state)).join("")).toContain(
        "financial context",
      );
      for (const part of articleChunks("财务经营数据".repeat(15000))) {
        const request = buildScreeningRequest(
          newCompany("Netflix"),
          article,
          part,
        );
        expect(
          new TextEncoder().encode(JSON.stringify(request.state)).length,
        ).toBeLessThan(31000);
      }
    } finally {
      s.db.close();
    }
  });
  it("suppresses cheap exclusions before any network request and preserves feedback on rescreen", async () => {
    const s = new LocalStore(":memory:");
    const c = newCompany("Netflix");
    c.excludedNewsSources = ["Netflix IR"];
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      const e = await processArticle(
        c,
        {
          ...article,
          title: "Netflix to announce third quarter financial results",
        },
        s,
        {},
      );
      expect(newsBucket(e)).toBe("suppressed");
      expect(fetcher).not.toHaveBeenCalled();
      const saved = (await s.get<DeskEvent>("event", e.id))!;
      await s.put(
        "event",
        e.id,
        { ...saved.data, feedback: "useful", reviewed: true },
        saved.version,
      );
      const again = await processArticle(
        c,
        { ...article, title: e.title },
        s,
        {},
        { existingId: e.id, reprocess: true },
      );
      expect(again.feedback).toBe("useful");
      expect(again.reviewed).toBe(true);
      expect(again.discoveredAt).toBe(e.discoveredAt);
    } finally {
      s.db.close();
    }
  });
  it("defers budget exhaustion without consuming retries and resets failures after context changes", async () => {
    const s = new LocalStore(":memory:"),
      c = newCompany("Netflix");
    const reserve = vi
      .spyOn(s, "reserve")
      .mockRejectedValue(new Error("TypeSafe monthly budget reached."));
    try {
      const first = await processArticle(c, article, s, {
        TYPESAFE_API_KEY: "test",
      });
      expect(first.screening?.attempts).toBe(0);
      expect(first.screening?.retryAfter).toBeTruthy();
      reserve.mockRejectedValue(new Error("Service unavailable"));
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await processArticle(
          c,
          article,
          s,
          { TYPESAFE_API_KEY: "test" },
          { existingId: first.id, reprocess: true },
        );
        expect(result.screening?.attempts).toBe(attempt);
        expect(Boolean(result.screening?.retryAfter)).toBe(attempt < 3);
      }
      const changed = await processArticle(
        { ...c, newsRevision: c.newsRevision + 1 },
        article,
        s,
        { TYPESAFE_API_KEY: "test" },
        { existingId: first.id, reprocess: true },
      );
      expect(changed.screening?.attempts).toBe(1);
      expect(changed.screening?.retryAfter).toBeTruthy();
    } finally {
      s.db.close();
    }
  });
});

describe("event grouping", () => {
  it("persists semantic duplicate links without merging a later development", async () => {
    const s = new LocalStore(":memory:"),
      c = newCompany("Netflix");
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u, init) => {
        call++;
        const relation = call === 3 ? "update" : "analysis";
        const answer = {
          type: "choice",
          choice: relation,
          probabilities: { [relation]: 0.95, unrelated: 0.05 },
        };
        return new Response(
          JSON.stringify(
            modelResponse(
              call > 1 ? { relation0: answer, relation1: answer } : {},
              JSON.parse(init.body),
            ),
          ),
        );
      }),
    );
    try {
      const first = await processArticle(c, article, s, {
        TYPESAFE_API_KEY: "test",
      });
      const second = await processArticle(
        c,
        { ...article, id: "b", official: false },
        s,
        { TYPESAFE_API_KEY: "test" },
      );
      expect(second.clusterId).toBe(first.id);
      const third = await processArticle(
        c,
        { ...article, id: "c", title: "A new quarter's actual results" },
        s,
        { TYPESAFE_API_KEY: "test" },
      );
      expect(third.clusterId).toBeUndefined();
      expect(third.relatedEventId).toBe(first.id);
      expect(groupNews(await s.list<DeskEvent>("event"))).toHaveLength(2);
    } finally {
      s.db.close();
    }
  });
  function doc(
    id: string,
    primary: boolean,
    clusterId = "result",
  ): Doc<DeskEvent> {
    return {
      id,
      version: 1,
      kind: "event",
      updatedAt: "",
      data: {
        id,
        companyId: "netflix",
        title: id,
        kind: "news",
        priority: "normal",
        body: "",
        url: `https://example.com/${id}`,
        publishedAt: "2026-09-18T01:00:00Z",
        discoveredAt: "2026-09-18T01:00:00Z",
        reviewed: false,
        clusterId,
        screening: assessment({ primary }),
      },
    };
  }
  it("selects a primary lead and groups coverage while keeping a later ruling separate", async () => {
    const docs = [
      doc("analysis", false),
      doc("primary", true),
      doc("new-ruling", true, "ruling"),
    ];
    const groups = groupNews(docs);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.coverage.length)?.lead.id).toBe("primary");
    const s = new LocalStore(":memory:");
    try {
      for (const d of docs) await s.put("event", d.id, d.data, 0);
      const digest = await digestPreview(s, new Date("2026-09-18T12:00:00Z"));
      expect(digest.count).toBe(2);
    } finally {
      s.db.close();
    }
  });
});
