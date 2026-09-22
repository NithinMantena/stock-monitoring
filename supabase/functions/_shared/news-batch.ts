import { ConflictError, type Company, type Store } from "./model.ts";
import { discoverPrimary } from "./article-content.ts";
import {
  companyNewsUrl,
  companyNewsDayUrl,
  isDefaultNewsFeed,
  newsSearchDays,
} from "./news.ts";
import { fetchFeed, type Article, type Env } from "./providers.ts";
import { processArticle } from "./jobs.ts";

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
  currentCompany: string;
  sourceIndex: number;
  pendingArticles: Article[];
  checked: number;
  added: number;
  warningCount: number;
  warnings: { companyId: string; message: string }[];
}
export type NewsBatchSummary = Omit<
  NewsBatch,
  "pendingArticles" | "sourceIndex" | "companyIds"
> & { totalCompanies: number };
export function newsBatchSummary(
  batch?: NewsBatch | null,
): NewsBatchSummary | null {
  if (!batch) return null;
  const {
    pendingArticles: _pending,
    sourceIndex: _source,
    companyIds,
    ...summary
  } = batch;
  return { ...summary, totalCompanies: companyIds.length };
}

// A separate queue, lease, and progress record: manual searches never alter regular monitoring's clocks.
export async function startNewsBatch(
  store: Store,
  input: {
    id: string;
    companyIds: string[];
    label: string;
    lookbackDays?: number;
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
      (await store.list<Company>("company", { summary: true })).map(
        (d) => d.id,
      ),
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
      createdAt: at,
      updatedAt: at,
      status: "running",
      lookbackDays: input.lookbackDays ?? 7,
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
    await store.batch([
      ...(old && !(await store.get("news_batch", old.data.id)) ? [{ kind: "news_batch", id: old.data.id, data: old.data, expected: 0 }] : []),
      { kind: "news_batch", id: "latest", data: batch, expected: old?.version || 0 },
    ]);
    return newsBatchSummary(batch)!;
  } finally {
    await store.release("manual-news-batch", lease);
  }
}

// Controls must remain available while the worker holds its lease. Optimistic writes
// let the worker preserve both the user's latest command and completed article work.
export async function controlNewsBatch(
  store: Store,
  id: string,
  action: "pause" | "resume" | "cancel",
) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const doc = await store.get<NewsBatch>("news_batch", "latest");
    if (!doc || doc.data.id !== id) throw new ConflictError();
    const batch = structuredClone(doc.data);
    if (batch.status === "completed" || batch.status === "cancelled")
      return newsBatchSummary(batch)!;
    batch.status =
      action === "pause"
        ? "paused"
        : action === "resume"
          ? "running"
          : "cancelled";
    batch.updatedAt = new Date().toISOString();
    if (action === "cancel") batch.finishedAt = batch.updatedAt;
    try {
      await store.put("news_batch", "latest", batch, doc.version);
      return newsBatchSummary(batch)!;
    } catch (error) {
      if (!(error instanceof ConflictError) || attempt === 7) throw error;
    }
  }
  throw new ConflictError();
}

