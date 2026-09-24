import {
  ConflictError,
  type Company,
  type DeskEvent,
  type Store,
} from "./model.ts";
import { discoverPrimary } from "./article-content.ts";
import {
  companyNewsUrl,
  companyNewsDayUrl,
  isDefaultNewsFeed,
  newsSearchDays,
} from "./news.ts";
import { fetchFeed, type Article, type Env } from "./providers.ts";
import {
  companyHistory,
  healthEvent,
  processArticle,
  updateFreshCompany,
} from "./jobs.ts";
import {
  beginHostTracking,
  currentPacing,
  endHostTracking,
  restorePacing,
  slowDown,
  speedUp,
  ThrottledError,
  trackedSkips,
  type Pacing,
} from "./fetch-policy.ts";

// Two independent run records share one engine: "latest" is the user's manual
// batch; "scheduled" is the nightly daily/weekly news run.
export type NewsBatchSlot = "latest" | "scheduled";
export interface NewsBatch {
  id: string;
  label: string;
  companyIds: string[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  status: "running" | "paused" | "cancelled" | "completed";
  lookbackDays?: number;
  articleLimit?: number;
  dailySearch?: boolean;
  tokens?: number;
  completedCompanies: number;
  // Stored so status can be read without the company list.
  totalCompanies?: number;
  currentCompany: string;
  sourceIndex: number;
  pendingArticles: Article[];
  checked: number;
  added: number;
  warningCount: number;
  warnings: { companyId: string; message: string }[];
  // Scheduled runs: which run, and the exact publication cutoff.
  schedule?: "daily" | "weekly";
  since?: string;
  // Consecutive rate-limited attempts at the current step, and when to retry.
  throttles?: number;
  // Consecutive unexpected failures on the current article.
  articleFailures?: number;
  backoffUntil?: string;
  // Publishers skipped for the rest of this run (blocked or timing out).
  skippedHosts?: string[];
  // Google request spacing learned from refusals during this run.
  pace?: Pacing;
  // Source failures for the current company, reported when it completes.
  sourceErrors?: { feedId: string; message: string }[];
}
export type NewsBatchSummary = Omit<
  NewsBatch,
  | "pendingArticles"
  | "sourceIndex"
  | "companyIds"
  | "skippedHosts"
  | "sourceErrors"
  | "pace"
> & { totalCompanies: number };
export function newsBatchSummary(
  batch?: NewsBatch | null,
): NewsBatchSummary | null {
  if (!batch) return null;
  const {
    pendingArticles: _pending,
    sourceIndex: _source,
    sourceErrors: _errors,
    skippedHosts: _skipped,
    pace: _pace,
    companyIds,
    ...summary
  } = batch;
  return { ...summary, totalCompanies: companyIds.length };
}
const SUMMARY_FIELDS = [
  "id",
  "label",
  "createdAt",
  "updatedAt",
  "finishedAt",
  "status",
  "lookbackDays",
  "articleLimit",
  "dailySearch",
  "tokens",
  "completedCompanies",
  "totalCompanies",
  "currentCompany",
  "checked",
  "added",
  "warningCount",
  "warnings",
  "schedule",
  "since",
  "throttles",
  "backoffUntil",
];
// Status reads skip the queue and company list (tens of KB during a run).
export async function readBatchSummary(
  store: Store,
  slot: NewsBatchSlot,
  options: { warnings?: boolean } = {},
): Promise<NewsBatchSummary | null> {
  const fields =
    options.warnings === false
      ? SUMMARY_FIELDS.filter((f) => f !== "warnings")
      : SUMMARY_FIELDS;
  const doc = await store.get<NewsBatch>("news_batch", slot, { fields });
  if (!doc) return null;
  // Records written before totalCompanies was stored need one full read.
  if (doc.data.totalCompanies === undefined)
    return newsBatchSummary(
      (await store.get<NewsBatch>("news_batch", slot))?.data,
    );
  // Without warnings the field stays absent so clients keep the list they have.
  return {
    ...doc.data,
    ...(options.warnings === false ? {} : { warnings: doc.data.warnings || [] }),
    totalCompanies: doc.data.totalCompanies,
  } as NewsBatchSummary;
}
const leaseFor = (slot: NewsBatchSlot) =>
  slot === "latest" ? "manual-news-batch" : "scheduled-news-run";

// A separate queue, lease, and progress record: manual searches never alter regular monitoring's clocks.
export async function startNewsBatch(
  store: Store,
  input: {
    id: string;
    companyIds: string[];
    label: string;
    lookbackDays?: number;
    articleLimit?: number;
  },
) {
  // One bounded article can contain up to 30 sequential 15-second model
  // requests. Keep a second worker from taking over its queue mid-article.
  const lease = await store.claim("manual-news-batch", 600);
  if (!lease)
    throw new Error(
      "A news batch is already being updated. Try again shortly.",
    );
  try {
    const old = await store.get<NewsBatch>("news_batch", "latest");
    if (old?.data.id === input.id) return newsBatchSummary(old.data)!;
    if (old?.data.status === "running" || old?.data.status === "paused")
      throw new Error(
        "A news batch is already running or paused. Resume or cancel it before starting another.",
      );
    const companyIds = [...new Set(input.companyIds)];
    const known = new Set(
      (await store.list<Company>("company", { fields: [] })).map((d) => d.id),
    );
    if (!companyIds.length || companyIds.some((id) => !known.has(id)))
      throw new Error(
        "Choose existing companies before starting a news batch.",
      );
    const at = new Date().toISOString();
    const batch: NewsBatch = {
      id: input.id,
      label: input.label,
      companyIds,
      totalCompanies: companyIds.length,
      createdAt: at,
      updatedAt: at,
      status: "running",
      lookbackDays: input.lookbackDays ?? 7,
      articleLimit: input.articleLimit ?? 10,
      dailySearch: true,
      tokens: 0,
      completedCompanies: 0,
      currentCompany: "",
      sourceIndex: -1,
      pendingArticles: [],
      checked: 0,
      added: 0,
      warningCount: 0,
      warnings: [],
    };
    await store.batch([
      ...(old && !(await store.get("news_batch", old.data.id, { fields: [] })) ? [{ kind: "news_batch", id: old.data.id, data: old.data, expected: 0 }] : []),
      { kind: "news_batch", id: "latest", data: batch, expected: old?.version || 0 },
    ]);
    return newsBatchSummary(batch)!;
  } finally {
    await store.release("manual-news-batch", lease);
  }
}

// The scheduler replaces the previous scheduled run's record; its summary is kept
// in the schedule history instead of accumulating full run records.
export async function startScheduledRun(
  store: Store,
  input: {
    schedule: "daily" | "weekly";
    companyIds: string[];
    since: string;
    now?: Date;
  },
) {
  const at = (input.now || new Date()).toISOString();
  const old = await store.get<NewsBatch>("news_batch", "scheduled", {
    fields: ["status"],
  });
  if (old?.data.status === "running")
    throw new Error("A scheduled news run is still in progress.");
  const batch: NewsBatch = {
    id: crypto.randomUUID(),
    label:
      input.schedule === "weekly"
        ? "Weekly news run · all companies · last 7 days"
        : "Daily news run · daily companies · last day",
    schedule: input.schedule,
    since: input.since,
    companyIds: [...new Set(input.companyIds)],
    totalCompanies: new Set(input.companyIds).size,
    createdAt: at,
    updatedAt: at,
    status: "running",
    articleLimit: 10,
    dailySearch: true,
    tokens: 0,
    completedCompanies: 0,
    currentCompany: "",
    sourceIndex: -1,
    pendingArticles: [],
    checked: 0,
    added: 0,
    warningCount: 0,
    warnings: [],
  };
  await store.put("news_batch", "scheduled", batch, old?.version || 0);
  return newsBatchSummary(batch)!;
}

// Controls must remain available while the worker holds its lease. Optimistic writes
// let the worker preserve both the user's latest command and completed article work.
export async function controlNewsBatch(
  store: Store,
  id: string,
  action: "pause" | "resume" | "cancel",
) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let slot: NewsBatchSlot = "latest";
    let target = await store.get<NewsBatch>("news_batch", slot);
    if (target?.data.id !== id) {
      slot = "scheduled";
      target = await store.get<NewsBatch>("news_batch", slot);
    }
    if (!target || target.data.id !== id) throw new ConflictError();
    const batch = structuredClone(target.data);
    if (batch.status === "completed" || batch.status === "cancelled")
      return newsBatchSummary(batch)!;
    batch.status =
      action === "pause"
        ? "paused"
        : action === "resume"
          ? "running"
          : "cancelled";
    batch.updatedAt = new Date().toISOString();
    if (action === "resume") batch.backoffUntil = undefined;
    if (action === "cancel") batch.finishedAt = batch.updatedAt;
    try {
      await store.put("news_batch", slot, batch, target.version);
      return newsBatchSummary(batch)!;
    } catch (error) {
      if (!(error instanceof ConflictError) || attempt === 7) throw error;
    }
  }
  throw new ConflictError();
}

