import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  forceCollide,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
import type { Company, Doc } from "../supabase/functions/_shared/model";
import { statusLabels, statuses } from "../supabase/functions/_shared/constants";
import {
  SIZE_BANDS,
  SIZE_CLASSES,
  companySize,
} from "../supabase/functions/_shared/company-size";
import { normalizeTag } from "../supabase/functions/_shared/library";
import { InlineName } from "./ui";

export type GroupBy = "status" | "tag" | "size" | "group";
export const GROUP_BY_LABELS: Record<GroupBy, string> = {
  status: "List",
  tag: "Tag",
  size: "Size",
  group: "Research group",
};

// Geometry (px). Bubbles vary about ±10% around BASE_R, fixed per company;
// the company whose notebook is open is drawn OPEN times larger.
const BASE_R = 23;
export const OPEN = 1.35;
const PAD = 1.5;
const LABEL = 26;
const GAP_X = 34;
const GAP_Y = 24;

// A stable 0..1 number from a string, so sizes and clump shapes never change.
function hash01(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}
export const radiusOf = (id: string) => BASE_R * (0.9 + 0.2 * hash01(id));

export interface Group {
  key: string;
  label: string;
}
export interface Placed {
  key: string;
  id: string;
  group: string;
}

// Which groups a company belongs to, in display order. A company with several
// tags is in each tag's group.
export function groupsOf(c: Company, by: GroupBy): Group[] {
  if (by === "status") return [{ key: c.status, label: statusLabels[c.status] }];
  if (by === "size") {
    const s = companySize(c);
    return [{ key: s, label: s === "unknown" ? "Size not set" : SIZE_BANDS[s].label }];
  }
  if (by === "group") {
    const g = c.originalGroup?.trim();
    return [g ? { key: "g:" + g.toLowerCase(), label: g } : { key: "~none", label: "No research group" }];
  }
  const seen = new Set<string>();
  const out: Group[] = [];
  for (const raw of c.tags) {
    const tag = normalizeTag(raw);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push({ key: "t:" + tag.toLowerCase(), label: tag });
  }
  return out.length ? out : [{ key: "~none", label: "No tag" }];
}

function groupOrder(by: GroupBy, g: Group) {
  if (g.key === "~none" || g.key === "unknown") return [2, ""] as const;
  if (by === "status") return [0, String(statuses.indexOf(g.key as never)).padStart(2, "0")] as const;
  if (by === "size") return [0, String(SIZE_CLASSES.indexOf(g.key as never))] as const;
  return [1, g.label.toLowerCase()] as const;
}

interface Node extends SimulationNodeDatum {
  key: string;
  r: number;
}
interface Clump {
  pos: { key: string; x: number; y: number; r: number }[];
  minX: number;
  minY: number;
  w: number;
  h: number;
}

