import { XMLParser } from "fast-xml-parser";
import { QuoteSchema, type Company } from "./model.ts";
import { hash, safeLink } from "./engine.ts";
import { cleanNewsText } from "./news.ts";

export type Env = Record<string, string | undefined>;
export interface Article {
  id: string;
  title: string;
  url: string;
  text: string;
  publishedAt: string;
  source: string;
  official: boolean;
  contentDepth?: import("./screening-policy.ts").ContentDepth;
  availableCharacters?: number;
  retrievalNote?: string;
  extractedTitle?: string;
  primaryReference?: {
    id: string;
    url: string;
    title: string;
    text: string;
    publishedAt: string;
  };
}
export interface Judgment {
  identity: number;
  major: number;
  event: string;
  evidence: string;
  matches: { text: string; relevance: number; direction: string }[];
  model: string;
  tokens: number;
  screening: import("./screening-policy.ts").NewsAssessment;
}
export function configuration(env: Env) {
  const requestedBudget = Number(env.TYPESAFE_MONTHLY_BUDGET_USD ?? 5);
  return {
    typesafe: !!env.TYPESAFE_API_KEY,
    model: env.TYPESAFE_MODEL || "jev-1.13.0",
    modelInputPricePerMillion: 0.042,
    credential: "TYPESAFE_API_KEY · Supabase server secret",
    modelBudget:
      Number.isFinite(requestedBudget) && requestedBudget >= 0
        ? Math.min(requestedBudget, 10)
        : 5,
    eodhd: !!env.EODHD_API_KEY,
    fmp: false,
    email:
      !!env.RESEND_API_KEY &&
      !!env.DIGEST_FROM &&
      env.ENABLE_EMAIL_DELIVERY === "true",
    recipient: env.DIGEST_TO || "nithin@mantena.com",
    feedHosts: (env.ALLOWED_FEED_HOSTS || "news.google.com")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  };
}

async function boundedFetch(
  url: string,
  options: RequestInit = {},
  maxBytes = 1500000,
): Promise<string> {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
  if (Number(response.headers.get("content-length")) > maxBytes)
    throw new Error("Source exceeds size limit.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty source response.");
  let bytes = 0;
  let result = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new Error("Source exceeds size limit.");
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
  } finally {
    await reader.cancel();
  }
  return result;
}
export function validateFeedUrl(value: string, env: Env): string {
  const url = new URL(value);
  const allowed = configuration(env).feedHosts;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !allowed.includes(url.hostname.toLowerCase()) ||
    /^(localhost|.*\.local|.*\.internal|\d+(?:\.\d+){3}|\[.*\])$/i.test(
      url.hostname,
    )
  )
    throw new Error(
      "Feed host must be explicitly enabled in ALLOWED_FEED_HOSTS on the server.",
    );
  return url.toString();
}
const plain = (value: unknown) =>
  cleanNewsText(
    String(
      typeof value === "object" && value
        ? (value as any)["#text"] || ""
        : value || "",
    ),
  );
const list = <T>(x: T | T[] | undefined): T[] =>
  x == null ? [] : Array.isArray(x) ? x : [x];
export async function parseFeed(
  xml: string,
  source: string,
  official: boolean,
): Promise<Article[]> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Unsupported XML declarations.");
  const parsed = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
  }).parse(xml);
  const items = list<any>(
    parsed?.rss?.channel?.item ||
      parsed?.feed?.entry ||
      parsed?.["rdf:RDF"]?.item,
  );
  if (!parsed?.rss && !parsed?.feed && !parsed?.["rdf:RDF"])
    throw new Error("This address did not return RSS or Atom.");
  return Promise.all(
    items.slice(0, 300).map(async (item) => {
      const links = list<any>(item.link);
      const link = links.find((x) => x?.["@_rel"] === "alternate") || links[0];
      const url = safeLink(
        typeof link === "string" ? link : link?.["@_href"] || "",
      );
      const date = new Date(
        item.pubDate || item.published || item.updated || item["dc:date"],
      );
      const title = plain(item.title).slice(0, 1000);
      const text = plain(
        item["content:encoded"] ||
          item.content ||
          item.description ||
          item.summary,
      ).slice(0, 120000);
      return {
        id: await hash(
          `${url || source}|${title}|${Number.isFinite(date.getTime()) ? date.toISOString() : ""}`,
        ),
        title,
        url,
        text,
        publishedAt: Number.isFinite(date.getTime()) ? date.toISOString() : "",
        source: plain(item.source) || source,
        official,
        contentDepth:
          item["content:encoded"] || item.content
            ? ("partial" as const)
            : ("snippet" as const),
      };
    }),
  );
}
export async function fetchFeed(url: string, official: boolean, env: Env) {
  return parseFeed(
    await boundedFetch(validateFeedUrl(url, env), {
      headers: {
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml",
        "User-Agent":
          env.FEED_USER_AGENT || "ResearchDesk/0.1 (private stock research)",
      },
    }),
    url,
    official,
  );
}

export async function fetchQuotes(c: Company, env: Env, now = new Date()) {
  if (c.provider !== "eodhd")
    throw new Error(
      c.provider === "none"
        ? "No quote provider configured."
        : "FMP is not enabled in this version.",
    );
  if (!env.EODHD_API_KEY) throw new Error("EODHD API key is not configured.");
  if (!/^[A-Za-z0-9_.-]{1,70}$/.test(c.providerSymbol) || !c.currency)
    throw new Error(
      "Confirm the provider symbol and native trading currency first.",
    );
  const since = c.lastQuoteCheck
    ? Math.max(
        now.getTime() - 35 * 86400000,
        new Date(c.lastQuoteCheck).getTime() - 2 * 86400000,
      )
    : now.getTime() - 9 * 86400000;
  const params = new URLSearchParams({
    api_token: env.EODHD_API_KEY,
    fmt: "json",
    period: "d",
    order: "a",
    from: new Date(since).toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  });
  const data: unknown = JSON.parse(
    await boundedFetch(
      `https://eodhd.com/api/eod/${encodeURIComponent(c.providerSymbol)}?${params}`,
    ),
  );
  if (!Array.isArray(data))
    throw new Error(
      "Provider returned no usable EOD series. Check symbol and subscription coverage.",
    );
  const quotes = data
    .flatMap((row) => {
      const result = QuoteSchema.safeParse({
        price: row.close,
        currency: c.currency,
        session: row.date,
        fetchedAt: now.toISOString(),
        source: `EODHD · ${c.providerSymbol}`,
        pe: null,
        marketCap: null,
      });
      return result.success ? [result.data] : [];
    })
    .filter((q) => q.session <= now.toISOString().slice(0, 10));
  if (!quotes.length)
    throw new Error("No eligible closes found. Coverage may be unavailable.");
  return quotes;
}

// Kept as the public adapter entry point for callers and evaluation scripts.
export { screenArticle as classifyArticle } from "./news-screening.ts";
