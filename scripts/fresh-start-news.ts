// Removes every stored news article so screening starts fresh, after saving a
// full restorable backup. Companies, notes, settings, health alerts and digests
// are kept. Dry run by default; pass --apply to delete.
//   node scripts/fresh-start-news.ts [--apply]
import { mkdirSync, writeFileSync } from "node:fs";
import { cloudSession } from "./cloud-session.ts";

const apply = process.argv.includes("--apply");
const session = await cloudSession();
try {
  const count = async (kind: string, news = false) => {
    let q = session.admin
      .from("desk_records")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", session.owner)
      .eq("kind", kind);
    if (news) q = q.eq("data->>kind", "news");
    const { count, error } = await q;
    if (error) throw new Error(`Count failed: ${error.message}`);
    return count ?? 0;
  };
  const before = {
    newsArticles: await count("event", true),
    allEvents: await count("event"),
    articleCache: await count("article_cache"),
  };
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry run", before }));
  if (!apply) process.exit(0);
  // Full restorable backup first (the same format as Import & backup → restore).
  const backup = await session.call("/export");
  const news = backup.records.filter(
    (r: any) => r.kind === "event" && r.data?.kind === "news",
  ).length;
  if (news < before.newsArticles)
    throw new Error(
      `Backup holds ${news} of ${before.newsArticles} news articles; nothing deleted.`,
    );
  mkdirSync(".local", { recursive: true });
  const file = `.local/fresh-start-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(backup), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ backup: file, records: backup.records.length, newsArticles: news }));
  const remove = async (kind: string, extra?: (q: any) => any) => {
    let q = session.admin
      .from("desk_records")
      .delete()
      .eq("owner_id", session.owner)
      .eq("kind", kind);
    if (extra) q = extra(q);
    const { error } = await q;
    if (error) throw new Error(`Delete ${kind} failed: ${error.message}`);
  };
  await remove("event", (q) => q.eq("data->>kind", "news"));
  await remove("article_cache");
  await remove("run", (q) => q.eq("id", "rescreen-queue"));
  console.log(
    JSON.stringify({
      after: {
        newsArticles: await count("event", true),
        allEvents: await count("event"),
        articleCache: await count("article_cache"),
      },
    }),
  );
} finally {
  await session.close();
}
