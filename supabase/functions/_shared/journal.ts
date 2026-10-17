import type { Company, Status } from "./model.ts";

// The journal mirrors the Investment Pitch List: ideas only (no portfolio or
// sold companies), one section per research stage, in the owner's own order.
export type JournalSectionId =
  "perpetual" | "watchlist" | "inbox" | "pass-valued" | "pass-unvalued";
export interface JournalSection {
  id: JournalSectionId;
  label: string;
  hint: string;
  status: Status;
  passKind: "" | "valued" | "unvalued";
  // Days after which an idea is flagged as due for another look.
  staleDays: number | null;
}
export const JOURNAL_SECTIONS: JournalSection[] = [
  {
    id: "perpetual",
    label: "Perpetual watch",
    hint: "Well-researched ideas on the bench",
    status: "perpetual",
    passKind: "",
    staleDays: 90,
  },
  {
    id: "watchlist",
    label: "Watchlist",
    hint: "Researched, with questions still open",
    status: "watchlist",
    passKind: "",
    staleDays: 180,
  },
  {
    id: "inbox",
    label: "Potential ideas",
    hint: "Not yet looked at deeply",
    status: "inbox",
    passKind: "",
    staleDays: null,
  },
  {
    id: "pass-valued",
    label: "Passed · valued",
    hint: "Valued, or within reach of valuing",
    status: "pass",
    passKind: "valued",
    staleDays: null,
  },
  {
    id: "pass-unvalued",
    label: "Passed · not valued",
    hint: "Passed without a valuation",
    status: "pass",
    passKind: "unvalued",
    staleDays: null,
  },
];
export const journalSectionById = (id: JournalSectionId) =>
  JOURNAL_SECTIONS.find((s) => s.id === id)!;

export function journalSection(
  c: Pick<Company, "status" | "passKind" | "archived">,
): JournalSectionId | null {
  if (c.archived) return null;
  if (c.status === "pass")
    return c.passKind === "valued" ? "pass-valued" : "pass-unvalued";
  if (
    c.status === "perpetual" ||
    c.status === "watchlist" ||
    c.status === "inbox"
  )
    return c.status;
  return null;
}

// Status and pass type for a section; moving in lands at the top.
export function sectionPatch(
  id: JournalSectionId,
  now = Date.now(),
): Pick<Company, "status" | "passKind" | "journalOrder"> {
  const s = journalSectionById(id);
  return { status: s.status, passKind: s.passKind, journalOrder: -now };
}

export function compareJournal(
  a: Pick<Company, "journalOrder" | "name">,
  b: Pick<Company, "journalOrder" | "name">,
) {
  const x = a.journalOrder ?? Number.POSITIVE_INFINITY;
  const y = b.journalOrder ?? Number.POSITIVE_INFINITY;
  return x === y ? a.name.localeCompare(b.name) : x < y ? -1 : 1;
}

const STEP = 1000;
// New journalOrder values after moving `id` to position `index` of a section
// (ids in their current order, which may or may not include `id`). Usually a
// single write: the midpoint between the new neighbours. When neighbours have
// no order yet or the gap is exhausted, the section is renumbered.
export function planReorder(
  section: { id: string; journalOrder: number | null }[],
  id: string,
  index: number,
): { id: string; journalOrder: number }[] {
  const rest = section.filter((x) => x.id !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  const before = rest[at - 1],
    after = rest[at];
  const a = before?.journalOrder,
    b = after?.journalOrder;
  let value: number | null = null;
  if (!before && !after) value = 0;
  else if (!before && b != null) value = b - STEP;
  else if (!after && a != null) value = a + STEP;
  else if (a != null && b != null) {
    const mid = (a + b) / 2;
    if (mid !== a && mid !== b) value = mid;
  }
  if (value !== null) return [{ id, journalOrder: value }];
  const ordered = [
    ...rest.slice(0, at),
    { id, journalOrder: null },
    ...rest.slice(at),
  ];
  return ordered
    .map((x, i) => ({ id: x.id, journalOrder: i * STEP, old: x.journalOrder }))
    .filter((x) => x.id === id || x.old !== x.journalOrder)
    .map(({ id, journalOrder }) => ({ id, journalOrder }));
}

export function daysSince(value: string, now = Date.now()) {
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.floor((now - at) / 86400000) : null;
}
export function isStale(
  c: Pick<Company, "status" | "passKind" | "archived" | "lastReviewed">,
  now = Date.now(),
) {
  const id = journalSection(c);
  const limit = id ? journalSectionById(id).staleDays : null;
  if (limit === null) return false;
  // Undated ideas are not flagged: there is nothing to compare against yet.
  const days = daysSince(c.lastReviewed, now);
  return days !== null && days > limit;
}

// Headings offered by "Insert section" in the notes editor.
export const NOTE_SECTIONS = [
  "Business",
  "Management",
  "Growth",
  "Competition",
  "Capital allocation",
  "Valuation",
  "Risks",
  "What to watch",
] as const;
