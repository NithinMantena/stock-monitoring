import { useMemo, useState } from "react";
import type { Company, Doc } from "../supabase/functions/_shared/model";
import {
  statusLabels,
  statuses,
} from "../supabase/functions/_shared/constants";
import {
  SIZE_BANDS,
  SIZE_CLASSES,
} from "../supabase/functions/_shared/company-size";
import {
  companyMatchScore,
  emptyCriteria,
  type CompanyCriteria,
} from "../supabase/functions/_shared/library";

const toggle = (values: string[], value: string) =>
  values.includes(value)
    ? values.filter((v) => v !== value)
    : [...values, value];

function ChipGroup({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  if (!options.length) return null;
  return (
    <div className="criteria-row" role="group" aria-label={label}>
      <span className="criteria-label">{label}</span>
      <div className="criteria-chips">
        {options.map((o) => (
          <button
            type="button"
            key={o.value}
            className={selected.includes(o.value) ? "chip selected" : "chip"}
            aria-pressed={selected.includes(o.value)}
            onClick={() => onChange(toggle(selected, o.value))}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Builds the company set for a custom news search. The matched companies are
// computed by the caller (matchCriteria) and previewed here.
export function CustomSearchPanel({
  docs,
  tags,
  criteria,
  onChange,
  matched,
}: {
  docs: Doc<Company>[];
  tags: { tag: string; count: number }[];
  criteria: CompanyCriteria;
  onChange: (next: CompanyCriteria) => void;
  matched: Doc<Company>[];
}) {
  const [pick, setPick] = useState("");
  const set = (patch: Partial<CompanyCriteria>) =>
    onChange({ ...criteria, ...patch });
  const groups = useMemo(
    () =>
      [...new Set(docs.map((d) => d.data.originalGroup).filter(Boolean))].sort(),
    [docs],
  );
  const names = useMemo(
    () => new Map(docs.map((d) => [d.id, d.data.name])),
    [docs],
  );
  const suggestions = useMemo(
    () =>
      pick.trim()
        ? docs
            .filter((d) => !criteria.companyIds.includes(d.id))
            .map((d) => ({ d, score: companyMatchScore(d.data, pick) }))
            .filter((x) => x.score > 0)
            .sort(
              (a, b) =>
                b.score - a.score || a.d.data.name.localeCompare(b.d.data.name),
            )
            .slice(0, 8)
            .map((x) => x.d)
        : [],
    [docs, pick, criteria.companyIds],
  );
  const add = (id: string) => {
    set({ companyIds: [...criteria.companyIds, id] });
    setPick("");
  };
  const empty =
    !criteria.tags.length &&
    !criteria.statuses.length &&
    !criteria.groups.length &&
    !criteria.sizes.length &&
    !criteria.companyIds.length;
  return (
    <section className="custom-search" aria-label="Custom news search">
      <div className="custom-search-head">
        <strong>Custom search</strong>
        <small className="muted">
          Companies matching every category you fill in, plus any you pick by
          name. Archived companies are only included when picked.
        </small>
        {!empty && (
          <button
            type="button"
            className="link"
            onClick={() => onChange(emptyCriteria())}
          >
            Clear
          </button>
        )}
      </div>
      <div className="criteria-row">
        <span className="criteria-label">Companies</span>
        <div className="criteria-picker">
          <input
            type="search"
            aria-label="Add a company to this search"
            placeholder="Type a name or ticker, Enter adds the best match…"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (suggestions[0]) add(suggestions[0].id);
              }
            }}
          />
          {suggestions.length > 0 && (
            <ul className="criteria-suggestions" role="listbox">
              {suggestions.map((d, i) => (
                <li key={d.id} role="option" aria-selected={i === 0}>
                  <button type="button" onClick={() => add(d.id)}>
                    <b>{d.data.name}</b> <small>{d.data.ticker}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="criteria-chips">
            {criteria.companyIds.map((id) => (
              <button
                type="button"
                key={id}
                className="chip selected"
                aria-label={`Remove ${names.get(id)} from this search`}
                onClick={() =>
                  set({
                    companyIds: criteria.companyIds.filter((x) => x !== id),
                  })
                }
              >
                {names.get(id) || "Removed company"} ×
              </button>
            ))}
          </div>
        </div>
      </div>
      <ChipGroup
        label="Tags"
        options={tags.map((t) => ({
          value: t.tag,
          label: `${t.tag} (${t.count})`,
        }))}
        selected={criteria.tags}
        onChange={(next) => set({ tags: next })}
      />
      {criteria.tags.length > 1 && (
        <div className="criteria-row">
          <span className="criteria-label" />
          <label className="criteria-mode">
            <input
              type="checkbox"
              checked={criteria.tagMode === "all"}
              onChange={(e) =>
                set({ tagMode: e.target.checked ? "all" : "any" })
              }
            />
            Require all selected tags (otherwise any)
          </label>
        </div>
      )}
      <ChipGroup
        label="Lists"
        options={statuses.map((s) => ({ value: s, label: statusLabels[s] }))}
        selected={criteria.statuses}
        onChange={(next) => set({ statuses: next })}
      />
      <ChipGroup
        label="Size"
        options={[
          ...SIZE_CLASSES.map((k) => ({ value: k, label: SIZE_BANDS[k].label })),
          { value: "unknown", label: "Size not set" },
        ]}
        selected={criteria.sizes}
        onChange={(next) => set({ sizes: next })}
      />
      <ChipGroup
        label="Research groups"
        options={groups.map((g) => ({ value: g, label: g }))}
        selected={criteria.groups}
        onChange={(next) => set({ groups: next })}
      />
      <details className="criteria-preview">
        <summary>
          {matched.length} {matched.length === 1 ? "company" : "companies"}{" "}
          selected
          {matched.length > 0 &&
            `: ${matched
              .slice(0, 6)
              .map((d) => d.data.name)
              .join(", ")}${matched.length > 6 ? "…" : ""}`}
        </summary>
        <p>{matched.map((d) => d.data.name).join(" · ")}</p>
      </details>
    </section>
  );
}