export function selectBatchArticles(
  articles: Article[],
  batch: NewsBatch,
): Article[] {
  const cutoff =
    Date.parse(batch.createdAt.slice(0, 10)) -
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

export async function advanceNewsBatch(
  store: Store,
  env: Env,
  options: { id?: string; milliseconds?: number; maxSteps?: number } = {},
) {
  const lease = await store.claim("manual-news-batch", 600);
  if (!lease)
    return {
      busy: true,
      batch: newsBatchSummary(
        (await store.get<NewsBatch>("news_batch", "latest"))?.data,
      ),
    };
  const start = Date.now();
  try {
    let doc = await store.get<NewsBatch>("news_batch", "latest");
    if (!doc || doc.data.status !== "running")
      return { busy: false, batch: newsBatchSummary(doc?.data) };
    if (options.id && options.id !== doc.data.id) throw new ConflictError();
    const batch = structuredClone(doc.data);
    const warn = (companyId: string, message: string) => {
      batch.warningCount++;
      if (batch.warnings.length < 100)
        batch.warnings.push({ companyId, message: message.slice(0, 500) });
    };
    const save = async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const fresh = await store.get<NewsBatch>("news_batch", "latest");
        if (!fresh || fresh.data.id !== batch.id) throw new ConflictError();
        if (fresh.data.status !== "running") {
          batch.status = fresh.data.status;
          batch.finishedAt = fresh.data.finishedAt;
        }
        batch.updatedAt = new Date().toISOString();
        try {
          doc = await store.put("news_batch", "latest", batch, fresh.version);
          return;
        } catch (error) {
          if (!(error instanceof ConflictError) || attempt === 7) throw error;
        }
      }
    };
    let steps = 0;
    while (
      batch.completedCompanies < batch.companyIds.length &&
      Date.now() - start < (options.milliseconds ?? 25000) &&
      steps < (options.maxSteps ?? 100)
    ) {
      const control = await store.get<NewsBatch>("news_batch", "latest");
      if (control?.data.status !== "running")
        return { busy: false, batch: newsBatchSummary(control?.data) };
      steps++;
      const companyId = batch.companyIds[batch.completedCompanies];
      const current = await store.get<Company>("company", companyId);
      if (!current) {
        warn(companyId, "Company no longer exists; skipped.");
        batch.pendingArticles = [];
        batch.sourceIndex = -1;
        batch.completedCompanies++;
        await save();
        continue;
      }
      const c = current.data;
      const sources = c.feeds.flatMap((feed) =>
        batch.dailySearch && isDefaultNewsFeed(feed)
          ? newsSearchDays(batch.createdAt, batch.lookbackDays ?? 7).map(
              (day) => ({ ...feed, url: companyNewsDayUrl(c, day), day }),
            )
          : [
              {
                ...feed,
                url: isDefaultNewsFeed(feed) ? companyNewsUrl(c) : feed.url,
                day: "",
              },
            ],
      );
      batch.currentCompany = c.name;
      if (batch.pendingArticles.length) {
        const article = batch.pendingArticles[0];
        if (!(await store.get("event", `news-${c.id}-${article.id}`))) {
          const result = await processArticle(c, article, store, env);
          batch.added++;
          batch.tokens =
            (batch.tokens || 0) + Number(result.classification?.tokens || 0);
          if (result.classification?.error)
            warn(c.id, String(result.classification.error));
        }
        batch.checked++;
        batch.pendingArticles.shift();
      } else if (batch.sourceIndex >= sources.length) {
        batch.completedCompanies++;
        batch.currentCompany = "";
        batch.sourceIndex = -1;
      } else {
        try {
          let articles: Article[];
          if (batch.sourceIndex === -1) {
            const primary = await discoverPrimary(c, env);
            articles = primary.articles;
            for (const message of primary.errors) warn(c.id, message);
            if (!articles.length && !primary.errors.length && !c.feeds.length)
              warn(c.id, `${c.name}: no news sources are configured.`);
          } else {
            const feed = sources[batch.sourceIndex];
            articles = await fetchFeed(feed.url, feed.official, env);
            if (feed.day)
              articles = articles.filter(
                (a) => a.publishedAt?.slice(0, 10) === feed.day,
              );
          }
          batch.pendingArticles = selectBatchArticles(articles, batch);
        } catch (error) {
          warn(
            c.id,
            `${batch.sourceIndex < 0 ? "Primary sources" : sources[batch.sourceIndex].label}: ${error instanceof Error ? error.message : "Source unavailable"}`,
          );
        }
        batch.sourceIndex++;
      }
      await save();
      if (batch.status !== "running") break;
    }
    if (
      batch.status === "running" &&
      batch.completedCompanies === batch.companyIds.length
    ) {
      batch.status = "completed";
      batch.currentCompany = "";
      batch.finishedAt = new Date().toISOString();
      await save();
    }
    return { busy: false, batch: newsBatchSummary(batch) };
  } finally {
    await store.release("manual-news-batch", lease);
  }
}
