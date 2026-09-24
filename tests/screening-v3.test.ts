import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../server/store.ts";
import {
  newCompany,
  type DeskEvent,
} from "../supabase/functions/_shared/model.ts";
import {
  decideScreening,
  GENRES,
  type ScreeningSignals,
} from "../supabase/functions/_shared/fundamental-policy.ts";
import { screenArticle } from "../supabase/functions/_shared/news-screening.ts";
import { processArticle } from "../supabase/functions/_shared/jobs.ts";
import { newsBucket } from "../supabase/functions/_shared/news.ts";
import { groupNews } from "../supabase/functions/_shared/screening-policy.ts";
import {
  beginHostTracking,
  endHostTracking,
} from "../supabase/functions/_shared/fetch-policy.ts";
import { modelResponse } from "./screening-fixtures.ts";

const stores: LocalStore[] = [];
const store = () => {
  const s = new LocalStore(":memory:");
  stores.push(s);
  return s;
};
afterEach(() => {
  vi.unstubAllGlobals();
  endHostTracking();
  stores.forEach((s) => s.db.close());
  stores.length = 0;
});
const now = new Date().toISOString();
const env = { TYPESAFE_API_KEY: "test" };
// A Google News item: headline and publisher only; the link must be translated.
const headline = (patch: Record<string, unknown> = {}) => ({
  id: "g1",
  title: "Acme reports third-quarter results - Reuters",
  text: "Acme reports third-quarter results Reuters",
  url: "https://news.google.com/rss/articles/CBMiAcmeResults",
  source: "Reuters",
  official: false,
  publishedAt: now,
  contentDepth: "snippet" as const,
  ...patch,
});
const genre = (top: string, p = 1) => ({
  type: "choice",
  choice: top,
  probabilities: Object.fromEntries(
    GENRES.map((g) => [g, g === top ? p : (1 - p) / (GENRES.length - 1)]),
  ),
});
const signals = (patch: Partial<ScreeningSignals> = {}): ScreeningSignals => ({
  useful: 0.95,
  meaningful: 0.5,
  current: 0.95,
  historical: 0.02,
  genre: Object.fromEntries(
    GENRES.map((g) => [g, g === "news_report" ? 1 : 0]),
  ) as ScreeningSignals["genre"],
  issuer: 0.05,
  ageDays: 1,
  textRead: false,
  evidenceVerified: false,
  ...patch,
});
const decide = (
  patch: Partial<ScreeningSignals> = {},
  identity = 0.95,
  primary = false,
) => decideScreening({ identity, primary, signals: signals(patch) });
const only = (g: string, p = 1) =>
  Object.fromEntries(
    GENRES.map((x) => [x, x === g ? p : 0]),
  ) as ScreeningSignals["genre"];
// TypeSafe answers come from the fixture; other hosts are answered by `web`.
const mock = (
  overrides: Record<string, any> = {},
  web: (url: string) => Response = () => new Response("", { status: 404 }),
) =>
  vi.fn(async (url: any, init?: any) =>
    String(url).includes("api.typesafe.ai")
      ? new Response(
          JSON.stringify(modelResponse(overrides, JSON.parse(init.body))),
        )
      : web(String(url)),
  );
const googleCalls = (fetcher: ReturnType<typeof mock>) =>
  fetcher.mock.calls.filter((c) => String(c[0]).includes("google.com")).length;

