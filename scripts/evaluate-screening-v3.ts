// Small live evaluation of screening v3 (headline-first) on real labelled articles
// from research/typesafe-screening-2-2026-09-22. Runs the production
// processArticle() flow with real TypeSafe calls and an in-memory store; never
// touches the hosted database or Google (noFetch). Companies are used exactly as
// they are today: bare names, no context.
//   node scripts/evaluate-screening-v3.ts
import { readFileSync, writeFileSync } from "node:fs";
import { LocalStore } from "../server/store.ts";
import { newCompany, type DeskEvent } from "../supabase/functions/_shared/model.ts";
import { processArticle } from "../supabase/functions/_shared/jobs.ts";
import { newsBucket } from "../supabase/functions/_shared/news.ts";
import { groupNews } from "../supabase/functions/_shared/screening-policy.ts";

if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY missing");
const R = "research/typesafe-screening-2-2026-09-22";
const sets = [
  { name: "dev", corpus: JSON.parse(readFileSync(`${R}/real-corpus-raw.json`, "utf8")), labels: JSON.parse(readFileSync(`${R}/LABELS.json`, "utf8")).labels, v2: JSON.parse(readFileSync(`${R}/runs/B.json`, "utf8")).results },
  { name: "holdout", corpus: JSON.parse(readFileSync(`${R}/holdout-corpus.json`, "utf8")), labels: JSON.parse(readFileSync(`${R}/HOLDOUT-LABELS.json`, "utf8")).labels, v2: JSON.parse(readFileSync(`${R}/runs/B-holdout-corpus.json`, "utf8")).results },
];
// Sample: every useful article, then evenly spaced noise and ambiguous articles.
const sample: any[] = [];
for (const s of sets) {
  const rows = s.labels.map((l: any) => ({ set: s.name, label: l, x: s.corpus[l.index], v2: s.v2[l.index]?.route }));
  const pick = (dev: string, n: number) => {
    const all = rows.filter((r: any) => r.label.dev === dev);
    return all.filter((_: any, i: number) => i % Math.max(1, Math.floor(all.length / n)) === 0).slice(0, n);
  };
  sample.push(...rows.filter((r: any) => r.label.dev === "U"), ...pick("N", s.name === "dev" ? 20 : 15), ...pick("A", s.name === "dev" ? 9 : 6));
}
const env = process.env as any;
const bucketRoute = (e: DeskEvent) => ({ relevant: "R", coverage: "C", uncertain: "V", suppressed: "S", all: "?" })[newsBucket(e)];

// headline: nothing is read (worst case). googleRefused: Google refuses every
// lookup, so only direct links (company/SEC documents) are read, as in production.
// text: every article body was available.
async function run(mode: "headline" | "googleRefused" | "text") {
  const store = new LocalStore(":memory:");
  const out: any[] = [];
  const byCompany = new Map<string, any[]>();
  for (const r of sample) byCompany.set(`${r.set}:${r.x.companyId}`, [...(byCompany.get(`${r.set}:${r.x.companyId}`) || []), r]);
  let next = 0;
  const groups = [...byCompany.values()];
  // Companies in parallel; each company's articles in publication order so
  // later reports can join earlier developments, as in a real run.
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < groups.length) {
      const items = groups[next++].sort((a: any, b: any) => (a.x.publishedAt || "").localeCompare(b.x.publishedAt || ""));
      const c: any = { ...newCompany(items[0].x.company.name), id: `${items[0].set}-${items[0].x.companyId}`, ticker: items[0].x.company.ticker || "" };
      for (const r of items) {
        const x = r.x;
        const withText = mode === "text" || (mode === "googleRefused" && !!x.official);
        const started = performance.now();
        const e = await processArticle(c, {
          id: `${r.set}-${r.label.index}`, title: x.title, url: x.url, source: x.host,
          text: withText ? x.text : x.title, publishedAt: x.publishedAt || "", official: !!x.official,
          contentDepth: withText ? x.contentDepth : "snippet",
        }, store, env, { noFetch: true });
        out.push({ set: r.set, index: r.label.index, dev: r.label.dev, cluster: r.label.cluster, ok: r.label.ok, title: x.title, v2: r.v2, route: bucketRoute(e), role: e.screening?.articleRole, reason: e.screening?.reasonCode, clusterId: e.clusterId || e.id, id: e.id, tokens: Number(e.classification?.tokens || 0), ms: Math.round(performance.now() - started), error: e.classification?.error });
      }
    }
  }));
  const events = (await store.list<DeskEvent>("event")).filter((d) => d.data.kind === "news");
  const relevantCards = groupNews(events.filter((d) => newsBucket(d.data) === "relevant"));
  store.db.close();
  return { out, relevantCards: relevantCards.length, relevantArticles: events.filter((d) => newsBucket(d.data) === "relevant").length, cards: relevantCards.map((g) => ({ lead: g.lead.data.title.slice(0, 80), coverage: g.coverage.length })) };
}

