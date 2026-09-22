import { assessment, modelResponse } from "./screening-fixtures.ts";
import { describe, expect, it, vi, afterEach } from "vitest";
import { LocalStore } from "../server/store.ts";
import {
  newCompany,
  type DeskEvent,
} from "../supabase/functions/_shared/model.ts";
import {
  companyNewsUrl,
  cleanNewsText,
  newsBucket,
  newsPriority,
} from "../supabase/functions/_shared/news.ts";
import { createApi } from "../supabase/functions/_shared/api.ts";
import {
  processArticle,
  digestPreview,
} from "../supabase/functions/_shared/jobs.ts";
import {
  consolidatedCandidates,
  markdownExport,
} from "../supabase/functions/_shared/importer.ts";

const stores: LocalStore[] = [];
function store() {
  const s = new LocalStore(":memory:");
  stores.push(s);
  return s;
}
afterEach(() => {
  stores.forEach((s) => s.db.close());
  stores.length = 0;
  vi.unstubAllGlobals();
});
function event(identity: number, extra: Partial<DeskEvent> = {}): DeskEvent {
  return {
    id: crypto.randomUUID(),
    companyId: "pgr",
    title: "Example",
    kind: "news",
    priority: "possible",
    body: "",
    url: "",
    publishedAt: "2026-09-18T01:00:00Z",
    discoveredAt: "2026-09-18T01:00:00Z",
    reviewed: false,
    classification: { identity },
    screening: assessment({
      identity,
      disposition:
        identity < 0.3
          ? "suppressed"
          : identity < 0.8
            ? "uncertain"
            : "relevant",
    }),
    ...extra,
  };
}
describe("company news regressions", () => {
  it("decodes escaped RSS markup without leaving URLs or executable HTML in article text", () => {
    expect(
      cleanNewsText(
        "&lt;a href=&quot;https://example.com/long-token&quot;&gt;Progressive earnings&lt;/a&gt; &amp;amp; growth &#39;26",
      ),
    ).toBe("Progressive earnings & growth '26");
    expect(cleanNewsText("&lt;script&gt;alert(1)&lt;/script&gt;Safe")).toBe(
      "Safe",
    );
    expect(() => cleanNewsText("&#99999999;")).not.toThrow();
  });
  it("hides actual low-identity Progressive false positives and recovers company stories previously suppressed as routine", () => {
    expect(newsBucket(event(0.18))).toBe("suppressed");
    expect(newsBucket(event(0.49))).toBe("uncertain");
    expect(newsBucket(event(0.86, { priority: "suppressed" }))).toBe(
      "relevant",
    );
    expect(
      newsBucket(
        event(0.99, {
          screening: undefined,
          classification: { error: "Timeout" },
        }),
      ),
    ).toBe("uncertain");
  });
  it("does not let a watch-point match rescue a different company", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              modelResponse({
                identity: { type: "noul", noul: 0.12 },
                relevance0: { type: "noul", noul: 0.9 },
                direction0: {
                  type: "choice",
                  choice: "concern",
                  probabilities: {
                    concern: 1,
                    reassuring: 0,
                    mixed: 0,
                    unrelated: 0,
                  },
                },
              }),
            ),
          ),
      ),
    );
    const c = newCompany("Progressive");
    c.watchPoints = [{ id: "w", text: "Margin deterioration", enabled: true }];
    const result = await processArticle(
      c,
      {
        id: "article",
        title: "Different insurer cuts guidance",
        text: "Margins down",
        contentDepth: "supplied",
        url: "",
        source: "Test",
        publishedAt: "",
        official: false,
      },
      store(),
      { TYPESAFE_API_KEY: "test" },
    );
    expect(result.priority).toBe("suppressed");
    expect(newsBucket(result)).toBe("suppressed");
    expect(
      newsPriority({ identity: 0.9, major: 0.05, evidence: "", matches: [] }),
    ).toBe("normal");
  });
  it("uses business context for ambiguous names and honors a custom query", () => {
    const c = newCompany("Progressive");
    const query = new URL(companyNewsUrl(c)).searchParams.get("q");
    expect(query).toContain("insurance");
    expect(query).toContain("PGR");
    expect(
      new URL(
        companyNewsUrl({ ...c, newsQuery: '"Progressive Corporation"' }),
      ).searchParams.get("q"),
    ).toBe('"Progressive Corporation" when:10d');
  });
  it("respects manual feedback in the feed and digest", async () => {
    expect(newsBucket(event(0.99, { feedback: "noise" }))).toBe("suppressed");
    expect(newsBucket(event(0.1, { feedback: "useful" }))).toBe("relevant");
    const s = store();
    for (const e of [
      event(0.12, { title: "Politics" }),
      event(0.9, { title: "Actual company story", priority: "suppressed" }),
      event(0.95, { title: "Dismissed", feedback: "noise" }),
    ])
      await s.put("event", e.id, e, 0);
    const digest = await digestPreview(s, new Date("2026-09-18T04:00:00Z"));
    expect(digest.text).toContain("Actual company story");
    expect(digest.text).not.toContain("Politics");
    expect(digest.text).not.toContain("Dismissed");
  });
  it("saves and reverses feedback without changing company notes, and rejects a conflicting write", async () => {
    const s = store(),
      api = createApi(s, {}, "local"),
      e = event(0.9);
    await s.put("event", e.id, e, 0);
    const put = (body: unknown) =>
      api.request(`/events/${e.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (await put({ version: 1, reviewed: true, feedback: "noise" })).status,
    ).toBe(200);
    expect(
      (await put({ version: 1, reviewed: true, feedback: "useful" })).status,
    ).toBe(409);
    expect(
      (await put({ version: 2, reviewed: false, feedback: null })).status,
    ).toBe(200);
    expect(
      (await s.get<DeskEvent>("event", e.id))!.data.feedback,
    ).toBeUndefined();
  });
  it("loads a company's full history independently from the global recent-event limit", async () => {
    const s = store(),
      api = createApi(s, {}, "local");
    const a = event(0.9),
      b = event(0.9, { companyId: "another" });
    await s.put("event", a.id, { ...a, rawText: "large source text" }, 0);
    await s.put("event", b.id, b, 0);
    const result = await (await api.request("/events?companyId=pgr")).json();
    expect(result.map((d: any) => d.id)).toEqual([a.id]);
    expect(result[0].data.rawText).toBeUndefined();
  });
});
describe("research import and sourcing", () => {
  it("does not offer a completed prepared import twice or duplicate its source", async () => {
    const s = store(),
      api = createApi(s, {}, "local");
    const source = "## Inbox\n- Progressive\n";
    const { hash } = await import("../supabase/functions/_shared/engine.ts");
    const fingerprint = await hash(source);
    await s.put(
      "import",
      "prepared",
      { source, importedBatch: "seed", complete: true },
      0,
    );
    await s.put(
      "import",
      "seed",
      { source, fingerprint, count: 1, complete: true },
      0,
    );
    const bootstrap = await (await api.request("/bootstrap")).json();
    expect(bootstrap.imports.map((d: any) => d.id)).toEqual(["seed"]);
    const result = await api.request("/import/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        selections: [{ id: "line-2", name: "Progressive", status: "inbox" }],
      }),
    });
    expect(result.status).toBe(400);
    expect((await result.json()).error).toContain("already imported");
  });
  it("consolidates duplicates while retaining every original note and the researched status", () => {
    const items = consolidatedCandidates(
      "## Inbox\n- Deckers\n  - First look\n## Pass\n- Deckers\n  - Expensive\n- React Group PL\n- 10m GBP market cap\n- Cleaning and decontamination services\n",
    );
    expect(items).toHaveLength(2);
    expect(items[0].status).toBe("pass");
    expect(items[0].notes).toContain("First look");
    expect(items[0].notes).toContain("Expensive");
    expect(items[1].notes).toContain("10m GBP");
  });
  it("creates, updates and exports idea source separately from import provenance", async () => {
    const s = store(),
      api = createApi(s, {}, "local");
    const created = await (
      await api.request("/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Progressive",
          status: "inbox",
          ideaSource: "Insurance newsletter",
        }),
      })
    ).json();
    expect(created.data.ideaSource).toBe("Insurance newsletter");
    const saved = await (
      await api.request(`/companies/${created.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: created.version,
          data: {
            ...created.data,
            source: "Original.md",
            ideaSource: "A podcast",
            newsQuery: '"Progressive Corporation"',
          },
        }),
      })
    ).json();
    expect(saved.data.ideaSource).toBe("A podcast");
    expect(saved.data.source).toBe("Original.md");
    expect(saved.data.feeds[0].url).toContain("Progressive+Corporation");
    expect(markdownExport(saved.data)).toContain('ideaSource: "A podcast"');
  });
});
