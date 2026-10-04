import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Company, Doc } from "../supabase/functions/_shared/model";
import {
  statusLabels,
  statuses,
  type Status,
} from "../supabase/functions/_shared/constants";
import {
  SIZE_BANDS,
  SIZE_CLASSES,
  formatMarketCap,
  parseMarketCap,
  type SizeSetting,
} from "../supabase/functions/_shared/company-size";
import { normalizeTag, sameTag } from "../supabase/functions/_shared/library";
import { multiSelectClick } from "./company-menu";

export interface NewCompanyRow {
  key: string;
  name: string;
  ticker: string;
  status: Status;
  sizeClass: SizeSetting;
  marketCap: string;
  ideaSource: string;
  tags: string[];
}
const blank = (carry?: Partial<NewCompanyRow>): NewCompanyRow => ({
  key: crypto.randomUUID(),
  name: "",
  ticker: "",
  status: carry?.status || "inbox",
  sizeClass: "unknown",
  marketCap: "",
  ideaSource: carry?.ideaSource || "",
  tags: carry?.tags ? [...carry.tags] : [],
});
const norm = (s: string) => s.trim().toLowerCase();

// Request body for one row (POST /companies/bulk).
export function rowPayload(r: NewCompanyRow) {
  const cap = r.marketCap.trim() ? parseMarketCap(r.marketCap) : null;
  return {
    name: r.name.trim(),
    ticker: r.ticker.trim() || undefined,
    status: r.status,
    sizeClass: r.sizeClass,
    marketCapUsd: cap,
    ideaSource: r.ideaSource.trim() || undefined,
    tags: r.tags,
  };
}

