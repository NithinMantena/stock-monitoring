// Brings the hosted desk in line with the Investment Pitch List (Markdown
// export of the Google Doc): each company's notes become its doc entry, its
// doc section becomes its journal section and the doc order its journal order.
//
//   node scripts/sync-pitch-list.ts "<path to Investment Pitch List.md>"          dry run
//   node scripts/sync-pitch-list.ts "<path to Investment Pitch List.md>" --apply  write
//
// --keep "<company name>" (repeatable) leaves that company in its current list;
// its notes and position still follow the doc.
//
// The dry run writes .local/pitch-list-sync-report.json. --apply first saves an
// essential export to .local/, keeps each replaced note in Note history, and
// writes companies in atomic batches that refuse records changed since the read.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cloudSession } from "./cloud-session.ts";
import { SupabaseStore } from "../supabase/functions/_shared/supabase-store.ts";
import {
  parsePitchList,
  planPitchListSync,
} from "../supabase/functions/_shared/pitch-list.ts";
import {
  CompanySchema,
  type Company,
  type Doc,
} from "../supabase/functions/_shared/model.ts";
import {
  companyNewsUrl,
  isDefaultNewsFeed,
} from "../supabase/functions/_shared/news.ts";
import { normalizeSize } from "../supabase/functions/_shared/company-size.ts";

const path = process.argv[2];
const apply = process.argv.includes("--apply");
const keep = new Set(
  process.argv
    .flatMap((arg, i, all) =>
      arg === "--keep" && all[i + 1] ? [all[i + 1]] : [],
    )
    .map((name) => name.trim().toLowerCase()),
);
if (!path || !existsSync(path))
  throw new Error("Pass the path to the Investment Pitch List Markdown file.");
const source = readFileSync(path, "utf8");

// One-off fixes applied with the sync, e.g. a company matched to the wrong
// listing: { name, patch: { ticker, exchange, officialName, ... }, why }.
const CORRECTIONS: {
  name: string;
  patch: Partial<Company>;
  why: string;
}[] = [];
const IDENTITY = [
  "name",
  "ticker",
  "exchange",
  "officialName",
  "newsQuery",
  "marketCapUsd",
];

const session = await cloudSession();
try {
  const store = new SupabaseStore(session.admin, session.owner);
  const docs = await store.list<Company>("company");
  const byId = new Map(docs.map((d) => [d.id, d]));
  const companies = docs.map((d) => CompanySchema.parse(d.data));
  const plan = planPitchListSync(parsePitchList(source), companies);
  const kept: string[] = [];
  for (const u of plan.updates) {
    if (!keep.has(u.name.toLowerCase())) continue;
    kept.push(u.name);
    delete u.patch.status;
    delete u.patch.passKind;
    u.fields = u.fields.filter((f) => f !== "status" && f !== "passKind");
    u.to = u.from;
  }
  // A kept company with nothing else to change is left untouched.
  plan.updates = plan.updates.filter(
    (u) => u.fields.length || !keep.has(u.name.toLowerCase()),
  );
  for (const name of keep)
    if (!kept.some((k) => k.toLowerCase() === name))
      throw new Error(`--keep "${name}" matched no company the doc updates.`);
  // Only corrections not already in place (so a second run writes nothing).
  const corrections = CORRECTIONS.flatMap((fix) => {
    const doc = docs.find((d) => d.data.name === fix.name);
    if (!doc) return [];
    const patch = Object.fromEntries(
      Object.entries(fix.patch).filter(
        ([k, v]) => JSON.stringify((doc.data as any)[k]) !== JSON.stringify(v),
      ),
    );
    return Object.keys(patch).length ? [{ id: doc.id, ...fix, patch }] : [];
  });
  const report = {
    at: new Date().toISOString(),
    source: path,
    companiesInApp: docs.length,
    updated: plan.updates.length,
    unchanged: plan.unchanged,
    moved: plan.updates
      .filter((u) => u.from !== u.to)
      .map((u) => `${u.name}: ${u.from} → ${u.to}`),
    created: plan.creates.map((c) => `${c.name} (${c.status})`),
    keptInPlace: kept,
    corrections: corrections.map((c) => `${c.name}: ${c.why}`),
    leftAsIs: plan.unlisted
      .filter((u) => !corrections.some((c) => c.id === u.id))
      .map((u) => `${u.name} (${u.archived ? "archived " : ""}${u.status})`),
  };
  mkdirSync(".local", { recursive: true });
  writeFileSync(
    ".local/pitch-list-sync-report.json",
    JSON.stringify({ ...report, updates: plan.updates }, null, 2),
  );
  console.log(
    JSON.stringify({ ...report, moved: report.moved.length, apply }, null, 2),
  );
  if (apply) {
    const backup = `.local/before-pitch-sync-${report.at.replace(/[:.]/g, "-")}.json`;
    writeFileSync(
      backup,
      JSON.stringify(await session.call("/export?scope=essential"), null, 2),
    );
    console.log(`Backup saved to ${backup}`);

    const now = new Date().toISOString();
    const patches = new Map<string, Partial<Company>>();
    for (const u of plan.updates) patches.set(u.id, { ...u.patch });
    for (const c of corrections)
      patches.set(c.id, { ...(patches.get(c.id) || {}), ...c.patch });
    const writes: {
      kind: string;
      id: string;
      data: unknown;
      expected: number;
    }[] = [];
    const revisions: typeof writes = [];
    for (const [id, patch] of patches) {
      const old = byId.get(id) as Doc<Company>;
      const before = CompanySchema.parse(old.data);
      let next: Company = normalizeSize(
        CompanySchema.parse({ ...before, ...patch }),
      );
      if (IDENTITY.some((k) => k in patch))
        next = {
          ...next,
          newsRevision: before.newsRevision + 1,
          feeds: next.feeds.map((f) =>
            isDefaultNewsFeed(f)
              ? {
                  ...f,
                  label: "Google News · company news",
                  url: companyNewsUrl(next),
                }
              : f,
          ),
        };
      if (before.notes !== next.notes)
        revisions.push({
          kind: "revision",
          id: `${id}-${old.version}`,
          data: {
            companyId: id,
            notes: before.notes,
            thesis: before.thesis,
            at: old.updatedAt,
          },
          expected: 0,
        });
      writes.push({
        kind: "company",
        id,
        data: { ...next, revision: before.revision + 1, updatedAt: now },
        expected: old.version,
      });
    }
    for (const c of plan.creates)
      writes.push({ kind: "company", id: c.id, data: c, expected: 0 });

    // Earlier note versions first, so history is complete before notes change.
    const existing = new Set(
      (await store.list("revision", { fields: [] })).map((d) => d.id),
    );
    const fresh = revisions.filter((r) => !existing.has(r.id));
    for (let i = 0; i < fresh.length; i += 50)
      await store.batch(fresh.slice(i, i + 50));
    let written = 0;
    for (let i = 0; i < writes.length; i += 50) {
      await store.batch(writes.slice(i, i + 50));
      written += Math.min(50, writes.length - i);
    }
    console.log(
      JSON.stringify({
        revisionsSaved: fresh.length,
        companiesWritten: written,
      }),
    );
  }
} finally {
  await session.close();
}
