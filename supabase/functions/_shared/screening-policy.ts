import type { DeskEvent, Doc } from "./model.ts";
import {
  decideFundamental,
  decideScreening,
  MAX_DEVELOPMENT_AGE_DAYS,
  type FundamentalDecision,
  type FundamentalSignals,
  type ScreeningSignals,
} from "./fundamental-policy.ts";

// v3 is headline-first; v2 assessments stay readable (their rules replay) until
// the nightly rescreen replaces them.
export const SCREENING_VERSION = "fundamental-v3";
export const LEGACY_SCREENING_VERSION = "fundamental-v2";
export { MAX_DEVELOPMENT_AGE_DAYS };
export const MAX_ARTICLE_CHARS = 120000;
export type ContentDepth =
  "full" | "partial" | "snippet" | "supplied" | "unavailable";
export interface NewsAssessment extends Partial<
  Omit<FundamentalDecision, "disposition" | "reason">
> {
  signals?: FundamentalSignals;
  // v3 judgments (headline-first).
  judgment?: ScreeningSignals;
  headlineOnly?: boolean;
  promptVersion?: string;
  cacheKey?: string;
  documentHash?: string;
  preferredSourceId?: string;
  coverageDuplicateOf?: string;
  evidenceBlock?: string;
  qualifyingEvidence?: string;
  rawAnswers?: Record<string, unknown>;
  readingCoverage?: { chunks: number; completed: number; reconciled: boolean };
  version: string;
  at: string;
  disposition: "relevant" | "uncertain" | "suppressed";
  reason: string;
  category: string;
  identity: number;
  materiality: number;
  quality: number;
  addedValue: number;
  evidenceSufficiency: number;
  primary: boolean;
  contentDepth: ContentDepth;
  charactersRead: number;
  availableCharacters: number;
  retrievalNote: string;
  possibleMajor: boolean;
  sourceUrl: string;
  comparisons?: { id: string; relation: string; probability: number }[];
  probabilities?: Record<string, Record<string, number>>;
  retryAfter?: string;
  attempts?: number;
  contextRevision?: number;
  reportedResults?: boolean;
  timeliness?: number;
  staleContent?: boolean;
  ageDays?: number | null;
}


export function articleAgeDays(
  publishedAt: string,
  now: Date | string = new Date(),
): number | null {
  const at = Date.parse(publishedAt);
  if (!publishedAt || !Number.isFinite(at)) return null;
  const reference = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (!Number.isFinite(reference)) return null;
  return (reference - at) / 86400000;
}

// Baseline annual/quarterly filings are deliberately retrieved once even when
// old; everything else must be recent to reach the inbox or the digest.
export function exemptFromAgeLimit(source: string): boolean {
  return /^SEC EDGAR$/i.test(source.trim());
}

export function staleDevelopment(
  publishedAt: string,
  now: Date | string = new Date(),
  maxAgeDays = MAX_DEVELOPMENT_AGE_DAYS,
): boolean {
  const age = articleAgeDays(publishedAt, now);
  return age !== null && age > maxAgeDays;
}

// Archive pages supply press releases with no date at all, so the reporting
// period named in the title is the only age evidence available without a model
// call. A fiscal year two or more years behind the current one is history.
// The previous year is kept: an annual report is published after its year ends.
export function staleTitlePeriod(
  title: string,
  now: Date | string = new Date(),
): boolean {
  const reference = typeof now === "string" ? new Date(now) : now;
  const thisYear = reference.getUTCFullYear();
  if (!Number.isFinite(thisYear)) return false;
  const years = [
    ...title.matchAll(
      /\b(?:fiscal|financial)\s*(?:year|yr)\s*(\d{4})\b|\bfy\s?(\d{4})\b|\b(?:q[1-4]|first|second|third|fourth)\s+(?:quarter\s+)?(?:of\s+)?(?:fiscal\s+)?(?:year\s+)?(\d{4})\b/gi,
    ),
  ]
    .flatMap((m) => [m[1], m[2], m[3]])
    .filter(Boolean)
    .map(Number)
    .filter((y) => y >= 1990 && y <= thisYear + 2);
  return years.length > 0 && Math.max(...years) < thisYear - 1;
}

