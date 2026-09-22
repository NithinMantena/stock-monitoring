import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../server/store.ts";
import {
  newCompany,
  type DeskEvent,
} from "../supabase/functions/_shared/model.ts";
import {
  decideFundamental,
  type FundamentalSignals,
} from "../supabase/functions/_shared/fundamental-policy.ts";
import { screenArticle } from "../supabase/functions/_shared/news-screening.ts";
import { processArticle } from "../supabase/functions/_shared/jobs.ts";
import { newsBucket } from "../supabase/functions/_shared/news.ts";
import { createV1Api } from "../supabase/functions/_shared/api-v1.ts";
import { ownerActor } from "../supabase/functions/_shared/integrations.ts";
import { modelResponse } from "./screening-fixtures.ts";
const stores: LocalStore[] = [];
const store = () => {
  const s = new LocalStore(":memory:");
  stores.push(s);
  return s;
};
afterEach(() => {
  vi.unstubAllGlobals();
  stores.forEach((s) => s.db.close());
  stores.length = 0;
});
const now = "2026-09-22T12:00:00Z";
const article = {
  id: "a",
  title: "Acme reports operating results",
  text: "Acme disclosed revenue of $500 million and stable margins for September 2026.",
  url: "",
  source: "Issuer",
  official: true,
  publishedAt: now,
  contentDepth: "supplied" as const,
};
const signals = (
  patch: Partial<FundamentalSignals> = {},
): FundamentalSignals => ({
  useful: 0.95,
  meaningful: 0.5,
  attributed: 0.98,
  unsupported: 0.01,
  absent: 0.01,
  incremental: 0.95,
  recap: 0.03,
  current: 0.95,
  historical: 0.01,
  analyticalQuality: 0.95,
  misleading: 0.01,
  missingContext: 0.05,
  alignment: "aligned",
  consistency: "coherent",
  evidenceVerified: true,
  partial: false,
  ...patch,
});
const decide = (patch: Partial<FundamentalSignals> = {}, primary = true) =>
  decideFundamental({
    identity: 0.95,
    primary,
    contentDepth: "full",
    retrievalNote: "",
    signals: signals(patch),
  });
const mock = (overrides: Record<string, any> = {}) =>
  vi.fn(
    async (_url, init) =>
      new Response(
        JSON.stringify(modelResponse(overrides, JSON.parse(init.body))),
      ),
  );

describe("fundamental v2 gates", () => {
  it("admits stable core results without requiring a surprise or a mean above two", () => {
    expect(decide({ useful: 0.76, meaningful: 0 }).articleRole).toBe(
      "primary_reading",
    );
  });
  it("separates a useful development from a secondary recap in every category", async () => {
    const s = store();
    vi.stubGlobal(
      "fetch",
      mock({
        contribution: {
          type: "choice",
          choice: "recap",
          probabilities: { incremental: 0.01, recap: 0.98, unknown: 0.01 },
        },
      }),
    );
    const result = await processArticle(
      newCompany("Acme"),
      { ...article, official: false },
      s,
      { TYPESAFE_API_KEY: "test" },
    );
    expect(result.screening).toMatchObject({
      development: { status: "relevant" },
      articleRole: "coverage_only",
      needsPreferredSource: true,
    });
    expect(newsBucket(result)).toBe("coverage");
  });
  it("requires both contribution and analytical quality", () => {
    expect(decide({}, false).articleRole).toBe("analytical_addition");
    expect(decide({ analyticalQuality: 0.4 }, false).reasonCode).toBe(
      "uncertain_analysis",
    );
    expect(decide({ incremental: 0.5 }, false).reasonCode).toBe(
      "uncertain_contribution",
    );
    expect(
      decide({ attributed: 0.1, unsupported: 0.89, meaningful: 0.99 }, false)
        .reasonCode,
    ).toBe("unsupported_claim");
  });
  it("requires currentness and gives SEC no blanket historical exemption", () => {
    expect(decide({ current: 0.5, historical: 0.1 }).reasonCode).toBe(
      "uncertain_currentness",
    );
    expect(decide({ current: 0.01, historical: 0.98 }).development.status).toBe(
      "historical",
    );
  });
  it("routes extraction failure before a misleading low identity or usefulness answer", () => {
    const result = decideFundamental({
      identity: 0.01,
      primary: true,
      contentDepth: "full",
      retrievalNote: "",
      signals: signals({ useful: 0.01, alignment: "different_document" }),
    });
    expect(result.reasonCode).toBe("extraction_mismatch");
  });
  it("rejects intact calendars before requiring a business passage", () => {
    expect(
      decide({
        useful: 0.01,
        meaningful: 0,
        attributed: 0,
        absent: 1,
        evidenceVerified: false,
      }).reasonCode,
    ).toBe("immaterial");
    expect(decide({ missingContext: 0.6 }).reasonCode).toBe("missing_context");
    expect(decide({ partial: true }).reasonCode).toBe("incomplete_document");
  });
  it("does not accept a primary results headline without the body or spend model tokens on it", async () => {
    const fetcher = mock();
    vi.stubGlobal("fetch", fetcher);
    const result = await screenArticle(
      newCompany("Acme"),
      { ...article, text: "", contentDepth: "snippet" },
      {},
      store(),
      [],
      now,
    );
    expect(result.screening.reasonCode).toBe("missing_text");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not hard-veto an options headline containing substantive business evidence", async () => {
    vi.stubGlobal("fetch", mock());
    const result = await processArticle(
      newCompany("Acme"),
      { ...article, title: "Acme unusual options activity after results" },
      store(),
      { TYPESAFE_API_KEY: "test" },
    );
    expect(result.screening?.articleRole).toBe("primary_reading");
  });
});

