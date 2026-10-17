import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Company,
  DeskEvent,
  Doc,
} from "../supabase/functions/_shared/model";
import {
  JOURNAL_SECTIONS,
  compareJournal,
  daysSince,
  isStale,
  journalSection,
  journalSectionById,
  planReorder,
  sectionPatch,
  type JournalSectionId,
} from "../supabase/functions/_shared/journal";
import { groupNews } from "../supabase/functions/_shared/screening-policy";
import { newsBucket } from "../supabase/functions/_shared/news";
import { inEventFolder } from "../supabase/functions/_shared/event-inbox";
import {
  cadenceOf,
  chicagoParts,
  safeLink,
} from "../supabase/functions/_shared/engine";
import { formatMarketCap } from "../supabase/functions/_shared/company-size";
import {
  NotesEditor,
  SectionPicker,
  type NotesEditorHandle,
} from "./notes-editor";
import { InlineName, shortDate } from "./ui";

// The journal: every idea as one long document, in the sections and order of
// the Investment Pitch List. The outline on the left finds and reorders
// companies; the page on the right is for reading and writing.

type Edit = (id: string, patch: Partial<Company>) => void;
interface NewsItem {
  id: string;
  title: string;
  url: string;
  at: string;
  published: string;
}
interface Drop {
  section: JournalSectionId;
  // Insert before this company, or at the end of the section when null.
  before: string | null;
}

function readCollapsed(): Set<string> {
  try {
    return new Set(
      JSON.parse(localStorage.getItem("journal-collapsed") || "[]"),
    );
  } catch {
    return new Set();
  }
}