// A reported release is useful even when its primary document cannot be retrieved.
// Keep previews, calendars and forecasts out of this narrow headline fallback.
export function reportsResults(title: string): boolean {
  if (
    /\b(will|to announce|to report|to release|preview|expects?|expected|estimates? ahead|schedule[ds]?|sets? date|upcoming)\b/i.test(
      title,
    )
  )
    return false;
  return (
    /\b(reports?|reported|releases?|released|announces?|announced|posts?|posted)\b.{0,100}\b((financial|quarter(?:ly)?|q[1-4]|annual|year.end)\b.{0,35}(results|earnings)|earnings results)\b/i.test(
      title,
    ) ||
    /\b(q[1-4]|quarter(?:ly)?|annual)\b.{0,45}\b(earnings|results)\b.{0,55}\b(beat|beats|miss|misses|rose|grew|fell|revenue|profit)\b/i.test(
      title,
    )
  );
}

// Admission-only changes reuse the saved judgments; they do not trigger another AI run.
// Title and publication-date rules are re-applied here so a policy change takes
// effect on previously screened items without paying for another model pass.
export function currentAssessment(
  e: DeskEvent,
  now: Date | string = new Date(),
): NewsAssessment | undefined {
  const a = e.screening;
  if (!a || e.classification?.error) return a;
  if (a.version === SCREENING_VERSION && a.judgment)
    return { ...a, ...decideScreening({ ...a, signals: a.judgment }) };
  if (a.version === LEGACY_SCREENING_VERSION && a.signals)
    return { ...a, ...decideFundamental({ ...a, signals: a.signals }) };
  if (a.version !== SCREENING_VERSION) return a;
  if (a.reasonCode) return a;
  if (
    a.retrievalNote.includes("Linked primary exhibit could not be read") &&
    a.primary
  )
    return a;
  const noise = obviousNoise(e.title);
  if (noise) return { ...a, disposition: "suppressed", reason: noise };
  const source = String(e.classification?.source || "");
  const ageDays = articleAgeDays(e.publishedAt, now);
  const updated = {
    ...a,
    reportedResults: a.reportedResults || reportsResults(e.title),
    ageDays,
    staleContent:
      a.staleContent ||
      (!exemptFromAgeLimit(source) &&
        (staleDevelopment(e.publishedAt, now) ||
          staleTitlePeriod(e.title, now))),
  };
  return { ...updated, ...decideNews(updated) };
}

export const EXCLUDED_CATEGORIES = new Set([
  "calendar",
  "routine_ownership",
  "options",
  "price_chatter",
  "promotion",
]);