// One group's bubbles, settled into a loose, organic clump around (0,0) by a
// short physics run (pull to the centre + collisions). Starting points come
// from a hash, so the same members always give the same clump. maxW limits the
// clump's width; a big group then spreads into a wide band.
const clumpCache = new Map<string, Clump>();
function clumpOf(members: { key: string; r: number }[], maxW: number): Clump {
  const area = members.reduce((s, m) => s + Math.PI * (m.r + PAD) ** 2, 0) / 0.7;
  const R = Math.sqrt(area / Math.PI);
  // A group that would take more than about half the map becomes a band across
  // the full width, so big groups use the space instead of forming a tall circle.
  const half = R * 2 + 8 > maxW * 0.55 ? maxW / 2 - 4 : Infinity;
  const cacheKey =
    (half === Infinity ? "free" : Math.round(half)) +
    "|" +
    members.map((m) => m.key + ":" + m.r.toFixed(1)).join(",");
  const hit = clumpCache.get(cacheKey);
  if (hit) return hit;
  // Free clumps start scattered in a circle; bands in a full-width strip.
  const bandH = half === Infinity ? 0 : (area * 1.1) / (2 * half);
  const nodes: Node[] = members.map((m) => {
    if (half !== Infinity)
      return {
        key: m.key,
        r: m.r,
        x: (hash01(m.key) * 2 - 1) * (half - m.r),
        y: (hash01(m.key + "d") - 0.5) * bandH,
      };
    const a = hash01(m.key) * Math.PI * 2,
      d = Math.sqrt(hash01(m.key + "d"));
    return { key: m.key, r: m.r, x: Math.cos(a) * d * R, y: Math.sin(a) * d * R };
  });
  const k = 0.09 * Math.min(1, Math.sqrt(15 / members.length));
  const sim = forceSimulation<Node>(nodes)
    // A band fills the full width: almost no sideways pull (the side walls hold
    // it) and a moderate downward squeeze keeps it compact. A free clump is
    // pulled evenly into a round shape.
    .force("x", forceX<Node>(0).strength(half !== Infinity ? k * 0.03 : k))
    .force("y", forceY<Node>(0).strength(half !== Infinity ? k * 0.35 * Math.min(1, (2 * half) / bandH) : k))
    .force("collide", forceCollide<Node>((n) => n.r + PAD).strength(0.9).iterations(3))
    .stop();
  for (let i = 0; i < 300; i++) {
    sim.tick();
    if (half !== Infinity)
      for (const n of nodes) n.x = Math.max(-half + n.r, Math.min(half - n.r, n.x!));
  }
  const minX = Math.min(...nodes.map((n) => n.x! - n.r)),
    maxX = Math.max(...nodes.map((n) => n.x! + n.r)),
    minY = Math.min(...nodes.map((n) => n.y! - n.r)),
    maxY = Math.max(...nodes.map((n) => n.y! + n.r));
  const clump: Clump = {
    pos: nodes.map((n) => ({ key: n.key, x: n.x!, y: n.y!, r: n.r })),
    minX,
    minY,
    w: maxX - minX,
    h: maxY - minY,
  };
  if (clumpCache.size > 300) clumpCache.delete(clumpCache.keys().next().value!);
  clumpCache.set(cacheKey, clump);
  return clump;
}

export interface Layout {
  pos: Map<string, { x: number; y: number; r: number }>;
  labels: { key: string; label: string; count: number; x: number; y: number; w: number }[];
  height: number;
}

// The whole map: each group is settled on its own and measured, then the
// groups are placed in rows by their real size, each label above its own clump,
// and each row is spread evenly across the full width. Groups therefore never
// overlap each other or their labels, and the map uses the whole space.
export function layoutMap(
  items: Placed[],
  groups: Group[],
  width: number,
  openId = "",
): Layout {
  const W = Math.max(width, BASE_R * 3);
  const pos = new Map<string, { x: number; y: number; r: number }>();
  const labels: Layout["labels"] = [];
  type Box = { g: Group; c: Clump; w: number; count: number };
  const rows: Box[][] = [[]];
  let used = 0;
  for (const g of groups) {
    const members = items
      .filter((i) => i.group === g.key)
      .map((i) => ({ key: i.key, r: radiusOf(i.id) * (i.id === openId ? OPEN : 1) }));
    if (!members.length) continue;
    const c = clumpOf(members, W);
    const w = Math.max(c.w, Math.min(g.label.length * 7 + 44, W));
    let row = rows[rows.length - 1];
    if (row.length && used + GAP_X + w > W) {
      rows.push((row = []));
      used = 0;
    }
    used += (row.length ? GAP_X : 0) + w;
    row.push({ g, c, w, count: members.length });
  }
  let y = 0;
  for (const row of rows) {
    if (!row.length) continue;
    const gap = (W - row.reduce((s, b) => s + b.w, 0)) / (row.length + 1);
    let x = gap;
    let rowH = 0;
    for (const { g, c, w, count } of row) {
      labels.push({ key: g.key, label: g.label, count, x: x + w / 2, y, w });
      const ox = x + (w - c.w) / 2 - c.minX,
        oy = y + LABEL - c.minY;
      for (const p of c.pos) pos.set(p.key, { x: ox + p.x, y: oy + p.y, r: p.r });
      x += w + gap;
      rowH = Math.max(rowH, LABEL + c.h);
    }
    y += rowH + GAP_Y;
  }
  return { pos, labels, height: Math.max(0, y - GAP_Y) + 6 };
}