describe("v3 rules: the route comes from the headline, not from setup or text", () => {
  it("admits a report of a current development without text, context or a ticker", () => {
    expect(decide()).toMatchObject({
      disposition: "relevant",
      articleRole: "news_report",
    });
  });
  it("never sends an article to verification because context, text or a ticker is missing", () => {
    for (const identity of [0.85, 0.95])
      for (const g of GENRES)
        for (const meaningful of [0, 0.1, 0.3])
          expect(
            decide({ genre: only(g), meaningful, useful: 0.9 }, identity)
              .disposition,
          ).not.toBe("uncertain");
  });
  it("verifies only when the company is uncertain and the development may be major", () => {
    expect(decide({ meaningful: 0.6 }, 0.5).reasonCode).toBe(
      "uncertain_identity",
    );
    expect(decide({ meaningful: 0.1 }, 0.5).reasonCode).toBe(
      "unclear_identity",
    );
    expect(decide({}, 0.1).reasonCode).toBe("wrong_entity");
  });
  it("drops law-firm advertisements, old news and commentary without a development", () => {
    expect(decide({ genre: only("legal_solicitation") }).reasonCode).toBe(
      "legal_solicitation",
    );
    expect(decide({ ageDays: 60 }).development.status).toBe("historical");
    expect(decide({ historical: 0.9 }).development.status).toBe("historical");
    expect(
      decide({ genre: only("market_commentary"), meaningful: 0.05 }).reasonCode,
    ).toBe("commentary");
    expect(decide({ useful: 0.3, meaningful: 0.05 }).reasonCode).toBe(
      "immaterial",
    );
  });
  it("keeps commentary about a real development as coverage, never as reading", () => {
    expect(
      decide({ genre: only("investment_opinion"), meaningful: 0.4 }).articleRole,
    ).toBe("coverage_only");
  });
  it("never screens out a possibly major development of this company", () => {
    for (const g of GENRES.filter((g) => g !== "legal_solicitation"))
      for (const identity of [0.3, 0.6, 0.95])
        expect(
          decide({ genre: only(g), meaningful: 0.6, useful: 0.9 }, identity)
            .articleRole,
        ).not.toBe("rejected");
  });
  it("prefers the company's own release and marks analysis as an addition", () => {
    expect(decide({ issuer: 0.9 }).articleRole).toBe("primary_reading");
    expect(decide({}, 0.95, true).articleRole).toBe("primary_reading");
    expect(decide({ genre: only("analysis") }).articleRole).toBe(
      "analytical_addition",
    );
  });
});