// Only decisive headline patterns are rejected without inference. Exceptions go to the model.
export function obviousNoise(title: string): string | null {
  if (
    /\b(to announce|sets? (?:a |the )?date|schedules?|will (?:announce|release|report))\b.{0,90}\b(earnings|financial results|conference call)\b/i.test(
      title,
    ) &&
    !/\b(cuts?|raises?|warns?|delay|restat|preliminary|guidance)\b/i.test(title)
  )
    return "Calendar announcement; no actual financial results.";
  if (
    /\b(options activity|unusual options|options trading|options flow|options frenzy)\b/i.test(
      title,
    )
  )
    return "Options activity does not supply fundamental business evidence.";
  if (
    /\b(stake|holdings|shares)\b/i.test(title) &&
    /\b(increases?|decreases?|boosts?|trims?|reduces?|raises?|buys?|sells?|purchases?|acquires?)\b/i.test(
      title,
    ) &&
    /\b(capital management|wealth|asset management|advisors?|investment management|llc|ltd\.|inc\.)\b/i.test(
      title,
    ) &&
    !/\b(activist|control|takeover|strategic|board|tender|buyback|repurchase|insider|ceo|founder)\b/i.test(
      title,
    )
  )
    return "Routine investor holdings change; no operating or control development.";
  // Pundit and recommendation formats carry no company evidence. A real corporate
  // event named in the same title still goes to the model rather than being dropped.
  const substantive =
    /\b(results|earnings report|revenue|guidance|acquisition|acquires?|merger|lawsuit|sued|settlement|investigation|recall|bankrupt|insolven|restat|resign|steps? down|appoint|dividend|buyback|impair|writedown|write-down|default|covenant|contract|approval|licen[cs]e|layoff|strike|fire|outage|breach)\b/i.test(
      title,
    );
  if (
    !substantive &&
    /\b(jim cramer|mad money|cramer(?:'s)? (?:says|take|lightning round)|lightning round)\b/i.test(
      title,
    )
  )
    return "Television pundit commentary; no company evidence.";
  if (
    !substantive &&
    /\b(should you (?:buy|sell|own)|is it time to (?:buy|sell)|worth buying|a (?:buy|sell) right now|better buy|buy the dip|here'?s why|\d+ reasons? to (?:buy|sell)|(?:top|best|worst) \d*\s*stocks?|stocks? to (?:buy|watch|avoid)|millionaire|retirement riches)\b/i.test(
      title,
    )
  )
    return "Stock recommendation or listicle format; no fundamental evidence.";
  if (
    !substantive &&
    /\b(price target|target price)\b/i.test(title) &&
    /\b(raise[sd]?|lower[sd]?|cuts?|lifts?|boosts?|trims?|sets?|reiterat\w*|maintain\w*|upgrade[sd]?|downgrade[sd]?)\b/i.test(
      title,
    )
  )
    return "Analyst price-target action; not a business development.";
  return null;
}

export function excludedSource(
  source: string,
  url: string,
  excluded: string[],
): boolean {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* no URL */
  }
  return excluded.some((s) => {
    const entry = s
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");
    return (
      !!entry &&
      (host === entry ||
        host.endsWith("." + entry) ||
        source.toLowerCase().includes(entry))
    );
  });
}

export function decideNews(
  a: Omit<NewsAssessment, "disposition" | "reason">,
): Pick<NewsAssessment, "disposition" | "reason"> {
  if (a.judgment) return decideScreening({ ...a, signals: a.judgment });
  if (a.signals) return decideFundamental({ ...a, signals: a.signals });
  if (a.identity < 0.3)
    return {
      disposition: "suppressed",
      reason: "Different company or incidental mention.",
    };
  // Age is checked before the reported-results allowance: an old results release
  // is a historical document, not a development to act on this morning.
  if (a.staleContent)
    return {
      disposition: "suppressed",
      reason:
        typeof a.ageDays === "number" && a.ageDays > MAX_DEVELOPMENT_AGE_DAYS
          ? `Published ${Math.round(a.ageDays)} days ago; outside the current monitoring window.`
          : "Reports a past period rather than a current development.",
    };
  if (EXCLUDED_CATEGORIES.has(a.category) && !a.reportedResults)
    return {
      disposition: "suppressed",
      reason: "Routine calendar, ownership, trading or promotional content.",
    };
  if (a.identity < 0.8)
    return {
      disposition: "uncertain",
      reason: "Company connection needs verification.",
    };
  // A results headline is trustworthy on its own from the company itself. From a
  // third party it must at least have retrievable text behind it, otherwise any
  // aggregator that rewrites an earnings headline is promoted on the title alone.
  if (
    a.reportedResults &&
    (a.contentDepth === "snippet" || a.contentDepth === "unavailable")
  ) {
    if (!a.primary && a.availableCharacters <= 0)
      return {
        disposition: "uncertain",
        reason:
          "Results headline from a secondary source with no retrievable article text; verify against the company's own release.",
      };
    return {
      disposition: "relevant",
      reason:
        "Reported financial results — headline/snippet only. Open the source to verify the figures; the primary document has not been verified.",
    };
  }
  if (a.materiality < 1.8 && a.category !== "results" && !a.reportedResults)
    return {
      disposition: a.possibleMajor ? "uncertain" : "suppressed",
      reason: a.possibleMajor
        ? "Potentially important, but materiality remains uncertain."
        : "Too minor to inform the investment case at this company's scale.",
    };
  if (a.contentDepth === "snippet" || a.contentDepth === "unavailable")
    return {
      disposition: "uncertain",
      reason:
        "Insufficient article or document evidence; further verification needed.",
    };
  if (
    !a.primary &&
    (a.quality < 1 ||
      (a.category === "research" && (a.quality < 2 || a.addedValue < 2)))
  )
    return {
      disposition: "suppressed",
      reason:
        "Secondary coverage lacks supported business facts or substantive research.",
    };
  if (a.evidenceSufficiency < 0.7)
    return {
      disposition: "uncertain",
      reason:
        "Insufficient article or document evidence; further verification needed.",
    };
  return {
    disposition: "relevant",
    reason: a.primary
      ? a.category === "results"
        ? "Primary financial results: substantive evidence about business performance."
        : "Primary disclosure with fundamental significance."
      : "Secondary reporting of a substantive development; primary source preferred when available.",
  };
}

