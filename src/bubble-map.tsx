import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

// Bubble geometry (px): diameter and centre-to-centre spacing.
const D = 46;
const P = 52;
const LABEL = 26;
const GAP_X = 40;
const GAP_Y = 22;
const ROW = (P * Math.sqrt(3)) / 2;

// Hex-lattice points nearest the centre first, so a group fills as a round
// cluster. Computed once and reused for every group.
const HEX: { x: number; y: number }[] = (() => {
  const pts: { x: number; y: number; d: number }[] = [];
  const R = 30;
  for (let r = -R; r <= R; r++)
    for (let q = -R; q <= R; q++) {
      const x = P * (q + r / 2),
        y = ROW * r;
      pts.push({ x, y, d: Math.hypot(x, y) + Math.atan2(y, x) * 1e-3 });
    }
  return pts.sort((a, b) => a.d - b.d);
})();

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

export interface Layout {
  pos: Map<string, { x: number; y: number }>;
  labels: { key: string; label: string; count: number; x: number; y: number }[];
  height: number;
}

// Lays groups out left to right, wrapping into rows. Small groups are round
// hex clusters; a group too wide for the space becomes a honeycomb block.
export function layoutBubbles(items: Placed[], groups: Group[], width: number): Layout {
  const pos = new Map<string, { x: number; y: number }>();
  const labels: Layout["labels"] = [];
  const W = Math.max(width, D + 8);
  let x = 0,
    y = 0,
    rowH = 0;
  for (const g of groups) {
    const members = items.filter((i) => i.group === g.key);
    if (!members.length) continue;
    let pts = HEX.slice(0, members.length).map((p) => ({ x: p.x, y: p.y }));
    let minX = Math.min(...pts.map((p) => p.x)),
      maxX = Math.max(...pts.map((p) => p.x));
    if (maxX - minX + D > W || members.length > HEX.length) {
      const cols = Math.max(1, Math.floor((W - D - P / 2) / P) + 1);
      pts = members.map((_, i) => {
        const r = Math.floor(i / cols);
        return { x: (i % cols) * P + (r % 2 ? P / 2 : 0), y: r * ROW };
      });
      minX = Math.min(...pts.map((p) => p.x));
      maxX = Math.max(...pts.map((p) => p.x));
    }
    const minY = Math.min(...pts.map((p) => p.y)),
      maxY = Math.max(...pts.map((p) => p.y));
    const labelW = g.label.length * 7 + 40;
    const w = Math.max(maxX - minX + D, Math.min(labelW, W));
    const h = maxY - minY + D + LABEL;
    if (x > 0 && x + w > W) {
      x = 0;
      y += rowH + GAP_Y;
      rowH = 0;
    }
    labels.push({ key: g.key, label: g.label, count: members.length, x, y });
    const offX = x + (w - (maxX - minX + D)) / 2 - minX;
    members.forEach((m, i) =>
      pos.set(m.key, { x: offX + pts[i].x, y: y + LABEL - minY + pts[i].y }),
    );
    x += w + GAP_X;
    rowH = Math.max(rowH, h);
  }
  return { pos, labels, height: y + rowH };
}

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
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  // Skip the transition on the very first layout so bubbles don't fly in.
  const [ready, setReady] = useState(false);
  const last = useRef(new Map<string, { x: number; y: number }>());
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

  const { placed, layout } = useMemo(() => {
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
    return { placed, layout: layoutBubbles(placed, groups, width) };
  }, [visible, groupBy, width]);

  // Remember where each company was, so a filtered-out bubble fades in place.
  useEffect(() => {
    for (const [key, p] of layout.pos) last.current.set(key, p);
  }, [layout]);

  const byId = useMemo(() => new Map(docs.map((d) => [d.id, d.data])), [docs]);
  // Every company keeps its first bubble mounted (hidden when filtered out) so
  // filtering and regrouping animate; extra tag copies come and go. The order
  // follows `docs`, so React never moves nodes (which would cut transitions).
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
  const renamePos = renamingId
    ? layout.pos.get(`${renamingId}#0`)
    : undefined;

  return (
    <div
      ref={box}
      className={"bubble-map" + (ready ? " ready" : "")}
      style={{ height: Math.max(layout.height, 120) }}
      role="listbox"
      aria-label="Companies as bubbles"
      aria-multiselectable="true"
    >
      {layout.labels.map((l) => (
        <div
          key={l.key}
          className="bubble-group-label"
          style={{ transform: `translate(${l.x}px, ${l.y}px)` }}
        >
          {l.label} <small>{l.count}</small>
        </div>
      ))}
      {bubbles.map((b) => {
        const c = byId.get(b.id);
        if (!c) return null;
        const p = b.gone
          ? last.current.get(b.key) || { x: 0, y: 0 }
          : layout.pos.get(b.key)!;
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
              b.gone ? "gone" : "",
              b.key.endsWith("#0") ? "" : "copy",
              selected === c.id ? "open" : "",
              picked.has(c.id) ? "picked" : "",
              hover?.id === c.id ? "twin" : "",
            ].join(" ")}
            style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
            onMouseDown={(e) => e.shiftKey && e.preventDefault()}
            onClick={(e) => onRowClick(e, c.id)}
            onDoubleClick={(e) => {
              e.preventDefault();
              onStartRename(c.id);
            }}
            onContextMenu={(e) => onRowMenu(e, c.id)}
            onMouseEnter={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setHover({ id: c.id, x: r.left + r.width / 2, y: r.top });
            }}
            onMouseLeave={() => setHover(null)}
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
          style={{ transform: `translate(${Math.max(0, renamePos.x - 80)}px, ${renamePos.y + D + 6}px)` }}
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
        <div
          className="bubble-tip"
          role="tooltip"
          style={{ left: hover.x, top: hover.y }}
        >
          <b>{hovered.name}</b>
          <small>
            {[hovered.ticker, statusLabels[hovered.status], hovered.archived && "Archived"]
              .filter(Boolean)
              .join(" · ")}
          </small>
          {hovered.tags.some(Boolean) && (
            <small>{hovered.tags.filter(Boolean).join(", ")}</small>
          )}
        </div>
      )}
      {!placed.length && <p className="muted bubble-empty">No companies match these filters.</p>}
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
