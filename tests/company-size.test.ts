import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  companySize,
  normalizeSize,
  parseMarketCap,
  sizeFromMarketCap,
  sizeGuidance,
} from "../supabase/functions/_shared/company-size.ts";
import {
  decideScreening,
  GENRES,
  type ScreeningSignals,
} from "../supabase/functions/_shared/fundamental-policy.ts";
import { newCompany } from "../supabase/functions/_shared/model.ts";
import { parseRows } from "../scripts/market-cap-migration.ts";

const signals = (patch: Partial<ScreeningSignals> = {}): ScreeningSignals => ({
  useful: 0.7,
  meaningful: 0.25,
  current: 0.95,
  historical: 0.02,
  genre: Object.fromEntries(
    GENRES.map((g) => [g, g === "news_report" ? 1 : 0]),
  ) as ScreeningSignals["genre"],
  issuer: 0.05,
  ageDays: 1,
  textRead: false,
  evidenceVerified: false,
  ...patch,
});

describe("company size tiers", () => {
  it("parses market caps and bands them", () => {
    expect(parseMarketCap("$3.50B")).toBe(3.5e9);
    expect(parseMarketCap("$265.7M")).toBe(265.7e6);
    expect(parseMarketCap("$2.69T")).toBe(2.69e12);
    expect(parseMarketCap("abc")).toBeNull();
    expect(sizeFromMarketCap(29.4e6)).toBe("micro");
    expect(sizeFromMarketCap(300e6)).toBe("small");
    expect(sizeFromMarketCap(3.5e9)).toBe("mid");
    expect(sizeFromMarketCap(96.6e9)).toBe("large");
    expect(sizeFromMarketCap(2.69e12)).toBe("mega");
    expect(sizeFromMarketCap(null)).toBe("unknown");
  });

  it("derives the tier from market cap and keeps manual choices", () => {
    const c = newCompany("Acme");
    expect(
      normalizeSize({ ...c, sizeSource: "market_cap", marketCapUsd: 5e9 })
        .sizeClass,
    ).toBe("mid");
    expect(
      normalizeSize({ ...c, sizeClass: "mega", sizeSource: "manual" })
        .sizeClass,
    ).toBe("mega");
    expect(companySize({ businessScale: "medium" })).toBe("mid");
    expect(sizeGuidance("mega", 2.69e12)).toContain("$2.69T");
  });

  it("drops routine news for mega caps but keeps it for micro caps", () => {
    const routine = signals();
    expect(decideScreening({ identity: 0.95, primary: false, signals: routine, size: "mega" }).reasonCode).toBe("immaterial_at_scale");
    expect(decideScreening({ identity: 0.95, primary: false, signals: routine, size: "micro" }).disposition).toBe("relevant");
    // Group results still reach the desk for a mega cap.
    const results = signals({ useful: 0.99, meaningful: 0.3 });
    expect(decideScreening({ identity: 0.95, primary: false, signals: results, size: "mega" }).disposition).toBe("relevant");
    // Unknown size behaves as before.
    expect(decideScreening({ identity: 0.95, primary: false, signals: signals({ useful: 0.5, meaningful: 0.1 }) }).reasonCode).toBe("immaterial");
  });

  it("reads every row of the market-cap sheet", () => {
    const rows = parseRows(
      readFileSync("data/company-market-caps-2026-09-23.csv", "utf8"),
    );
    expect(rows).toHaveLength(247);
    const aena = rows.find((r) => r.officialName.startsWith("Aena"))!;
    expect(aena).toMatchObject({ officialName: "Aena S.M.E., S.A.", ticker: "AENA", exchange: "BME", country: "ES" });
    const truxton = rows.find((r) => r.ticker === "TRUX")!;
    expect(truxton.officialName).toBe("Truxton Corporation");
    expect(rows.find((r) => r.officialName === "Hyne Timber Group")!.ticker).toBe("");
  });
});
