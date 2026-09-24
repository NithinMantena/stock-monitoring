import type { Company, Store } from "./model.ts";
import { cadenceOf, chicagoParts } from "./engine.ts";
import { NEWS_SCHEDULE } from "./constants.ts";
import type { Env } from "./providers.ts";
import { advanceJob } from "./job-queue.ts";
import {
  dailySnapshot,
  rescreenCandidates,
  rescreenNews,
  runMonitor,
  sendDueDigest,
} from "./jobs.ts";
import {
  advanceNewsBatch,
  startScheduledRun,
  type NewsBatch,
} from "./news-batch.ts";

// The hosted scheduler calls tick() every minute. An idle tick reads one small
// state record; all heavier work happens at most once per night or while a run
// is actually in progress. Every byte the server reads counts toward egress.
// Times and limits are in NEWS_SCHEDULE (constants.ts, shared with the desk).
export interface ScheduleState {
  installedAt?: string;
  dailyRunDate?: string;
  lastWeeklyStartedAt?: string;
  lastRunStartedAt?: string;
  activeRunId?: string;
  quotesDate?: string;
  backupDate?: string;
  digestDate?: string;
  rescreenDate?: string;
  rescreenPending?: number;
  history: {
    id: string;
    schedule: "daily" | "weekly";
    startedAt: string;
    finishedAt?: string;
    status: NewsBatch["status"];
    companies: number;
    checked: number;
    added: number;
    warnings: number;
  }[];
}
const HOUR = 3600000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function scheduleState(store: Store) {
  return store.get<ScheduleState>("run", "schedule");
}

export async function tick(
  store: Store,
  env: Env,
  options: { now?: Date; milliseconds?: number } = {},
) {
  const now = options.now || new Date();
  const started = Date.now();
  const left = () => (options.milliseconds ?? 50000) - (Date.now() - started);
  const lease = await store.claim("scheduler-tick", 150);
  if (!lease) return { busy: true };
  const result: Record<string, unknown> = {};
  const errors: string[] = [];
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      result[name] = await fn();
    } catch (error) {
      errors.push(`${name}: ${(error as Error).message}`);
    }
  };
  const doc = await scheduleState(store);
  const { date, hour } = chicagoParts(now);
  // First run after deployment: today's news was already monitored. Start with
  // tomorrow's daily run; the first weekly run is the coming Friday evening.
  const state: ScheduleState = doc?.data || {
    installedAt: now.toISOString(),
    dailyRunDate: date,
    lastRunStartedAt: now.toISOString(),
    history: [],
  };
  const before = JSON.stringify(state);
  try {
    // Explicitly queued API work gets one bounded step.
    await step("apiJob", () => advanceJob(store, env));

    // The morning digest must not wait behind a long news run.
    if (state.digestDate !== date)
      await step("digest", async () => {
        const email = await sendDueDigest(store, env, now);
        if (email.sent || /Already|skipped/.test(email.reason || ""))
          state.digestDate = date;
        return email;
      });

    if (state.backupDate !== date)
      await step("backup", async () => {
        const backup = await dailySnapshot(store, now);
        state.backupDate = date;
        return backup;
      });

    await step("newsRun", () => newsRun(store, env, state, now, left));

    // A manual batch keeps progressing while its browser tab is closed.
    if (left() > 15000)
      await step("manualBatch", async () => {
        const manual = await store.get<NewsBatch>("news_batch", "latest", {
          fields: ["status"],
        });
        if (manual?.data.status !== "running") return null;
        return (
          await advanceNewsBatch(store, env, {
            milliseconds: Math.min(40000, left() - 10000),
            maxArticles: NEWS_SCHEDULE.articlesPerTick,
          })
        ).batch;
      });

    // Closing prices are end-of-day: check them once per night.
    if (state.quotesDate !== date && hour >= NEWS_SCHEDULE.dailyHour && left() > 15000)
      await step("quotes", async () => {
        const monitor = await runMonitor(store, env, {
          news: false,
          maxCompanies: 25,
          milliseconds: Math.min(30000, left() - 10000),
        });
        if (!monitor.busy && (!monitor.processed || !("remaining" in monitor && monitor.remaining)))
          state.quotesDate = date;
        return monitor;
      });

    // Retries and re-screens after the night's news run, bounded per night.
    if (!state.activeRunId && hour >= NEWS_SCHEDULE.dailyHour && left() > 15000)
      await step("rescreen", () => rescreen(store, env, state, now, left));
  } finally {
    if (errors.length) result.errors = errors;
    if (JSON.stringify(state) !== before)
      await store
        .put("run", "schedule", state, doc?.version || 0)
        .catch((error) => errors.push(`state: ${(error as Error).message}`));
    await store.release("scheduler-tick", lease);
  }
  return result;
}

