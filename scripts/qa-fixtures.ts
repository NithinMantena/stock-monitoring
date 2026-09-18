import { LocalStore } from "../server/store.ts";
import { newCompany } from "../supabase/functions/_shared/model.ts";
const s = new LocalStore();
if (process.argv.includes("--clean")) {
  const ids = new Set(
    (await s.list<any>("company"))
      .filter(
        (d) =>
          d.id.startsWith("qa-fixture-") ||
          d.data.name === "QA Example Company",
      )
      .map((d) => d.id),
  );
  for (const kind of ["company", "event", "revision", "attempt"])
    for (const doc of await s.list<any>(kind))
      if (ids.has(doc.id) || ids.has(doc.data.companyId))
        await s.remove(kind, doc.id, doc.version);
  console.log(`Removed ${ids.size} temporary local QA companies.`);
} else {
  for (let i = 0; i < 500; i++) {
    const c = newCompany(
      `QA Research Company ${String(i + 1).padStart(3, "0")}`,
      i % 10 === 0 ? "owned" : i % 7 === 0 ? "perpetual" : "watchlist",
    );
    c.id = `qa-fixture-${i}`;
    c.notes =
      `# Synthetic research fixture\n\nCompany number ${i + 1}.\n\n` +
      "Notes about margins, competitive position and capital allocation. ".repeat(
        30,
      );
    c.thesis = "Synthetic data for performance verification.";
    const old = await s.get("company", c.id);
    await s.put("company", c.id, c, old?.version || 0);
  }
  console.log(
    "500 clearly labelled local QA companies prepared. No market requests or news calls made.",
  );
}
s.db.close();