// Add many companies by keyboard: fill a row, Enter puts it in the list on the
// right, and nothing is saved until "Add companies". Status, idea source and
// tags carry over to the next row.
export function AddCompaniesWindow({
  companies,
  known,
  onSubmit,
  onClose,
}: {
  companies: Doc<Company>[];
  known: { tag: string; count: number }[];
  onSubmit: (rows: NewCompanyRow[]) => Promise<void>;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<NewCompanyRow[]>([]);
  const [draft, setDraft] = useState<NewCompanyRow>(() => blank());
  const [editing, setEditing] = useState<string | null>(null);
  const [tagText, setTagText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<NewCompanyRow>) => {
    setError("");
    setDraft((d) => ({ ...d, ...patch }));
  };
  const existing = useMemo(
    () =>
      new Map(
        companies.flatMap((d) => [
          ["n:" + norm(d.data.name), d.data.name] as const,
          ...(d.data.ticker
            ? [["t:" + norm(d.data.ticker), d.data.name] as const]
            : []),
        ]),
      ),
    [companies],
  );
  const onDesk = (r: Pick<NewCompanyRow, "name" | "ticker">) =>
    existing.get("n:" + norm(r.name)) ||
    (r.ticker.trim() ? existing.get("t:" + norm(r.ticker)) : undefined);
  const draftOnDesk = draft.name.trim() ? onDesk(draft) : undefined;

  const addTag = (raw: string) => {
    const tag = known.find((k) => sameTag(k.tag, raw))?.tag || normalizeTag(raw);
    if (tag && !draft.tags.some((t) => sameTag(t, tag)))
      set({ tags: [...draft.tags, tag] });
    setTagText("");
  };
  const commitRow = () => {
    const pendingTag = normalizeTag(tagText);
    const row = {
      ...draft,
      tags:
        pendingTag && !draft.tags.some((t) => sameTag(t, pendingTag))
          ? [...draft.tags, known.find((k) => sameTag(k.tag, pendingTag))?.tag || pendingTag]
          : draft.tags,
    };
    if (!row.name.trim()) {
      setError("Type a company name first.");
      nameInput.current?.focus();
      return;
    }
    if (row.marketCap.trim() && parseMarketCap(row.marketCap) === null) {
      setError("Market cap not understood. Use a number such as 3.5B, 265M or 1.2T.");
      return;
    }
    const twin = rows.find(
      (r) =>
        r.key !== editing &&
        (norm(r.name) === norm(row.name) ||
          (!!row.ticker.trim() && norm(r.ticker) === norm(row.ticker))),
    );
    if (twin) {
      setError(`"${twin.name}" is already in this list.`);
      return;
    }
    if (editing) setRows((rs) => rs.map((r) => (r.key === editing ? row : r)));
    else setRows((rs) => [...rs, row]);
    setEditing(null);
    setTagText("");
    setError("");
    setDraft(blank(row));
    nameInput.current?.focus();
  };
  const remove = (keys: string[]) => {
    setRows((rs) => rs.filter((r) => !keys.includes(r.key)));
    setPicked((p) => p.filter((k) => !keys.includes(k)));
    if (editing && keys.includes(editing)) {
      setEditing(null);
      setDraft((d) => blank(d));
    }
  };
  const edit = (r: NewCompanyRow) => {
    setEditing(r.key);
    setDraft({ ...r, tags: [...r.tags] });
    setTagText("");
    setError("");
    nameInput.current?.focus();
  };
  const submit = async () => {
    if (!rows.length || busy) return;
    if (draft.name.trim() && !editing && !confirm(`"${draft.name.trim()}" is still in the form and not in the list. Add the ${rows.length} listed compan${rows.length === 1 ? "y" : "ies"} without it?`))
      return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(rows);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const close = () => {
    if (
      (rows.length || draft.name.trim()) &&
      !confirm(
        `Close without adding ${rows.length ? `${rows.length} listed compan${rows.length === 1 ? "y" : "ies"}` : "this company"}?`,
      )
    )
      return;
    onClose();
  };
  // Enter in any field puts the row in the list; Ctrl+Enter adds everything.
  const fieldKeys = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) void submit();
    else commitRow();
  };

  return (
    <dialog
      className="modal-backdrop"
      aria-labelledby="add-companies-title"
      ref={(node) => {
        if (node && !node.open) {
          node.showModal();
          // showModal focuses the first button (×); start typing in Name instead.
          nameInput.current?.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="modal add-window">
        <header className="tag-window-head">
          <div>
            <p className="eyebrow">CAPTURE IDEAS</p>
            <h2 id="add-companies-title">Add companies</h2>
          </div>
          <button
            type="button"
            className="dismiss"
            aria-label="Close add companies"
            disabled={busy}
            onClick={close}
          >
            ×
          </button>
        </header>
        <div className="add-panes">
          <section className="tag-pane add-entry" aria-label="Company details">
            <p className="tag-section-label">
              {editing ? "Editing a listed company" : "New company"}
            </p>
            <label className="field">
              <span>Company name</span>
              <input
                ref={nameInput}
                autoFocus
                maxLength={200}
                placeholder="e.g. Progressive"
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
                onKeyDown={fieldKeys}
              />
              {draftOnDesk && (
                <small className="add-warning">
                  Already on your desk as “{draftOnDesk}”. You can still add it.
                </small>
              )}
            </label>
            <div className="form-grid">
              <label className="field">
                <span>Ticker (optional)</span>
                <input
                  maxLength={50}
                  placeholder="e.g. PGR"
                  value={draft.ticker}
                  onChange={(e) => set({ ticker: e.target.value })}
                  onKeyDown={fieldKeys}
                />
              </label>
              <label className="field">
                <span>Status</span>
                <select
                  value={draft.status}
                  onChange={(e) => set({ status: e.target.value as Status })}
                  onKeyDown={fieldKeys}
                >
                  {statuses.map((s) => (
                    <option key={s} value={s}>
                      {statusLabels[s]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>Size</span>
                <select
                  value={draft.sizeClass}
                  onChange={(e) =>
                    set({ sizeClass: e.target.value as SizeSetting })
                  }
                  onKeyDown={fieldKeys}
                >
                  <option value="unknown">Not sure yet</option>
                  {SIZE_CLASSES.map((k) => (
                    <option key={k} value={k}>
                      {SIZE_BANDS[k].label} ({SIZE_BANDS[k].range})
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>…or market cap, USD</span>
                <input
                  placeholder="e.g. 3.5B or 265M"
                  value={draft.marketCap}
                  onChange={(e) => set({ marketCap: e.target.value })}
                  onKeyDown={fieldKeys}
                />
              </label>
            </div>
            <label className="field">
              <span>Where did you find this idea?</span>
              <input
                maxLength={2000}
                placeholder="Screener, newsletter, person, podcast or link…"
                value={draft.ideaSource}
                onChange={(e) => set({ ideaSource: e.target.value })}
                onKeyDown={fieldKeys}
              />
            </label>
            <label className="field">
              <span>Tags</span>
              <div className="tag-editor">
                {draft.tags.map((t) => (
                  <span key={t} className="tag-chip editable">
                    <span className="tag-chip-name">{t}</span>
                    <button
                      type="button"
                      tabIndex={-1}
                      className="tag-chip-remove"
                      aria-label={`Remove tag ${t}`}
                      onClick={() =>
                        set({ tags: draft.tags.filter((x) => x !== t) })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  list="add-known-tags"
                  aria-label="Add a tag"
                  placeholder={draft.tags.length ? "" : "Type a tag, comma adds it…"}
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === ",") {
                      e.preventDefault();
                      addTag(tagText);
                    } else if (e.key === "Enter" && tagText.trim() && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault();
                      addTag(tagText);
                    } else if (e.key === "Backspace" && !tagText && draft.tags.length)
                      set({ tags: draft.tags.slice(0, -1) });
                    else fieldKeys(e);
                  }}
                />
                <datalist id="add-known-tags">
                  {known
                    .filter((k) => !draft.tags.some((t) => sameTag(t, k.tag)))
                    .map((k) => (
                      <option key={k.tag} value={k.tag} />
                    ))}
                </datalist>
              </div>
            </label>
            <div className="add-entry-actions">
              <button type="button" className="primary" onClick={commitRow}>
                {editing ? "Update in list" : "Add to list ↵"}
              </button>
              {editing && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setDraft((d) => blank(d));
                  }}
                >
                  Cancel edit
                </button>
              )}
            </div>
            <p className="muted add-hint">
              Tab moves between fields. Enter puts the company in the list (in
              Tags, Enter adds the typed tag first). Ctrl+Enter adds everything.
              Status, idea source and tags carry over to the next company.
            </p>
          </section>

          <section
            className="tag-pane selection add-list"
            aria-label="Companies to add"
            tabIndex={-1}
            onKeyDown={(e) => {
              if ((e.key === "Delete" || e.key === "Backspace") && picked.length) {
                e.preventDefault();
                remove(picked);
              }
            }}
          >
            <h3>
              To add
              <small>
                {rows.length} {rows.length === 1 ? "company" : "companies"}
                {picked.length > 1 ? ` · ${picked.length} selected` : ""}
              </small>
            </h3>
            {picked.length > 1 && (
              <div className="add-list-bar">
                <button type="button" className="link" onClick={() => remove(picked)}>
                  Remove {picked.length} selected
                </button>
                <button type="button" className="link" onClick={() => setPicked([])}>
                  Clear selection
                </button>
              </div>
            )}
            <ul className="add-rows">
              {rows.map((r) => {
                const dup = onDesk(r);
                const cap = r.marketCap.trim() ? parseMarketCap(r.marketCap) : null;
                return (
                  <li
                    key={r.key}
                    className={[
                      editing === r.key ? "editing" : "",
                      picked.includes(r.key) ? "picked" : "",
                    ].join(" ")}
                    onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                    onClick={(e) => {
                      const next = multiSelectClick(
                        e,
                        rows.map((x) => x.key),
                        r.key,
                        picked,
                        anchor.current,
                      );
                      if (!e.shiftKey) anchor.current = r.key;
                      if (next) setPicked(next);
                      else {
                        setPicked([]);
                        edit(r);
                      }
                    }}
                    title="Click to edit · Ctrl/Shift-click to select several"
                  >
                    <div className="add-row-main">
                      <b>{r.name}</b>
                      <small>
                        {[
                          r.ticker || "No ticker",
                          statusLabels[r.status],
                          cap
                            ? formatMarketCap(cap)
                            : r.sizeClass !== "unknown"
                              ? SIZE_BANDS[r.sizeClass].label
                              : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                      {r.ideaSource && (
                        <small className="add-row-source">From: {r.ideaSource}</small>
                      )}
                      {(r.tags.length > 0 || dup) && (
                        <span className="row-tags">
                          {dup && <span className="add-warning">On desk already</span>}
                          {r.tags.map((t) => (
                            <span key={t} className="tag-chip small">
                              {t}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="link"
                      aria-label={`Remove ${r.name} from the list`}
                      onClick={(e) => {
                        e.stopPropagation();
                        remove([r.key]);
                      }}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
              {!rows.length && (
                <li className="muted add-empty">
                  Companies you add appear here. Nothing is saved until you
                  confirm.
                </li>
              )}
            </ul>
          </section>
        </div>
        <footer className="tag-window-foot">
          {error && <span role="alert">{error}</span>}
          <span className="muted">
            {rows.length
              ? "Click a company to edit it, × to remove it."
              : "Fill in a company and press Enter."}
          </span>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!rows.length || busy}
            onClick={submit}
          >
            {busy
              ? "Adding…"
              : `Add ${rows.length || ""} ${rows.length === 1 ? "company" : "companies"}`}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