async function newsRun(
  store: Store,
  env: Env,
  state: ScheduleState,
  now: Date,
  left: () => number,
) {
  const { date, hour, weekday } = chicagoParts(now);
  let run = state.activeRunId
    ? await store.get<NewsBatch>("news_batch", "scheduled")
    : null;
  if (run && run.data.id !== state.activeRunId) run = null;
  if (run && run.data.status !== "running") {
    // Completed, or cancelled by the user: record it and allow the next run.
    record(state, run.data);
    state.activeRunId = undefined;
    run = null;
  }
  if (!run) {
    // Due from the scheduled evening through the next day (in case another run
    // was still active), and as a catch-up if a whole week was missed.
    const dayAfter = DAYS[(DAYS.indexOf(NEWS_SCHEDULE.weeklyDay) + 1) % 7];
    const startedThisWeek =
      !!state.lastWeeklyStartedAt &&
      now.getTime() - Date.parse(state.lastWeeklyStartedAt) < 3 * 24 * HOUR;
    const weeklyDue =
      (!startedThisWeek &&
        ((weekday === NEWS_SCHEDULE.weeklyDay &&
          hour >= NEWS_SCHEDULE.weeklyHour) ||
          weekday === dayAfter)) ||
      now.getTime() -
        Date.parse(state.lastWeeklyStartedAt || state.installedAt || "") >
        8 * 24 * HOUR;
    const dailyDue =
      state.dailyRunDate !== date && hour >= NEWS_SCHEDULE.dailyHour;
    const weeklyRecent =
      !!state.lastWeeklyStartedAt &&
      now.getTime() - Date.parse(state.lastWeeklyStartedAt) < 24 * HOUR;
    if (dailyDue && weeklyRecent && !weeklyDue) {
      // The weekly run already covers the daily companies (they go first).
      state.dailyRunDate = date;
      return { skipped: "daily run covered by this week's run" };
    }
    if (!weeklyDue && !dailyDue) return null;
    const companies = (
      await store.list<Company>("company", {
        fields: ["name", "status", "cadence", "archived"],
      })
    )
      .filter((d) =>
        weeklyDue
          ? cadenceOf(d.data) !== "paused"
          : cadenceOf(d.data) === "daily",
      )
      .sort(
        (a, b) =>
          Number(cadenceOf(b.data) === "daily") -
            Number(cadenceOf(a.data) === "daily") ||
          a.data.name.localeCompare(b.data.name),
      );
    const since = weeklyDue
      ? new Date(now.getTime() - 7 * 24 * HOUR)
      : new Date(
          Math.max(
            now.getTime() - 7 * 24 * HOUR,
            Math.min(
              now.getTime() - 24 * HOUR,
              Date.parse(state.lastRunStartedAt || "") ||
                now.getTime() - 24 * HOUR,
            ) -
              NEWS_SCHEDULE.overlapHours * HOUR,
          ),
        );
    if (weeklyDue) {
      state.lastWeeklyStartedAt = now.toISOString();
    }
    state.dailyRunDate = date;
    if (!companies.length) return { skipped: "no companies to check" };
    const started = await startScheduledRun(store, {
      schedule: weeklyDue ? "weekly" : "daily",
      companyIds: companies.map((d) => d.id),
      since: since.toISOString(),
      now,
    });
    state.activeRunId = started.id;
    state.lastRunStartedAt = now.toISOString();
    record(state, { ...started, companyIds: companies.map((d) => d.id) } as any);
  }
  if (left() < 15000) return { waiting: "time budget" };
  const advanced = await advanceNewsBatch(store, env, {
    slot: "scheduled",
    milliseconds: Math.min(45000, left() - 5000),
    maxArticles: NEWS_SCHEDULE.articlesPerTick,
  });
  if (advanced.batch && advanced.batch.status !== "running") {
    record(state, advanced.batch as any);
    state.activeRunId = undefined;
  }
  return advanced.batch;
}

function record(
  state: ScheduleState,
  run: Pick<
    NewsBatch,
    | "id"
    | "schedule"
    | "createdAt"
    | "finishedAt"
    | "status"
    | "checked"
    | "added"
    | "warningCount"
  > & { totalCompanies?: number; companyIds?: string[] },
) {
  const entry = {
    id: run.id,
    schedule: run.schedule || "daily",
    startedAt: run.createdAt,
    finishedAt: run.finishedAt,
    status: run.status,
    companies: run.totalCompanies ?? run.companyIds?.length ?? 0,
    checked: run.checked,
    added: run.added,
    warnings: run.warningCount,
  };
  state.history = [
    entry,
    ...state.history.filter((h) => h.id !== run.id),
  ].slice(0, 14);
}

// The queue is computed once per night from a projected scan and stored in its
// own record, which is read only while it still has work.
async function rescreen(
  store: Store,
  env: Env,
  state: ScheduleState,
  now: Date,
  left: () => number,
) {
  const { date } = chicagoParts(now);
  if (state.rescreenDate !== date) {
    const ids = (await rescreenCandidates(store)).slice(
      0,
      NEWS_SCHEDULE.rescreensPerNight,
    );
    const queue = await store.get("run", "rescreen-queue", { fields: [] });
    await store.put("run", "rescreen-queue", { date, ids }, queue?.version || 0);
    state.rescreenDate = date;
    state.rescreenPending = ids.length;
  }
  if (!state.rescreenPending) return null;
  const queue = await store.get<{ date: string; ids: string[] }>(
    "run",
    "rescreen-queue",
  );
  if (!queue?.data.ids.length) {
    state.rescreenPending = 0;
    return null;
  }
  // Re-screens judge what is already stored and never contact Google.
  const outcome = await rescreenNews(store, env, {
    ids: queue.data.ids,
    limit: 10,
    milliseconds: Math.min(40000, left() - 10000),
  });
  if (outcome.busy) return outcome;
  const ids = queue.data.ids.slice(outcome.consumed);
  await store.put("run", "rescreen-queue", { ...queue.data, ids }, queue.version);
  state.rescreenPending = ids.length;
  return { processed: outcome.processed, remaining: ids.length };
}