const delayOf = (key: string) => `${Math.round(hash01(key) * 70)}ms`;

export function BubbleMap({
  docs,
  visible,
  groupBy,
  selected,
  picked,
  renamingId,
  onRowClick,
  onRowMenu,
  onStartRename,
  onRename,
}: {
  docs: Doc<Company>[];
  visible: Doc<Company>[];
  groupBy: GroupBy;
  selected: string;
  picked: Set<string>;
  renamingId: string | null;
  onRowClick: (e: React.MouseEvent, id: string) => void;
  onRowMenu: (e: React.MouseEvent, id: string) => void;
  onStartRename: (id: string) => void;
  onRename: (id: string, name: string | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ key: string; id: string; x: number; y: number } | null>(null);
  // Transitions start after the first positioned paint, so bubbles don't fly in.
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!width || ready) return;
    const t = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    return () => cancelAnimationFrame(t);
  }, [width, ready]);

  const { placed, groups } = useMemo(() => {
    const sorted = [...visible].sort((a, b) => a.data.name.localeCompare(b.data.name));
    const groupMap = new Map<string, Group>();
    const placed: Placed[] = [];
    for (const d of sorted)
      groupsOf(d.data, groupBy).forEach((g, i) => {
        if (!groupMap.has(g.key)) groupMap.set(g.key, g);
        placed.push({ key: `${d.id}#${i}`, id: d.id, group: g.key });
      });
    const groups = [...groupMap.values()].sort((a, b) => {
      const [ra, ka] = groupOrder(groupBy, a),
        [rb, kb] = groupOrder(groupBy, b);
      return ra - rb || ka.localeCompare(kb);
    });
    return { placed, groups };
  }, [visible, groupBy]);
  const layout = useMemo(
    () => (width ? layoutMap(placed, groups, width, selected) : null),
    [placed, groups, width, selected],
  );

  // Where each bubble last was, so a filtered-out bubble fades in place and a
  // new tag copy appears beside the company's other bubble.
  const last = useRef(new Map<string, { x: number; y: number; r: number }>());
  useEffect(() => {
    if (layout) for (const [key, p] of layout.pos) last.current.set(key, p);
  }, [layout]);

  const byId = useMemo(() => new Map(docs.map((d) => [d.id, d.data])), [docs]);
  // Every company keeps its first bubble mounted (hidden when filtered out) so
  // filtering animates; extra tag copies come and go. The order follows
  // `docs`, so React never moves nodes (which would cut transitions short).
  const bubbles = useMemo(() => {
    const byCompany = new Map<string, Placed[]>();
    for (const p of placed) byCompany.set(p.id, [...(byCompany.get(p.id) || []), p]);
    return docs.flatMap((d) =>
      (byCompany.get(d.id) || [{ key: `${d.id}#0`, id: d.id, group: "" }]).map(
        (p) => ({ ...p, gone: !byCompany.has(d.id) }),
      ),
    );
  }, [docs, placed]);
  const hovered = hover && byId.get(hover.id);
  const renamePos = renamingId && layout ? layout.pos.get(`${renamingId}#0`) : undefined;

  return (
    <div
      ref={box}
      className={"bubble-map" + (ready ? " ready" : "")}
      style={{ height: Math.max(layout?.height || 0, 120) }}
      role="listbox"
      aria-label="Companies as bubbles"
      aria-multiselectable="true"
    >
      {layout?.labels.map((l) => (
        <div
          key={l.key}
          className="bubble-group-label"
          style={{ transform: `translate(${l.x}px, ${l.y}px) translateX(-50%)`, maxWidth: l.w }}
          title={`${l.label} · ${l.count}`}
        >
          <span>{l.label}</span> <small>{l.count}</small>
        </div>
      ))}
      {layout &&
        bubbles.map((b) => {
          const c = byId.get(b.id);
          if (!c) return null;
          const p = b.gone
            ? last.current.get(b.key)
            : layout.pos.get(b.key) ||
              last.current.get(b.key) ||
              last.current.get(`${b.id}#0`);
          const r = p?.r ?? radiusOf(c.id);
          const at = p || { x: -100, y: -100 };
          const text = c.ticker || c.name;
          return (
            <button
              key={b.key}
              type="button"
              role="option"
              aria-selected={picked.has(c.id)}
              aria-label={`${c.name}${c.ticker ? ` (${c.ticker})` : ""}, ${statusLabels[c.status]}`}
              tabIndex={b.gone ? -1 : 0}
              className={[
                "bubble",
                c.status,
                c.archived ? "archived" : "",
                b.gone || !p ? "gone" : "",
                b.key.endsWith("#0") ? "" : "copy",
                selected === c.id ? "open" : "",
                picked.has(c.id) ? "picked" : "",
                hover?.id === c.id && hover.key !== b.key ? "twin" : "",
              ].join(" ")}
              style={{
                width: 2 * r,
                height: 2 * r,
                transform: `translate(${at.x - r}px, ${at.y - r}px)`,
                // A few milliseconds' difference per bubble keeps the move organic.
                transitionDelay: `${delayOf(b.key)}, ${delayOf(b.key)}, ${delayOf(b.key)}, 0ms, 0ms`,
              }}
              onMouseDown={(e) => e.shiftKey && e.preventDefault()}
              onClick={(e) => onRowClick(e, c.id)}
              onDoubleClick={(e) => {
                e.preventDefault();
                onStartRename(c.id);
              }}
              onContextMenu={(e) => onRowMenu(e, c.id)}
              onMouseEnter={(e) => {
                if (b.gone) return;
                const rect = e.currentTarget.getBoundingClientRect();
                setHover({ key: b.key, id: c.id, x: rect.left + rect.width / 2, y: rect.top });
              }}
              onMouseLeave={() => setHover((h) => (h?.key === b.key ? null : h))}
            >
              <span className={text.length > 5 ? "long" : ""}>
                {text.length > 7 ? text.slice(0, 6) + "…" : text}
              </span>
            </button>
          );
        })}
      {renamingId && renamePos && (
        <div
          className="bubble-rename"
          style={{
            transform: `translate(${Math.max(0, Math.min(width - 200, renamePos.x - 100))}px, ${renamePos.y + renamePos.r + 6}px)`,
          }}
        >
          <InlineName
            className="company-name-input"
            label="Company name"
            value={byId.get(renamingId)?.name || ""}
            onDone={(name) => onRename(renamingId, name)}
          />
        </div>
      )}
      {hovered && hover && !renamingId && (
        <div className="bubble-tip" role="tooltip" style={{ left: hover.x, top: hover.y }}>
          <b>{hovered.name}</b>
          <small>
            {[hovered.ticker, statusLabels[hovered.status], hovered.archived && "Archived"]
              .filter(Boolean)
              .join(" · ")}
          </small>
          {hovered.tags.some(Boolean) && <small>{hovered.tags.filter(Boolean).join(", ")}</small>}
        </div>
      )}
      {layout && !placed.length && (
        <p className="muted bubble-empty">No companies match these filters.</p>
      )}
    </div>
  );
}

export function BubbleLegend() {
  return (
    <span className="bubble-legend" aria-label="Bubble colours">
      {statuses.map((s) => (
        <span key={s}>
          <i className={"bubble-dot " + s} />
          {statusLabels[s]}
        </span>
      ))}
    </span>
  );
}
