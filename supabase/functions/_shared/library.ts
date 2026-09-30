import { z } from "zod";
import type { Company, DeskEvent, Doc } from "./model.ts";

// The owner's saved-article lists (like playlists) and tag catalogue. Stored as
// the `settings/library` record, so no new record kind or migration is needed,
// and it travels with exports and backups alongside `settings/main`.
export const LIBRARY_ID = "library";
export const REVIEW_LATER = "review-later";
export const DEFAULT_LISTS = [
  { id: REVIEW_LATER, name: "Review later" },
  { id: "favorites", name: "Favorites" },
];
const listId = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9-]+$/);
export const SavedListSchema = z.object({
  id: listId,
  name: z.string().trim().min(1).max(80),
});
export type SavedList = z.infer<typeof SavedListSchema>;
export const LibrarySchema = z.object({
  lists: z
    .array(SavedListSchema)
    .max(50)
    .default(DEFAULT_LISTS)
    .refine(
      (lists) => new Set(lists.map((l) => l.id)).size === lists.length,
      "List ids must be unique.",
    ),
  // Tags created before any company carries them. Tags in use live on companies.
  tags: z.array(z.string().trim().min(1).max(80)).max(500).default([]),
});
export type Library = z.infer<typeof LibrarySchema>;
export const defaultLibrary = (): Library => ({
  lists: DEFAULT_LISTS.map((l) => ({ ...l })),
  tags: [],
});
export const ListIds = z.array(listId).max(50);

// Articles saved before lists existed carry only `saved: true`: they are in
// Review later, which is how the owner used Save.
export function eventLists(e: Pick<DeskEvent, "saved" | "lists">): string[] {
  return e.lists ?? (e.saved ? [REVIEW_LATER] : []);
}

// `saved` stays the folder flag (inbox, digest and integrations rely on it) and
// always equals "in at least one list".
export function applySavePatch<T extends Pick<DeskEvent, "saved" | "lists">>(
  data: T,
  patch: { saved?: boolean; lists?: string[] },
): T {
  let lists: string[] | undefined;
  if (patch.lists !== undefined) lists = [...new Set(patch.lists)];
  else if (patch.saved === false) lists = [];
  else if (patch.saved === true) {
    const current = eventLists(data);
    lists = current.length ? current : [REVIEW_LATER];
  }
  if (!lists) return data;
  return { ...data, lists, saved: lists.length > 0 };
}

export const normalizeTag = (tag: string) => tag.trim().replace(/\s+/g, " ");
export const sameTag = (a: string, b: string) =>
  normalizeTag(a).toLowerCase() === normalizeTag(b).toLowerCase();
export const hasTag = (c: Pick<Company, "tags">, tag: string) =>
  c.tags.some((t) => sameTag(t, tag));

// Every known tag with the number of companies carrying it, case-insensitively.
export function tagCounts(
  companies: Doc<Company>[],
  library?: Pick<Library, "tags"> | null,
): { tag: string; count: number }[] {
  const byKey = new Map<string, { tag: string; count: number }>();
  for (const { data } of companies) {
    const seen = new Set<string>();
    for (const raw of data.tags.map(normalizeTag).filter(Boolean)) {
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const item = byKey.get(key);
      if (item) item.count++;
      else byKey.set(key, { tag: raw, count: 1 });
    }
  }
  for (const raw of library?.tags || []) {
    const tag = normalizeTag(raw);
    if (tag && !byKey.has(tag.toLowerCase()))
      byKey.set(tag.toLowerCase(), { tag, count: 0 });
  }
  return [...byKey.values()].sort((a, b) =>
    a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }),
  );
}

export function slugForList(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "list";
  let id = base,
    n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

// Ranks a company against typed text: exact ticker, then name prefixes, words,
// substrings, all words, and finally the letters in order ("srl acq"). 0 = no match.
export function companyMatchScore(
  c: Pick<Company, "name" | "ticker"> & { officialName?: string },
  query: string,
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const name = c.name.toLowerCase(),
    ticker = (c.ticker || "").toLowerCase(),
    hay = `${name} ${ticker} ${(c.officialName || "").toLowerCase()}`;
  if (ticker && ticker === q) return 100;
  if (name === q) return 95;
  if (name.startsWith(q)) return 80;
  if (ticker && ticker.startsWith(q)) return 70;
  if (name.split(/[^a-z0-9]+/).some((w) => w && w.startsWith(q))) return 60;
  if (hay.includes(q)) return 40;
  const words = q.split(/\s+/);
  if (words.every((w) => hay.includes(w))) return 30;
  let i = 0;
  const letters = q.replace(/\s+/g, "");
  for (const ch of name) if (ch === letters[i]) i++;
  return i === letters.length ? 10 : 0;
}

// A custom news search's company selection. Filled-in categories must all match
// (any value within a category; tags can require all); hand-picked companies
// are always included. With no categories, only the picked companies are used.
export interface CompanyCriteria {
  tags: string[];
  tagMode: "any" | "all";
  statuses: string[];
  groups: string[];
  sizes: string[];
  companyIds: string[];
}
export const emptyCriteria = (): CompanyCriteria => ({
  tags: [],
  tagMode: "any",
  statuses: [],
  groups: [],
  sizes: [],
  companyIds: [],
});
export function matchCriteria<T extends Doc<Company>>(
  docs: T[],
  criteria: CompanyCriteria,
  sizeOf: (c: Company) => string,
): T[] {
  const filtering =
    criteria.tags.length +
    criteria.statuses.length +
    criteria.groups.length +
    criteria.sizes.length;
  return docs
    .filter(({ id, data: c }) => {
      if (criteria.companyIds.includes(id)) return true;
      if (!filtering || c.archived) return false;
      const tags = criteria.tags;
      return (
        (!tags.length ||
          (criteria.tagMode === "all"
            ? tags.every((t) => hasTag(c, t))
            : tags.some((t) => hasTag(c, t)))) &&
        (!criteria.statuses.length || criteria.statuses.includes(c.status)) &&
        (!criteria.groups.length || criteria.groups.includes(c.originalGroup)) &&
        (!criteria.sizes.length || criteria.sizes.includes(sizeOf(c)))
      );
    })
    .sort((a, b) => a.data.name.localeCompare(b.data.name));
}