// UTC calendar days to search: from the scheduled cutoff through the run's start,
// or the manual batch's fixed lookback.
export function batchSearchDays(batch: NewsBatch): string[] {
  if (!batch.since) return newsSearchDays(batch.createdAt, batch.lookbackDays ?? 7);
  const first = Date.parse(batch.since.slice(0, 10));
  const last = Date.parse(batch.createdAt.slice(0, 10));
  return newsSearchDays(
    batch.createdAt,
    Math.max(1, Math.round((last - first) / 86400000) + 1),
  );
}

export function selectBatchArticles(
  articles: Article[],
  batch: NewsBatch,
): Article[] {
  const cutoff = batch.since
    ? Date.parse(batch.since)
    : Date.parse(batch.createdAt.slice(0, 10)) -
      ((batch.lookbackDays ?? 7) - 1) * 86400000;
  return [
    ...new Map(
      articles
        .filter(
          (a) =>
            !a.publishedAt ||
            !Number.isFinite(Date.parse(a.publishedAt)) ||
            Date.parse(a.publishedAt) >= cutoff,
        )
        .map((a) => [a.id, { ...a, text: a.text.slice(0, 8000) }]),
    ).values(),
  ].slice(0, batch.articleLimit ?? 10);
}

function batchSources(c: Company, batch: NewsBatch) {
  return c.feeds.flatMap((feed) =>
    batch.dailySearch && isDefaultNewsFeed(feed)
      ? batchSearchDays(batch).map((day) => ({
          ...feed,
          url: companyNewsDayUrl(c, day),
          day,
        }))
      : [
          {
            ...feed,
            url: isDefaultNewsFeed(feed) ? companyNewsUrl(c) : feed.url,
            day: "",
          },
        ],
  );
}

