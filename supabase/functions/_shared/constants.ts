export const statuses = [
  "inbox",
  "watchlist",
  "perpetual",
  "owned",
  "pass",
  "sold",
] as const;
export type Status = (typeof statuses)[number];
export const statusLabels: Record<Status, string> = {
  inbox: "Inbox",
  watchlist: "Watchlist",
  perpetual: "Perpetual watch",
  owned: "Portfolio",
  pass: "Passed",
  sold: "Sold",
};
export const defaultSettings = {
  timezone: "America/Chicago" as const,
  digestHour: 7,
  digestEnabled: false,
  skipEmpty: false,
};