describe("v3 flow: headline first, one read attempt, no retries", () => {
  it("judges a headline-only article in one request without evidence questions", async () => {
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
    const result = await screenArticle(
      newCompany("Acme"),
      headline(),
      env,
      store(),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].state.article.textStatus).toBe("headline only");
    expect(requests[0].questions.evidence).toBeUndefined();
    expect(result.screening).toMatchObject({
      headlineOnly: true,
      disposition: "relevant",
    });
  });
  it("tries Google once, ignores a refusal and screens from the headline", async () => {
    const fetcher = mock({}, () => new Response("", { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    const e = await processArticle(newCompany("Acme"), headline(), store(), env);
    expect(googleCalls(fetcher)).toBe(1);
    expect(e.screening).toMatchObject({
      disposition: "relevant",
      headlineOnly: true,
    });
    expect(e.screening?.retrievalNote).toContain("screened from the headline");
    expect(e.screening?.retryAfter).toBeUndefined();
    expect(newsBucket(e)).toBe("relevant");
  });
  it("recognises Google's CAPTCHA redirect as a refusal", async () => {
    const fetcher = mock(
      {},
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://www.google.com/sorry/index?continue=x" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const e = await processArticle(newCompany("Acme"), headline(), store(), env);
    expect(e.screening?.retrievalNote).toContain(
      "Google did not provide the article link",
    );
    expect(googleCalls(fetcher)).toBe(1);
  });
  it("stops asking Google for the rest of a run after two refusals", async () => {
    const fetcher = mock({}, () => new Response("", { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    const s = store(),
      c = newCompany("Acme");
    beginHostTracking();
    for (const id of ["a", "b", "c"])
      await processArticle(
        c,
        headline({ id, url: `https://news.google.com/rss/articles/${id}` }),
        s,
        env,
      );
    expect(googleCalls(fetcher)).toBe(2);
    const third = (await s.get<DeskEvent>("event", `news-${c.id}-c`))!.data;
    expect(third.screening?.retrievalNote).toContain("paused");
    expect(third.screening?.disposition).toBe("relevant");
  });
  it("does not open a Google link the headline already rules out", async () => {
    const fetcher = mock({
      identity: { type: "noul", noul: 0.02 },
      significance: {
        type: "score",
        score: 0,
        probabilities: { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0 },
        confidence: 1,
      },
    });
    vi.stubGlobal("fetch", fetcher);
    const e = await processArticle(newCompany("Acme"), headline(), store(), env);
    expect(e.screening?.reasonCode).toBe("wrong_entity");
    expect(e.screening?.retrievalNote).toContain("not opened");
    expect(googleCalls(fetcher)).toBe(0);
  });
  it("opens a Google link once when the development may be major, even if the headline omits the company", async () => {
    const fetcher = mock({ identity: { type: "noul", noul: 0.02 } }, () =>
      new Response("", { status: 429 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await processArticle(newCompany("Acme"), headline(), store(), env);
    expect(googleCalls(fetcher)).toBe(1);
  });
  it("reads a direct link before judging, without a headline-only pass", async () => {
    const requests: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        if (String(url).includes("api.typesafe.ai")) {
          requests.push(JSON.parse(init.body));
          return new Response(
            JSON.stringify(modelResponse({}, JSON.parse(init.body))),
          );
        }
        return new Response(
          "<html><body><article><h1>Acme results</h1><p>" +
            "Acme reported revenue of $500 million for the third quarter, up 12%. ".repeat(8) +
            "</p></article></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      }),
    );
    const e = await processArticle(
      newCompany("Acme"),
      headline({ url: "https://www.sec.gov/Archives/acme-8k.htm", source: "SEC EDGAR" }),
      store(),
      env,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].state.article.textStatus).not.toBe("headline only");
    expect(e.screening?.headlineOnly).toBe(false);
  });
  it("re-screens from stored data without contacting Google", async () => {
    const fetcher = mock();
    vi.stubGlobal("fetch", fetcher);
    await processArticle(newCompany("Acme"), headline(), store(), env, {
      noFetch: true,
    });
    expect(googleCalls(fetcher)).toBe(0);
  });
  it("accepts a rounding near-tie and otherwise uses the most probable option", async () => {
    const answer = (news_report: number, analysis: number) => ({
      genre: {
        type: "choice",
        choice: "analysis",
        probabilities: {
          ...Object.fromEntries(GENRES.map((g) => [g, 0])),
          news_report,
          analysis,
        },
      },
    });
    vi.stubGlobal("fetch", mock(answer(0.51, 0.49)));
    const tie = await screenArticle(newCompany("Acme"), headline(), env, store());
    expect(tie.screening.category).toBe("analysis");
    vi.stubGlobal("fetch", mock(answer(0.6, 0.4)));
    const clear = await screenArticle(
      newCompany("Acme"),
      headline(),
      env,
      store(),
    );
    expect(clear.screening.category).toBe("news_report");
  });
});

describe("v3 grouping: several reports of one development, best source first", () => {
  it("keeps duplicates relevant in one development led by the established newsroom", async () => {
    let call = 0;
    const duplicate = { type: "noul", noul: 0.95 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: any, init?: any) => {
        if (!String(u).includes("api.typesafe.ai"))
          return new Response("", { status: 429 });
        call++;
        return new Response(
          JSON.stringify(
            modelResponse(
              call > 1 ? { relation0: duplicate } : {},
              JSON.parse(init.body),
            ),
          ),
        );
      }),
    );
    const s = store(),
      c = newCompany("Acme");
    const first = await processArticle(
      c,
      headline({
        id: "mb",
        title: "Acme reports third-quarter results - MarketBeat",
        source: "MarketBeat",
      }),
      s,
      env,
    );
    const second = await processArticle(c, headline({ id: "rt" }), s, env);
    expect(second.clusterId).toBe(first.id);
    expect(newsBucket(first)).toBe("relevant");
    expect(newsBucket(second)).toBe("relevant");
    const groups = groupNews(await s.list<DeskEvent>("event"));
    expect(groups).toHaveLength(1);
    expect(groups[0].lead.id).toBe(second.id);
    expect(groups[0].coverage.map((d) => d.id)).toEqual([first.id]);
  });
  it("uses the purpose answer for commentary about a development", async () => {
    vi.stubGlobal(
      "fetch",
      mock({
        genre: genre("market_commentary"),
        significance: {
          type: "score",
          score: 2.4,
          probabilities: { 0: 0, 1: 0, 2: 0.6, 3: 0.4, 4: 0 },
          confidence: 0.8,
        },
      }),
    );
    const e = await processArticle(
      newCompany("Acme"),
      headline({ title: "Acme shares fall 13% as guidance trails - Yahoo" }),
      store(),
      env,
    );
    expect(newsBucket(e)).toBe("coverage");
  });
});