// Google rate limits clear on their own. Retry the same step later with growing
// delays; only after THROTTLE_RETRIES consecutive refusals is it given up.
export const THROTTLE_RETRIES = 5;
const THROTTLE_DELAYS = [60, 180, 600, 1200, 1800];
function backOff(batch: NewsBatch) {
  slowDown();
  const n = (batch.throttles || 0) + 1;
  batch.throttles = n;
  batch.backoffUntil = new Date(
    Date.now() + THROTTLE_DELAYS[Math.min(n, THROTTLE_DELAYS.length) - 1] * 1000,
  ).toISOString();
}

// A scheduled run replaces automatic news monitoring, so it keeps the company's
// news clock and feed status current and raises the same monitoring alerts.
async function finishScheduledCompany(store: Store, c: Company, batch: NewsBatch) {
  const errors = batch.sourceErrors || [];
  // One alert per failing source, not one per failed daily search.
  const bySource = new Map<string, string[]>();
  for (const e of errors)
    bySource.set(e.feedId, [...(bySource.get(e.feedId) || []), e.message]);
  for (const messages of bySource.values())
    await healthEvent(
      store,
      c,
      messages[0] +
        (messages.length > 1 ? ` (and ${messages.length - 1} more)` : ""),
    );
  const feedErrors = errors.filter((e) => e.feedId !== "primary");
  const at = new Date().toISOString();
  await updateFreshCompany(store, c.id, (latest) =>
    store.put(
      "company",
      c.id,
      {
        ...latest.data,
        feeds: latest.data.feeds.map((f) => {
          const failed = feedErrors.find((e) => e.feedId === f.id);
          return failed
            ? { ...f, error: failed.message.slice(0, 300) }
            : { ...f, error: "", lastSuccess: at };
        }),
        lastNewsCheck: feedErrors.length ? latest.data.lastNewsCheck : at,
      },
      latest.version,
    ),
  ).catch(() => undefined); // A concurrent edit wins; the run result stays in the record.
}

