import {
  newCompany,
  type DeskEvent,
  type Doc,
} from "../supabase/functions/_shared/model.ts";
import { assessment } from "./screening-fixtures.ts";

export function reviewFixture(count = 4000) {
  const companies = Array.from({ length: 30 }, (_, i) => {
    const c = newCompany(
      `Review Company ${String(i + 1).padStart(2, "0")}`,
      i % 3 ? "watchlist" : "owned",
    );
    c.id = `review-company-${i}`;
    c.notes =
      "# Synthetic review notes\n\nRevenue, margins, and competitive position.\n".repeat(
        30,
      );
    c.ticker = `REV${i}`;
    c.feeds = [];
    return c;
  });
  const events: Doc<DeskEvent>[] = Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.now() - (i % 45) * 86400000).toISOString();
    const data: DeskEvent = {
      id: `review-event-${i}`,
      companyId: companies[i % companies.length].id,
      title: `Review Company ${(i % companies.length) + 1} reports Q${(i % 4) + 1} financial results · source ${i}`,
      kind: "news",
      priority: i % 4 === 0 ? "major" : "normal",
      body: "Revenue grew 12% as operating margins improved. This is synthetic data for interface verification.",
      rawText:
        "Synthetic article text. Revenue grew 12% as operating margins improved.",
      url: "https://example.com/results",
      publishedAt: at,
      discoveredAt: at,
      reviewed: i % 13 === 0,
      saved: i % 19 === 0,
      clusterId: `group-${i % 600}`,
      classification: { source: `Publisher ${i % 8}`, tokens: 0 },
      screening: assessment({
        primary: i % 7 === 0,
        quality: 1 + (i % 3),
        addedValue: i % 3,
        materiality: 2 + (i % 3) / 2,
        contentDepth: "supplied",
      }),
    };
    return { id: data.id, kind: "event", data, version: 1, updatedAt: at };
  });
  return { companies, events };
}
