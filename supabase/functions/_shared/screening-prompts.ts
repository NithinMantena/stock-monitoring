// Frozen five-core rubric from the September 22 screening research.
export const PROMPT_VERSION = "fundamental-core-2.0.0";
export const CORE_QUESTIONS = {
  identity: {
    type: "noul",
    instructions:
      "Is the company discussed in `article` the same business as `company`, or is that business explicitly exposed through the described supplier/customer/regulation? Judge entity connection only, not importance.",
  },
  significance: {
    type: "score",
    instructions:
      "Rate the usefulness of the reported business information for understanding this company’s long-term economic value at its supplied scale. Evaluate the text’s content; do not require a surprise, a proven future outcome, or certainty that an allegation is true. Use company context for scale. An indirect exposure counts when documented.",
    criteria: [
      "No useful business evidence: only a calendar notice, share trading, name collision, generic promotion, unsupported rumor, or generic boilerplate.",
      "An actual isolated event too small or routine to inform company economics at the supplied scale.",
      "Useful evidence about core financial/operating performance or an important business assumption, including stable reported results and supported comparative analysis.",
      "Potential to meaningfully change company earning power, competitive advantage, capital allocation, management integrity or financial risk.",
      "Potential transformation of control, survival or the core business.",
    ],
  },
  support: {
    type: "choice",
    instructions:
      "Classify the visible evidentiary basis of the main BUSINESS information in `article.text`. This is about attribution in the supplied text, not independently proving truth. `article.primary` is supplied provenance. A filed allegation remains an allegation; it can still be attributable. Do not require an audit, legal verdict or a complete valuation.",
    criteria: {
      attributed:
        "Actual figures or actions disclosed by the company/regulator; or business claims attributed to identifiable documents, accountable sources, or a described original dataset/method. Reported claims may remain disputed or uncertain.",
      unsupported:
        "Text is visible but its business claims are hype, bare prediction, rumor or assertion without a stated evidentiary basis.",
      absent:
        "Text is missing, blocked, only a headline, or does not contain the actual business information needed.",
    },
  },
  contribution: {
    type: "choice",
    instructions:
      "For a secondary article, classify its contribution beyond a basic primary announcement. Use `primaryReference` when present. Judge the comparison, data or reasoning actually visible. A new connection among existing public facts can add value; it need not be a scoop. Do not classify something as incremental merely because it is detailed, long or well written.",
    criteria: {
      incremental:
        "Contains original evidence or documented comparative/causal analysis that changes understanding, such as reserve reconciliation, peer benchmark, contract comparison, unit-economics analysis or independent reporting.",
      recap:
        "Repeats disclosure figures or claims, reports share-price reaction, or adds only generic definitions/opinion without a substantive analytical step.",
      unknown:
        "Available text does not establish whether there is a substantive contribution.",
    },
  },
  temporal: {
    type: "choice",
    instructions:
      "Is the BUSINESS information current at `asOf`? Use dates within the text and publication date. A recent analysis of older data with a new current implication can be current. A future action announced now can be current. A reprint of old results with no new interpretation is historical. Do not mistake boilerplate forward-looking warnings or prior-year comparisons for the development date.",
    criteria: {
      current:
        "Current disclosure, development or new analysis as of the supplied evaluation date.",
      historical:
        "Only an old event or historical release recirculated without new relevance.",
      unknown: "Insufficient evidence to date the information.",
    },
  },
} as const;