export async function advanceNewsBatch(
  store: Store,
  env: Env,
  options: {
    id?: string;
    milliseconds?: number;
    maxSteps?: number;
    // Bounds per-invocation CPU on hosted workers.
    maxArticles?: number;
    slot?: NewsBatchSlot;
  } = {},
) {
  const slot = options.slot ?? "latest";
  const lease = await store.claim(leaseFor(slot), 300);
  if (!lease)
    return {
      busy: true,
      batch: newsBatchSummary(
        (await store.get<NewsBatch>("news_batch", slot))?.data,
      ),
    };
  const start = Date.now();
  try {
    const doc = await store.get<NewsBatch>("news_batch", slot);
    if (!doc || doc.data.status !== "running")
      return { busy: false, batch: newsBatchSummary(doc?.data) };
    if (options.id && options.id !== doc.data.id) throw new ConflictError();
    if (doc.data.backoffUntil && doc.data.backoffUntil > new Date().toISOString())
      return { busy: false, batch: newsBatchSummary(doc.data) };
    const batch = structuredClone(doc.data);
    batch.backoffUntil = undefined;
    let version = doc.version;
    beginHostTracking(batch.skippedHosts);
    restorePacing(batch.pace);
    const warn = (companyId: string, message: string) => {
      batch.warningCount++;
      if (batch.warnings.length < 100)
        batch.warnings.push({ companyId, message: message.slice(0, 500) });
    };
    // Progress is written every few steps and at the end of the slice. A killed
    // worker repeats at most those steps; stored articles are never re-screened.
    const save = async () => {
      batch.skippedHosts = trackedSkips();
      batch.pace = currentPacing();
      for (let attempt = 0; attempt < 8; attempt++) {
        batch.updatedAt = new Date().toISOString();
        try {
          version = (await store.put("news_batch", slot, batch, version)).version;
          return;
        } catch (error) {
          if (!(error instanceof ConflictError) || attempt === 7) throw error;
          const fresh = await store.get<NewsBatch>("news_batch", slot, {
            fields: ["id", "status", "finishedAt"],
          });
          if (!fresh || fresh.data.id !== batch.id) throw new ConflictError();
          if (fresh.data.status !== "running") {
            batch.status = fresh.data.status;
            batch.finishedAt = fresh.data.finishedAt;
          }
          version = fresh.version;
        }
      }
    };
    const companies = new Map<string, Company | null>();
    const histories = new Map<string, DeskEvent[]>();
    let steps = 0,
      articles = 0,
      unsaved = 0;
    while (
      batch.completedCompanies < batch.companyIds.length &&
      Date.now() - start < (options.milliseconds ?? 25000) &&
      steps < (options.maxSteps ?? 100) &&
      articles < (options.maxArticles ?? Infinity)
    ) {
      // Pause/cancel must stop paid work promptly; this read is a few bytes.
      const control = await store.get<NewsBatch>("news_batch", slot, {
        fields: ["status"],
      });
      if (control?.data.status !== "running") {
        if (!control) throw new ConflictError();
        batch.status = control.data.status;
        if (unsaved) await save();
        return { busy: false, batch: newsBatchSummary(batch) };
      }
      steps++;
      const companyId = batch.companyIds[batch.completedCompanies];
      if (!companies.has(companyId))
        companies.set(
          companyId,
          (await store.get<Company>("company", companyId))?.data || null,
        );
      const c = companies.get(companyId);
      if (!c) {
        warn(companyId, "Company no longer exists; skipped.");
        batch.pendingArticles = [];
        batch.sourceIndex = -1;
        batch.sourceErrors = [];
        batch.completedCompanies++;
        await save();
        unsaved = 0;
        continue;
      }
      const sources = batchSources(c, batch);
      batch.currentCompany = c.name;
      let halt = false;
      if (batch.pendingArticles.length) {
        const article = batch.pendingArticles[0];
        const id = `news-${c.id}-${article.id}`;
        let done = true;
        if (!(await store.get("event", id, { fields: [] }))) {
          try {
            if (!histories.has(c.id))
              histories.set(c.id, await companyHistory(store, c.id));
            const result = await processArticle(c, article, store, env, {
              assumeNew: true,
              history: histories.get(c.id),
            });
            articles++;
            batch.added++;
            batch.throttles = 0;
            speedUp();
            batch.articleFailures = 0;
            batch.tokens =
              (batch.tokens || 0) + Number(result.classification?.tokens || 0);
            if (result.classification?.error)
              warn(c.id, String(result.classification.error));
          } catch (error) {
            if (error instanceof ThrottledError) {
              backOff(batch);
              done = false;
              halt = true;
            } else if (error instanceof ConflictError) {
              // Another worker holds this article; retry it on a later slice.
              done = false;
              halt = true;
            } else if ((batch.articleFailures || 0) < 2) {
              // Unexpected failure (e.g. a database write): retry on a later slice.
              batch.articleFailures = (batch.articleFailures || 0) + 1;
              await save();
              throw error;
            } else {
              // A persistent failure must not stall the run; report and move on.
              batch.articleFailures = 0;
              warn(
                c.id,
                `${article.title.slice(0, 120)}: skipped after repeated processing failures (${
                  error instanceof Error ? error.message : "unknown error"
                }).`,
              );
            }
          }
        }
        if (done) {
          batch.checked++;
          batch.pendingArticles.shift();
        }
      } else if (batch.sourceIndex >= sources.length) {
        if (batch.schedule) await finishScheduledCompany(store, c, batch);
        batch.completedCompanies++;
        batch.currentCompany = "";
        batch.sourceIndex = -1;
        batch.sourceErrors = [];
        histories.delete(c.id);
      } else {
        const source = batch.sourceIndex < 0 ? null : sources[batch.sourceIndex];
        const label = source
          ? `${source.label}${source.day ? ` (${source.day})` : ""}`
          : "Primary sources";
        try {
          let found: Article[];
          if (!source) {
            const primary = await discoverPrimary(c, env);
            found = primary.articles;
            for (const message of primary.errors) {
              warn(c.id, message);
              batch.sourceErrors = [
                ...(batch.sourceErrors || []),
                { feedId: "primary", message },
              ];
            }
            if (!found.length && !primary.errors.length && !c.feeds.length)
              warn(c.id, `${c.name}: no news sources are configured.`);
          } else {
            found = await fetchFeed(source.url, source.official, env);
            if (source.day)
              found = found.filter(
                (a) => a.publishedAt?.slice(0, 10) === source.day,
              );
          }
          batch.pendingArticles = selectBatchArticles(found, batch);
          batch.throttles = 0;
          speedUp();
          batch.sourceIndex++;
        } catch (error) {
          if (
            error instanceof ThrottledError &&
            (batch.throttles || 0) < THROTTLE_RETRIES - 1
          ) {
            backOff(batch);
            halt = true;
          } else {
            const message = `${label}: ${
              error instanceof ThrottledError
                ? `skipped after ${THROTTLE_RETRIES} rate-limited attempts (HTTP ${error.status}).`
                : error instanceof Error
                  ? error.message
                  : "Source unavailable"
            }`;
            warn(c.id, message);
            batch.sourceErrors = [
              ...(batch.sourceErrors || []),
              { feedId: source?.id || "primary", message },
            ];
            batch.throttles = 0;
            batch.sourceIndex++;
          }
        }
      }
      if (halt || ++unsaved >= 5) {
        await save();
        unsaved = 0;
        if (halt || batch.status !== "running") break;
      }
    }
    if (
      batch.status === "running" &&
      batch.completedCompanies === batch.companyIds.length
    ) {
      batch.status = "completed";
      batch.currentCompany = "";
      batch.finishedAt = new Date().toISOString();
      unsaved++;
    }
    if (unsaved) await save();
    return { busy: false, batch: newsBatchSummary(batch) };
  } finally {
    endHostTracking();
    await store.release(leaseFor(slot), lease);
  }
}
