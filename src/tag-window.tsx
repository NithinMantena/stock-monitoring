import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Company, Doc } from "../supabase/functions/_shared/model";
import { statusLabels } from "../supabase/functions/_shared/constants";
import { formatMarketCap } from "../supabase/functions/_shared/company-size";
import { formatMoney } from "../supabase/functions/_shared/engine";
import {
  companyMatchScore,
  hasTag,
  normalizeTag,
  sameTag,
  tagCounts,
  type Library,
} from "../supabase/functions/_shared/library";
import { ContextMenu } from "./company-menu";

export function TagChip({
  tag,
  onOpen,
  small = false,
}: {
  tag: string;
  onOpen?: (tag: string) => void;
  small?: boolean;
}) {
  if (!onOpen)
    return <span className={small ? "tag-chip small" : "tag-chip"}>{tag}</span>;
  return (
    <button
      type="button"
      className={small ? "tag-chip small" : "tag-chip"}
      title={`Open the tag window for "${tag}"`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(tag);
      }}
    >
      {tag}
    </button>
  );
}

const capOf = (c: Company) =>
  c.marketCapUsd
    ? formatMarketCap(c.marketCapUsd)
    : c.quote?.marketCap
      ? formatMoney(c.quote.marketCap, c.currency)
      : "—";
const foundOf = (c: Company) => c.dateFound || (c.createdAt || "").slice(0, 10);
const listOf = (c: Company) =>
  c.archived ? "Archived" : statusLabels[c.status];