// Which article leads a development when several sources report it. Without
// the text, a secondary source is judged by provenance: the company's own
// release, then established newsrooms, then other reporting; aggregators and
// investing templates rank last. Reading the text adds only a little.
const ESTABLISHED_NEWSROOMS =
  /(^|\.)(reuters|bloomberg|wsj|ft|apnews|cnbc|nytimes|economist|barrons|marketwatch|theglobeandmail|afr|nikkei|insurancejournal)\.(com|co\.uk|com\.au|co\.jp)$|^(reuters|bloomberg|the wall street journal|financial times|associated press|cnbc|the new york times|the economist|barron's|marketwatch|the globe and mail|australian financial review|nikkei asia)$/i;
const TEMPLATE_PUBLISHERS =
  /(simplywall\.st|simply wall st|marketbeat|zacks|fool\.com|motley fool|gurufocus|ad-hoc-news|stocktitan|stock titan|tipranks|247wallst|24\/7 wall st|insidermonkey|insider monkey|investorplace|stocktradersdaily|stock traders daily|kalkine|quiverquant|tradingview|benzinga)/i;
export function sourceQuality(
  e: Pick<DeskEvent, "url" | "title" | "classification" | "screening">,
) {
  let host = "";
  try {
    host = new URL(e.screening?.sourceUrl || e.url).hostname.replace(
      /^www\./,
      "",
    );
  } catch {
    /* no URL */
  }
  const source = String(e.classification?.source || "");
  // Google News headlines end with " - Publisher" when the link is unresolved.
  const names = [
    /^https?:/.test(source) ? "" : source.trim(),
    e.title.lastIndexOf(" - ") > 0
      ? e.title.slice(e.title.lastIndexOf(" - ") + 3).trim()
      : "",
  ].filter(Boolean);
  const any = (re: RegExp) => re.test(host) || names.some((n) => re.test(n));
  if (any(TEMPLATE_PUBLISHERS)) return -20;
  if (any(ESTABLISHED_NEWSROOMS)) return 25;
  return 0;
}
export function screeningRank(e: DeskEvent): number {
  const a = e.screening;
  if (a?.judgment) {
    const role = currentAssessment(e)?.articleRole;
    return (
      (e.feedback === "useful" ? 1000 : 0) +
      (role === "primary_reading"
        ? 300
        : role === "news_report"
          ? 150
          : role === "analytical_addition"
            ? 140
            : role === "pending_verification"
              ? 50
              : role === "coverage_only"
                ? 20
                : 0) +
      sourceQuality(e) +
      (a.judgment.textRead ? 10 : 0)
    );
  }
  if (a?.signals)
    return (
      (e.feedback === "useful" ? 1000 : 0) +
      (a.articleRole === "primary_reading"
        ? 300
        : a.articleRole === "analytical_addition"
          ? 200
          : a.articleRole === "pending_verification"
            ? 50
            : 0)
    );
  return (
    (e.feedback === "useful" ? 100 : 0) +
    (currentAssessment(e)?.disposition === "relevant" ? 50 : 0) +
    (a?.contentDepth === "snippet" || a?.contentDepth === "unavailable"
      ? -40
      : 0) +
    (a?.primary ? 30 : 0) +
    (a?.quality || 0) * 3 +
    (a?.addedValue || 0) * 2 +
    (a?.contentDepth === "full" ? 2 : 0)
  );
}

// Importance ordering for the digest: what deserves the reader's first minute.
// Distinct from screeningRank, which picks the best article within one cluster.
export function digestImportance(
  e: DeskEvent,
  now: Date | string = new Date(),
): number {
  const a = currentAssessment(e);
  const age = articleAgeDays(e.publishedAt, now);
  if (a?.signals || a?.judgment)
    return (
      (eventPriorityRank(e) === "major"
        ? 300
        : a.disposition === "relevant"
          ? 200
          : 100) + Math.max(0, Math.min(45, 45 - (age ?? 45)))
    );
  return (
    (e.feedback === "useful" ? 40 : 0) +
    (a?.disposition === "relevant" ? 30 : 0) +
    (eventPriorityRank(e) === "major" ? 25 : 0) +
    (a?.materiality || 0) * 10 +
    (a?.primary ? 8 : 0) +
    (a?.quality || 0) * 2 +
    (a?.addedValue || 0) * 1.5 +
    (a?.contentDepth === "snippet" || a?.contentDepth === "unavailable"
      ? -10
      : 0) +
    // Prefer today's news over a development already a week old.
    (age === null ? -4 : Math.max(-8, 6 - age))
  );
}

// Local copy of the priority rule; screening-policy must not import news.ts,
// which imports this module.
function eventPriorityRank(e: DeskEvent): DeskEvent["priority"] {
  const a = currentAssessment(e);
  if (e.kind !== "news" || !a) return e.priority;
  if (a.disposition === "suppressed") return "suppressed";
  if (a.disposition === "uncertain") return "possible";
  const meaningful = meaningfulOf(a);
  return (meaningful !== undefined ? meaningful >= 0.7 : a.materiality >= 2.8)
    ? "major"
    : "normal";
}

export interface NewsGroup {
  lead: Doc<DeskEvent>;
  coverage: Doc<DeskEvent>[];
  additions?: Doc<DeskEvent>[];
}
// Input must already have its view/feedback filters applied; hidden/noise sources cannot become the lead.
export function groupNews(docs: Doc<DeskEvent>[]): NewsGroup[] {
  const grouped = new Map<string, Doc<DeskEvent>[]>();
  const ranks = new Map<Doc<DeskEvent>, number>();
  for (const doc of docs) {
    const key =
      doc.data.kind === "news"
        ? `${doc.data.companyId}:${doc.data.clusterId || doc.id}`
        : doc.id;
    const items = grouped.get(key);
    if (items) items.push(doc);
    else grouped.set(key, [doc]);
    ranks.set(doc, screeningRank(doc.data));
  }
  return [...grouped.values()]
    .map((items) => {
      items.sort(
        (a, b) =>
          ranks.get(b)! - ranks.get(a)! ||
          a.data.discoveredAt.localeCompare(b.data.discoveredAt),
      );
      return {
        lead: items[0],
        coverage: items.slice(1),
        additions: items
          .slice(1)
          .filter(
            (d) => d.data.screening?.articleRole === "analytical_addition",
          ),
        latest: items.reduce(
          (at, d) => (d.data.discoveredAt > at ? d.data.discoveredAt : at),
          "",
        ),
      };
    })
    .sort((a, b) => b.latest.localeCompare(a.latest))
    .map(({ lead, coverage, additions }) => ({ lead, coverage, additions }));
}

// P(significance level 3-4) for v3 or v2 judgments; undefined for older ones.
export function meaningfulOf(a?: NewsAssessment): number | undefined {
  return a?.judgment?.meaningful ?? a?.signals?.meaningful;
}
