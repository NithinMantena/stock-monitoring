import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { LocalStore } from "../server/store.ts";
import { parseInvestmentMarkdown } from "../supabase/functions/_shared/importer.ts";
const source = readFileSync(
  "C:/Users/nithi/Downloads/Investment Pitch List.md",
  "utf8",
);
const preview = parseInvestmentMarkdown(source);
const value = {
  source,
  draft: true,
  count: preview.candidates.length,
  at: new Date().toISOString(),
};
if (process.argv.includes("--cloud")) {
  const keys = JSON.parse(
    readFileSync(".local/supabase-keys.json", "utf8").replace(/^\uFEFF/, ""),
  );
  const setup = JSON.parse(readFileSync(".local/cloud-setup.json", "utf8"));
  const db = createClient(
    setup.url,
    keys.find((k: any) => k.name === "service_role").api_key,
    { auth: { persistSession: false } },
  );
  const { error } = await db
    .from("desk_records")
    .upsert({
      owner_id: setup.owner,
      kind: "import",
      id: "prepared-investment-pitch-list",
      data: value,
      version: 1,
    });
  if (error) throw new Error("Could not stage import in private project.");
} else {
  const s = new LocalStore();
  const old = await s.get("import", "prepared-investment-pitch-list");
  await s.put(
    "import",
    "prepared-investment-pitch-list",
    value,
    old?.version || 0,
  );
  s.db.close();
}
console.log(
  JSON.stringify({
    staged: true,
    candidates: preview.candidates.length,
    review: preview.candidates.filter((c) => c.review).length,
    cloud: process.argv.includes("--cloud"),
    imported: false,
  }),
);
