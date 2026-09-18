import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseInvestmentMarkdown } from "../supabase/functions/_shared/importer.ts";
const path =
  process.argv[2] || "C:/Users/nithi/Downloads/Investment Pitch List.md";
const source = readFileSync(path, "utf8");
const preview = parseInvestmentMarkdown(source);
mkdirSync(".local", { recursive: true });
writeFileSync(".local/import-preview.json", JSON.stringify(preview, null, 2));
writeFileSync(
  ".local/import-review.md",
  `# Import review\n\nOriginal source preserved in import-preview.json. No companies imported by this script.\n\n${preview.candidates.map((c) => `- ${c.review ? "[ ] REVIEW" : "[x]"} ${c.name} — ${c.status} — lines ${c.start}–${c.end}`).join("\n")}`,
);
console.log(
  JSON.stringify({
    lines: preview.lineCount,
    candidates: preview.candidates.length,
    needsReview: preview.candidates.filter((x) => x.review).length,
    report: ".local/import-review.md",
  }),
);
