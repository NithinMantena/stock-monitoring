import { mkdirSync, writeFileSync } from "node:fs";
import { LocalStore } from "../server/store.ts";
const store = new LocalStore();
const records = (
  await Promise.all(
    ["company", "event", "revision", "settings", "import"].map((k) =>
      store.list(k),
    ),
  )
).flat();
mkdirSync(".local/backups", { recursive: true });
const path = `.local/backups/research-desk-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(
  path,
  JSON.stringify(
    {
      format: "research-desk",
      version: 1,
      exportedAt: new Date().toISOString(),
      records,
    },
    null,
    2,
  ),
);
store.db.close();
console.log(`Backup saved: ${path} (${records.length} records)`);
