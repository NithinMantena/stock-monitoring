import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { reviewFixture } from "../tests/review-fixtures.ts";
import {
  groupNews,
  screeningRank,
  type NewsGroup,
} from "../supabase/functions/_shared/screening-policy.ts";
import type { DeskEvent, Doc } from "../supabase/functions/_shared/model.ts";

// Retain the pre-review algorithm solely as a reproducible equivalence/performance baseline.
function baseline(docs: Doc<DeskEvent>[]): NewsGroup[] {
  const grouped = new Map<string, Doc<DeskEvent>[]>();
  for (const doc of docs) {
    const key =
      doc.data.kind === "news"
        ? `${doc.data.companyId}:${doc.data.clusterId || doc.id}`
        : doc.id;
    grouped.set(key, [...(grouped.get(key) || []), doc]);
  }
  return [...grouped.values()]
    .map((items) => {
      items.sort(
        (a, b) =>
          screeningRank(b.data) - screeningRank(a.data) ||
          a.data.discoveredAt.localeCompare(b.data.discoveredAt),
      );
      return { lead: items[0], coverage: items.slice(1) };
    })
    .sort((a, b) => {
      const latest = (g: NewsGroup) =>
        [g.lead, ...g.coverage].reduce(
          (at, d) => (d.data.discoveredAt > at ? d.data.discoveredAt : at),
          "",
        );
      return latest(b).localeCompare(latest(a));
    });
}
const { events } = reviewFixture(12000);
const resultIds = (groups: NewsGroup[]) =>
  groups.map((g) => [g.lead.id, ...g.coverage.map((d) => d.id)]);
assert.deepEqual(resultIds(groupNews(events)), resultIds(baseline(events)));
function measure(fn: typeof groupNews) {
  fn(events);
  const times = Array.from({ length: 21 }, () => {
    const start = performance.now();
    fn(events);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return { medianMs: times[10], p95Ms: times[19] };
}
const before = measure(baseline),
  after = measure(groupNews);
const result = {
  at: new Date().toISOString(),
  scope:
    "In-process grouping of 12,000 synthetic articles, 21 warm samples; not end-to-end network latency",
  articles: events.length,
  groups: groupNews(events).length,
  identicalLeadCoverageAndOrder: true,
  before,
  after,
  medianSpeedup: before.medianMs / after.medianMs,
};
writeFileSync(
  "validation/code-review-performance.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