// Renders a card's notes only once it nears the screen; it then stays rendered.
function useNear(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    if (typeof IntersectionObserver === "undefined") return setNear(true);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { root: el.closest(".journal-doc"), rootMargin: "1500px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref]);
  return near;
}

export function Journal({
  docs,
  events,
  edit,
  openNotebook,
  onStopNews,
  onAdd,
  focus,
  onToggleFocus,
  jumpTo,
  onJumped,
}: {
  docs: Doc<Company>[];
  events: Doc<DeskEvent>[];
  edit: Edit;
  openNotebook: (id: string) => void;
  onStopNews: (id: string) => void;
  onAdd: () => void;
  focus: boolean;
  onToggleFocus: () => void;
  jumpTo: string;
  onJumped: () => void;
}) {
  // Stable callbacks keep unchanged cards from re-rendering on every keystroke.
  const live = useRef({ edit, openNotebook, onStopNews });
  live.current = { edit, openNotebook, onStopNews };
  const stableEdit = useCallback<Edit>((id, p) => live.current.edit(id, p), []);
  const stableOpen = useCallback(
    (id: string) => live.current.openNotebook(id),
    [],
  );
  const stableStop = useCallback(
    (id: string) => live.current.onStopNews(id),
    [],
  );

  const [query, setQuery] = useState("");
  // Ids needing attention when the filter was switched on. A snapshot, so a
  // card does not vanish while you write in it (writing marks it reviewed).
  const [attention, setAttention] = useState<Set<string> | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [active, setActive] = useState("");
  const [flash, setFlash] = useState("");
  const [passing, setPassing] = useState<{
    id: string;
    section: JournalSectionId;
    before: string | null | undefined;
  } | null>(null);
  const [dragId, setDragId] = useState("");
  const [drop, setDrop] = useState<Drop | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLElement>(null);

  const newsByCompany = useMemo(() => {
    const relevant = events.filter(
      (d) =>
        d.data.kind === "news" &&
        inEventFolder(d.data, "inbox") &&
        newsBucket(d.data) === "relevant",
    );
    const map = new Map<string, NewsItem[]>();
    for (const g of groupNews(relevant)) {
      const e = g.lead.data;
      const list = map.get(e.companyId) || [];
      list.push({
        id: g.lead.id,
        title: e.title,
        url: e.url,
        at: [g.lead, ...g.coverage].reduce(
          (at, d) => (d.data.discoveredAt > at ? d.data.discoveredAt : at),
          "",
        ),
        published: e.publishedAt,
      });
      map.set(e.companyId, list);
    }
    for (const list of map.values())
      list.sort((a, b) => b.at.localeCompare(a.at));
    return map;
  }, [events]);
  const freshNews = (c: Company) =>
    (newsByCompany.get(c.id) || []).filter(
      (n) => !c.lastReviewed || n.at > c.lastReviewed,
    );

  const bySection = useMemo(() => {
    const map = new Map<JournalSectionId, Doc<Company>[]>(
      JOURNAL_SECTIONS.map((s) => [s.id, []]),
    );
    for (const d of docs) {
      const id = journalSection(d.data);
      if (id) map.get(id)!.push(d);
    }
    for (const list of map.values())
      list.sort((a, b) => compareJournal(a.data, b.data));
    return map;
  }, [docs]);
  const q = query.trim().toLowerCase();
  const needsAttention = (c: Company) => isStale(c) || freshNews(c).length > 0;
  const shown = (d: Doc<Company>) =>
    (!q || `${d.data.name}\n${d.data.notes}`.toLowerCase().includes(q)) &&
    (!attention || attention.has(d.id));
  const visible = JOURNAL_SECTIONS.map((s) => ({
    section: s,
    all: bySection.get(s.id)!,
    items: bySection.get(s.id)!.filter(shown),
  }));
  const total = visible.reduce((n, v) => n + v.all.length, 0);
  const attentionCount = useMemo(
    () =>
      [...bySection.values()].flat().filter((d) => needsAttention(d.data))
        .length,
    [bySection, newsByCompany],
  );
  const orderKey = visible.flatMap((v) => v.items.map((d) => d.id)).join(",");

  const jump = useCallback((id: string) => {
    const el = docRef.current?.querySelector<HTMLElement>(
      `[data-card="${id}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    setActive(id);
    setFlash(id);
    setTimeout(() => setFlash((f) => (f === id ? "" : f)), 1400);
  }, []);
  useEffect(() => {
    if (!jumpTo) return;
    const t = setTimeout(() => {
      jump(jumpTo);
      onJumped();
    }, 50);
    return () => clearTimeout(t);
  }, [jumpTo, jump, onJumped]);

  // The outline follows the card at the top of the page.
  useEffect(() => {
    const root = docRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const inBand = new Set<string>();
    const order = orderKey.split(",");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.card!;
          if (e.isIntersecting) inBand.add(id);
          else inBand.delete(id);
        }
        const first = order.find((id) => inBand.has(id));
        if (first) setActive(first);
      },
      // Below the sticky heading, in the top part of the page.
      { root, rootMargin: "-90px 0px -60% 0px" },
    );
    root.querySelectorAll("[data-card]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [orderKey]);
  useEffect(() => {
    outlineRef.current
      ?.querySelector(`[data-outline="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const toggleSection = (id: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem("journal-collapsed", JSON.stringify([...next]));
      } catch {
        /* storage unavailable; the choice lasts for this visit */
      }
      return next;
    });

  // Moves a company to a section (and position). Moving an idea into Passed
  // first asks why, inside its card.
  const place = (
    id: string,
    target: JournalSectionId,
    before: string | null | undefined,
    extra: Partial<Company> = {},
  ) => {
    const list = bySection.get(target)!.map((d) => ({
      id: d.id,
      journalOrder: d.data.journalOrder,
    }));
    const rest = list.filter((x) => x.id !== id);
    const index =
      before === undefined
        ? undefined
        : before === null
          ? rest.length
          : Math.max(
              0,
              rest.findIndex((x) => x.id === before),
            );
    const doc = docs.find((d) => d.id === id);
    const moving = doc && journalSection(doc.data) !== target;
    if (
      !moving &&
      index !== undefined &&
      list.findIndex((x) => x.id === id) === index
    )
      return;
    const patches = index === undefined ? [] : planReorder(list, id, index);
    const own = patches.find((p) => p.id === id);
    stableEdit(id, {
      ...(moving ? sectionPatch(target) : {}),
      ...(own ? { journalOrder: own.journalOrder } : {}),
      ...extra,
    });
    for (const p of patches)
      if (p.id !== id) stableEdit(p.id, { journalOrder: p.journalOrder });
  };
  const move = useCallback(
    (id: string, target: JournalSectionId, before?: string | null) => {
      const doc = docs.find((d) => d.id === id);
      if (!doc) return;
      if (
        journalSectionById(target).status === "pass" &&
        doc.data.status !== "pass"
      ) {
        setPassing({ id, section: target, before });
        setTimeout(() => jump(id), 30);
        return;
      }
      place(id, target, before);
    },
    [docs, bySection],
  );
  const moveRef = useRef(move);
  moveRef.current = move;
  const stableMove = useCallback(
    (id: string, target: JournalSectionId) => moveRef.current(id, target),
    [],
  );
  const finishPass = (kind: "valued" | "unvalued", reason: string) => {
    if (!passing) return;
    const doc = docs.find((d) => d.id === passing.id);
    const old = doc?.data.passReason.trim() || "";
    const why = reason.trim();
    place(
      passing.id,
      kind === "valued" ? "pass-valued" : "pass-unvalued",
      passing.before,
      {
        passedAt: chicagoParts().date,
        ...(why ? { passReason: old ? `${why}\n\n${old}` : why } : {}),
      },
    );
    setPassing(null);
  };
  const passRef = useRef(finishPass);
  passRef.current = finishPass;
  const stablePassDone = useCallback(
    (kind: "valued" | "unvalued", reason: string) =>
      passRef.current(kind, reason),
    [],
  );
  const stablePassCancel = useCallback(() => setPassing(null), []);

  const dragOverItem = (
    e: React.DragEvent,
    section: JournalSectionId,
    items: Doc<Company>[],
    i: number,
  ) => {
    if (!dragId) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const target = after ? items[i + 1] : items[i];
    setDrop({ section, before: target?.id ?? null });
  };
  const finishDrag = () => {
    if (dragId && drop && drop.before !== dragId)
      move(dragId, drop.section, drop.before);
    setDragId("");
    setDrop(null);
  };

  return (
    <div className={"journal" + (dragId ? " dragging" : "")}>
      <aside
        className="journal-outline"
        ref={outlineRef}
        aria-label="Journal outline"
      >
        <div className="outline-tools">
          <input
            type="search"
            className="outline-search"
            aria-label="Find a company in the journal"
            placeholder="Find a company or phrase…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const first = visible.find((v) => v.items.length)?.items[0];
                if (first) jump(first.id);
              }
            }}
          />
          <button
            type="button"
            className={"chip" + (attention ? " selected" : "")}
            aria-pressed={!!attention}
            onClick={() =>
              setAttention(
                attention
                  ? null
                  : new Set(
                      [...bySection.values()]
                        .flat()
                        .filter((d) => needsAttention(d.data))
                        .map((d) => d.id),
                    ),
              )
            }
            title="Ideas with new news since your last review, or not reviewed for a while"
          >
            Needs attention ({attentionCount})
          </button>
          <p className="outline-hint">
            Drag names to reorder or move them between sections.
          </p>
        </div>
        {visible.map(({ section, all, items }) => (
          <div className="outline-section" key={section.id}>
            <button
              type="button"
              className="outline-heading"
              aria-expanded={!collapsed.has(section.id)}
              onClick={() => toggleSection(section.id)}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setDrop({ section: section.id, before: all[0]?.id ?? null });
              }}
              onDrop={(e) => {
                e.preventDefault();
                finishDrag();
              }}
            >
              <span aria-hidden>{collapsed.has(section.id) ? "▸" : "▾"}</span>
              {section.label}
              <small>
                {q || attention ? `${items.length}/${all.length}` : all.length}
              </small>
            </button>
            {!collapsed.has(section.id) && (
              <ol
                className={
                  drop?.section === section.id && drop.before === null
                    ? "drop-end"
                    : ""
                }
                onDragOver={(e) => {
                  if (!dragId || e.target !== e.currentTarget) return;
                  e.preventDefault();
                  setDrop({ section: section.id, before: null });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  finishDrag();
                }}
              >
                {items.map((d, i) => {
                  const news = freshNews(d.data).length;
                  return (
                    <li
                      key={d.id}
                      data-outline={d.id}
                      draggable
                      className={[
                        active === d.id ? "active" : "",
                        dragId === d.id ? "dragged" : "",
                        drop?.before === d.id && drop.section === section.id
                          ? "drop-before"
                          : "",
                      ].join(" ")}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", d.data.name);
                        setDragId(d.id);
                      }}
                      onDragEnd={() => {
                        setDragId("");
                        setDrop(null);
                      }}
                      onDragOver={(e) => dragOverItem(e, section.id, items, i)}
                      onDrop={(e) => {
                        e.preventDefault();
                        finishDrag();
                      }}
                    >
                      <span
                        role="button"
                        tabIndex={0}
                        className="outline-name"
                        title={d.data.name}
                        onClick={() => jump(d.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            jump(d.id);
                          }
                        }}
                      >
                        {d.data.name}
                      </span>
                      {news > 0 && (
                        <span
                          className="outline-dot"
                          title={`${news} new development${news === 1 ? "" : "s"}`}
                        />
                      )}
                    </li>
                  );
                })}
                {!items.length && (
                  <li className="outline-empty">
                    {all.length ? "No matches" : "Empty"}
                  </li>
                )}
              </ol>
            )}
          </div>
        ))}
      </aside>
      <div className="journal-doc" ref={docRef}>
        <header className="journal-head">
          <div>
            <p className="eyebrow">INVESTMENT JOURNAL</p>
            <h1>
              Ideas <span>{total}</span>
            </h1>
          </div>
          <div className="journal-actions">
            <button type="button" onClick={onAdd}>
              + Add idea
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={onToggleFocus}
              aria-pressed={focus}
              aria-label={focus ? "Leave full screen" : "Full screen"}
              title={focus ? "Leave full screen (Esc)" : "Full screen"}
            >
              {focus ? "⤡" : "⤢"}
            </button>
          </div>
        </header>
        {visible.map(({ section, items, all }) => (
          <section
            className="journal-section"
            key={section.id}
            aria-labelledby={`js-${section.id}`}
          >
            <h2 id={`js-${section.id}`}>
              {section.label} <small>{section.hint}</small>
            </h2>
            {!items.length && (
              <p className="muted journal-empty">
                {all.length ? "No ideas here match." : "Nothing here yet."}
              </p>
            )}
            {items.map((d) => (
              <JournalCard
                key={d.id}
                doc={d}
                news={newsByCompany.get(d.id)}
                edit={stableEdit}
                onMove={stableMove}
                onOpen={stableOpen}
                onStopNews={stableStop}
                flash={flash === d.id}
                passing={passing?.id === d.id ? passing.section : null}
                onPassDone={stablePassDone}
                onPassCancel={stablePassCancel}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

const JournalCard = React.memo(function JournalCard({
  doc,
  news,
  edit,
  onMove,
  onOpen,
  onStopNews,
  flash,
  passing,
  onPassDone,
  onPassCancel,
}: {
  doc: Doc<Company>;
  news: NewsItem[] | undefined;
  edit: Edit;
  onMove: (id: string, section: JournalSectionId) => void;
  onOpen: (id: string) => void;
  onStopNews: (id: string) => void;
  flash: boolean;
  passing: JournalSectionId | null;
  onPassDone: (kind: "valued" | "unvalued", reason: string) => void;
  onPassCancel: () => void;
}) {
  const c = doc.data;
  const ref = useRef<HTMLElement>(null);
  const editor = useRef<NotesEditorHandle>(null);
  const near = useNear(ref);
  const [renaming, setRenaming] = useState(false);
  const [showNews, setShowNews] = useState(false);
  const section = journalSection(c)!;
  const fresh = (news || []).filter(
    (n) => !c.lastReviewed || n.at > c.lastReviewed,
  );
  const paused = cadenceOf(c) === "paused";
  const days = daysSince(c.lastReviewed);
  const stale = isStale(c);
  const facts = [
    c.country,
    c.marketCapUsd ? `${formatMarketCap(c.marketCapUsd)} market cap` : "",
    c.ideaSource
      ? `Source: ${c.ideaSource.length > 60 ? c.ideaSource.slice(0, 57) + "…" : c.ideaSource}`
      : "",
    c.dateFound ? `Found ${shortDate(c.dateFound)}` : "",
    c.status === "pass" && c.passedAt ? `Passed ${shortDate(c.passedAt)}` : "",
  ].filter(Boolean);
  const lines = c.notes.split("\n").length;
  return (
    <article
      ref={ref}
      data-card={c.id}
      id={`journal-${c.id}`}
      className={"jcard" + (flash ? " flash" : "")}
    >
      <header className="jcard-head">
        {renaming ? (
          <InlineName
            className="jcard-name-input"
            label="Company name"
            value={c.name}
            onDone={(name) => {
              setRenaming(false);
              if (name !== null && name.trim() && name.trim() !== c.name)
                edit(c.id, { name: name.trim() });
            }}
          />
        ) : (
          <h3
            title="Double-click to rename"
            onDoubleClick={() => setRenaming(true)}
          >
            {c.name}
          </h3>
        )}
        <div className="jcard-tools">
          <SectionPicker
            compact
            onInsert={(block) => editor.current?.insert(block)}
          />
          <select
            aria-label={`Section for ${c.name}`}
            value={section}
            onChange={(e) => onMove(c.id, e.target.value as JournalSectionId)}
          >
            {JOURNAL_SECTIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() =>
              edit(c.id, { lastReviewed: new Date().toISOString() })
            }
            title="You looked at this idea again; nothing to add"
          >
            ✓ Reviewed
          </button>
          <button
            type="button"
            onClick={() => onOpen(c.id)}
            title="Open the notebook"
          >
            Notebook
          </button>
        </div>
      </header>
      <p className="jcard-facts">
        {facts.map((f) => (
          <span key={f}>{f}</span>
        ))}
        <span className={stale ? "stale" : ""}>
          {c.lastReviewed
            ? `Reviewed ${shortDate(c.lastReviewed)}${days !== null && days > 30 ? ` · ${days} days ago` : ""}`
            : "No review date yet"}
        </span>
      </p>
      {passing && (
        <PassBox
          initial={passing}
          name={c.name}
          onConfirm={onPassDone}
          onCancel={onPassCancel}
        />
      )}
      {c.status === "pass" && c.passReason.trim() && (
        <p className="jcard-pass">
          <b>Why I passed:</b> {c.passReason}
        </p>
      )}
      {near ? (
        <NotesEditor
          ref={editor}
          edit="click"
          className="jcard-notes"
          label={`Notes on ${c.name}`}
          placeholder="Click to start writing…"
          value={c.notes}
          onChange={(notes) => edit(c.id, { notes })}
        />
      ) : (
        <div
          className="jcard-placeholder"
          style={{ height: Math.min(4000, 30 + lines * 27) }}
        />
      )}
      <footer className="jcard-news">
        {paused ? (
          <>
            <span>News off</span>
            <button
              type="button"
              className="link"
              onClick={() => edit(c.id, { cadence: "auto" })}
            >
              Turn on
            </button>
          </>
        ) : fresh.length ? (
          <button
            type="button"
            className="link news-count"
            aria-expanded={showNews}
            onClick={() => setShowNews(!showNews)}
          >
            {fresh.length} new development{fresh.length === 1 ? "" : "s"} since
            your last review {showNews ? "▴" : "▾"}
          </button>
        ) : (
          <span>No new news since your last review</span>
        )}
        {!paused && (
          <button
            type="button"
            className="link quiet"
            onClick={() => onStopNews(c.id)}
          >
            Stop news
          </button>
        )}
        {showNews && fresh.length > 0 && (
          <ul>
            {fresh.slice(0, 6).map((n) => (
              <li key={n.id}>
                {safeLink(n.url) ? (
                  <a href={safeLink(n.url)} target="_blank" rel="noreferrer">
                    {n.title}
                  </a>
                ) : (
                  n.title
                )}{" "}
                <small>{shortDate(n.published || n.at)}</small>
              </li>
            ))}
            {fresh.length > 6 && (
              <li>…and {fresh.length - 6} more on the News page</li>
            )}
          </ul>
        )}
      </footer>
    </article>
  );
});

function PassBox({
  initial,
  name,
  onConfirm,
  onCancel,
}: {
  initial: JournalSectionId;
  name: string;
  onConfirm: (kind: "valued" | "unvalued", reason: string) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<"valued" | "unvalued">(
    initial === "pass-valued" ? "valued" : "unvalued",
  );
  const [reason, setReason] = useState("");
  return (
    <div className="pass-box" role="group" aria-label={`Pass on ${name}`}>
      <b>Passing on {name}</b>
      <div className="pass-kind">
        <label>
          <input
            type="radio"
            checked={kind === "valued"}
            onChange={() => setKind("valued")}
          />{" "}
          I valued it
        </label>
        <label>
          <input
            type="radio"
            checked={kind === "unvalued"}
            onChange={() => setKind("unvalued")}
          />{" "}
          Not valued
        </label>
      </div>
      <textarea
        autoFocus
        rows={3}
        aria-label="Why I passed"
        placeholder="Why I passed, and what would change my mind (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="pass-actions">
        <button
          type="button"
          className="primary"
          onClick={() => onConfirm(kind, reason)}
        >
          Move to Passed
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
