import type { Company, DeskEvent } from "./model.ts";
import {
  LEGACY_SCREENING_VERSION,
  SCREENING_VERSION,
  currentAssessment,
  meaningfulOf,
} from "./screening-policy.ts";

export function cleanNewsText(value: string): string {
  // RSS commonly embeds escaped HTML. Decode only bounded, standard entities;
  // strip markup afterwards and render the result as text, never HTML.
  let text = value;
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (match, code: string) => {
        if (code[0] !== "#") return entities[code.toLowerCase()] || match;
        const point =
          code[1].toLowerCase() === "x"
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10);
        return point > 0 &&
          point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point)
          : " ";
      },
    );
  }
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function newsSource(e: DeskEvent): string {
  const source = String(e.classification?.source || "");
  if (!source.startsWith("https://")) return cleanNewsText(source);
  const separator = e.title.lastIndexOf(" - ");
  if (separator !== -1) return cleanNewsText(e.title.slice(separator + 3));
  try {
    return new URL(source).hostname;
  } catch {
    return "Unknown source";
  }
}

export type NewsView =
  "relevant" | "uncertain" | "suppressed" | "coverage" | "all";

// Apply the same policy to historical judgments, new items, the inbox and digests.
export function newsBucket(e: DeskEvent): Exclude<NewsView, "all"> {
  if (e.feedback === "noise") return "suppressed";
  if (e.feedback === "useful" || e.kind === "price") return "relevant";
  if (
    e.screening?.version === SCREENING_VERSION ||
    e.screening?.version === LEGACY_SCREENING_VERSION
  ) {
    const a = currentAssessment(e)!;
    return a.articleRole === "coverage_only" ? "coverage" : a.disposition;
  }
  if (e.kind === "health" || e.classification?.error) return "uncertain";
  const identity = e.classification?.identity;
  if (typeof identity !== "number" || !Number.isFinite(identity))
    return "uncertain";
  if (identity < 0.3) return "suppressed";
  return "uncertain"; // Historical identity-only judgments await fundamental screening.
}

export function newsPriority(result: {
  identity: number;
  major: number;
  evidence: string;
  matches: { relevance: number }[];
  screening?: import("./screening-policy.ts").NewsAssessment;
}): DeskEvent["priority"] {
  if (result.screening) {
    if (result.screening.disposition === "suppressed") return "suppressed";
    if (result.screening.disposition === "uncertain") return "possible";
    const meaningful = meaningfulOf(result.screening);
    return (
      meaningful !== undefined
        ? meaningful >= 0.7
        : result.screening.materiality >= 2.8
    )
      ? "major"
      : "normal";
  }
  if (result.identity < 0.3) return "suppressed";
  if (result.identity < 0.7) return "possible";
  if (result.major >= 0.65 && result.evidence) return "major";
  if (result.matches.some((x) => x.relevance >= 0.35)) return "possible";
  return "normal";
}

export function eventPriority(e: DeskEvent): DeskEvent["priority"] {
  if (e.kind !== "news" || !e.screening) return e.priority;
  const bucket = newsBucket(e);
  return bucket === "suppressed"
    ? "suppressed"
    : bucket === "uncertain"
      ? "possible"
      : (
            meaningfulOf(e.screening) !== undefined
              ? meaningfulOf(e.screening)! >= 0.7
              : e.screening.materiality >= 2.8
          )
        ? "major"
        : "normal";
}

export function companyNewsQuery(
  c: Pick<Company, "name" | "ticker"> & { newsQuery?: string },
) {
  if (c.newsQuery?.trim()) return c.newsQuery.trim();
  const name = c.name
    .replace(/\([^)]*\)/g, "")
    .replace(/"/g, "")
    .trim();
  if (/^(the )?progressive( corporation| corp\.?)?$/i.test(name))
    return '"Progressive" (insurance OR insurer OR "PGR")';
  return `"${name}"${name.split(/\s+/).length === 1 ? " (company OR stock OR earnings OR business)" : ""}`;
}

export function companyNewsUrl(
  c: Pick<Company, "name" | "ticker"> & { newsQuery?: string },
  lookbackDays = 10,
) {
  return `https://news.google.com/rss/search?${new URLSearchParams({ q: `${companyNewsQuery(c)} when:${lookbackDays}d`, hl: "en-US", gl: "US", ceid: "US:en" })}`;
}

export function isDefaultNewsFeed(feed: { url: string; label: string }) {
  try {
    const url = new URL(feed.url);
    return (
      url.hostname === "news.google.com" &&
      url.pathname === "/rss/search" &&
      /^Google News · (broad headlines|company news)$/.test(feed.label)
    );
  } catch {
    return false;
  }
}

// UTC calendar days, including today. Preserve Google's relevance order within each day.
export function newsSearchDays(at: string, days = 7): string[] {
  const today = Date.parse(at.slice(0, 10));
  return Array.from({ length: days }, (_, i) =>
    new Date(today - i * 86400000).toISOString().slice(0, 10),
  );
}
export function companyNewsDayUrl(
  c: Pick<Company, "name" | "ticker"> & { newsQuery?: string },
  day: string,
) {
  const before = new Date(Date.parse(day) + 86400000)
    .toISOString()
    .slice(0, 10);
  return `https://news.google.com/rss/search?${new URLSearchParams({ q: `${companyNewsQuery(c)} after:${day} before:${before}`, hl: "en-US", gl: "US", ceid: "US:en" })}`;
}
