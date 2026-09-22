import { useEffect, useMemo, useState } from "react";
import type {
  Company,
  DeskEvent,
  Doc,
} from "../supabase/functions/_shared/model";
import type { NewsBatchSummary } from "../supabase/functions/_shared/news-batch";
import { safeLink } from "../supabase/functions/_shared/engine";
import {
  eventGroupKey,
  inEventFolder,
  type EventFolder,
} from "../supabase/functions/_shared/event-inbox";
import {
  groupNews,
  currentAssessment,
} from "../supabase/functions/_shared/screening-policy";
import {
  cleanNewsText,
  eventPriority,
  newsBucket,
  newsSource,
  type NewsView,
} from "../supabase/functions/_shared/news";
import { api } from "./api";
import { Field, chicagoDate } from "./ui";
export type EventUpdate = (
  doc: Doc<DeskEvent>,
  patch: Partial<
    Pick<DeskEvent, "reviewed" | "saved" | "feedback" | "feedbackReason">
  >,
  scope?: "article" | "development",
) => Promise<void>;
export function NewsBatchStatus({
  batch,
  onControl,
  controlBusy,
}: {
  batch?: NewsBatchSummary | null;
  onControl: (action: "pause" | "resume" | "cancel") => void;
  controlBusy: boolean;
}) {
  if (!batch) return null;
  return (
    <section className="news-batch" aria-label="News search progress">
      <div role="status">
        <strong>
          {
            {
              running: "Searching news",
              paused: "News search paused",
              cancelled: "News search cancelled",
              completed: "News search completed",
            }[batch.status]
          }
        </strong>{" "}
        · {batch.label}
        <br />
        {batch.completedCompanies} / {batch.totalCompanies}{" "}
        {batch.totalCompanies === 1 ? "company" : "companies"} · {batch.added}{" "}
        new source {batch.added === 1 ? "item" : "items"} · {batch.checked}{" "}
        checked
        {batch.tokens != null &&
          ` · ${batch.tokens.toLocaleString()} TypeSafe tokens (≈$${((batch.tokens * 0.042) / 1e6).toFixed(3)})`}
        {batch.currentCompany && ` · Checking ${batch.currentCompany}`}
      </div>
      {batch.status === "running" && (
        <progress
          max={batch.totalCompanies}
          value={batch.completedCompanies}
          aria-label="Companies checked"
        />
      )}
      <small>
        {batch.dailySearch &&
          `Up to ${batch.articleLimit} articles per day × ${batch.lookbackDays} days per company, plus primary sources. `}
        {batch.status === "running" &&
          "Progress is saved; the server continues if you leave this page."}
        {(batch.status === "paused" || batch.status === "cancelled") &&
          "Completed articles are kept. An article already being processed may finish; no further articles in this search will start."}
      </small>
      {(batch.status === "running" || batch.status === "paused") && (
        <div className="actions">
          <button
            disabled={controlBusy}
            onClick={() =>
              onControl(batch.status === "paused" ? "resume" : "pause")
            }
          >
            {batch.status === "paused" ? "Resume" : "Pause"}
          </button>
          <button disabled={controlBusy} onClick={() => onControl("cancel")}>
            Cancel search
          </button>
          <small>
            Pause saves your place. Cancel ends this search. Automatic
            monitoring has its own schedule.
          </small>
        </div>
      )}
      {!!batch.warningCount && (
        <details>
          <summary>{batch.warningCount} source or screening warnings</summary>
          <ul>
            {batch.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ArticleReader({ event }: { event: DeskEvent }) {
  const [content, setContent] = useState<{
    text: string;
    url: string;
    contentDepth: string;
    note?: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const read = async () => {
    if (content) {
      setOpen(!open);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setContent(await api(`/events/${event.id}/content`, {}));
      setOpen(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="article-reader">
      <button disabled={loading} onClick={read}>
        {loading
          ? "Loading article…"
          : open
            ? "Hide article text"
            : "Read available text"}
      </button>
      {error && <p role="alert">{error}</p>}
      {open && content && (
        <div>
          <p className="muted">
            {content.note || "Available source text."} Reading does not run AI
            screening.
            {safeLink(content.url) && (
              <>
                {" "}
                <a
                  href={safeLink(content.url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open publisher ↗
                </a>
              </>
            )}
          </p>
          <div className="article-reader-text">
            {content.text ||
              "No readable text is available. Open the publisher to read the source."}
          </div>
        </div>
      )}
    </div>
  );
}

export function EventList({
  docs,
  companies,
  updateEvent,
  savingEvents,
  compact = false,
  companyFilter,
  onCompanyFilterChange,
}: {
  docs: Doc<DeskEvent>[];
  companies: Doc<Company>[];
  updateEvent: EventUpdate;
  savingEvents: Set<string>;
  compact?: boolean;
  companyFilter?: string;
  onCompanyFilterChange?: (id: string) => void;
}) {
  const [show, setShow] = useState<NewsView>("relevant");
  const [folder, setFolder] = useState<EventFolder>("inbox");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const [query, setQuery] = useState("");
  const [localCompany, setLocalCompany] = useState("");
  const company = companyFilter ?? localCompany;
  const setCompany = onCompanyFilterChange || setLocalCompany;
  const [importance, setImportance] = useState("");
  const [source, setSource] = useState("");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [visibleCount, setVisibleCount] = useState(50);
  useEffect(
    () => setVisibleCount(50),
    [show, folder, query, company, importance, source, after, before],
  );
  const names = useMemo(
    () => new Map(companies.map((x) => [x.id, x.data.name])),
    [companies],
  );
  const membersByGroup = useMemo(() => {
    const map = new Map<string, Doc<DeskEvent>[]>();
    for (const d of docs) {
      const key = eventGroupKey(d.data);
      const items = map.get(key);
      if (items) items.push(d);
      else map.set(key, [d]);
    }
    return map;
  }, [docs]);
  const scoped = useMemo(
    () =>
      docs
        .filter(
          (d) =>
            names.has(d.data.companyId) &&
            (!company || d.data.companyId === company),
        )
        .map((d) => ({
          ...d,
          data: {
            ...d.data,
            screening: currentAssessment(d.data),
            priority: eventPriority(d.data),
          },
        })),
    [docs, names, company],
  );
  const folderDocs = useMemo(
    () => scoped.filter((d) => inEventFolder(d.data, folder, now)),
    [scoped, folder, now],
  );
  const sources = useMemo(
    () =>
      [
        ...new Set(folderDocs.map((d) => newsSource(d.data)).filter(Boolean)),
      ].sort(),
    [folderDocs],
  );
  const counts = useMemo(() => {
    const folders = {
      inbox: new Set<string>(),
      saved: new Set<string>(),
      history: new Set<string>(),
    };
    const views = {
      all: new Set<string>(),
      relevant: new Set<string>(),
      uncertain: new Set<string>(),
      suppressed: new Set<string>(),
      coverage: new Set<string>(),
    };
    for (const d of scoped) {
      const key = eventGroupKey(d.data),
        bucket = newsBucket(d.data);
      for (const f of ["inbox", "saved", "history"] as const)
        if (
          inEventFolder(d.data, f, now) &&
          (f !== "inbox" || bucket === "relevant")
        )
          folders[f].add(key);
      if (inEventFolder(d.data, folder, now)) {
        views.all.add(key);
        if (d.data.kind !== "health") views[bucket].add(key);
      }
    }
    return { folders, views };
  }, [scoped, folder, now]);
  const filtered = useMemo(
    () =>
      folderDocs
        .filter(({ data: e }) => {
          const date = (e.publishedAt || e.discoveredAt).slice(0, 10);
          return (
            (show === "all" ||
              (e.kind !== "health" && newsBucket(e) === show)) &&
            (!company || e.companyId === company) &&
            (!importance ||
              (importance === "major"
                ? e.priority === "major"
                : !!e.matches?.length)) &&
            (!source || newsSource(e) === source) &&
            (!after || date >= after) &&
            (!before || date <= before) &&
            `${e.title} ${e.body} ${names.get(e.companyId) || ""}`
              .toLowerCase()
              .includes(query.toLowerCase())
          );
        })
        .sort((a, b) => b.data.discoveredAt.localeCompare(a.data.discoveredAt)),
    [
      folderDocs,
      show,
      company,
      importance,
      source,
      after,
      before,
      names,
      query,
    ],
  );
  const groups = useMemo(() => groupNews(filtered), [filtered]);
  return (
    <div className={compact ? "event-list compact" : "event-list"}>
      <div
        className="filters inbox-folders"
        role="group"
        aria-label="News folders"
      >
        {(["inbox", "saved", "history"] as const).map((f) => (
          <button
            key={f}
            className={folder === f ? "chip selected" : "chip"}
            onClick={() => {
              setFolder(f);
              setShow(f === "inbox" ? "relevant" : "all");
            }}
          >
            {{ inbox: "Inbox", saved: "Saved", history: "History" }[f]} (
            {counts.folders[f].size})
          </button>
        ))}
      </div>
      {folder === "saved" && (
        <p className="muted">
          Saved items stay here until you unsave them, including items older
          than 30 days.
        </p>
      )}
      {folder === "history" && (
        <p className="muted">
          Reviewed items and items that aged out of the inbox. Return to inbox
          starts a new 30-day review window.
        </p>
      )}
      <div className="filters">
        {(
          ["relevant", "uncertain", "coverage", "suppressed", "all"] as const
        ).map((s) => (
          <button
            key={s}
            className={show === s ? "chip selected" : "chip"}
            onClick={() => setShow(s)}
          >
            {
              {
                relevant: "Relevant developments",
                uncertain: "Needs verification",
                suppressed: "Screened out / noise",
                coverage: "Coverage / preferred source needed",
                all: "All events",
              }[s]
            }{" "}
            ({counts.views[s].size})
          </button>
        ))}
      </div>
      <details className="news-filters">
        <summary>Filter news</summary>
        <div className="form-grid">
          <Field label="Search headlines and text">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by keyword…"
            />
          </Field>
          {!compact && (
            <Field label="Company">
              <select
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              >
                <option value="">All companies</option>
                {[...companies]
                  .sort((a, b) => a.data.name.localeCompare(b.data.name))
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.data.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <Field label="Importance">
            <select
              value={importance}
              onChange={(e) => setImportance(e.target.value)}
            >
              <option value="">All relevant developments</option>
              <option value="major">Important events</option>
              <option value="watch">Matches my watch points</option>
            </select>
          </Field>
          <Field label="Source">
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">All sources</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Published from">
            <input
              type="date"
              value={after}
              onChange={(e) => setAfter(e.target.value)}
            />
          </Field>
          <Field label="Published through">
            <input
              type="date"
              value={before}
              onChange={(e) => setBefore(e.target.value)}
            />
          </Field>
        </div>
        <button
          className="link"
          onClick={() => {
            setQuery("");
            setCompany("");
            setImportance("");
            setSource("");
            setAfter("");
            setBefore("");
          }}
        >
          Clear filters
        </button>
      </details>
      <p className="muted" role="status">
        {groups.length} developments from {filtered.length} source items.
        Primary evidence and supported additional analysis are recommended.
        Recaps remain in Coverage. Repeated coverage is grouped. Marking Useful
        overrides screening.
      </p>
      {!filtered.length && (
        <div className="empty">
          <h3>No events in this view</h3>
          <p>
            Source coverage and failures appear in Monitoring health. An empty
            feed does not establish that nothing happened.
          </p>
        </div>
      )}
      {groups
        .slice(0, visibleCount)
        .map(({ lead: doc, coverage, additions = [] }) => {
          const e = doc.data;
          const members = membersByGroup.get(eventGroupKey(e)) || [doc];
          const saving = members.some((d) => savingEvents.has(d.id));
          const updateGroup = (
            patch: Parameters<EventUpdate>[1],
            scope: "article" | "development" = "development",
          ) => {
            void updateEvent(doc, patch, scope);
          };
          return (
            <article className={"event " + e.priority} key={e.id}>
              <div className="event-meta">
                <b>{names.get(e.companyId) || "Company"}</b>
                <span>
                  {e.kind === "health"
                    ? "Coverage issue"
                    : newsBucket(e) === "coverage"
                      ? "Relevant event · coverage only"
                      : newsBucket(e) === "suppressed"
                        ? "Screened out / noise"
                        : newsBucket(e) === "uncertain"
                          ? "Needs verification"
                          : e.priority === "major"
                            ? "Important"
                            : "Fundamentally relevant"}
                </span>
                <span>
                  {e.publishedAt
                    ? chicagoDate(e.publishedAt)
                    : "Publication date unknown"}
                </span>
              </div>
              <h3>
                {safeLink(e.url) ? (
                  <a href={safeLink(e.url)} target="_blank" rel="noreferrer">
                    {e.title} ↗
                  </a>
                ) : (
                  e.title
                )}
              </h3>
              <p>{cleanNewsText(e.body)}</p>
              {e.kind === "news" && <ArticleReader event={e} />}
              {e.screening ? (
                <div className="screening-summary">
                  <p>
                    <b>Why this appears:</b>{" "}
                    {e.feedback === "useful" ? "You marked this useful. " : ""}
                    {e.screening.reason}
                  </p>
                  <p className="muted">
                    {e.screening.primary
                      ? "Primary source"
                      : "Secondary source"}{" "}
                    ·{" "}
                    {e.screening.contentDepth === "full"
                      ? "Article/document text read"
                      : e.screening.contentDepth === "supplied"
                        ? "Supplied text read"
                        : e.screening.contentDepth === "partial"
                          ? "Partial text read"
                          : "Headline / snippet only"}
                    {" · "}
                    {e.screening.charactersRead.toLocaleString()} characters
                    assessed
                    {e.screening.materiality > 0 && (
                      <>
                        {" "}
                        · Significance {e.screening.materiality.toFixed(1)}/4
                      </>
                    )}
                  </p>
                  {e.screening.retrievalNote &&
                    e.screening.contentDepth !== "full" && (
                      <p className="muted">{e.screening.retrievalNote}</p>
                    )}
                </div>
              ) : (
                e.kind === "news" && (
                  <p className="muted">
                    Awaiting the new fundamental screening policy.
                  </p>
                )
              )}
              {e.evidence && (
                <blockquote>{cleanNewsText(e.evidence)}</blockquote>
              )}
              {e.screening?.qualifyingEvidence && (
                <p className="muted">
                  <b>Qualification:</b> {e.screening.qualifyingEvidence}
                </p>
              )}
              {additions.length > 0 && (
                <div className="analytical-additions">
                  <b>Additional analysis worth reading</b>
                  {additions.map((d) => (
                    <p key={d.id}>
                      <a
                        href={safeLink(d.data.url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {d.data.title}
                      </a>
                      <br />
                      {d.data.evidence}
                    </p>
                  ))}
                </div>
              )}
              {coverage.length > 0 && (
                <details className="related-coverage">
                  <summary>
                    {coverage.length} additional source
                    {coverage.length === 1 ? "" : "s"} for this development
                  </summary>
                  {coverage.map((d) => (
                    <p key={d.id}>
                      <a
                        href={safeLink(d.data.url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {d.data.title}
                      </a>
                      {" · "}
                      {newsSource(d.data)}
                    </p>
                  ))}
                </details>
              )}
              {e.matches?.map((m, i) => (
                <p className="match" key={i}>
                  <b>
                    {m.direction === "concern"
                      ? "Concern increased"
                      : m.direction === "reassuring"
                        ? "Potentially reassuring"
                        : "Relevant / uncertain"}
                  </b>{" "}
                  · {m.text}
                </p>
              ))}
              <div className="event-actions">
                <button
                  disabled={saving}
                  onClick={() =>
                    updateGroup(
                      folder === "inbox"
                        ? { reviewed: true }
                        : { reviewed: false, saved: false },
                    )
                  }
                >
                  {folder === "inbox" ? "Mark reviewed" : "Return to inbox"}
                </button>
                <button
                  disabled={saving}
                  aria-pressed={!!e.saved}
                  onClick={() =>
                    updateGroup({ saved: !e.saved, reviewed: true })
                  }
                >
                  {e.saved ? "Unsave" : "Save"}
                </button>
                <button
                  disabled={saving}
                  aria-pressed={e.feedback === "useful"}
                  onClick={() =>
                    updateGroup(
                      { reviewed: true, feedback: "useful" },
                      "article",
                    )
                  }
                >
                  Useful
                </button>
                <button
                  disabled={saving}
                  aria-pressed={e.feedback === "noise"}
                  onClick={() =>
                    updateGroup({ reviewed: true, feedback: "noise" })
                  }
                >
                  Noise
                </button>
                <select
                  aria-label="Why this article is noise"
                  value={e.feedbackReason || ""}
                  disabled={saving}
                  onChange={(ev) => {
                    if (ev.target.value)
                      updateGroup(
                        {
                          reviewed: true,
                          feedback: "noise",
                          feedbackReason: ev.target
                            .value as DeskEvent["feedbackReason"],
                        },
                        [
                          "poor_source",
                          "duplicate",
                          "no_new_information",
                        ].includes(ev.target.value)
                          ? "article"
                          : "development",
                      );
                  }}
                >
                  <option value="">Dismiss with reason…</option>
                  <option value="too_minor">Too minor</option>
                  <option value="wrong_company">Wrong company</option>
                  <option value="poor_source">Poor source</option>
                  <option value="duplicate">Duplicate</option>
                  <option value="no_new_information">No new information</option>
                  <option value="other">Other noise</option>
                </select>
                {e.feedback && (
                  <button
                    disabled={saving}
                    onClick={() =>
                      updateGroup(
                        {
                          reviewed: false,
                          feedback: undefined,
                          feedbackReason: undefined,
                        },
                        e.feedback === "useful" ||
                          [
                            "poor_source",
                            "duplicate",
                            "no_new_information",
                          ].includes(e.feedbackReason || "")
                          ? "article"
                          : "development",
                      )
                    }
                  >
                    Undo feedback
                  </button>
                )}
                {saving && <span role="status">Saving…</span>}
                <details>
                  <summary>Evidence & model details</summary>
                  <pre>{JSON.stringify(e.classification || {}, null, 2)}</pre>
                  {e.screening && (
                    <pre>{JSON.stringify(e.screening, null, 2)}</pre>
                  )}
                  <p>Discovered {e.discoveredAt}</p>
                </details>
              </div>
            </article>
          );
        })}
      {groups.length > visibleCount && (
        <button
          className="load-more"
          onClick={() => setVisibleCount((n) => n + 50)}
        >
          Show next {Math.min(50, groups.length - visibleCount)} developments (
          {visibleCount} of {groups.length} shown)
        </button>
      )}
    </div>
  );
}
