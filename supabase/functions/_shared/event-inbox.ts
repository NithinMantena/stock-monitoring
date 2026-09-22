import type { Company, DeskEvent, Doc, Status } from "./model.ts";

export type EventFolder = "inbox" | "saved" | "history";
export const INBOX_DAYS = 30;
export function isExpired(e: DeskEvent, now = Date.now()): boolean {
  const arrived = Date.parse(e.inboxAt || e.discoveredAt);
  return Number.isFinite(arrived) && arrived <= now - INBOX_DAYS * 86400000;
}
export function inEventFolder(
  e: DeskEvent,
  folder: EventFolder,
  now = Date.now(),
): boolean {
  if (folder === "saved") return e.saved === true;
  if (e.saved) return false;
  const historical = e.reviewed || isExpired(e, now);
  return folder === "history" ? historical : !historical;
}
export function eventGroupKey(e: DeskEvent): string {
  return `${e.companyId}:${e.kind === "news" ? e.clusterId || e.id : e.id}`;
}
// The cluster value shared by a development's members (store `cluster` filter).
export function developmentKey(doc: Doc<DeskEvent>): string {
  return doc.data.kind === "news" ? doc.data.clusterId || doc.id : doc.id;
}
export interface CompanyFilters {
  status: Status | "all" | "archived";
  group?: string;
  search?: string;
}
export function filterCompanies(
  docs: Doc<Company>[],
  filters: CompanyFilters,
): Doc<Company>[] {
  const search = (filters.search || "").trim().toLowerCase();
  return docs
    .filter(
      ({ data: c }) =>
        (filters.status === "archived"
          ? c.archived
          : !c.archived &&
            (filters.status === "all" || c.status === filters.status)) &&
        (!filters.group || c.originalGroup === filters.group) &&
        (!search ||
          `${c.name} ${c.ticker} ${c.exchange} ${c.tags.join(" ")} ${c.thesis} ${c.notes}`
            .toLowerCase()
            .includes(search)),
    )
    .sort((a, b) => a.data.name.localeCompare(b.data.name));
}