function summarise(res: Awaited<ReturnType<typeof run>>) {
  const o = res.out;
  const count = (f: (r: any) => boolean) => o.filter(f).length;
  const routes = (dev: string) => Object.fromEntries(["R", "C", "V", "S"].map((k) => [k, count((r) => r.dev === dev && r.route === k)]));
  const clusters = [...new Set(o.filter((r) => r.dev === "U").map((r) => `${r.set}:${r.cluster}`))];
  const members = (c: string) => o.filter((r) => r.dev === "U" && `${r.set}:${r.cluster}` === c);
  const reasons = (route: string) => o.filter((r) => r.route === route).reduce((m: any, r) => ((m[r.reason] = (m[r.reason] || 0) + 1), m), {});
  return {
    articles: o.length,
    errors: count((r) => !!r.error),
    routes: { useful: routes("U"), ambiguous: routes("A"), noise: routes("N") },
    developments: {
      total: clusters.length,
      surfaced: clusters.filter((c) => members(c).some((r) => ["R", "C"].includes(r.route))).length,
      verifyOnly: clusters.filter((c) => !members(c).some((r) => ["R", "C"].includes(r.route)) && members(c).some((r) => r.route === "V")).length,
      lost: clusters.filter((c) => members(c).every((r) => r.route === "S")).map((c) => c),
      cardsPerSurfacedDevelopment: clusters.filter((c) => members(c).some((r) => r.route === "R")).map((c) => `${c}:${new Set(members(c).filter((r) => r.route === "R").map((r) => r.clusterId)).size}`),
    },
    usefulArticlesScreenedOut: o.filter((r) => r.dev === "U" && r.route === "S" && !r.ok.includes("S")).map((r) => `${r.set}#${r.index} ${r.reason} :: ${r.title.slice(0, 70)}`),
    noiseInInbox: o.filter((r) => r.dev === "N" && r.route === "R").map((r) => `${r.set}#${r.index} ${r.reason} :: ${r.title.slice(0, 70)}`),
    verify: { total: count((r) => r.route === "V"), reasons: reasons("V") },
    screenedOutReasons: reasons("S"),
    relevantArticles: res.relevantArticles,
    relevantCards: res.relevantCards,
    tokens: o.reduce((n, r) => n + r.tokens, 0),
    medianMs: o.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(o.length / 2)],
  };
}

const headline = await run("headline");
const refused = await run("googleRefused");
const text = await run("text");
const key = (r: any) => `${r.set}#${r.index}`;
const textRoute = new Map(text.out.map((r: any) => [key(r), r.route]));
const agreement = headline.out.filter((r: any) => textRoute.get(key(r)) === r.route).length;
const changes = headline.out.filter((r: any) => textRoute.get(key(r)) !== r.route).map((r: any) => `${key(r)} ${r.dev} ${r.route}->${textRoute.get(key(r))} :: ${r.title.slice(0, 60)}`);
const v2 = { routes: Object.fromEntries(["U", "A", "N"].map((d) => [d, Object.fromEntries(["R", "C", "V", "S"].map((k) => [k, headline.out.filter((r: any) => r.dev === d && r.v2 === k).length]))])), verify: headline.out.filter((r: any) => r.v2 === "V").length };
const report = {
  at: new Date().toISOString(),
  scope: "Small live evaluation: 90 real articles (all 40 labelled useful, 35 noise, 15 ambiguous) from the research corpora; companies as they are today (no context, no tickers). Labels are provisional research labels, not the owner's.",
  model: "jev-1.13.0",
  v2ProductionOnSameArticlesWithText: v2,
  headlineOnly: summarise(headline),
  googleRefusesEveryLookup: summarise(refused),
  withText: summarise(text),
  headlineVsTextRouteAgreement: `${agreement}/${headline.out.length}`,
  routeChangesWhenTextIsRead: changes,
  headlineOnlyCards: headline.cards,
  rows: { headline: headline.out, googleRefused: refused.out, text: text.out },
};
writeFileSync("validation/screening-v3-live.json", JSON.stringify(report, null, 1));
const { rows, headlineOnlyCards, ...brief } = report;
console.log(JSON.stringify(brief, null, 1));
