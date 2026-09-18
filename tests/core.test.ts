import { afterEach, describe, expect, it, vi } from "vitest";
import { newCompany, type Quote } from "../supabase/functions/_shared/model";
import {
  cadenceOf,
  chicagoParts,
  due,
  evaluateRules,
} from "../supabase/functions/_shared/engine";
import { parseInvestmentMarkdown } from "../supabase/functions/_shared/importer";
import { createApi } from "../supabase/functions/_shared/api";
import {
  classifyArticle,
  parseFeed,
  validateFeedUrl,
} from "../supabase/functions/_shared/providers";
import {
  dailySnapshot,
  processArticle,
  saveQuoteObservations,
  sendDueDigest,
} from "../supabase/functions/_shared/jobs";
import { LocalStore } from "../server/store";

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
const quote = (
  price: number,
  session: string,
  extra: Partial<Quote> = {},
): Quote => ({
  price,
  session,
  currency: "USD",
  fetchedAt: "2026-09-18T00:00:00Z",
  source: "Test",
  pe: null,
  marketCap: null,
  peBasis: "Trailing P/E",
  fundamentalDate: "",
  ...extra,
});
const companyWithRule = (metric: "price" | "pe" | "decline" = "price") => {
  const c = newCompany("Example");
  c.currency = "USD";
  c.rules = [
    {
      id: "r1",
      metric,
      threshold: metric === "price" ? 100 : 10,
      currency: "USD",
      baseline: 100,
      enabled: true,
      triggered: false,
      episode: 0,
      lastSession: "",
      lastFingerprint: "",
      basis: "Trailing P/E",
    },
  ];
  return c;
};
describe("monitoring cadence and Chicago time", () => {
  it("makes portfolio and perpetual daily with explicit override and archive precedence", () => {
    const c = newCompany("A", "owned");
    expect(cadenceOf(c)).toBe("daily");
    c.status = "perpetual";
    expect(cadenceOf(c)).toBe("daily");
    c.status = "watchlist";
    expect(cadenceOf(c)).toBe("weekly");
    c.cadence = "daily";
    expect(cadenceOf(c)).toBe("daily");
    c.archived = true;
    expect(cadenceOf(c)).toBe("paused");
  });
  it("uses Chicago midnight and DST, independent of machine timezone", () => {
    expect(chicagoParts(new Date("2026-01-15T12:00:00Z")).hour).toBe(6);
    expect(chicagoParts(new Date("2026-07-15T12:00:00Z")).hour).toBe(7);
    expect(chicagoParts(new Date("2026-09-18T01:00:00Z")).date).toBe(
      "2026-09-17",
    );
  });
  it("does not check weekly companies every day", () => {
    const c = newCompany("A");
    expect(
      due(c, "2026-09-15T12:00:00Z", new Date("2026-09-16T12:00:00Z")),
    ).toBe(false);
    expect(
      due(c, "2026-09-15T12:00:00Z", new Date("2026-09-22T12:00:00Z")),
    ).toBe(true);
  });
});
describe("numerical alerts", () => {
  it("discovers a weekly crossing even if the price recovered before the check", () => {
    const c = companyWithRule();
    const result = evaluateRules(
      c,
      [
        quote(110, "2026-09-14"),
        quote(95, "2026-09-15"),
        quote(108, "2026-09-16"),
      ],
      new Date("2026-09-18"),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0].publishedAt).toBe("2026-09-15");
    expect(result.rules[0].triggered).toBe(false);
  });
  it("is replay-safe and rearms after recovery", () => {
    const c = companyWithRule();
    const history = [quote(99, "2026-09-14"), quote(98, "2026-09-15")];
    const first = evaluateRules(c, history);
    c.rules = first.rules;
    expect(evaluateRules(c, history).events).toHaveLength(0);
    const next = evaluateRules(c, [
      quote(102, "2026-09-16"),
      quote(98, "2026-09-17"),
    ]);
    expect(next.events).toHaveLength(1);
    expect(next.events[0].id).not.toBe(first.events[0].id);
  });
  it("does not trigger on wrong currency, future data or missing / negative / wrong-basis P/E", () => {
    const c = companyWithRule("pe");
    const quotes = [
      quote(99, "2026-09-14"),
      quote(99, "2026-09-15", { pe: -5 }),
      quote(99, "2026-09-16", { pe: 8, currency: "CAD" }),
      quote(99, "2026-09-17", { pe: 8, peBasis: "Forward P/E" }),
      quote(99, "2027-01-01", { pe: 8 }),
    ];
    expect(
      evaluateRules(c, quotes, new Date("2026-09-18")).events,
    ).toHaveLength(0);
  });
  it("withholds potentially split-driven alerts and reports the discontinuity", async () => {
    const s = store();
    const c = companyWithRule();
    c.quote = quote(200, "2026-09-15");
    c.lastQuoteCheck = "2026-09-15T22:00:00Z";
    const doc = await s.put("company", c.id, c, 0);
    await saveQuoteObservations(
      s,
      doc,
      [quote(50, "2026-09-16")],
      new Date("2026-09-18"),
    );
    const events = await s.list<any>("event");
    expect(events.some((e) => e.data.kind === "price")).toBe(false);
    expect(events.some((e) => e.data.kind === "health")).toBe(true);
  });
});
describe("durable data and API", () => {
  it("restores a daily research snapshot with schema defaults and preserves an existing newer note", async () => {
    const source = store();
    const c = newCompany("Snapshot Company");
    c.notes = "Research to preserve";
    await source.put("company", c.id, c, 0);
    await dailySnapshot(source, new Date("2026-09-18T13:00:00Z"));
    const snapshot = (await source.get<any>("backup", "2026-09-18"))!.data;
    expect(snapshot.records[0].data.quoteHistory).toBeUndefined();
    const target = store();
    const app = createApi(target, {}, "local");
    const request = () =>
      app.request("/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
    expect((await request()).status).toBe(200);
    const restored = (await target.get<any>("company", c.id))!;
    expect(restored.data.quoteHistory).toEqual([]);
    expect(restored.data.notes).toBe(c.notes);
    await target.put(
      "company",
      c.id,
      { ...restored.data, notes: "Newer work" },
      restored.version,
    );
    await request();
    expect((await target.get<any>("company", c.id))!.data.notes).toBe(
      "Newer work",
    );
  });
  it("rejects stale writes without losing the latest note", async () => {
    const s = store();
    const c = newCompany("Example");
    const first = await s.put("company", c.id, c, 0);
    await s.put("company", c.id, { ...c, notes: "New note" }, first.version);
    await expect(
      s.put("company", c.id, { ...c, notes: "Stale note" }, first.version),
    ).rejects.toThrow("changed");
    expect((await s.get<any>("company", c.id))!.data.notes).toBe("New note");
  });
  it("enforces leases and an atomic monthly AI spending ceiling", async () => {
    const s = store();
    const lease = await s.claim("job", 5);
    expect(lease).toBeTruthy();
    expect(await s.claim("job", 5)).toBeNull();
    await s.release("job", "wrong");
    expect(await s.claim("job", 5)).toBeNull();
    await s.release("job", lease!);
    expect(await s.claim("job", 5)).toBeTruthy();
    await s.reserve(0.75, 1);
    await expect(s.reserve(0.3, 1)).rejects.toThrow("budget");
  });
  it("creates, versions, exports and restores company notes without overwriting", async () => {
    const s = store();
    const app = createApi(s, {}, "local");
    const request = (path: string, body: any, method = "POST") =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const created = await (
      await request("/companies", { name: "Progressive", status: "perpetual" })
    ).json();
    expect(created.version).toBe(1);
    const saved = await request(
      `/companies/${created.id}`,
      {
        version: 1,
        data: { ...created.data, notes: "Watch autonomous vehicles" },
      },
      "PUT",
    );
    expect(saved.status).toBe(200);
    expect(
      (
        await request(
          `/companies/${created.id}`,
          { version: 1, data: created.data },
          "PUT",
        )
      ).status,
    ).toBe(409);
    const backup = await (await app.request("/export")).json();
    expect(backup.records.some((r: any) => r.kind === "revision")).toBe(true);
    const target = store();
    const second = createApi(target, {}, "local");
    const response = await second.request("/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(backup),
    });
    expect(response.status).toBe(200);
    expect(
      (await target.get<any>("company", created.id))!.data.notes,
    ).toContain("autonomous");
  });
  it("keeps the whole import source and blocks duplicate import", async () => {
    const source =
      "Preface\n## Perpetual Watchlist\n- Progressive\n  - Autonomous vehicle risk\n\n## Pass\n- Example Company\n  - Too cyclical\n";
    const preview = parseInvestmentMarkdown(source);
    expect(preview.source).toBe(source);
    expect(preview.candidates).toHaveLength(2);
    expect(preview.candidates[0].status).toBe("perpetual");
    expect(preview.candidates[0].notes).toContain("Autonomous");
    const s = store();
    const app = createApi(s, {}, "local");
    const body = JSON.stringify({
      source,
      selections: preview.candidates.map(({ id, name, status }) => ({
        id,
        name,
        status,
      })),
    });
    const response = await app.request("/import/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
    expect((await s.list<any>("import"))[0].data.source).toBe(source);
    expect(
      (
        await app.request("/import/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      ).status,
    ).toBe(400);
  });
  it("merges a note edit over a background quote update but rejects two conflicting note edits", async () => {
    const s = store();
    const c = newCompany("Example");
    await s.put("company", c.id, c, 0);
    await s.put("company", c.id, { ...c, quote: quote(123, "2026-09-17") }, 1);
    const app = createApi(s, {}, "local");
    const request = (notes: string) =>
      app.request(`/companies/${c.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, base: c, data: { ...c, notes } }),
      });
    const response = await request("My new thesis");
    expect(response.status).toBe(200);
    expect((await response.json()).data.quote.price).toBe(123);
    expect((await request("Conflicting tab edit")).status).toBe(409);
  });
  it("keeps narrative bullets attached to their company and flags duplicate companies", () => {
    const result = parseInvestmentMarkdown(
      "## Pass\n- React Group PL\n- 10m GBP market cap\n- Cleaning and decontamination services\n- Fouynded in 2015\n- Financisl\n  - Margins improved\n- React Group PL\n",
    );
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].notes).toContain("Margins improved");
    expect(result.candidates.every((c) => c.review)).toBe(true);
  });
});
describe("news and model boundaries", () => {
  it("rejects unexpected feed hosts and non-HTTPS/private URLs", () => {
    const env = { ALLOWED_FEED_HOSTS: "investors.example.com" };
    expect(
      validateFeedUrl("https://investors.example.com/news.xml", env),
    ).toContain("news.xml");
    for (const url of [
      "http://investors.example.com/a",
      "https://evil.test/a",
      "https://127.0.0.1/a",
      "https://user@investors.example.com/a",
    ])
      expect(() => validateFeedUrl(url, env)).toThrow();
  });
  it("parses dated RSS and Atom and rejects entity declarations", async () => {
    const rss = await parseFeed(
      "<rss><channel><item><title>Guidance cut</title><link>https://example.com/a</link><description>Profit down 20%.</description><pubDate>Thu, 17 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>",
      "https://example.com/feed",
      true,
    );
    expect(rss[0].text).toBe("Profit down 20%.");
    expect(rss[0].publishedAt).toBe("2026-09-17T12:00:00.000Z");
    const atom = await parseFeed(
      '<feed><entry><title>Update</title><link href="https://example.com/b"/><updated>2026-09-17T12:00:00Z</updated><summary>Trading update</summary></entry></feed>',
      "feed",
      false,
    );
    expect(atom[0].url).toBe("https://example.com/b");
    await expect(parseFeed("<!DOCTYPE x><rss/>", "", false)).rejects.toThrow();
  });
  it("validates typed model answers and stores selected evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "jev-1.13.0",
              answers: {
                identity: { type: "noul", noul: 0.95 },
                major: { type: "noul", noul: 0.98 },
                event: { type: "choice", choice: "earnings" },
                evidence: { type: "choice", choice: "s0" },
              },
              usage: { input_tokens: 400 },
            }),
          ),
      ),
    );
    const s = store();
    const judgment = await classifyArticle(
      newCompany("Example"),
      {
        id: "a",
        title: "Example cuts guidance",
        text: "Profits expected to fall.",
        url: "",
        publishedAt: "",
        source: "Test",
        official: true,
      },
      { TYPESAFE_API_KEY: "synthetic-test-key" },
      s,
    );
    expect(judgment.evidence).toContain("guidance");
    expect((s.usage()[0] as any).cost).toBeCloseTo(0.0000168);
  });
  it("keeps failures visible and is idempotent across retries", async () => {
    const s = store();
    const c = newCompany("Example");
    const article = {
      id: "article1",
      title: "Major legal development",
      text: "New lawsuit.",
      url: "",
      publishedAt: "",
      source: "Test",
      official: false,
    };
    const e = await processArticle(c, article, s, {});
    expect(e.priority).toBe("possible");
    expect(e.body).toContain("Unclassified");
    await processArticle(c, article, s, {});
    expect(await s.list("event")).toHaveLength(1);
  });
  it("does not send a digest without deliberate configuration and opt-in", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await sendDueDigest(
      store(),
      { RESEND_API_KEY: "test" },
      new Date("2026-09-18T15:00:00Z"),
    );
    expect(result.sent).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
