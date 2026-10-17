import { parseInvestmentMarkdown, type ImportCandidate } from "./importer.ts";
import { journalSectionById, type JournalSectionId } from "./journal.ts";
import { newCompany, type Company } from "./model.ts";

// Brings the app in line with the owner's Investment Pitch List (Markdown export
// of the Google Doc). Each company's entry becomes its notes; the doc section
// decides its journal section; the doc order becomes the journal order.

export interface PitchEntry {
  key: string;
  name: string;
  section: JournalSectionId;
  group: string;
  notes: string;
  // ISO date from the entry's first line ("Acme (9/23/2026)"), or "".
  lastReviewed: string;
  ideaSource: string;
  start: number;
  end: number;
}
export interface PitchList {
  entries: PitchEntry[];
  // Names from the "Companies to add to App Tracker" lists (no notes).
  tracker: { key: string; name: string; ideaSource: string; line: number }[];
}

const SECTION_RULES: [RegExp, JournalSectionId | "tracker" | "ignore"][] = [
  [/^Perpetual Watch List \(High/i, "perpetual"],
  [/^Perpetual Watch List \(Mid/i, "watchlist"],
  [/^Potential Ideas/i, "inbox"],
  [/^Pass \(valued/i, "pass-valued"],
  [/^Pass \(un-?valued/i, "pass-unvalued"],
  [/^Companies to (?:add|be added)/i, "tracker"],
  [/Rereview|Earnings Calls/i, "ignore"],
];
const sectionFor = (group: string) =>
  SECTION_RULES.find(([re]) => re.test(group))?.[1] ?? "ignore";

// "Northwind Traders (NWT)" and "northwind traders" are the same company.
// Aliases map a short name in the doc to the name used on the desk.
const ALIASES: Record<string, string> = {};
export function companyKey(name: string) {
  const key = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9à-ž]+/g, " ")
    .trim();
  return ALIASES[key] || key;
}

const SOURCE_TAGS: [RegExp, string][] = [
  [/\*?\bUk screen\b/i, "UK screen"],
  [/\(?Australia screen\)?/i, "Australia screen"],
  [/\(?experimental screener\)?/i, "Experimental screener"],
];
function sourceOf(text: string) {
  return SOURCE_TAGS.find(([re]) => re.test(text))?.[1] || "";
}
function stripSourceTags(name: string) {
  return SOURCE_TAGS.reduce((n, [re]) => n.replace(re, ""), name)
    .replace(/\s*\((?:reach out)\)/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

const DATE = /(\d{1,2})\/(\d{1,2})\s*[\/,]\s*(\d{4})/;
export function firstDate(text: string) {
  const m = DATE.exec(text);
  if (!m) return "";
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
// Parentheses holding only a date, e.g. "(8/24/2026)" or "(date last checked: 6/9/2026)".
const DATE_ONLY =
  /\s*\((?:date last checked:\s*)?\d{1,2}\/\d{1,2}\s*[\/,]\s*\d{4}\)/gi;

// A top-level line that reads as a sentence about the previous company, such
// as "Globex currently trading for 7x earnings" inside a parent company's entry.
const SENTENCE = /^\S+ (?:currently trading|is trading)\b/i;

function unescape(text: string) {
  return text.replace(/\\([&+*_.~#\-])/g, "$1");
}

// "Hooli (via newsletter)" is Hooli; a ticker such as "(NWT)" stays in the name.
function displayName(name: string) {
  return name
    .replace(/\s*\(([^)]*)\)/g, (all, inner: string) =>
      /^[A-Z0-9.\-]{1,8}$/.test(inner.trim()) ? all : "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

// The entry's notes: its sub-bullets, outdented one level, led by anything on
// the first line other than the company name and its date.
function entryNotes(item: ImportCandidate, name: string) {
  const lines = item.notes
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => l.replace(/\t/g, "    "));
  const top = lines[0].replace(/^-\s+/, "");
  const body = lines.slice(1);
  const indent = (l: string) => /^ */.exec(l)![0].length;
  const filled = body.filter((l) => l.trim());
  const cut = filled.length ? Math.min(...filled.map(indent)) : 0;
  const dedented = body.map((l) => l.slice(Math.min(cut, indent(l))));
  const plainTop = unescape(top).replace(DATE_ONLY, "").trim();
  let lead = "";
  if (plainTop.toLowerCase().startsWith(name.toLowerCase()))
    lead = plainTop.slice(name.length).trim();
  else lead = top.trim();
  lead = lead.replace(/^[,;:\-–]\s*/, "");
  return [lead, ...(lead && dedented.length ? [""] : []), ...dedented]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parsePitchList(source: string): PitchList {
  const raw = parseInvestmentMarkdown(source).candidates;
  // Fold sentence-like "companies" back into the entry they belong to.
  const candidates: ImportCandidate[] = [];
  for (const item of raw) {
    const prev = candidates.at(-1);
    if (prev && SENTENCE.test(item.name) && prev.group === item.group) {
      prev.notes += item.notes;
      prev.end = item.end;
    } else candidates.push({ ...item });
  }
  const entries: PitchEntry[] = [];
  const tracker: PitchList["tracker"] = [];
  for (const item of candidates) {
    const section = sectionFor(item.group);
    if (section === "ignore") continue;
    const name = displayName(
      stripSourceTags(
        item.name.replace(/\s+\d+(?:\.\d+)?x$/i, "").replace(DATE_ONLY, ""),
      ),
    );
    if (!name) continue;
    if (section === "tracker") {
      tracker.push({
        key: companyKey(name),
        name,
        ideaSource: sourceOf(item.name),
        line: item.start,
      });
      continue;
    }
    const firstLine = item.notes.split("\n")[0];
    entries.push({
      key: companyKey(name),
      name,
      section,
      group: item.group,
      notes: entryNotes(item, name),
      lastReviewed: firstDate(firstLine),
      ideaSource: sourceOf(item.name),
      start: item.start,
      end: item.end,
    });
  }
  return { entries, tracker };
}

// One company per key. When an idea appears in two sections, the entry with
// the latest date leads (ties: the earlier, more researched section) and the
// other entry's notes follow it.
export function mergeDuplicates(entries: PitchEntry[]) {
  const byKey = new Map<string, PitchEntry[]>();
  for (const e of entries) byKey.set(e.key, [...(byKey.get(e.key) || []), e]);
  return [...byKey.values()].map((group) => {
    if (group.length === 1) return group[0];
    const lead = [...group].sort(
      (a, b) =>
        b.lastReviewed.localeCompare(a.lastReviewed) || a.start - b.start,
    )[0];
    const others = group.filter((e) => e !== lead);
    return {
      ...lead,
      notes: [
        lead.notes,
        ...others.map(
          (e) =>
            `*Also listed under ${journalSectionById(e.section).label}:*\n\n${e.notes}`,
        ),
      ]
        .filter(Boolean)
        .join("\n\n---\n\n"),
      ideaSource:
        lead.ideaSource || others.find((e) => e.ideaSource)?.ideaSource || "",
    };
  });
}

export interface SyncChange {
  id: string;
  name: string;
  from: string;
  to: string;
  fields: string[];
  patch: Partial<Company>;
}
export interface SyncPlan {
  updates: SyncChange[];
  creates: Company[];
  // Companies in the app that the doc no longer lists (left as they are).
  unlisted: { id: string; name: string; status: string; archived: boolean }[];
  unchanged: number;
}

const label = (c: Pick<Company, "status" | "passKind" | "archived">) =>
  `${c.archived ? "archived " : ""}${c.status}${c.status === "pass" ? `/${c.passKind || "unvalued"}` : ""}`;

export function planPitchListSync(
  list: PitchList,
  companies: Company[],
): SyncPlan {
  const entries = mergeDuplicates(list.entries);
  const byKey = new Map<string, Company>();
  // One company per name; an archived duplicate gives way to a live one.
  for (const c of companies) {
    const key = companyKey(c.name);
    const prior = byKey.get(key);
    if (!prior || (prior.archived && !c.archived)) byKey.set(key, c);
  }
  const seen = new Set<string>();
  const updates: SyncChange[] = [];
  const creates: Company[] = [];
  let unchanged = 0;
  for (const entry of entries) {
    const section = journalSectionById(entry.section);
    const existing = byKey.get(entry.key);
    const want: Partial<Company> = {
      notes: entry.notes,
      journalOrder: entry.start,
      originalGroup: entry.group,
      sourceLines: `${entry.start}–${entry.end}`,
      ...(entry.lastReviewed ? { lastReviewed: entry.lastReviewed } : {}),
    };
    if (!existing) {
      const created = newCompany(entry.name, section.status);
      creates.push({
        ...created,
        ...want,
        passKind: section.passKind,
        ideaSource: entry.ideaSource,
        source: "Investment Pitch List.md",
      });
      continue;
    }
    seen.add(existing.id);
    // Portfolio and sold companies keep their status; the doc only lists ideas.
    if (existing.status !== "owned" && existing.status !== "sold") {
      want.status = section.status;
      want.passKind = section.passKind;
    }
    if (!existing.ideaSource && entry.ideaSource)
      want.ideaSource = entry.ideaSource;
    const fields = Object.keys(want).filter(
      (k) =>
        JSON.stringify((existing as any)[k]) !==
        JSON.stringify((want as any)[k]),
    );
    if (!fields.length) {
      unchanged++;
      continue;
    }
    updates.push({
      id: existing.id,
      name: existing.name,
      from: label(existing),
      to: label({ ...existing, ...want } as Company),
      fields,
      patch: Object.fromEntries(fields.map((k) => [k, (want as any)[k]])),
    });
  }
  // Tracker names already in the app go to the top of Potential ideas, in the
  // doc's order; names not yet anywhere become new potential ideas.
  for (const t of list.tracker) {
    const c = [...byKey.entries()].find(
      ([k]) =>
        k === t.key ||
        t.key.startsWith(k + " ") ||
        (t.key.startsWith(k) && k.length > 6),
    )?.[1];
    if (!c || seen.has(c.id) || c.journalOrder !== null) continue;
    seen.add(c.id);
    updates.push({
      id: c.id,
      name: c.name,
      from: label(c),
      to: label(c),
      fields: ["journalOrder"],
      patch: { journalOrder: t.line },
    });
  }
  // Tracker names not yet anywhere become potential ideas.
  const known = [...byKey.keys(), ...entries.map((e) => e.key)].filter(Boolean);
  const matches = (key: string) =>
    known.some(
      (k) => k === key || k.startsWith(key + " ") || key.startsWith(k),
    );
  for (const t of list.tracker) {
    if (!t.key || matches(t.key)) continue;
    known.push(t.key);
    creates.push({
      ...newCompany(t.name, "inbox"),
      journalOrder: t.line,
      originalGroup: "Companies to add to App Tracker",
      ideaSource: t.ideaSource,
      source: "Investment Pitch List.md",
    });
  }
  const unlisted = companies
    .filter(
      (c) =>
        !seen.has(c.id) &&
        !list.tracker.some((t) => {
          const k = companyKey(c.name);
          return t.key === k || t.key.startsWith(k);
        }),
    )
    .map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      archived: c.archived,
    }));
  return { updates, creates, unlisted, unchanged };
}
