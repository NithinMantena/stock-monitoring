import { describe, expect, it } from "vitest";
import {
  newCompany,
  type Company,
} from "../supabase/functions/_shared/model.ts";
import {
  compareJournal,
  isStale,
  journalSection,
  planReorder,
  sectionPatch,
} from "../supabase/functions/_shared/journal.ts";
import {
  companyKey,
  firstDate,
  mergeDuplicates,
  parsePitchList,
  planPitchListSync,
} from "../supabase/functions/_shared/pitch-list.ts";

const company = (name: string, patch: Partial<Company> = {}): Company => ({
  ...newCompany(name),
  ...patch,
});

describe("journal sections and order", () => {
  it("places ideas only, splitting passes by kind", () => {
    expect(journalSection(company("A", { status: "perpetual" }))).toBe(
      "perpetual",
    );
    expect(journalSection(company("A", { status: "inbox" }))).toBe("inbox");
    expect(
      journalSection(company("A", { status: "pass", passKind: "valued" })),
    ).toBe("pass-valued");
    // Passes without a kind sit with the un-valued ones.
    expect(journalSection(company("A", { status: "pass" }))).toBe(
      "pass-unvalued",
    );
    expect(journalSection(company("A", { status: "owned" }))).toBeNull();
    expect(journalSection(company("A", { status: "sold" }))).toBeNull();
    expect(
      journalSection(company("A", { status: "watchlist", archived: true })),
    ).toBeNull();
  });

  it("puts new and moved ideas at the top", () => {
    const old = company("Old", { journalOrder: 51 });
    const fresh = company("Fresh");
    expect(compareJournal(fresh, old)).toBeLessThan(0);
    expect(sectionPatch("pass-valued", 5)).toEqual({
      status: "pass",
      passKind: "valued",
      journalOrder: -5,
    });
    // Unordered companies follow ordered ones, by name.
    const a = company("A", { journalOrder: null });
    const b = company("B", { journalOrder: null });
    expect([b, a, old].sort(compareJournal).map((c) => c.name)).toEqual([
      "Old",
      "A",
      "B",
    ]);
  });

  it("reorders with a single write when there is room", () => {
    const list = [
      { id: "a", journalOrder: 10 },
      { id: "b", journalOrder: 20 },
      { id: "c", journalOrder: 30 },
    ];
    expect(planReorder(list, "c", 1)).toEqual([{ id: "c", journalOrder: 15 }]);
    expect(planReorder(list, "a", 2)).toEqual([
      { id: "a", journalOrder: 1030 },
    ]);
    expect(planReorder(list, "c", 0)).toEqual([
      { id: "c", journalOrder: -990 },
    ]);
    // A company arriving from another section.
    expect(planReorder(list, "x", 3)).toEqual([
      { id: "x", journalOrder: 1030 },
    ]);
  });

  it("renumbers a section when neighbours have no order or no gap", () => {
    const unordered = [
      { id: "a", journalOrder: null },
      { id: "b", journalOrder: null },
    ];
    expect(planReorder(unordered, "b", 0)).toEqual([
      { id: "b", journalOrder: 0 },
      { id: "a", journalOrder: 1000 },
    ]);
    const tight = [
      { id: "a", journalOrder: 1 },
      { id: "b", journalOrder: 1 + Number.EPSILON },
      { id: "c", journalOrder: 5 },
    ];
    const plan = planReorder(tight, "c", 1);
    const order = new Map(tight.map((x) => [x.id, x.journalOrder]));
    for (const p of plan) order.set(p.id, p.journalOrder);
    expect([...order].sort((x, y) => x[1] - y[1]).map((x) => x[0])).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("flags dated ideas past their section's review window", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    expect(
      isStale(
        company("A", { status: "perpetual", lastReviewed: "2026-06-09" }),
        now,
      ),
    ).toBe(true);
    expect(
      isStale(
        company("A", { status: "perpetual", lastReviewed: "2026-09-01" }),
        now,
      ),
    ).toBe(false);
    expect(
      isStale(company("A", { status: "perpetual", lastReviewed: "" }), now),
    ).toBe(false);
    expect(
      isStale(
        company("A", { status: "pass", lastReviewed: "2020-01-01" }),
        now,
      ),
    ).toBe(false);
  });
});

const DOC = `# Process

- For each company write name

# Companies

## Earnings Calls / Companies to Rereview

- Soylent
    - Trading at 11x FCF

## Companies to add to App Tracker

- Vandelay Industries
- Stark Partners  Uk screen

## Perpetual Watch List (High-quality, researched ideas)

- Super well researched ideas with some formal pitch written up
- Acme Insurance (date last checked: 6/9/2026)
    - 50 billion market cap
    - Valuation
        - Attractive below 100 per share.

## Perpetual Watch List (Mid-quality or mid-researched ideas)

- Globex (9/28,2026, financials as of June 30th)
    - Trading for 10 bn (\\~200m USD) market cap
- Initech Holdings ([https://example.com/initech-notes](<https://example.com/initech-notes>))
    - Market cap of 1 billion

## Potential Ideas

- Hooli (via newsletter)
- Umbrella (holding co)
    - Holding company

## Pass (valued / want to value)

- Umbrella (7/20/2026)
- Globex currently trading for 7x earnings
    - Could grow at 7% per year next decade and exit for 12x
- Real estate worth 5 billion and grow at 4% per year
- Wayne Footwear (7/30/2026)
    - Owns two shoe brands

## Pass (un-valued)

- Oscorp 2.6x
    - Activist-backed
`;

describe("Investment Pitch List sync", () => {
  it("reads entries by section, with clean notes and review dates", () => {
    const { entries, tracker } = parsePitchList(DOC);
    expect(entries.map((e) => `${e.name}:${e.section}`)).toEqual([
      "Acme Insurance:perpetual",
      "Globex:watchlist",
      "Initech Holdings:watchlist",
      "Hooli:inbox",
      "Umbrella:inbox",
      "Umbrella:pass-valued",
      "Wayne Footwear:pass-valued",
      "Oscorp:pass-unvalued",
    ]);
    const acme = entries[0];
    expect(acme.lastReviewed).toBe("2026-06-09");
    // The company line becomes the card title; its bullets are outdented.
    expect(acme.notes).toBe(
      "- 50 billion market cap\n- Valuation\n    - Attractive below 100 per share.",
    );
    const globex = entries[1];
    expect(globex.lastReviewed).toBe("2026-09-28");
    expect(globex.notes.split("\n")[0]).toBe(
      "(9/28,2026, financials as of June 30th)",
    );
    // A link on the company line is kept at the top of the notes.
    expect(entries[2].notes.split("\n")[0]).toContain("example.com");
    expect(entries[3].notes).toBe("(via newsletter)");
    expect(entries[7].notes.split("\n")[0]).toBe("2.6x");
    // Sentences about Globex inside the Umbrella entry stay with Umbrella.
    expect(entries[5].notes).toContain(
      "Globex currently trading for 7x earnings",
    );
    expect(entries[5].notes).toContain("Real estate worth 5 billion");
    expect(entries.some((e) => e.name === "Soylent")).toBe(false);
    expect(tracker.map((t) => [t.name, t.ideaSource])).toEqual([
      ["Vandelay Industries", ""],
      ["Stark Partners", "UK screen"],
    ]);
  });

  it("merges an idea listed twice, led by the latest dated entry", () => {
    const merged = mergeDuplicates(parsePitchList(DOC).entries);
    const umbrella = merged.find((e) => e.key === "umbrella")!;
    expect(umbrella.section).toBe("pass-valued");
    expect(umbrella.notes).toContain("*Also listed under Potential ideas:*");
    expect(umbrella.notes).toContain("Holding company");
  });

  it("matches existing companies by name and plans moves, creations and order", () => {
    const existing = [
      company("Acme Insurance", { status: "perpetual" }),
      company("Globex", { status: "pass" }),
      company("Wayne Footwear", { status: "perpetual" }),
      company("Vandelay Industries", { status: "inbox", journalOrder: null }),
      company("Monsters Inc", { status: "owned" }),
      company("Oscorp", { status: "pass", notes: "old" }),
    ];
    const plan = planPitchListSync(parsePitchList(DOC), existing);
    const byName = new Map(plan.updates.map((u) => [u.name, u]));
    expect(byName.get("Globex")!.patch).toMatchObject({
      status: "watchlist",
      lastReviewed: "2026-09-28",
    });
    expect(byName.get("Wayne Footwear")!.patch).toMatchObject({
      status: "pass",
      passKind: "valued",
    });
    // Already passed: only the pass type and notes change.
    expect(byName.get("Oscorp")!.patch).not.toHaveProperty("status");
    expect(byName.get("Oscorp")!.patch).toMatchObject({
      passKind: "unvalued",
      notes: "2.6x\n\n- Activist-backed",
    });
    // Doc order becomes journal order.
    expect(byName.get("Acme Insurance")!.patch.journalOrder).toBeLessThan(
      byName.get("Globex")!.patch.journalOrder!,
    );
    // Tracker names already in the app move to the top of Potential ideas.
    expect(byName.get("Vandelay Industries")!.patch).toEqual({
      journalOrder: 14,
    });
    expect(plan.creates.map((c) => `${c.name}:${c.status}`).sort()).toEqual([
      "Hooli:inbox",
      "Initech Holdings:watchlist",
      "Stark Partners:inbox",
      "Umbrella:pass",
    ]);
    expect(
      plan.creates.find((c) => c.name === "Stark Partners")!.ideaSource,
    ).toBe("UK screen");
    expect(plan.unlisted.map((u) => u.name)).toEqual(["Monsters Inc"]);
  });

  it("updates the live company when an archived duplicate shares its name", () => {
    const archived = company("Umbrella", { status: "pass", archived: true });
    const live = company("Umbrella (holding co)", { status: "inbox" });
    const plan = planPitchListSync(parsePitchList(DOC), [archived, live]);
    expect(plan.updates.find((u) => u.name.startsWith("Umbrella"))!.id).toBe(
      live.id,
    );
    expect(plan.unlisted.map((u) => u.id)).toContain(archived.id);
  });

  it("parses dates and keys loosely", () => {
    expect(firstDate("Contoso (research) (8/24/2026)")).toBe("2026-08-24");
    expect(firstDate("10/502026 I found it")).toBe("");
    expect(companyKey("Northwind Traders (NWT)")).toBe("northwind traders");
  });
});
