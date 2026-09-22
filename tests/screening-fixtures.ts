import {
  SCREENING_VERSION,
  type NewsAssessment,
} from "../supabase/functions/_shared/screening-policy.ts";
export function assessment(
  patch: Partial<NewsAssessment> = {},
): NewsAssessment {
  return {
    version: SCREENING_VERSION,
    at: "2026-09-18T00:00:00Z",
    disposition: "relevant",
    reason: "Primary financial evidence.",
    category: "results",
    identity: 0.95,
    materiality: 3,
    quality: 2.5,
    addedValue: 2.5,
    evidenceSufficiency: 0.95,
    primary: true,
    contentDepth: "full",
    charactersRead: 1000,
    availableCharacters: 1000,
    retrievalNote: "",
    possibleMajor: false,
    sourceUrl: "https://example.com/results",
    ...patch,
  };
}

export function modelResponse(
  overrides: Record<string, any> = {},
  request?: any,
) {
  const choice = (selected: string, keys: string[]) => ({
    type: "choice",
    choice: selected,
    probabilities: Object.fromEntries(
      keys.map((k) => [k, k === selected ? 1 : 0]),
    ),
  });
  const answers: Record<string, any> = {
    identity: { type: "noul", noul: 0.95 },
    significance: {
      type: "score",
      score: 3,
      probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0 },
      confidence: 1,
    },
    support: choice("attributed", ["attributed", "unsupported", "absent"]),
    contribution: choice("incremental", ["incremental", "recap", "unknown"]),
    temporal: choice("current", ["current", "historical", "unknown"]),
    analyticalQuality: choice("adequate", [
      "adequate",
      "weak",
      "misleading",
      "unknown",
    ]),
    alignment: choice("aligned", ["aligned", "different_document", "unclear"]),
    consistency: choice("coherent", [
      "coherent",
      "corrected",
      "conflicting",
      "unknown",
    ]),
    contextDependency: { type: "noul", noul: 0.05 },
    evidence: choice("p0", ["p0", "none"]),
    ...overrides,
  };
  if (request)
    for (const [id, q] of Object.entries(request.questions) as [
      string,
      any,
    ][]) {
      if (q.type !== "choice") continue;
      const keys = Object.keys(q.criteria);
      const selected =
        id === "evidence"
          ? keys.find((k) => k !== "none")!
          : answers[id]?.choice ||
            (id === "qualification"
              ? "none"
              : id.startsWith("relation")
                ? "unrelated"
                : keys[0]);
      if (id === "evidence") answers[id] = choice(selected, keys);
      else
        answers[id] = {
          ...choice(selected, keys),
          ...answers[id],
          probabilities: {
            ...Object.fromEntries(keys.map((k) => [k, 0])),
            ...(answers[id]?.probabilities || { [selected]: 1 }),
          },
        };
    }
  return { model: "jev-1.13.0", usage: { input_tokens: 400 }, answers };
}