// Three panes: tags (find, pick, create), companies (search and click whole rows),
// and the selection for this tag. Nothing is written until Confirm.
export function TagWindow({
  companies,
  library,
  initialTag = "",
  onClose,
  onConfirm,
  onCreateTag,
  onDeleteTag,
  onRenameTag,
}: {
  companies: Doc<Company>[];
  library: Library;
  initialTag?: string;
  onClose: () => void;
  onConfirm: (tag: string, add: string[], remove: string[]) => Promise<void>;
  onCreateTag: (tag: string) => Promise<void>;
  onDeleteTag: (tag: string) => Promise<void>;
  onRenameTag: (from: string, to: string) => Promise<void>;
}) {
  const [tag, setTag] = useState(initialTag);
  const [tagQuery, setTagQuery] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [adding, setAdding] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  // Renaming a tag in the left pane, and its right-click menu.
  const [renaming, setRenaming] = useState<{ tag: string; text: string } | null>(null);
  const [menu, setMenu] = useState<{ tag: string; count: number; x: number; y: number } | null>(null);
  const anchor = useRef<number | null>(null);
  const renamingNow = useRef(renaming);
  renamingNow.current = renaming;
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tags = useMemo(() => tagCounts(companies, library), [companies, library]);
  const byId = useMemo(
    () => new Map(companies.map((d) => [d.id, d.data])),
    [companies],
  );
  const dirty = adding.length + removing.length;
  const tagged = useMemo(
    () =>
      tag
        ? companies
            .filter((d) => hasTag(d.data, tag))
            .sort((a, b) => a.data.name.localeCompare(b.data.name))
        : [],
    [companies, tag],
  );
  const visibleTags = tags.filter((t) =>
    t.tag.toLowerCase().includes(tagQuery.trim().toLowerCase()),
  );
  const canCreate =
    !!normalizeTag(tagQuery) && !tags.some((t) => sameTag(t.tag, tagQuery));
  const rows = useMemo(() => {
    const scored = companies
      .filter(
        (d) =>
          !statusFilter ||
          (statusFilter === "archived"
            ? d.data.archived
            : !d.data.archived && d.data.status === statusFilter),
      )
      .map((d) => ({ d, score: companyMatchScore(d.data, query) }))
      .filter((x) => x.score > 0);
    return scored
      .sort(
        (a, b) =>
          b.score - a.score || a.d.data.name.localeCompare(b.d.data.name),
      )
      .map((x) => x.d);
  }, [companies, query, statusFilter]);
  useEffect(() => setActive(0), [query, statusFilter]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    if (tag) search.current?.focus();
  }, [tag]);

  const chooseTag = (next: string) => {
    if (sameTag(next, tag)) return;
    if (
      dirty &&
      !confirm(
        `Discard ${dirty} unconfirmed change${dirty === 1 ? "" : "s"} to "${tag}"?`,
      )
    )
      return;
    setTag(next);
    setAdding([]);
    setRemoving([]);
    setFlash("");
    setError("");
  };
  const isSelected = (c: Company) =>
    adding.includes(c.id) || (hasTag(c, tag) && !removing.includes(c.id));
  // Puts companies into (want = true) or out of the selection for this tag.
  const setMany = (cs: Company[], want: boolean) => {
    if (!tag) return;
    setFlash("");
    const has = cs.filter((c) => hasTag(c, tag)).map((c) => c.id);
    const lacks = cs.filter((c) => !hasTag(c, tag)).map((c) => c.id);
    setRemoving((r) =>
      want ? r.filter((x) => !has.includes(x)) : [...new Set([...r, ...has])],
    );
    setAdding((a) =>
      want
        ? [...lacks.filter((x) => !a.includes(x)).reverse(), ...a]
        : a.filter((x) => !lacks.includes(x)),
    );
  };
  const toggle = (c: Company) => setMany([c], !isSelected(c));
  // Shift-click selects (or clears) every row between the last click and this one.
  const clickRow = (e: React.MouseEvent, i: number) => {
    const c = rows[i]?.data;
    if (!c || !tag) return;
    const from = anchor.current;
    if (e.shiftKey && from !== null && rows[from]) {
      const [a, b] = [from, i].sort((x, y) => x - y);
      setMany(
        rows.slice(a, b + 1).map((d) => d.data),
        isSelected(rows[from].data),
      );
    } else {
      toggle(c);
      anchor.current = i;
    }
  };
  useEffect(() => {
    anchor.current = null;
  }, [query, statusFilter, tag]);
  const rename = async (from: string, raw: string) => {
    const to = normalizeTag(raw);
    setRenaming(null);
    if (!to || to === normalizeTag(from)) return;
    if (dirty) {
      setError("Confirm or cancel your changes before renaming a tag.");
      return;
    }
    const other = tags.find((t) => sameTag(t.tag, to) && !sameTag(t.tag, from));
    if (
      other &&
      !confirm(
        `"${other.tag}" already exists. Merge "${from}" into "${other.tag}"? Companies tagged "${from}" will be tagged "${other.tag}" and "${from}" will disappear.`,
      )
    )
      return;
    setError("");
    setBusy(true);
    try {
      await onRenameTag(from, other?.tag || to);
      if (sameTag(tag, from)) setTag(other?.tag || to);
      setFlash(
        other
          ? `Merged "${from}" into "${other.tag}".`
          : `Renamed "${from}" to "${to}".`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirmChanges = async () => {
    if (!tag || !dirty || busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm(tag, adding, removing);
      setFlash(
        `Saved "${tag}": ${adding.length ? `added to ${adding.length}` : ""}${adding.length && removing.length ? ", " : ""}${removing.length ? `removed from ${removing.length}` : ""}.`,
      );
      setAdding([]);
      setRemoving([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (
      dirty &&
      !confirm(
        `Close without saving ${dirty} change${dirty === 1 ? "" : "s"} to "${tag}"?`,
      )
    )
      return;
    onClose();
  };
  const createTag = async () => {
    const next = normalizeTag(tagQuery);
    if (!next) return;
    setError("");
    try {
      await onCreateTag(next);
      setTagQuery("");
      chooseTag(next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <dialog
      className="modal-backdrop"
      aria-labelledby="tag-window-title"
      ref={(node) => {
        if (node && !node.open) node.showModal();
      }}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="modal tag-window">
        <header className="tag-window-head">
          <div>
            <p className="eyebrow">TAG COMPANIES</p>
            <h2 id="tag-window-title">
              {tag ? <>Tagging “{tag}”</> : "Choose or create a tag"}
            </h2>
          </div>
          <button
            type="button"
            className="dismiss"
            aria-label="Close tag window"
            onClick={close}
          >
            ×
          </button>
        </header>
        <div className="tag-panes">
          <section className="tag-pane tags" aria-label="Tags">
            <input
              type="search"
              aria-label="Find or create a tag"
              placeholder="Find or create a tag…"
              autoFocus={!initialTag}
              value={tagQuery}
              onChange={(e) => setTagQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (canCreate) void createTag();
                else if (visibleTags[0]) {
                  chooseTag(visibleTags[0].tag);
                  setTagQuery("");
                }
              }}
            />
            {canCreate && (
              <button type="button" className="tag-create" onClick={createTag}>
                + Create “{normalizeTag(tagQuery)}”
              </button>
            )}
            <ul className="tag-options">
              {visibleTags.map((t) => (
                <li key={t.tag}>
                  {renaming && sameTag(renaming.tag, t.tag) ? (
                    <input
                      className="tag-rename"
                      aria-label={`Rename tag ${t.tag}`}
                      autoFocus
                      maxLength={80}
                      value={renaming.text}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) =>
                        setRenaming({ tag: t.tag, text: e.target.value })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void rename(t.tag, renaming.text);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          setRenaming(null);
                        }
                      }}
                      onBlur={() => {
                        // Enter and Escape already finished the rename.
                        if (renamingNow.current) void rename(t.tag, renaming.text);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className={sameTag(t.tag, tag) ? "selected" : ""}
                      aria-pressed={sameTag(t.tag, tag)}
                      title="Double-click or right-click to rename"
                      onClick={() => chooseTag(t.tag)}
                      onDoubleClick={() =>
                        setRenaming({ tag: t.tag, text: t.tag })
                      }
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ ...t, x: e.clientX, y: e.clientY });
                      }}
                    >
                      <span>{t.tag}</span>
                      <small>{t.count}</small>
                    </button>
                  )}
                  {t.count === 0 && (
                    <button
                      type="button"
                      className="link tag-delete"
                      aria-label={`Delete unused tag ${t.tag}`}
                      title="Delete this unused tag"
                      onClick={() => {
                        if (sameTag(t.tag, tag)) setTag("");
                        void onDeleteTag(t.tag).catch((e) =>
                          setError((e as Error).message),
                        );
                      }}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
              {!visibleTags.length && !canCreate && (
                <li className="muted">No tags yet. Type a name to create one.</li>
              )}
            </ul>
          </section>

          <section className="tag-pane companies" aria-label="Companies">
            <div className="tag-search-row">
              <input
                ref={search}
                type="search"
                aria-label="Search companies to tag"
                placeholder={
                  tag
                    ? "Type a name or ticker, Enter adds the best match…"
                    : "Pick a tag first"
                }
                disabled={!tag}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((i) => Math.min(rows.length - 1, i + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((i) => Math.max(0, i - 1));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const row = rows[active];
                    if (row && query.trim()) {
                      toggle(row.data);
                      setQuery("");
                    }
                  } else if (e.key === "Escape" && query) {
                    e.preventDefault();
                    e.stopPropagation();
                    setQuery("");
                  }
                }}
              />
              <select
                aria-label="Show companies from list"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">All lists</option>
                {Object.entries(statusLabels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
                <option value="archived">Archived</option>
              </select>
            </div>
            <p className="muted tag-hint">
              {rows.length} {rows.length === 1 ? "company" : "companies"}
              {query && rows[0] ? ` · Enter adds ${rows[active]?.data.name}` : ""}
              {" · ↑↓ to move · Shift-click selects a range"}
            </p>
            <div className="tag-rows" ref={listRef} role="listbox" aria-multiselectable="true">
              {rows.map((d, i) => {
                const c = d.data;
                const selected = !!tag && isSelected(c);
                const state = adding.includes(c.id)
                  ? "adding"
                  : removing.includes(c.id)
                    ? "removing"
                    : hasTag(c, tag)
                      ? "tagged"
                      : "";
                const others = c.tags.filter(
                  (t) => normalizeTag(t) && !sameTag(t, tag),
                );
                return (
                  <div
                    key={d.id}
                    data-row={i}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={!tag}
                    tabIndex={-1}
                    className={[
                      "tag-row",
                      selected ? "selected" : "",
                      state,
                      i === active && query ? "active" : "",
                    ].join(" ")}
                    onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                    onClick={(e) => clickRow(e, i)}
                    onMouseEnter={() => query && setActive(i)}
                  >
                    <div className="tag-row-main">
                      <b>{c.name}</b>
                      <small>
                        {c.ticker || "No ticker"} · {listOf(c)}
                        {c.originalGroup ? ` · ${c.originalGroup}` : ""}
                      </small>
                    </div>
                    <div className="tag-row-facts">
                      <span title="Market cap">{capOf(c)}</span>
                      <small title="Date found">
                        {foundOf(c) ? `Found ${foundOf(c)}` : ""}
                      </small>
                    </div>
                    <div className="tag-row-tags">
                      {others.slice(0, 4).map((t) => (
                        <TagChip key={t} tag={t} small />
                      ))}
                      {others.length > 4 && (
                        <small className="muted">+{others.length - 4}</small>
                      )}
                    </div>
                    <span className="tag-row-mark" aria-hidden>
                      {state === "adding"
                        ? "+ New"
                        : state === "removing"
                          ? "− Remove"
                          : state === "tagged"
                            ? "✓ Tagged"
                            : ""}
                    </span>
                  </div>
                );
              })}
              {!rows.length && (
                <p className="muted">No companies match “{query}”.</p>
              )}
            </div>
          </section>

          <section className="tag-pane selection" aria-label="Selected companies">
            <h3>
              {tag ? `“${tag}”` : "No tag chosen"}
              <small>
                {tagged.length - removing.length + adding.length} companies
              </small>
            </h3>
            {adding.length > 0 && (
              <>
                <p className="tag-section-label new">
                  Added this session ({adding.length})
                </p>
                <ul className="tag-picked">
                  {adding.map((id) => (
                    <li key={id} className="adding">
                      <span>{byId.get(id)?.name}</span>
                      <button
                        type="button"
                        className="link"
                        aria-label={`Undo adding ${byId.get(id)?.name}`}
                        onClick={() => setAdding((a) => a.filter((x) => x !== id))}
                      >
                        Undo
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {removing.length > 0 && (
              <>
                <p className="tag-section-label remove">
                  Removing ({removing.length})
                </p>
                <ul className="tag-picked">
                  {removing.map((id) => (
                    <li key={id} className="removing">
                      <span>{byId.get(id)?.name}</span>
                      <button
                        type="button"
                        className="link"
                        aria-label={`Keep ${byId.get(id)?.name}`}
                        onClick={() =>
                          setRemoving((r) => r.filter((x) => x !== id))
                        }
                      >
                        Keep
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="tag-section-label">
              Already tagged ({tagged.length})
            </p>
            <ul className="tag-picked">
              {tagged.map((d) => (
                <li
                  key={d.id}
                  className={removing.includes(d.id) ? "removing" : "existing"}
                >
                  <span>{d.data.name}</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => toggle(d.data)}
                  >
                    {removing.includes(d.id) ? "Keep" : "Remove"}
                  </button>
                </li>
              ))}
              {!tagged.length && (
                <li className="muted">
                  {tag ? "No companies have this tag yet." : "Pick a tag on the left."}
                </li>
              )}
            </ul>
          </section>
        </div>
        <footer className="tag-window-foot">
          {error && <span role="alert">{error}</span>}
          {flash && !dirty && <span role="status">{flash}</span>}
          <span className="muted">
            {dirty
              ? `${adding.length} to add · ${removing.length} to remove`
              : "Click rows to select. Nothing changes until you confirm."}
          </span>
          <button type="button" onClick={close}>
            {dirty ? "Cancel" : "Done"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!dirty || busy}
            onClick={confirmChanges}
          >
            {busy
              ? "Saving…"
              : `Confirm${dirty ? ` · +${adding.length} / −${removing.length}` : ""}`}
          </button>
        </footer>
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            title={`“${menu.tag}”`}
            onClose={() => setMenu(null)}
            items={[
              {
                label: "Edit name",
                hint: "or double-click",
                onSelect: () => setRenaming({ tag: menu.tag, text: menu.tag }),
              },
              { label: "Tag companies", onSelect: () => chooseTag(menu.tag) },
              "separator",
              {
                label: "Delete tag",
                danger: true,
                disabled: menu.count > 0,
                hint: menu.count > 0 ? "only unused tags" : undefined,
                onSelect: () => {
                  if (sameTag(menu.tag, tag)) setTag("");
                  void onDeleteTag(menu.tag).catch((e) =>
                    setError((e as Error).message),
                  );
                },
              },
            ]}
          />
        )}
      </div>
    </dialog>
  );
}
