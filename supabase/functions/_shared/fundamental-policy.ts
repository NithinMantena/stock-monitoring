// Admission thresholds are application policy, not model confidence scores.
export const POLICY_VERSION = "fundamental-policy-2.0.0";
export interface FundamentalSignals {
  useful: number;
  meaningful: number;
  attributed: number;
  unsupported: number;
  absent: number;
  incremental: number;
  recap: number;
  current: number;
  historical: number;
  analyticalQuality: number;
  misleading: number;
  missingContext: number;
  alignment: "aligned" | "different_document" | "unclear";
  consistency: "coherent" | "corrected" | "conflicting" | "unknown";
  evidenceVerified: boolean;
  partial: boolean;
}
export type DevelopmentStatus =
  "relevant" | "uncertain" | "irrelevant" | "historical";
export type ArticleRole =
  | "primary_reading"
  | "analytical_addition"
  // v3: a secondary report of a relevant development. It is shown under the
  // development's best source rather than demoted to Coverage.
  | "news_report"
  | "coverage_only"
  | "pending_verification"
  | "rejected";
export interface FundamentalDecision {
  disposition: "relevant" | "uncertain" | "suppressed";
  development: { status: DevelopmentStatus };
  articleRole: ArticleRole;
  reasonCode: string;
  reason: string;
  policyVersion: string;
  needsPreferredSource: boolean;
}
export function decideFundamental(a: {
  identity: number;
  primary: boolean;
  contentDepth: string;
  retrievalNote: string;
  preferredSourceId?: string;
  coverageDuplicateOf?: string;
  signals: FundamentalSignals;
}): FundamentalDecision {
  const s = a.signals;
  const result = (
    status: DevelopmentStatus,
    role: ArticleRole,
    code: string,
    reason: string,
  ): FundamentalDecision => ({
    disposition:
      role === "primary_reading" ||
      role === "analytical_addition" ||
      role === "news_report"
        ? "relevant"
        : role === "pending_verification"
          ? "uncertain"
          : "suppressed",
    development: { status },
    articleRole: role,
    reasonCode: code,
    reason,
    policyVersion: POLICY_VERSION,
    needsPreferredSource: role === "coverage_only" && !a.preferredSourceId,
  });
  const verify = (code: string, reason: string) =>
    result("uncertain", "pending_verification", code, reason);
  const reject = (code: string, reason: string) =>
    result("irrelevant", "rejected", code, reason);
  // Extraction failures must not masquerade as wrong-company or immaterial judgments.
  if (["snippet", "unavailable"].includes(a.contentDepth))
    return verify(
      "missing_text",
      "The article body could not be verified. Open the source or retry retrieval.",
    );
  if (s.alignment !== "aligned")
    return verify(
      "extraction_mismatch",
      "The retrieved document may not match the headline. Verify the source text.",
    );
  if (s.consistency === "conflicting" || s.consistency === "unknown")
    return verify(
      "conflicting_evidence",
      "The document contains unresolved or incomplete evidence. Review its qualifications and corrections.",
    );
  if (
    a.retrievalNote.includes("Linked primary exhibit could not be read") ||
    s.partial
  )
    return verify(
      "incomplete_document",
      "Only part of the document or its supporting exhibits was read; verify the complete disclosure.",
    );
  if (a.identity < 0.2)
    return reject(
      "wrong_entity",
      "The evidence concerns another company without a documented exposure.",
    );
  if (s.historical >= 0.8)
    return result(
      "historical",
      "rejected",
      "historical_only",
      "Historical information without a new current implication.",
    );
  if (a.identity < 0.8)
    return verify(
      "uncertain_identity",
      "The connection to this company needs verification.",
    );
  if (s.missingContext >= 0.5)
    return verify(
      "missing_context",
      "Missing company context could change the significance of this development.",
    );
  // An intact calendar or immaterial office announcement does not need a business quotation.
  if (s.useful < 0.2 && !(s.meaningful >= 0.2 && s.attributed >= 0.75))
    return reject(
      "immaterial",
      "No useful business evidence at this company's scale.",
    );
  if (s.unsupported >= 0.8)
    return reject(
      "unsupported_claim",
      "The visible claims lack an attributable evidentiary basis.",
    );
  if (s.attributed < 0.75 || !s.evidenceVerified)
    return verify(
      "missing_evidence",
      "Specific, attributable source evidence is needed before recommending this article.",
    );
  if (s.current < 0.7 || s.historical >= 0.2)
    return verify(
      "uncertain_currentness",
      "The information's current relevance needs verification.",
    );
  if (s.useful < 0.75)
    return verify(
      "uncertain_significance",
      s.meaningful >= 0.2
        ? "Potentially important business evidence; its significance needs review."
        : "The usefulness of this information remains uncertain.",
    );
  if (a.primary)
    return result(
      "relevant",
      "primary_reading",
      "primary_evidence",
      "Current primary evidence about the company's business fundamentals.",
    );
  if (a.coverageDuplicateOf)
    return result(
      "relevant",
      "coverage_only",
      "already_covered",
      "The development is relevant, but this article adds nothing beyond an existing recommended reading.",
    );
  if (s.recap >= 0.7)
    return result(
      "relevant",
      "coverage_only",
      "secondary_recap",
      a.preferredSourceId
        ? "Relevant development covered by a primary document; this article adds no supported analysis."
        : "Relevant development, but this article mainly repeats disclosure. A preferred source is needed.",
    );
  if (s.misleading >= 0.75)
    return result(
      "relevant",
      "coverage_only",
      "misleading_analysis",
      "The development is relevant, but the article's analysis is not supported by its evidence.",
    );
  if (s.incremental < 0.7)
    return verify(
      "uncertain_contribution",
      "Verify what this secondary article adds beyond the disclosure and existing coverage.",
    );
  if (s.analyticalQuality < 0.75)
    return verify(
      "uncertain_analysis",
      "The article adds analysis, but its evidence and reasoning need review.",
    );
  return result(
    "relevant",
    "analytical_addition",
    "valuable_analysis",
    "Supported secondary reporting or analysis adds useful understanding beyond the disclosure.",
  );
}

