import { describe, expect, it } from "vitest";
import { newCompany } from "../supabase/functions/_shared/model.ts";
import {
  OPEN,
  groupsOf,
  layoutMap,
  radiusOf,
  type Placed,
} from "../src/bubble-map.tsx";

const items = (n: number, group: string): Placed[] =>
  Array.from({ length: n }, (_, i) => ({ key: `${group}${i}#0`, id: `${group}${i}`, group }));
const LABEL_TEXT = 18;

function check(placed: Placed[], groups: { key: string; label: string }[], width: number, open = "") {
  const layout = layoutMap(placed, groups, width, open);
  const pts = [...layout.pos.values()];
  expect(pts).toHaveLength(placed.length);
  // Inside the width and the height.
  for (const p of pts) {
    expect(p.x - p.r).toBeGreaterThanOrEqual(-0.5);
    expect(p.x + p.r).toBeLessThanOrEqual(width + 0.5);
    expect(p.y + p.r).toBeLessThanOrEqual(layout.height + 0.5);
  }
  // No two bubbles overlap, in the same group or across groups.
  let worst = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      worst = Math.max(worst, pts[i].r + pts[j].r - Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  expect(worst).toBeLessThan(3);
  // No bubble covers any group's label.
  for (const l of layout.labels)
    for (const p of pts) {
      const across = p.x + p.r > l.x - l.w / 2 && p.x - p.r < l.x + l.w / 2;
      const down = p.y + p.r > l.y && p.y - p.r < l.y + LABEL_TEXT;
      expect(across && down).toBe(false);
    }
  return layout;
}

describe("bubble map layout", () => {
  const placed = [...items(7, "a"), ...items(40, "b"), ...items(250, "c"), ...items(23, "d")];
  const groups = ["a", "b", "c", "d"].map((key) => ({
    key,
    label: key === "d" ? "Confirm company identity" : key.toUpperCase(),
  }));
  it("keeps groups apart, labels clear and bubbles inside the width", () => {
    for (const width of [360, 800, 1400]) {
      const layout = check(placed, groups, width);
      expect(layout.labels.map((l) => l.count)).toEqual([7, 40, 250, 23]);
    }
  });
  it("gives the same layout every time, and when regrouping back", () => {
    const one = layoutMap(placed, groups, 900);
    layoutMap(items(30, "z"), [{ key: "z", label: "Z" }], 900);
    const two = layoutMap(placed, groups, 900);
    expect([...two.pos]).toEqual([...one.pos]);
  });
  it("draws the open company larger, with room made around it", () => {
    const layout = check(placed, groups, 900, "b5");
    expect(layout.pos.get("b5#0")!.r).toBeCloseTo(radiusOf("b5") * OPEN);
  });
  it("gives each company a slightly different, stable size", () => {
    const sizes = ["a", "b", "c", "d", "e"].map(radiusOf);
    expect(new Set(sizes).size).toBeGreaterThan(1);
    for (const r of sizes) expect(r).toBeGreaterThanOrEqual(23 * 0.9 - 0.001);
    expect(radiusOf("a")).toBe(sizes[0]);
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
