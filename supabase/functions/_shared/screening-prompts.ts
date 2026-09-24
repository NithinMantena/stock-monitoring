// Screening v3 (headline-first). Every question must be answerable from the
// company, headline, publisher, snippet and date alone; article text, when it
// was read, is extra evidence for the same questions. Tested in
// research/typesafe-screening-2-2026-09-22 (identity criteria, purpose Choice,
// issuer Noul and the cookbook-style evidence split).
export const PROMPT_VERSION = "headline-first-3.1.0";
export const CORE_QUESTIONS = {
  identity: {
    type: "noul",
    instructions:
      "Is `article` about `company` (the same business, or a subsidiary, brand or division it owns), or about a named customer, supplier or regulator action explicitly linked to it? Judge the entity connection only, not importance. The company profile may be sparse; use its name, ticker, exchange and description when present.",
    criteria: {
      true: {
        what: "The headline or text refers to this company, one of its businesses, or a documented exposure of it.",
        examples: [
          "The company reports results or announces a transaction",
          "A regulator acts against the company or its subsidiary",
          "A named supplier or customer contract with the company",
        ],
      },
      false: {
        what: "A different person, place, product or business that merely shares a word of the name, or the company appears only in a passing list.",
        examples: [
          "A person or place with the same name",
          "Another business with a similar name",
          "A market wrap that lists many tickers",
        ],
      },
    },
  },
  significance: {
    type: "score",
    instructions:
      "Rate the business development that `article` reports, for understanding this company's long-term economic value. Judge from the headline, publisher and snippet; use `article.text` only when it is present. Judge significance relative to `company.size`: the same event can be level 3 for a micro cap and level 0-1 for a mega cap. For large and mega caps, product news, individual contracts or partnerships, regional launches, executive remarks, routine lawsuits and feature stories are level 0-1 unless they could move group-level revenue, profit or risk. When size is unknown, judge the nature of the event and do not demote it merely because size is unknown. Positive and negative developments count equally. Do not require a surprise or proof that an allegation is true.",
    criteria: [
      {
        summary:
          "No business development: share-price or trading moves, analyst ratings or price targets on their own, should-you-buy or valuation templates, calendar notices, name collisions, generic promotion.",
      },
      {
        summary:
          "An actual but routine or small event: minor contract, store opening, marketing campaign, routine board appointment, rating affirmation, small holder change.",
      },
      {
        summary:
          "Useful evidence about core performance or an important business assumption: reported results, monthly or quarterly operating figures, guidance, pricing, costs, market share, a meaningful partnership.",
      },
      {
        summary:
          "Could meaningfully change earning power, competitive position, capital allocation, management or financial risk: large acquisition or financing, major customer or licence change, activist campaign, leadership upheaval, material litigation or regulatory decision.",
      },
      {
        summary:
          "Could transform control, survival or the core business: takeover of the company, insolvency, loss of the core licence or only operating asset.",
      },
    ],
  },
  genre: {
    type: "choice",
    instructions:
      "What is the primary purpose of `article`? Judge the article as a whole from its headline, publisher and any text, not from a passing sentence.",
    criteria: {
      company_disclosure:
        "Issued by the company itself, or a regulator or filing: press release, filing, official statement or presentation, including verbatim newswire copies.",
      news_report:
        "Journalism reporting a specific event or disclosure (results, guidance, deal, financing, regulatory action, lawsuit ruling, leadership change, operating update), with or without added analysis.",
      analysis:
        "Substantive original analysis or investigation of the business built on evidence, not a stock-picking template.",
      market_commentary:
        "Share-price or trading moves, options activity, technical levels, analyst ratings or price targets, or pundit remarks.",
      investment_opinion:
        "Should-you-buy pieces, stock-versus-stock comparisons, fair-value or valuation templates, price predictions, dividend or 'most searched stock' templates.",
      legal_solicitation:
        "Law-firm notices seeking plaintiffs or reminding investors of class-action deadlines.",
      other:
        "Anything else, including unrelated, lifestyle, sport or local-interest stories.",
    },
  },
  issuerRelease: {
    type: "noul",
    instructions:
      "Is `article` an announcement issued by `company` itself (its own press release, filing or statement, possibly distributed by a newswire or reprinted verbatim)?",
    criteria: {
      true: "The company is the author or issuer of the announcement.",
      false:
        "A journalist, analyst, law firm, rating agency, another company or an aggregator is the author.",
    },
  },
  temporal: {
    type: "choice",
    instructions:
      "Is the development `article` reports current at `asOf`? Day counts in `article.dateFacts` were computed in code; rely on them rather than comparing dates yourself. A recent article about a recent or newly announced event is current. A months-old document with nothing new is historical.",
    criteria: {
      current: "A current disclosure, development or new analysis.",
      historical:
        "Only an old event or document recirculated without new relevance.",
      unknown: "The available evidence does not establish when it happened.",
    },
  },
} as const;
