import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { LocalStore } from "../server/store.ts";
import { newCompany } from "../supabase/functions/_shared/model.ts";
import { screenArticle } from "../supabase/functions/_shared/news-screening.ts";
const cases = JSON.parse(readFileSync("tests/fixtures/fundamental-v2-cases.json", "utf8"));
mkdirSync(".local", { recursive: true });
if (!process.env.TYPESAFE_API_KEY) throw Error("Missing TypeSafe credential");
const s = new LocalStore(":memory:");
const originalFetch = globalThis.fetch;
const rawResponses: unknown[] = [];
globalThis.fetch = async (...args) => {
  const r = await originalFetch(...args);
  if (String(args[0]).includes("api.typesafe.ai"))
    rawResponses.push(await r.clone().json());
  return r;
};
const results: any[] = [];
try {
  for (const item of cases) {
    try {
      const c = {
        ...newCompany(item.company.name),
        ticker: item.company.ticker || "",
        businessScale: item.company.scale,
        businessContext: item.company.context,
        contextAsOf: "2026-09-22",
        contextSource: "Synthetic evaluation fixture",
      };
      const started = performance.now();
      const result = await screenArticle(
        c,
        {
          id: item.id,
          title: item.title,
          text: item.text,
          url: "",
          source: "Synthetic fixture",
          publishedAt: item.publishedAt,
          official: item.primary,
          contentDepth: item.depth,
          ...(item.reference
            ? {
                primaryReference: {
                  id: "reference",
                  url: "",
                  title: item.title,
                  text: item.reference,
                  publishedAt: item.publishedAt,
                },
              }
            : {}),
        },
        process.env,
        s,
        [],
        item.now,
      );
      const actual =
        result.screening.disposition === "relevant"
          ? "read"
          : result.screening.disposition === "uncertain"
            ? "verify"
            : "skip";
      const row = {
        id: item.id,
        expected: item.label,
        actual,
        correct: actual === item.label,
        role: result.screening.articleRole,
        reason: result.screening.reasonCode,
        ms: Math.round(performance.now() - started),
        tokens: result.tokens,
        signals: result.screening.signals,
      };
      results.push(row);
      console.log(
        JSON.stringify({
          id: row.id,
          expected: row.expected,
          actual,
          reason: row.reason,
        }),
      );
    } catch (error) {
      results.push({
        id: item.id,
        expected: item.label,
        actual: "error",
        error: String(error),
        tokens: 0,
      });
    }
  }
  const report = {
    at: new Date().toISOString(),
    model: "jev-1.13.0",
    note: "Integration regression on 24 previously evaluated synthetic examples; not fresh holdout accuracy or user labels.",
    cases: results.length,
    correct: results.filter((x) => x.correct).length,
    tokens: results.reduce((n, r) => n + r.tokens, 0),
    results,
  };
  writeFileSync(
    "validation/fundamental-v2-live.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      cases: report.cases,
      correct: report.correct,
      tokens: report.tokens,
      estimatedInputCostUSD: (report.tokens * 0.042) / 1e6,
    }),
  );
} finally {
  writeFileSync(".local/v2-raw.json", JSON.stringify(rawResponses, null, 2));
  s.db.close();
}
