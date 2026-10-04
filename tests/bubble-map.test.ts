import { describe, expect, it } from "vitest";
import { newCompany } from "../supabase/functions/_shared/model.ts";
import { groupsOf, layoutBubbles, type Placed } from "../src/bubble-map.tsx";

const items = (n: number, group = "g"): Placed[] =>
  Array.from({ length: n }, (_, i) => ({ key: `c${i}#0`, id: `c${i}`, group }));

describe("bubble map layout", () => {
  it("never overlaps bubbles and stays inside the width", () => {
    const placed = [...items(7, "a"), ...items(40, "b").map((p) => ({ ...p, key: p.key + "b", id: p.id + "b" })), ...items(300, "c").map((p) => ({ ...p, key: p.key + "c", id: p.id + "c" }))];
    const groups = ["a", "b", "c"].map((key) => ({ key, label: key.toUpperCase() }));
    for (const width of [320, 700, 1400]) {
      const { pos, labels, height } = layoutBubbles(placed, groups, width);
      expect(pos.size).toBe(placed.length);
      expect(labels.map((l) => l.count)).toEqual([7, 40, 300]);
      const pts = [...pos.values()];
      for (const p of pts) {
        expect(p.x).toBeGreaterThanOrEqual(-0.01);
        expect(p.x + 46).toBeLessThanOrEqual(width + 0.01);
        expect(p.y + 46).toBeLessThanOrEqual(height + 0.01);
      }
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++)
          expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThan(46);
    }
  });
  it("puts a company in every one of its tag groups, or No tag", () => {
    const c = newCompany("Alpha");
    c.tags = ["Moats", " moats", "Insurers", ""];
    expect(groupsOf(c, "tag").map((g) => g.label)).toEqual(["Moats", "Insurers"]);
    expect(groupsOf(newCompany("Beta"), "tag")).toEqual([{ key: "~none", label: "No tag" }]);
    expect(groupsOf(newCompany("Gamma", "owned"), "status")[0].label).toBe("Portfolio");
    expect(groupsOf(newCompany("Delta"), "size")[0].label).toBe("Size not set");
  });
});
