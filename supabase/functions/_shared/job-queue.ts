import { z } from "zod";
import { ConflictError, type Company, type Store } from "./model.ts";
import { processArticle, rescreenNews, runMonitor } from "./jobs.ts";
import { hash, safeLink } from "./engine.ts";
import type { Env } from "./providers.ts";
import { MAX_ARTICLE_CHARS } from "./screening-policy.ts";

export const JobInput = z
  .object({
    type: z.enum(["monitor", "rescreen", "analyze"]),
    companyId: z.string().max(100).optional(),
    article: z
      .object({
        title: z.string().min(1).max(1000),
        text: z.string().min(1).max(MAX_ARTICLE_CHARS),
        url: z.string().max(2000).default(""),
        publishedAt: z.string().max(40).default(""),
      })
      .optional(),
  })
  .strict();
export interface Job {
  id: string;
  type: "monitor" | "rescreen" | "analyze";
  status:
    "queued" | "running" | "paused" | "cancelled" | "completed" | "failed";
  companyIds: string[];
  cursor: number;
  processed: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  article?: z.infer<typeof JobInput>["article"];
  result?: unknown;
}
export function jobSummary(j: Job) {
  const { article: _article, companyIds, ...rest } = j;
  return { ...rest, totalCompanies: companyIds.length };
}
export async function enqueueJob(store: Store, input: unknown) {
  const parsed = JobInput.parse(input);
  if (parsed.article) parsed.article.url = safeLink(parsed.article.url);
  if (parsed.type === "analyze" && (!parsed.companyId || !parsed.article))
    throw new Error("Analysis requires a company and supplied article.");
  const companies = await store.list<Company>("company", { summary: true });
  if (parsed.companyId && !companies.some((c) => c.id === parsed.companyId))
    throw new Error("Company not found.");
  const ids = companies
    .filter((c) =>
      parsed.companyId
        ? c.id === parsed.companyId
        : !c.data.archived && c.data.cadence !== "paused",
    )
    .map((c) => c.id);
  const at = new Date().toISOString(),
    id = crypto.randomUUID();
  const doc = await store.put<Job>(
    "job",
    id,
    {
      id,
      type: parsed.type,
      article: parsed.article,
      companyIds: ids,
      cursor: 0,
      processed: 0,
      status: "queued",
      createdAt: at,
      updatedAt: at,
    },
    0,
  );
  return jobSummary(doc.data);
}
export async function controlJob(
  store: Store,
  id: string,
  action: "pause" | "resume" | "cancel",
) {
  for (let i = 0; i < 8; i++) {
    const doc = await store.get<Job>("job", id);
    if (!doc) throw new Error("Job not found.");
    if (["completed", "cancelled"].includes(doc.data.status))
      return jobSummary(doc.data);
    const next: Job = {
      ...doc.data,
      status:
        action === "pause"
          ? "paused"
          : action === "resume"
            ? "queued"
            : "cancelled",
      updatedAt: new Date().toISOString(),
      error: "",
    };
    try {
      await store.put("job", id, next, doc.version);
      return jobSummary(next);
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  throw new ConflictError();
}
export async function advanceJob(store: Store, env: Env, id?: string) {
  const candidate = id
    ? await store.get<Job>("job", id)
    : (await store.list<Job>("job"))
        .reverse()
        .find((d) => ["queued", "running"].includes(d.data.status));
  if (!candidate || !["queued", "running"].includes(candidate.data.status))
    return candidate ? jobSummary(candidate.data) : null;
  const lease = await store.claim(`api-job-${candidate.id}`, 600);
  if (!lease) return jobSummary(candidate.data);
  try {
    const fresh = await store.get<Job>("job", candidate.id);
    if (!fresh || !["queued", "running"].includes(fresh.data.status))
      return fresh ? jobSummary(fresh.data) : null;
    const j = { ...fresh.data, status: "running" as Job["status"] };
    await store.put(
      "job",
      j.id,
      { ...j, updatedAt: new Date().toISOString() },
      fresh.version,
    );
    try {
      const companyId = j.companyIds[j.cursor];
      if (companyId) {
        if (j.type === "monitor") {
          const result = await runMonitor(store, env, {
            companyId,
            force: true,
          });
          if (!result.busy) {
            j.cursor++;
            j.processed++;
          }
          j.result = result;
        } else if (j.type === "rescreen") {
          const result = await rescreenNews(store, env, {
            companyId,
            limit: 1,
            milliseconds: 20000,
          });
          if (!result.busy) {
            j.processed += result.processed;
            if (!result.remaining) j.cursor++;
          }
          j.result = result;
        } else {
          const company = await store.get<Company>("company", companyId);
          if (!company || !j.article)
            throw new Error("Company or supplied article is unavailable.");
          const result = await processArticle(
            company.data,
            {
              ...j.article,
              id: await hash(
                `${j.article.title}|${j.article.text}|${j.article.url}`,
              ),
              official: false,
              source: "Manually supplied article",
              contentDepth: "supplied",
            },
            store,
            env,
          );
          j.result = { eventId: result.id };
          j.processed++;
          j.cursor++;
        }
      }
      if (j.cursor >= j.companyIds.length) j.status = "completed";
    } catch (error) {
      j.status = "failed";
      j.error = (error as Error).message;
    }
    for (let i = 0; i < 8; i++) {
      const latest = (await store.get<Job>("job", j.id))!;
      if (["paused", "cancelled"].includes(latest.data.status))
        j.status = latest.data.status;
      try {
        await store.put(
          "job",
          j.id,
          { ...j, updatedAt: new Date().toISOString() },
          latest.version,
        );
        return jobSummary(j);
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }
    throw new ConflictError();
  } finally {
    await store.release(`api-job-${candidate.id}`, lease);
  }
}
