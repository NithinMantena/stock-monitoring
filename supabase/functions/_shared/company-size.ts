// Company size tiers, derived from market capitalisation in US dollars.
// News screening uses the tier to set how big a development must be before it
// matters: a $50M contract is transformational for a micro cap and noise for a
// mega cap, which draws dozens of low-consequence articles every day.
export const SIZE_CLASSES = ["micro", "small", "mid", "large", "mega"] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];
export type SizeSetting = SizeClass | "unknown";

// Lower bounds in USD (conventional market-cap bands).
export const SIZE_BANDS: Record<SizeClass, { min: number; label: string; range: string }> = {
  micro: { min: 0, label: "Micro cap", range: "under $300M" },
  small: { min: 300e6, label: "Small cap", range: "$300M – $2B" },
  mid: { min: 2e9, label: "Mid cap", range: "$2B – $10B" },
  large: { min: 10e9, label: "Large cap", range: "$10B – $200B" },
  mega: { min: 200e9, label: "Mega cap", range: "$200B and above" },
};

export function sizeFromMarketCap(usd: number | null | undefined): SizeSetting {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd <= 0)
    return "unknown";
  let tier: SizeClass = "micro";
  for (const s of SIZE_CLASSES) if (usd >= SIZE_BANDS[s].min) tier = s;
  return tier;
}

// "$3.50B", "$265.7M", "$2.69T", "1.2bn", "450000000" → USD number.
export function parseMarketCap(text: string): number | null {
  const m = text
    .replace(/[$,\s]/g, "")
    .match(/^(\d+(?:\.\d+)?)(k|m|mm|mn|b|bn|t|tn)?$/i);
  if (!m) return null;
  const unit = (m[2] || "").toLowerCase();
  const mult = unit.startsWith("t")
    ? 1e12
    : unit.startsWith("b")
      ? 1e9
      : unit.startsWith("m")
        ? 1e6
        : unit === "k"
          ? 1e3
          : 1;
  const value = Math.round(Number(m[1]) * mult);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function formatMarketCap(usd: number | null | undefined): string {
  if (!usd || !Number.isFinite(usd)) return "";
  if (usd >= 1e12) return `$${(usd / 1e12).toFixed(2)}T`;
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

// Older records carry a three-level businessScale; map it when no tier is set.
const legacy: Record<string, SizeSetting> = {
  small: "small",
  medium: "mid",
  large: "large",
};
export function companySize(c: {
  sizeClass?: string;
  marketCapUsd?: number | null;
  businessScale?: string;
}): SizeSetting {
  if (c.sizeClass && c.sizeClass !== "unknown") return c.sizeClass as SizeClass;
  const fromCap = sizeFromMarketCap(c.marketCapUsd);
  if (fromCap !== "unknown") return fromCap;
  return legacy[c.businessScale || ""] || "unknown";
}

// Text given to TypeSafe with the company profile.
export function sizeGuidance(size: SizeSetting, marketCapUsd?: number | null) {
  const cap = formatMarketCap(marketCapUsd);
  if (size === "unknown") return "unknown";
  const band = SIZE_BANDS[size];
  const scale = {
    micro:
      "Very small business. Single contracts, customers, financings, management changes and store or plant openings are often material.",
    small:
      "Small business. Individual contracts, product launches, financings and leadership changes can be material.",
    mid: "Mid-sized business. Routine contracts and openings are minor; results, guidance, acquisitions and financing decisions matter.",
    large:
      "Large business. Only developments that could move group-level revenue, profit or risk matter; individual contracts, product launches, store openings and executive commentary are routine.",
    mega: "Mega-cap with constant media coverage. Most daily articles (product news, partnerships, executive remarks, features, lawsuits, regional launches, individual deals) are immaterial to group value. Only group results and guidance, very large acquisitions or capital returns, CEO change, or regulatory/legal actions threatening a major business line matter.",
  }[size];
  return `${band.label} (${cap || band.range}). ${scale}`;
}

// Screening thresholds per tier. A development is rejected as immaterial when
// P(significance ≥ 3) < minMeaningful AND P(significance ≥ 2) < minUseful.
// "Possibly major" (meaningful ≥ majorAt) is never silently dropped.
export const SIZE_THRESHOLDS: Record<
  SizeSetting,
  { minMeaningful: number; minUseful: number; majorAt: number }
> = {
  micro: { minMeaningful: 0.15, minUseful: 0.45, majorAt: 0.45 },
  small: { minMeaningful: 0.2, minUseful: 0.55, majorAt: 0.5 },
  unknown: { minMeaningful: 0.2, minUseful: 0.6, majorAt: 0.5 },
  mid: { minMeaningful: 0.2, minUseful: 0.6, majorAt: 0.5 },
  large: { minMeaningful: 0.3, minUseful: 0.75, majorAt: 0.55 },
  mega: { minMeaningful: 0.45, minUseful: 0.95, majorAt: 0.6 },
};

// Keeps sizeClass consistent with its source: a market cap always decides the
// tier; a manual choice stands on its own.
export function normalizeSize<
  T extends { sizeClass: SizeSetting; sizeSource: "none" | "market_cap" | "manual"; marketCapUsd: number | null },
>(c: T): T {
  if (c.sizeSource === "market_cap") {
    const derived = sizeFromMarketCap(c.marketCapUsd);
    return derived === "unknown"
      ? { ...c, sizeClass: "unknown", sizeSource: "none" }
      : { ...c, sizeClass: derived };
  }
  if (c.sizeSource === "manual" && c.sizeClass === "unknown")
    return { ...c, sizeSource: "none" };
  if (c.sizeSource === "none" && c.sizeClass !== "unknown")
    return { ...c, sizeSource: "manual" };
  return c;
}