// ---------------------------------------------------------------------------
// Screening v3: headline-first. The route is decided from what is known about
// every article (company, headline, publisher, snippet, date). Article text, when
// it could be read, refines the same judgments but is never required. Missing
// text, company context or a ticker never sends an article to verification.
// Verification is reserved for "possibly this company and possibly major".
export const POLICY_VERSION_V3 = "headline-first-policy-3.0.0";
// A daily desk reports current developments.
export const MAX_DEVELOPMENT_AGE_DAYS = 45;
export const GENRES = [
  "company_disclosure",
  "news_report",
  "analysis",
  "market_commentary",
  "investment_opinion",
  "legal_solicitation",
  "other",
] as const;
export type Genre = (typeof GENRES)[number];
export interface ScreeningSignals {
  // P(significance level 2-4) and P(level 3-4).
  useful: number;
  meaningful: number;
  current: number;
  historical: number;
  genre: Record<Genre, number>;
  // P(the text or release is issued by the company itself).
  issuer: number;
  // Computed in code from the publication date; null when undated.
  ageDays: number | null;
  // Computed in code: the headline names a reporting period that ended long ago
  // (e.g. "fiscal year 2021"). The model reads dates as text; code compares them.
  staleTitle?: boolean;
  textRead: boolean;
  evidenceVerified: boolean;
}
export function decideScreening(a: {
  identity: number;
  primary: boolean;
  signals: ScreeningSignals;
}): FundamentalDecision {
  const s = a.signals;
  const g = s.genre;
  const result = (
    status: DevelopmentStatus,
    role: ArticleRole,
    code: string,
    reason: string,
  ): FundamentalDecision => ({
    disposition:
      role === "primary_reading" ||
      role === "analytical_addition" ||
      role === "news_report"
        ? "relevant"
        : role === "pending_verification"
          ? "uncertain"
          : "suppressed",
    development: { status },
    articleRole: role,
    reasonCode: code,
    reason,
    policyVersion: POLICY_VERSION_V3,
    needsPreferredSource: false,
  });
  const verify = (code: string, reason: string) =>
    result("uncertain", "pending_verification", code, reason);
  const reject = (code: string, reason: string) =>
    result("irrelevant", "rejected", code, reason);
  const historical = (reason: string) =>
    result("historical", "rejected", "historical_only", reason);
  // "Possibly major" is the one thing never silently screened out.
  const major = s.meaningful >= 0.5;

  if (a.identity < 0.2)
    return reject(
      "wrong_entity",
      "About a different business, person or place that shares the name.",
    );
  if ((g.legal_solicitation || 0) >= 0.6)
    return reject(
      "legal_solicitation",
      "Law-firm advertisement seeking plaintiffs; a real lawsuit reaches the desk through news or filings.",
    );
  if (s.ageDays !== null && s.ageDays > MAX_DEVELOPMENT_AGE_DAYS)
    return historical(
      `Published ${Math.round(s.ageDays)} days ago; outside the current monitoring window.`,
    );
  if (s.historical >= 0.8)
    return historical("Old information recirculated without a new development.");
  if (s.staleTitle)
    return historical("Reports a period that ended long ago.");
  // An undated page (often an investor-relations archive) must show it is current.
  if (s.ageDays === null && s.current < 0.5)
    return major
      ? verify(
          "uncertain_currentness",
          "Potentially important, but undated and possibly old. Check the date.",
        )
      : historical("Undated, and nothing shows it is current.");
  if (a.identity < 0.8)
    return major
      ? verify(
          "uncertain_identity",
          "Possibly an important development, but it may concern a different company. Confirm the company.",
        )
      : reject(
          "unclear_identity",
          "Probably a different entity, and nothing significant is reported.",
        );
  if (Math.max(g.market_commentary || 0, g.investment_opinion || 0) >= 0.6)
    return s.meaningful >= 0.2
      ? result(
          "relevant",
          "coverage_only",
          "commentary_on_development",
          "Price, rating or opinion piece about a real development; kept as coverage, not as reading.",
        )
      : reject(
          "commentary",
          "Share-price, analyst-rating or investment-opinion content without a business development.",
        );
  if (s.meaningful < 0.2 && s.useful < 0.6)
    return reject("immaterial", "No business development of consequence.");
  if (s.historical >= 0.5)
    return major
      ? verify(
          "uncertain_currentness",
          "Potentially important, but it may be old news. Check the date.",
        )
      : historical("Mostly old information recirculated.");
  if (a.primary || s.issuer >= 0.8)
    return result(
      "relevant",
      "primary_reading",
      "primary_evidence",
      s.textRead
        ? "The company's own disclosure of a current development."
        : "The company's own disclosure of a current development (screened from the headline; open the source for details).",
    );
  if ((g.analysis || 0) >= 0.6)
    return result(
      "relevant",
      "analytical_addition",
      "analysis",
      "Analysis of a current development; shown alongside the development's main source.",
    );
  return result(
    "relevant",
    "news_report",
    "news_report",
    "Report of a current business development; grouped with its other coverage under the best source.",
  );
}
