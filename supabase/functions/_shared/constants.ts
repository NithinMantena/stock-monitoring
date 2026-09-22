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
// Nightly news runs (America/Chicago), shown on the desk and used by the scheduler.
export const NEWS_SCHEDULE = {
  // Weekly: every non-paused company, last 7 days, daily companies first. Starts
  // after Friday's close; ~6,200 articles at 10 a minute finish before 7am.
  weeklyDay: "Fri",
  weeklyHour: 18,
  // Daily: daily-cadence (portfolio / perpetual watch) companies, last day.
  dailyHour: 1,
  // A daily run reaches back to the previous run's start plus this overlap.
  overlapHours: 2,
  // Hosted workers allow 2 s CPU per request. Measured ~80 ms per article
  // (2026-09-22), so 10 articles keeps a tick near half the allowance.
  articlesPerTick: 10,
  // Rescreens (retries, policy/context changes) per night; bounds model spend.
  rescreensPerNight: 300,
};