describe("v2 evidence, cache and failures", () => {
  it("rejects incomplete distributions and inconsistent mean scores", async () => {
    vi.stubGlobal(
      "fetch",
      mock({
        significance: {
          type: "score",
          score: 4,
          confidence: 1,
          probabilities: { 0: 0, 1: 0, 2: 1, 3: 0, 4: 0 },
        },
      }),
    );
    await expect(
      screenArticle(
        newCompany("Acme"),
        article,
        { TYPESAFE_API_KEY: "test" },
        store(),
        [],
        now,
      ),
    ).rejects.toThrow("disagrees");
    vi.stubGlobal(
      "fetch",
      mock({
        temporal: {
          type: "choice",
          choice: "current",
          probabilities: { current: 0.2 },
        },
      }),
    );
    await expect(
      screenArticle(
        newCompany("Acme"),
        article,
        { TYPESAFE_API_KEY: "test" },
        store(),
        [],
        now,
      ),
    ).rejects.toThrow("distribution");
  });
  it("reconciles a correction instead of retaining the most positive chunk", async () => {
    const requests: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u, init) => {
        const r = JSON.parse(init.body);
        requests.push(r);
        return new Response(
          JSON.stringify(
            modelResponse(
              r.questions.consistency
                ? {
                    significance: {
                      type: "score",
                      score: 1,
                      probabilities: { 0: 0, 1: 1, 2: 0, 3: 0, 4: 0 },
                      confidence: 1,
                    },
                    consistency: {
                      type: "choice",
                      choice: "corrected",
                      probabilities: {
                        coherent: 0,
                        corrected: 1,
                        conflicting: 0,
                        unknown: 0,
                      },
                    },
                  }
                : {},
              r,
            ),
          ),
        );
      }),
    );
    const text =
      "Acme initially reported a shutdown. ".repeat(430) +
      "\nCORRECTION: the shutdown was an exercise; production continues normally.";
    const result = await screenArticle(
      newCompany("Acme"),
      { ...article, text },
      { TYPESAFE_API_KEY: "test" },
      store(),
      [],
      now,
    );
    expect(requests.at(-1).questions.consistency).toBeTruthy();
    expect(result.screening).toMatchObject({
      reasonCode: "immaterial",
      signals: { consistency: "corrected" },
      readingCoverage: { reconciled: true },
    });
    expect(result.screening.charactersRead).toBe(text.length);
  });
  it("retains unresolved contradictions for verification", () =>
    expect(
      decide({ consistency: "conflicting", meaningful: 0.99 }).reasonCode,
    ).toBe("conflicting_evidence"));
  it("reuses identical inference but invalidates context, date and model changes", async () => {
    const s = store(),
      c = newCompany("Acme"),
      fetcher = mock();
    vi.stubGlobal("fetch", fetcher);
    const env = { TYPESAFE_API_KEY: "test" };
    await screenArticle(c, article, env, s, [], now);
    const replay = await screenArticle(c, article, env, s, [], now);
    expect(replay.tokens).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await screenArticle(
      { ...c, businessScale: "large" },
      article,
      env,
      s,
      [],
      now,
    );
    await screenArticle(c, article, env, s, [], "2026-09-23T12:00:00Z");
    await screenArticle(
      c,
      article,
      { ...env, TYPESAFE_MODEL: "different-model" },
      s,
      [],
      now,
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("keeps service failures separate from content judgments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unavailable", { status: 503 })),
    );
    const e = await processArticle(newCompany("Acme"), article, store(), {
      TYPESAFE_API_KEY: "test",
    });
    expect(e.screening).toMatchObject({
      reasonCode: "processing_failed",
      articleRole: "pending_verification",
    });
    expect(e.screening?.retryAfter).toBeTruthy();
  });
  it("dismisses a weak article without dismissing other coverage of its development", async () => {
    const s = store();
    for (const id of ["primary", "recap"])
      await s.put(
        "event",
        id,
        {
          id,
          kind: "news",
          companyId: "c",
          clusterId: "primary",
          reviewed: false,
        },
        0,
      );
    const app = createV1Api(s, {}, "local", ownerActor);
    const response = await app.request("/developments/recap", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        versions: { recap: 1 },
        scope: "article",
        patch: { feedback: "noise", feedbackReason: "poor_source" },
      }),
    });
    expect(response.status).toBe(200);
    expect(
      (await s.get<DeskEvent>("event", "primary"))?.data.feedback,
    ).toBeUndefined();
    expect((await s.get<DeskEvent>("event", "recap"))?.data.feedback).toBe(
      "noise",
    );
  });
});
