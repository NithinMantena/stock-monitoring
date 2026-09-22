import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { LocalStore } from "../server/store.ts";
import { createV1Api } from "../supabase/functions/_shared/api-v1.ts";
import { createApi } from "../supabase/functions/_shared/api.ts";
import { reviewFixture } from "../tests/review-fixtures.ts";

// Disposable, in-memory UI preview. Never uses local research, cloud data or paid APIs.
const store = new LocalStore(":memory:");
const fixture = reviewFixture();
if (process.argv.includes("--framework")) {
  const { decideFundamental } =
    await import("../supabase/functions/_shared/fundamental-policy.ts");
  const signals = {
    useful: 0.95,
    meaningful: 0.8,
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
    alignment: "aligned" as const,
    consistency: "coherent" as const,
    evidenceVerified: true,
    partial: false,
  };
  fixture.events = fixture.events.slice(0, 4).map((d, i) => {
    const a = {
      ...d.data.screening!,
      signals: {
        ...signals,
        ...(i === 2 ? { incremental: 0.01, recap: 0.98 } : {}),
        ...(i === 3 ? { missingContext: 0.8 } : {}),
      },
      primary: i === 0,
    };
    return {
      ...d,
      data: {
        ...d.data,
        companyId: fixture.companies[0].id,
        reviewed: false,
        saved: false,
        discoveredAt: new Date().toISOString(),
        clusterId: i < 2 ? "framework-primary" : d.id,
        title: [
          "Core quarterly results",
          "Reserve analysis explains margin change",
          "Wire recap of results",
          "Contract significance needs company context",
        ][i],
        evidence: [
          "Issuer reported revenue grew 12% with stable operating margins.",
          "Filed reserve tables attribute the margin change to prior-year development.",
          "The wire repeats the issuer's revenue and margin figures.",
          "The contract value is disclosed, but the company's operating scale is missing.",
        ][i],
        screening: { ...a, ...decideFundamental(a) },
      },
    };
  });
}

for (const c of fixture.companies) await store.put("company", c.id, c, 0);
for (const e of fixture.events) await store.put("event", e.id, e.data, 0);
const at = new Date().toISOString();
await store.put(
  "news_batch",
  "latest",
  {
    id: "review-batch",
    label: "Synthetic review preview",
    companyIds: fixture.companies.map((c) => c.id),
    createdAt: at,
    updatedAt: at,
    status: "paused",
    completedCompanies: 4,
    currentCompany: "Review Company 05",
    sourceIndex: 0,
    pendingArticles: [],
    checked: 250,
    added: 170,
    tokens: 50000,
    warningCount: 0,
    warnings: [],
    lookbackDays: 7,
    articleLimit: 10,
    dailySearch: true,
  },
  0,
);
const app = new Hono();
app.use("*", async (c, next) => {
  if (c.req.header("host") !== "127.0.0.1:8788")
    return c.json({ error: "Local preview only" }, 403);
  await next();
});
app.route("/api/v1", createV1Api(store, {}, "local"));
app.route("/api", createApi(store, {}, "local"));
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 8788 });
console.log("Synthetic UI review API: http://127.0.0.1:8788/api");
