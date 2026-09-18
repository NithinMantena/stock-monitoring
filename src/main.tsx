import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { createClient, type Session } from "@supabase/supabase-js";
import ReactMarkdown from "react-markdown";
import {
  CompanySchema,
  RuleSchema,
  defaultSettings,
  statusLabels,
  statuses,
  type Company,
  type DeskEvent,
  type Doc,
  type Settings,
  type Status,
} from "../supabase/functions/_shared/model";
import {
  cadenceOf,
  formatMoney,
  quoteState,
  safeLink,
} from "../supabase/functions/_shared/engine";
import type { ImportPreview } from "../supabase/functions/_shared/importer";
import "./style.css";
import { loadDrafts, saveDraft, type Draft } from "./drafts";

const cloud = !!import.meta.env.VITE_SUPABASE_URL;
const supabase = cloud
  ? createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_ANON_KEY,
    )
  : null;
const base = import.meta.env.VITE_API_URL || "/api";
let accessToken = "";
async function api<T = any>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : method,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json();
  if (!response.ok)
    throw new Error(json.error || `Request failed (${response.status}).`);
  return json;
}
function chicagoDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(value).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    dateStyle: "medium",
    timeStyle: "short",
  });
}
function download(name: string, text: string, type = "application/json") {
  const a = document.createElement("a");
  const url = URL.createObjectURL(new Blob([text], { type }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function StatusSelect({
  value,
  onChange,
}: {
  value: Status;
  onChange: (s: Status) => void;
}) {
  return (
    <select
      aria-label="Company status"
      value={value}
      onChange={(e) => onChange(e.target.value as Status)}
    >
      {statuses.map((s) => (
        <option key={s} value={s}>
          {statusLabels[s]}
        </option>
      ))}
    </select>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Root() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!cloud);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      accessToken = data.session?.access_token || "";
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      accessToken = next?.access_token || "";
      setSession(next);
      setReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  if (!ready) return <div className="login">Opening your desk…</div>;
  if (cloud && !session)
    return (
      <main className="login">
        <div className="brand">RESEARCH DESK</div>
        <h1>
          Your companies.
          <br />
          Your thinking.
        </h1>
        <p>A private place to follow the businesses that matter to you.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const { error } = await supabase!.auth.signInWithPassword({
              email: String(form.get("email")),
              password: String(form.get("password")),
            });
            setError(error?.message || "");
          }}
        >
          <Field label="Email">
            <input
              autoComplete="username"
              type="email"
              name="email"
              
              required
            />
          </Field>
          <Field label="Password">
            <input
              autoComplete="current-password"
              type="password"
              name="password"
              required
            />
          </Field>
          <button className="primary">Sign in</button>
          <button
            type="button"
            className="spaced"
            onClick={async (e) => {
              const form = e.currentTarget.closest("form")!;
              const email = String(new FormData(form).get("email"));
              const { error } = await supabase!.auth.signInWithOtp({
                email,
                options: {
                  shouldCreateUser: false,
                  emailRedirectTo: window.location.origin,
                },
              });
              setError(
                error?.message || "Check your email for a sign-in link.",
              );
            }}
          >
            Email me a sign-in link
          </button>
          <p role="alert">{error}</p>
        </form>
      </main>
    );
  return (
    <App
      key={session?.user.id || "local"}
      owner={session?.user.id || "local"}
      onLogout={supabase ? () => supabase.auth.signOut() : undefined}
    />
  );
}

interface Bootstrap {
  companies: Doc<Company>[];
  events: Doc<DeskEvent>[];
  settings: Settings;
  settingsVersion: number;
  configuration: any;
  run?: any;
  imports: any[];
  usage?: { month: string; cost: number; tokens: number; requests: number }[];
}
function App({ onLogout, owner }: { onLogout?: () => void; owner: string }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [section, setSection] = useState("companies");
  const [filter, setFilter] = useState<Status | "all" | "archived">("all");
  const [group, setGroup] = useState("");
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.toLowerCase());
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState("research");
  const openCompany = useCallback((id: string) => {
    setSelected(id);
    setTab("research");
  }, []);
  const [adding, setAdding] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const state = useRef(data);
  state.current = data;
  const pending = useRef(new Map<string, Draft>());
  const flushing = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reload = useCallback(async () => {
    try {
      const next = await api<Bootstrap>("/bootstrap");
      for (const doc of next.companies) {
        const draft = pending.current.get(doc.id);
        if (draft) {
          const existing = state.current?.companies.find(
            (d) => d.id === doc.id,
          );
          doc.data = draft.data;
          if (existing) doc.version = existing.version;
        }
      }
      setData(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    let live = true;
    loadDrafts(owner)
      .then((drafts) => {
        if (!live) return;
        for (const [id, draft] of drafts)
          if (!pending.current.has(id)) pending.current.set(id, draft);
        setPendingCount(pending.current.size);
        if (drafts.size)
          setNotice(
            "Recovered unsaved drafts from this device. Use Retry save to sync them.",
          );
        return reload();
      })
      .catch(() => {
        if (live) {
          setNotice(
            "Device draft recovery is unavailable. Keep this tab open until changes are saved.",
          );
          reload();
        }
      });
    return () => {
      live = false;
    };
  }, [reload, owner]);
  useEffect(() => {
    const protect = (e: BeforeUnloadEvent) => {
      if (pending.current.size) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);
  const flush = async (id: string) => {
    if (flushing.current.has(id)) return;
    const draft = pending.current.get(id);
    const doc = state.current?.companies.find((c) => c.id === id);
    if (!draft || !doc) return;
    flushing.current.add(id);
    try {
      const saved = await api<Doc<Company>>(
        `/companies/${id}`,
        { version: draft.version, data: draft.data, base: draft.base },
        "PUT",
      );
      const next = pending.current.get(id);
      if (next?.generation === draft.generation) pending.current.delete(id);
      else if (next)
        pending.current.set(id, {
          ...next,
          base: saved.data,
          version: saved.version,
        });
      await saveDraft(owner, id, pending.current.get(id)).catch(() => {});
      setData(
        (old) =>
          old && {
            ...old,
            companies: old.companies.map((c) =>
              c.id === id
                ? {
                    ...saved,
                    data: pending.current.get(id)?.data || saved.data,
                  }
                : c,
            ),
          },
      );
      setPendingCount(pending.current.size);
      setError("");
      if (pending.current.has(id)) setTimeout(() => flush(id), 50);
    } catch (e) {
      setError(
        `${doc.data.name}: ${(e as Error).message} Your draft is still open. Export your draft before reloading if there is a conflict.`,
      );
    } finally {
      flushing.current.delete(id);
    }
  };
  const edit = (id: string, patch: Partial<Company>) => {
    const doc = state.current?.companies.find((c) => c.id === id);
    if (!doc) return;
    const company = {
      ...(pending.current.get(id)?.data || doc.data),
      ...patch,
    };
    const previous = pending.current.get(id);
    pending.current.set(id, {
      data: company,
      base: previous?.base || doc.data,
      version: previous?.version || doc.version,
      generation: (previous?.generation || 0) + 1,
    });
    saveDraft(owner, id, pending.current.get(id)).catch(() =>
      setError(
        "Device draft storage is full or unavailable. Keep this tab open until the server saves your changes.",
      ),
    );
    setData(
      (old) =>
        old && {
          ...old,
          companies: old.companies.map((c) =>
            c.id === id ? { ...c, data: company } : c,
          ),
        },
    );
    setPendingCount(pending.current.size);
    clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      setTimeout(() => flush(id), 600),
    );
  };
  const action = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      if (message) setNotice(message);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const docs = data?.companies || [];
  const filtered = useMemo(
    () =>
      docs
        .filter(
          ({ data: c }) =>
            (filter === "archived"
              ? c.archived
              : !c.archived && (filter === "all" || c.status === filter)) &&
            (!group || c.originalGroup === group) &&
            (!search ||
              `${c.name} ${c.ticker} ${c.exchange} ${c.tags.join(" ")} ${c.thesis} ${c.notes}`
                .toLowerCase()
                .includes(search)),
        )
        .sort((a, b) => a.data.name.localeCompare(b.data.name)),
    [docs, filter, group, search],
  );
  const selectedDoc = docs.find((c) => c.id === selected);
  const unseen = (data?.events || []).filter(
    (e) =>
      !e.data.reviewed &&
      e.data.priority !== "suppressed" &&
      e.data.kind !== "health",
  ).length;
  if (!data)
    return (
      <main className="login">
        <div className="brand">RESEARCH DESK</div>
        <p>{error || "Opening your desk…"}</p>
        {error && <button onClick={reload}>Retry</button>}
      </main>
    );
  return (
    <div className="app">
      <header className="topbar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setSection("companies");
          }}
        >
          RESEARCH DESK<span>Company notebook & monitor</span>
        </a>
        <div className="top-right">
          <span className={pendingCount ? "saving" : "saved"}>
            {pendingCount ? `${pendingCount} unsaved` : "All changes saved"}
          </span>
          {pendingCount > 0 && (
            <button
              className="link"
              onClick={() => pending.current.forEach((_draft, id) => flush(id))}
            >
              Save now
            </button>
          )}
          <span className="mode">{cloud ? "Private cloud" : "Local desk"}</span>
          <button
            className="primary"
            onClick={() => {
              setAdding(true);
              setSection("companies");
            }}
          >
            + Add company
          </button>
        </div>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <p className="eyebrow">WORKSPACE</p>
          <button
            className={section === "companies" ? "nav active" : "nav"}
            onClick={() => setSection("companies")}
          >
            Companies <span>{docs.filter((c) => !c.data.archived).length}</span>
          </button>
          <button
            className={section === "news" ? "nav active" : "nav"}
            onClick={() => setSection("news")}
          >
            News & alerts <span>{unseen}</span>
          </button>
          <button
            className={section === "monitor" ? "nav active" : "nav"}
            onClick={() => setSection("monitor")}
          >
            Monitoring health
          </button>
          <button
            className={section === "import" ? "nav active" : "nav"}
            onClick={() => setSection("import")}
          >
            Import & backup
          </button>
          <button
            className={section === "settings" ? "nav active" : "nav"}
            onClick={() => setSection("settings")}
          >
            Settings & digest
          </button>
          <div className="sidebar-bottom">
            <b>America / Chicago</b>
            <p>
              Portfolio & perpetual: daily
              <br />
              Other companies: weekly
            </p>
            {onLogout && (
              <button onClick={onLogout} disabled={pendingCount > 0}>
                Sign out
              </button>
            )}
          </div>
        </aside>
        <main className="workspace">
          {error && (
            <div className="banner error" role="alert">
              {error}
              {pendingCount > 0 && (
                <>
                  <button
                    onClick={() =>
                      download(
                        "unsaved-drafts.json",
                        JSON.stringify(
                          [...pending.current.values()].map((x) => x.data),
                          null,
                          2,
                        ),
                      )
                    }
                  >
                    Export drafts
                  </button>
                  <button
                    onClick={() =>
                      pending.current.forEach((_v, id) => flush(id))
                    }
                  >
                    Retry save
                  </button>
                </>
              )}
              <button
                className="dismiss"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="banner" role="status">
              {notice}
              <button
                className="dismiss"
                aria-label="Dismiss message"
                onClick={() => setNotice("")}
              >
                ×
              </button>
            </div>
          )}
          {section === "companies" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">YOUR RESEARCH, IN ONE PLACE</p>
                  <h1>
                    Companies <span>{filtered.length}</span>
                  </h1>
                </div>
                <input
                  className="search"
                  aria-label="Search companies and notes"
                  placeholder="Search companies, tickers, notes…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div
                className="filters"
                role="group"
                aria-label="Filter companies"
              >
                {(["all", ...statuses, "archived"] as const).map((s) => (
                  <button
                    key={s}
                    className={filter === s ? "chip selected" : "chip"}
                    onClick={() => {
                      setFilter(s);
                      setGroup("");
                    }}
                  >
                    {s === "all"
                      ? "All companies"
                      : s === "archived"
                        ? "Archived"
                        : statusLabels[s]}
                  </button>
                ))}
                <select
                  aria-label="Original research group"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  <option value="">All research groups</option>
                  {[
                    ...new Set(
                      docs.map((c) => c.data.originalGroup).filter(Boolean),
                    ),
                  ]
                    .sort()
                    .map((g) => (
                      <option key={g}>{g}</option>
                    ))}
                </select>
              </div>
              <div className="desk-columns">
                <div
                  className={
                    "company-list " + (selectedDoc ? "with-detail" : "")
                  }
                >
                  {filtered.length === 0 ? (
                    <div className="empty">
                      <h2>
                        {docs.length
                          ? "No matches"
                          : "Start with a company you know"}
                      </h2>
                      <p>
                        {docs.length
                          ? "Try another search or category."
                          : "Add a company in seconds, or bring in your Investment Pitch List."}
                      </p>
                      <button
                        onClick={() =>
                          docs.length ? setQuery("") : setSection("import")
                        }
                      >
                        {docs.length ? "Clear search" : "Import your notes"}
                      </button>
                    </div>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Company</th>
                          <th>Status</th>
                          <th>Last close</th>
                          <th>P/E</th>
                          {!selectedDoc && <th>Market cap</th>}
                          <th>Monitor</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map(({ data: c }) => (
                          <CompanyRow
                            key={c.id}
                            c={c}
                            selected={selected === c.id}
                            showDetail={!!selectedDoc}
                            onSelect={openCompany}
                          />
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                {selectedDoc && (
                  <CompanyDetail
                    key={selectedDoc.id}
                    doc={selectedDoc}
                    tab={tab}
                    setTab={setTab}
                    edit={(patch) => edit(selectedDoc.id, patch)}
                    close={() => setSelected("")}
                    events={data.events.filter(
                      (e) => e.data.companyId === selected,
                    )}
                    config={data.configuration}
                    busy={busy || pending.current.has(selected)}
                    action={action}
                  />
                )}
              </div>
            </>
          )}
          {section === "news" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">DEVELOPMENTS TO REVIEW</p>
                  <h1>News & alerts</h1>
                </div>
                <button
                  disabled={busy}
                  onClick={() =>
                    action(
                      () => api("/monitor", {}),
                      "Monitoring batch completed. See Monitoring health for remaining work.",
                    )
                  }
                >
                  {busy ? "Checking…" : "Check due companies"}
                </button>
              </div>
              <EventList docs={data.events} companies={docs} action={action} />
            </>
          )}
          {section === "monitor" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">COVERAGE YOU CAN INSPECT</p>
                  <h1>Monitoring health</h1>
                </div>
                <button
                  disabled={busy}
                  onClick={() =>
                    action(
                      () => api("/monitor", {}),
                      "Completed a monitoring batch.",
                    )
                  }
                >
                  {busy ? "Checking…" : "Run a batch"}
                </button>
              </div>
              <div className="cards">
                <article>
                  <b>
                    {docs.filter((c) => cadenceOf(c.data) === "daily").length}
                  </b>
                  <p>Daily companies</p>
                </article>
                <article>
                  <b>
                    {docs.filter((c) => cadenceOf(c.data) === "weekly").length}
                  </b>
                  <p>Weekly companies</p>
                </article>
                <article>
                  <b>
                    {
                      docs.filter(
                        (c) => !c.data.archived && !c.data.feeds.length,
                      ).length
                    }
                  </b>
                  <p>Missing news sources</p>
                </article>
              </div>
              <p className="muted">
                Last monitoring batch:{" "}
                {data.run?.finishedAt
                  ? new Date(data.run.finishedAt).toLocaleString("en-US", {
                      timeZone: "America/Chicago",
                    }) + " Chicago"
                  : "Not run yet"}
                . {data.run?.remaining || 0} companies remained in that batch.{" "}
                {cloud
                  ? "Hosted scheduling must be enabled for automatic runs."
                  : "This local preview checks sources on demand. The hosted worker runs while your computer is off."}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Cadence</th>
                    <th>Quotes</th>
                    <th>News sources</th>
                    <th>Last news check</th>
                  </tr>
                </thead>
                <tbody>
                  {docs
                    .filter((d) => !d.data.archived)
                    .map(({ data: c }) => (
                      <tr key={c.id}>
                        <td>
                          <button
                            className="company-name"
                            onClick={() => {
                              setSelected(c.id);
                              setTab("monitoring");
                              setSection("companies");
                            }}
                          >
                            {c.name}
                          </button>
                        </td>
                        <td>{cadenceOf(c)}</td>
                        <td>{c.quoteError || quoteState(c)}</td>
                        <td>
                          {c.feeds.length
                            ? c.feeds
                                .map(
                                  (f) =>
                                    `${f.label}: ${f.error || (f.lastSuccess ? "last fetch succeeded" : "not checked")}`,
                                )
                                .join(" · ")
                            : "Not configured"}
                        </td>
                        <td>
                          {c.lastNewsCheck
                            ? chicagoDate(c.lastNewsCheck)
                            : "Never"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </>
          )}
          {section === "import" && (
            <ImportPanel batches={data.imports} action={action} busy={busy} />
          )}
          {section === "settings" && (
            <SettingsPanel data={data} action={action} busy={busy} />
          )}
        </main>
      </div>
      {adding && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              await action(async () => {
                const doc = await api<Doc<Company>>("/companies", {
                  name: f.get("name"),
                  ticker: f.get("ticker"),
                  status: f.get("status"),
                });
                setSelected(doc.id);
                setTab("research");
                setFilter("all");
                setGroup("");
                setQuery("");
                setAdding(false);
              }, "Company added. Start typing your notes.");
            }}
          >
            <button
              type="button"
              className="dismiss"
              aria-label="Close add company"
              onClick={() => setAdding(false)}
            >
              ×
            </button>
            <p className="eyebrow">CAPTURE AN IDEA</p>
            <h2>Add company</h2>
            <Field label="Company name">
              <input
                autoFocus
                name="name"
                placeholder="e.g. Progressive"
                required
                maxLength={200}
              />
            </Field>
            <div className="form-grid">
              <Field label="Ticker (optional)">
                <input name="ticker" placeholder="e.g. PGR" />
              </Field>
              <Field label="Status">
                <select name="status" defaultValue="inbox">
                  {statuses.map((s) => (
                    <option key={s} value={s}>
                      {statusLabels[s]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <p className="muted">
              You can link market data and news sources after adding it.
            </p>
            <button className="primary" disabled={busy}>
              {busy ? "Adding…" : "Add company"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

const CompanyRow = React.memo(function CompanyRow({
  c,
  selected,
  showDetail,
  onSelect,
}: {
  c: Company;
  selected: boolean;
  showDetail: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <tr
      key={c.id}
      className={selected ? "selected-row" : ""}
      onClick={() => onSelect(c.id)}
    >
      <td>
        <button className="company-name" onClick={() => onSelect(c.id)}>
          {c.name}
        </button>
        <small>
          {c.ticker
            ? `${c.ticker} · ${c.exchange || "Exchange unconfirmed"}`
            : "Symbol not linked"}
        </small>
      </td>
      <td>
        <span className={"status " + c.status}>{statusLabels[c.status]}</span>
      </td>
      <td>
        <b>{formatMoney(c.quote?.price, c.quote?.currency)}</b>
        <small>
          {c.quote?.session || "No quote yet"}
          {c.quote && quoteState(c) !== "Latest stored close"
            ? ` · ${quoteState(c)}`
            : ""}
        </small>
      </td>
      <td>
        {c.quote?.pe && c.quote.pe > 0 ? c.quote.pe.toFixed(1) + "×" : "—"}
      </td>
      {!showDetail && <td>{formatMoney(c.quote?.marketCap, c.currency)}</td>}
      <td>
        <span className="cadence">{cadenceOf(c)}</span>
        <small>
          {!c.feeds.length
            ? "No news feed"
            : c.feeds.some((f) => f.error)
              ? "Feed issue"
              : `${c.feeds.length} news sources`}
        </small>
      </td>
    </tr>
  );
});

interface DetailProps {
  doc: Doc<Company>;
  tab: string;
  setTab: (s: string) => void;
  edit: (p: Partial<Company>) => void;
  close: () => void;
  events: Doc<DeskEvent>[];
  config: any;
  busy: boolean;
  action: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
}
function CompanyDetail({
  doc,
  tab,
  setTab,
  edit,
  close,
  events,
  config,
  busy,
  action,
}: DetailProps) {
  const c = doc.data;
  const [preview, setPreview] = useState(false);
  const [history, setHistory] = useState<Doc<any>[]>([]);
  return (
    <section className="detail" aria-label={`${c.name} details`}>
      <div className="detail-heading">
        <p className="eyebrow">COMPANY NOTEBOOK</p>
        <button aria-label="Close company details" onClick={close}>
          ×
        </button>
      </div>
      <input
        className="name-input"
        aria-label="Company name"
        value={c.name}
        onChange={(e) => edit({ name: e.target.value })}
      />
      <div className="detail-status">
        <StatusSelect
          value={c.status}
          onChange={(status) => edit({ status })}
        />
        <span>{cadenceOf(c)} monitoring</span>
        <button
          className="link"
          onClick={() => edit({ archived: !c.archived })}
        >
          {c.archived ? "Unarchive" : "Archive"}
        </button>
      </div>
      <div className="quote-strip">
        <div>
          <small>Last close</small>
          <b>{formatMoney(c.quote?.price, c.quote?.currency)}</b>
        </div>
        <div>
          <small>{c.quote?.peBasis || "P/E"}</small>
          <b>
            {c.quote?.pe && c.quote.pe > 0 ? c.quote.pe.toFixed(1) + "×" : "—"}
          </b>
        </div>
        <div>
          <small>Market cap</small>
          <b>{formatMoney(c.quote?.marketCap, c.currency)}</b>
        </div>
      </div>
      <p className="quote-source">
        {quoteState(c)}
        {c.quote
          ? ` · ${c.quote.session} · ${c.quote.source}`
          : " · Link a source under Monitoring"}
      </p>
      <nav className="detail-tabs" aria-label="Company sections">
        {["research", "watch points", "alerts", "monitoring"].map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      <div className="detail-body">
        {tab === "research" && (
          <>
            <Field label="My thesis / one-line summary">
              <textarea
                rows={2}
                placeholder="Why this business is worth following…"
                value={c.thesis}
                onChange={(e) => edit({ thesis: e.target.value })}
              />
            </Field>
            {c.status === "pass" && (
              <Field label="Why I passed / what would change my mind">
                <textarea
                  rows={3}
                  value={c.passReason}
                  onChange={(e) => edit({ passReason: e.target.value })}
                />
              </Field>
            )}
            <div className="field-heading">
              <b>Research notes</b>
              <button className="link" onClick={() => setPreview(!preview)}>
                {preview ? "Edit notes" : "Read formatted"}
              </button>
            </div>
            {preview ? (
              <div className="markdown">
                <ReactMarkdown
                  skipHtml
                  components={{
                    a: (props) => (
                      <a {...props} target="_blank" rel="noreferrer" />
                    ),
                  }}
                >
                  {c.notes || "*No notes yet.*"}
                </ReactMarkdown>
              </div>
            ) : (
              <textarea
                className="notes"
                aria-label="Research notes"
                placeholder="Write or paste your notes. Markdown is supported. Changes save automatically."
                value={c.notes}
                onChange={(e) => edit({ notes: e.target.value })}
              />
            )}
            <div className="form-grid">
              <Field label="Tags (comma separated)">
                <input
                  value={c.tags.join(", ")}
                  onChange={(e) =>
                    edit({
                      tags: e.target.value.split(",").map((x) => x.trim()),
                    })
                  }
                />
              </Field>
              <Field label="Next research review">
                <input
                  type="date"
                  value={c.nextReview}
                  onChange={(e) => edit({ nextReview: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Research group">
              <input
                value={c.originalGroup}
                onChange={(e) => edit({ originalGroup: e.target.value })}
              />
            </Field>
            <p className="muted">
              {c.source &&
                `Source: ${c.source} ${c.sourceLines ? "· original lines " + c.sourceLines : ""}`}
            </p>
            <button
              onClick={async () => {
                setHistory(await api(`/companies/${c.id}/revisions`));
              }}
            >
              Note history
            </button>
            <button
              onClick={async () => {
                const response = await fetch(
                  base + `/companies/${c.id}/markdown`,
                  {
                    headers: accessToken
                      ? { Authorization: `Bearer ${accessToken}` }
                      : {},
                  },
                );
                download(
                  `${c.name.replace(/[^a-z0-9 -]/gi, "")}.md`,
                  await response.text(),
                  "text/markdown",
                );
              }}
            >
              Export Markdown
            </button>
            {history.map((r) => (
              <details key={r.id}>
                <summary>{chicagoDate(r.data.at)} — previous revision</summary>
                <pre>{r.data.notes}</pre>
                <button
                  onClick={() => {
                    edit({ notes: r.data.notes, thesis: r.data.thesis });
                    setHistory([]);
                  }}
                >
                  Restore this revision
                </button>
              </details>
            ))}
          </>
        )}
        {tab === "watch points" && (
          <>
            <h3>What are you watching?</h3>
            <p className="muted">
              Write a concern or a development you want to track. News is
              checked against these points and independently for major events.
            </p>
            {c.watchPoints.map((w, i) => (
              <div className="watch-point" key={w.id}>
                <textarea
                  aria-label={`Watch point ${i + 1}`}
                  rows={3}
                  value={w.text}
                  onChange={(e) =>
                    edit({
                      watchPoints: c.watchPoints.map((x) =>
                        x.id === w.id ? { ...x, text: e.target.value } : x,
                      ),
                    })
                  }
                />
                <label className="check">
                  <input
                    type="checkbox"
                    checked={w.enabled}
                    onChange={(e) =>
                      edit({
                        watchPoints: c.watchPoints.map((x) =>
                          x.id === w.id
                            ? { ...x, enabled: e.target.checked }
                            : x,
                        ),
                      })
                    }
                  />
                  Track this point
                </label>
                <button
                  className="link"
                  onClick={() =>
                    edit({
                      watchPoints: c.watchPoints.filter((x) => x.id !== w.id),
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              disabled={c.watchPoints.length >= 20}
              onClick={() =>
                edit({
                  watchPoints: [
                    ...c.watchPoints,
                    {
                      id: crypto.randomUUID(),
                      text: "What would change my thesis?",
                      enabled: true,
                    },
                  ],
                })
              }
            >
              + Add watch point
            </button>
            <h3>Try it on an article</h3>
            <p className="muted">
              Paste a headline and article text. TypeSafe screens the supplied
              text; it does not fetch the linked page.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                action(
                  () =>
                    api(`/companies/${c.id}/analyze`, Object.fromEntries(f)),
                  "Article screened. See News & alerts for evidence.",
                );
              }}
            >
              <Field label="Headline">
                <input name="title" required />
              </Field>
              <Field label="Article text">
                <textarea name="text" rows={5} maxLength={16000} required />
              </Field>
              <Field label="Source URL (optional)">
                <input name="url" type="url" />
              </Field>
              <button className="primary" disabled={busy || !config.typesafe}>
                {busy ? "Screening…" : "Screen with TypeSafe"}
              </button>
              {!config.typesafe && (
                <p>TypeSafe key is not configured on this server.</p>
              )}
            </form>
          </>
        )}
        {tab === "alerts" && (
          <>
            <h3>Valuation alerts</h3>
            <p className="muted">
              Alerts use stored closes in the stated currency. P/E needs a
              positive value with a matching basis. Weekly checks can discover
              an earlier crossing.
            </p>
            {c.rules.map((r) => (
              <div className="rule" key={r.id}>
                <b>
                  {r.metric === "decline"
                    ? `Decline ≥ ${r.threshold}% from ${formatMoney(r.baseline, r.currency)}`
                    : `${r.metric === "pe" ? r.basis : `Price (${r.currency})`} ≤ ${r.threshold}`}
                </b>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) =>
                      edit({
                        rules: c.rules.map((x) =>
                          x.id === r.id
                            ? { ...x, enabled: e.target.checked }
                            : x,
                        ),
                      })
                    }
                  />
                  {r.triggered ? "Triggered · waiting for recovery" : "Enabled"}
                </label>
                <button
                  className="link"
                  onClick={() =>
                    edit({ rules: c.rules.filter((x) => x.id !== r.id) })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const rule = RuleSchema.parse({
                  id: crypto.randomUUID(),
                  metric: f.get("metric"),
                  threshold: Number(f.get("threshold")),
                  currency: String(f.get("currency")).toUpperCase(),
                  baseline: f.get("baseline")
                    ? Number(f.get("baseline"))
                    : null,
                });
                if (rule.metric === "decline" && !rule.baseline) {
                  alert("A decline alert needs a baseline price.");
                  return;
                }
                edit({ rules: [...c.rules, rule] });
                e.currentTarget.reset();
              }}
            >
              <div className="form-grid">
                <Field label="Alert when">
                  <select name="metric">
                    <option value="price">Price at or below</option>
                    <option value="pe">Trailing P/E at or below</option>
                    <option value="decline">% decline from baseline</option>
                  </select>
                </Field>
                <Field label="Threshold">
                  <input
                    name="threshold"
                    type="number"
                    step="any"
                    min="0.0001"
                    required
                  />
                </Field>
                <Field label="Trading currency">
                  <input
                    name="currency"
                    defaultValue={c.currency}
                    placeholder="USD"
                    required
                    maxLength={12}
                  />
                </Field>
                <Field label="Baseline price (for % decline)">
                  <input
                    name="baseline"
                    type="number"
                    step="any"
                    min="0.0001"
                  />
                </Field>
              </div>
              <button>+ Add alert</button>
            </form>
            <h3>Recent developments</h3>
            <EventList
              docs={events}
              companies={[doc]}
              action={action}
              compact
            />
          </>
        )}
        {tab === "monitoring" && (
          <>
            <Field label="Monitoring frequency">
              <select
                value={c.cadence}
                onChange={(e) =>
                  edit({ cadence: e.target.value as Company["cadence"] })
                }
              >
                <option value="auto">Automatic from company status</option>
                <option value="daily">Daily · important company</option>
                <option value="weekly">Weekly</option>
                <option value="paused">Paused</option>
              </select>
            </Field>
            <div className="form-grid">
              <Field label="Ticker">
                <input
                  value={c.ticker}
                  onChange={(e) => edit({ ticker: e.target.value })}
                />
              </Field>
              <Field label="Exchange">
                <input
                  value={c.exchange}
                  onChange={(e) => edit({ exchange: e.target.value })}
                />
              </Field>
              <Field label="Native trading currency">
                <input
                  value={c.currency}
                  placeholder="USD / GBP / GBX / …"
                  onChange={(e) =>
                    edit({ currency: e.target.value.toUpperCase() })
                  }
                />
              </Field>
              <Field label="Quote provider">
                <select
                  value={c.provider}
                  onChange={(e) =>
                    edit({ provider: e.target.value as Company["provider"] })
                  }
                >
                  <option value="none">Not linked / manual</option>
                  <option value="eodhd">EODHD · daily close</option>
                </select>
              </Field>
            </div>
            {c.provider === "eodhd" && (
              <>
                <Field label="Confirmed EODHD symbol">
                  <input
                    placeholder="e.g. PGR.US"
                    value={c.providerSymbol}
                    onChange={(e) => edit({ providerSymbol: e.target.value })}
                  />
                </Field>
                <p className="muted">
                  {config.eodhd
                    ? "Provider key configured."
                    : "EODHD key still needed on the server."}{" "}
                  Confirm the exchange, currency and subscription coverage. This
                  adapter retrieves daily prices; P/E and market cap require
                  manual observations in this version.
                </p>
              </>
            )}
            <h3>News sources</h3>
            <p className="muted">
              Use company investor-relations and regulator feeds where
              available. Broad news feeds help catch events outside your thesis.
              Enabled hosts: {config.feedHosts.join(", ") || "none yet"}.
            </p>
            {c.feeds.map((f) => (
              <div className="rule" key={f.id}>
                <b>
                  {f.label}
                  {f.official ? " · official" : ""}
                </b>
                <p className="small wrap">{f.url}</p>
                <p className="muted">
                  {f.error ||
                    (f.lastSuccess
                      ? "Last successful fetch: " + f.lastSuccess
                      : "Not checked yet")}
                </p>
                <button
                  className="link"
                  onClick={() =>
                    edit({ feeds: c.feeds.filter((x) => x.id !== f.id) })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                edit({
                  feeds: [
                    ...c.feeds,
                    {
                      id: crypto.randomUUID(),
                      label: String(f.get("label")),
                      url: String(f.get("url")),
                      official: f.get("official") === "on",
                      lastSuccess: "",
                      error: "",
                    },
                  ],
                });
                e.currentTarget.reset();
              }}
            >
              <Field label="Feed name">
                <input name="label" required placeholder="Investor relations" />
              </Field>
              <Field label="RSS / Atom URL">
                <input type="url" name="url" required placeholder="https://…" />
              </Field>
              <label className="check">
                <input name="official" type="checkbox" />
                Official company or regulator source
              </label>
              <button disabled={c.feeds.length >= 10}>+ Add source</button>
            </form>
            <button
              className="primary spaced"
              disabled={busy}
              onClick={() =>
                action(
                  () => api("/monitor", { companyId: c.id }),
                  "Company check completed.",
                )
              }
            >
              {busy ? "Working…" : "Check this company now"}
            </button>
            <details>
              <summary>Record a manual financial observation</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  action(
                    () =>
                      api(`/companies/${c.id}/quote`, {
                        version: doc.version,
                        quote: {
                          price: Number(f.get("price")),
                          currency: String(f.get("currency")).toUpperCase(),
                          session: f.get("session"),
                          fetchedAt: new Date().toISOString(),
                          source: "Manual",
                          pe: f.get("pe") ? Number(f.get("pe")) : null,
                          marketCap: f.get("marketCap")
                            ? Number(f.get("marketCap"))
                            : null,
                          peBasis: "Trailing P/E",
                          fundamentalDate: f.get("session"),
                        },
                      }),
                    "Manual observation recorded.",
                  );
                }}
              >
                <div className="form-grid">
                  <Field label="Close price">
                    <input
                      name="price"
                      type="number"
                      step="any"
                      min="0.0001"
                      required
                    />
                  </Field>
                  <Field label="Currency">
                    <input name="currency" defaultValue={c.currency} required />
                  </Field>
                  <Field label="Session date">
                    <input
                      name="session"
                      type="date"
                      required
                      max={new Date().toISOString().slice(0, 10)}
                    />
                  </Field>
                  <Field label="Trailing P/E (optional)">
                    <input name="pe" type="number" step="any" />
                  </Field>
                  <Field label="Market cap, full units (optional)">
                    <input name="marketCap" type="number" step="any" min="0" />
                  </Field>
                </div>
                <button disabled={busy}>Save observation</button>
              </form>
            </details>
          </>
        )}
      </div>
    </section>
  );
}

function EventList({
  docs,
  companies,
  action,
  compact = false,
}: {
  docs: Doc<DeskEvent>[];
  companies: Doc<Company>[];
  action: DetailProps["action"];
  compact?: boolean;
}) {
  const [show, setShow] = useState("unread");
  const names = new Map(companies.map((x) => [x.id, x.data.name]));
  const filtered = docs
    .filter(({ data: e }) =>
      show === "all" || show === "suppressed"
        ? show === "all" || e.priority === "suppressed"
        : !e.reviewed && e.priority !== "suppressed" && e.kind !== "health",
    )
    .sort((a, b) => b.data.discoveredAt.localeCompare(a.data.discoveredAt));
  return (
    <div className={compact ? "event-list compact" : "event-list"}>
      <div className="filters">
        {["unread", "all", "suppressed"].map((s) => (
          <button
            key={s}
            className={show === s ? "chip selected" : "chip"}
            onClick={() => setShow(s)}
          >
            {s === "unread"
              ? "Needs review"
              : s === "all"
                ? "Recent events & issues"
                : "Screened out"}
          </button>
        ))}
      </div>
      {!filtered.length && (
        <div className="empty">
          <h3>No events in this view</h3>
          <p>
            Source coverage and failures appear in Monitoring health. An empty
            feed does not establish that nothing happened.
          </p>
        </div>
      )}
      {filtered.map((doc) => {
        const e = doc.data;
        return (
          <article className={"event " + e.priority} key={e.id}>
            <div className="event-meta">
              <b>{names.get(e.companyId) || "Company"}</b>
              <span>
                {e.kind === "health"
                  ? "Coverage issue"
                  : e.priority === "major"
                    ? "Important"
                    : e.priority === "possible"
                      ? "Review / uncertain"
                      : "Screened out"}
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
            <p>{e.body}</p>
            {e.evidence && <blockquote>{e.evidence}</blockquote>}
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
                onClick={() =>
                  action(() =>
                    api(
                      `/events/${e.id}`,
                      { version: doc.version, reviewed: !e.reviewed },
                      "PUT",
                    ),
                  )
                }
              >
                {e.reviewed ? "Mark unread" : "Mark reviewed"}
              </button>
              <button
                onClick={() =>
                  action(() =>
                    api(
                      `/events/${e.id}`,
                      {
                        version: doc.version,
                        reviewed: true,
                        feedback: "useful",
                      },
                      "PUT",
                    ),
                  )
                }
              >
                Useful
              </button>
              <button
                onClick={() =>
                  action(() =>
                    api(
                      `/events/${e.id}`,
                      {
                        version: doc.version,
                        reviewed: true,
                        feedback: "noise",
                      },
                      "PUT",
                    ),
                  )
                }
              >
                Noise
              </button>
              <details>
                <summary>Evidence & model details</summary>
                <pre>{JSON.stringify(e.classification || {}, null, 2)}</pre>
                <p>Discovered {e.discoveredAt}</p>
              </details>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ImportPanel({
  batches,
  action,
  busy,
}: {
  batches: any[];
  action: DetailProps["action"];
  busy: boolean;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [error, setError] = useState("");
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">BRING YOUR RESEARCH WITH YOU</p>
          <h1>Import & backup</h1>
        </div>
      </div>
      <div className="settings-card">
        <h2>Investment Pitch List</h2>
        {batches
          .filter((b) => b.draft)
          .map((b) => (
            <div className="banner" key={b.id}>
              Your original Investment Pitch List is ready.{" "}
              <button
                onClick={async () => {
                  try {
                    const p = await api<ImportPreview>(
                      `/import/${b.id}/preview`,
                    );
                    setPreview(p);
                    setSelected(
                      new Set(
                        p.candidates.filter((x) => !x.review).map((x) => x.id),
                      ),
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Review prepared import
              </button>
            </div>
          ))}
        <p>
          Preview detected company sections before importing. Your entire
          original file is preserved. Ambiguous entries start unchecked; no
          companies are silently merged.
        </p>
        <label className="file-input">
          Choose Markdown file
          <input
            type="file"
            accept=".md,.txt"
            onChange={async (e) => {
              try {
                const file = e.target.files?.[0];
                if (!file) return;
                const p = await api<ImportPreview>("/import/preview", {
                  source: await file.text(),
                });
                setPreview(p);
                setSelected(
                  new Set(
                    p.candidates.filter((x) => !x.review).map((x) => x.id),
                  ),
                );
                setError("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        {preview && (
          <>
            <h3>
              {preview.candidates.length} possible company sections ·{" "}
              {selected.size} selected
            </h3>
            <p>
              Review names, duplicate entries and category mappings. Tickers and
              old prices remain notes until you confirm a market-data mapping.
            </p>
            <button
              onClick={() =>
                setSelected(new Set(preview.candidates.map((x) => x.id)))
              }
            >
              Select all
            </button>
            <button onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
            <div className="import-preview">
              <table>
                <thead>
                  <tr>
                    <th>Import</th>
                    <th>Company</th>
                    <th>Category</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.candidates.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <input
                          aria-label={`Import ${item.name}`}
                          type="checkbox"
                          checked={selected.has(item.id)}
                          onChange={(e) =>
                            setSelected((old) => {
                              const next = new Set(old);
                              e.target.checked
                                ? next.add(item.id)
                                : next.delete(item.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Company at line ${item.start}`}
                          value={item.name}
                          onChange={(e) =>
                            setPreview({
                              ...preview,
                              candidates: preview.candidates.map((x) =>
                                x.id === item.id
                                  ? { ...x, name: e.target.value }
                                  : x,
                              ),
                            })
                          }
                        />
                        {item.review && (
                          <small className="warning">Needs review</small>
                        )}
                        <details>
                          <summary>Original notes</summary>
                          <pre>{item.notes}</pre>
                        </details>
                      </td>
                      <td>
                        <StatusSelect
                          value={item.status}
                          onChange={(status) =>
                            setPreview({
                              ...preview,
                              candidates: preview.candidates.map((x) =>
                                x.id === item.id ? { ...x, status } : x,
                              ),
                            })
                          }
                        />
                      </td>
                      <td>
                        <small>
                          {item.group}
                          <br />
                          Lines {item.start}–{item.end}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              className="primary"
              disabled={busy || !selected.size}
              onClick={() =>
                action(async () => {
                  await api("/import/commit", {
                    source: preview.source,
                    selections: preview.candidates
                      .filter((x) => selected.has(x.id))
                      .map(({ id, name, status }) => ({ id, name, status })),
                  });
                  setPreview(null);
                }, "Selected companies imported. The original source file is preserved in your backup.")
              }
            >
              {busy ? "Importing…" : `Import ${selected.size} companies`}
            </button>
          </>
        )}
      </div>
      <div className="settings-card">
        <h2>Portable backup</h2>
        <button
          onClick={() =>
            action(async () => {
              const snapshots = await api<Doc<any>[]>("/backups");
              if (!snapshots.length)
                throw new Error(
                  "No automatic snapshot yet. The hosted scheduler creates one daily.",
                );
              const latest = snapshots.sort((a, b) =>
                b.id.localeCompare(a.id),
              )[0];
              download(
                `research-snapshot-${latest.id}.json`,
                JSON.stringify(await api(`/backups/${latest.id}`), null, 2),
              );
            })
          }
        >
          Download latest daily research snapshot
        </button>
        <p>
          Hosted monitoring keeps 30 days of research snapshots: companies,
          notes, rules and original imports. Complete exports below also include
          alert history and note revisions.
        </p>
        <p>
          Export companies, notes, original import files, revisions, watch
          points and alert history. Restore adds missing records without
          overwriting current work.
        </p>
        <button
          onClick={() =>
            action(async () =>
              download(
                `research-desk-${new Date().toISOString().slice(0, 10)}.json`,
                JSON.stringify(await api("/export"), null, 2),
              ),
            )
          }
        >
          Download complete backup
        </button>
        <label className="file-input secondary">
          Restore backup
          <input
            type="file"
            accept=".json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file)
                await action(async () => {
                  const result = await api(
                    "/restore",
                    JSON.parse(await file.text()),
                  );
                  alert(
                    `Restored ${result.restored}; kept ${result.skipped} existing records.`,
                  );
                });
            }}
          />
        </label>
      </div>
      {batches.length > 0 && (
        <div className="settings-card">
          <h2>Import history</h2>
          {batches
            .filter((b) => !b.draft)
            .map((b) => (
              <div className="rule" key={b.id}>
                <b>
                  {b.count} companies · {chicagoDate(b.at)}
                </b>
                <p>
                  {b.rolledBack
                    ? "Rolled back; original source retained."
                    : "Original source archived with this batch."}
                </p>
                {!b.rolledBack && (
                  <button
                    onClick={() => {
                      if (
                        confirm(
                          "Remove untouched companies from this import? Companies you edited will be preserved.",
                        )
                      )
                        action(
                          () => api(`/import/${b.id}/rollback`, {}),
                          "Import rolled back. Edited companies were kept.",
                        );
                    }}
                  >
                    Roll back untouched entries
                  </button>
                )}
              </div>
            ))}
        </div>
      )}
    </>
  );
}
function SettingsPanel({
  data,
  action,
  busy,
}: {
  data: Bootstrap;
  action: DetailProps["action"];
  busy: boolean;
}) {
  const [digest, setDigest] = useState<any>(null);
  const settings = data.settings || defaultSettings;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">DAILY RHYTHM, LOW RUNNING COST</p>
          <h1>Settings & digest</h1>
        </div>
      </div>
      <div className="settings-card">
        <h2>Your daily email</h2>
        <p>
          Recipient: <b>{data.configuration.recipient}</b>
          <br />
          Timezone: <b>America/Chicago</b> (daylight saving adjusts
          automatically)
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            action(
              () =>
                api(
                  "/settings",
                  {
                    version: data.settingsVersion,
                    data: {
                      timezone: "America/Chicago",
                      digestHour: Number(f.get("hour")),
                      digestEnabled: f.get("enabled") === "on",
                      skipEmpty: f.get("skip") === "on",
                    },
                  },
                  "PUT",
                ),
              "Digest preferences saved.",
            );
          }}
        >
          <Field label="Send at (Chicago time)">
            <select name="hour" defaultValue={settings.digestHour}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </Field>
          <label className="check">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={settings.digestEnabled}
            />
            Enable daily digest
          </label>
          <label className="check">
            <input
              name="skip"
              type="checkbox"
              defaultChecked={settings.skipEmpty}
            />
            Skip empty emails when there are no coverage issues
          </label>
          <p className="muted">
            {data.configuration.email
              ? "Email service configured."
              : "Email service is not yet configured. A verified sender and Resend key are required."}
          </p>
          <button disabled={busy}>Save preferences</button>
          <button
            type="button"
            onClick={() => action(async () => setDigest(await api("/digest")))}
          >
            Preview next digest
          </button>
        </form>
        {digest && (
          <details open>
            <summary>{digest.subject}</summary>
            <pre className="digest-preview">{digest.text}</pre>
          </details>
        )}
      </div>
      <div className="settings-card">
        <h2>Connected services</h2>
        <dl>
          <dt>TypeSafe</dt>
          <dd>
            {data.configuration.typesafe
              ? `Connected · ${data.configuration.model}`
              : "Not configured"}
          </dd>
          <dt>TypeSafe spending ceiling</dt>
          <dd>${data.configuration.modelBudget}/month · server enforced</dd>
          <dt>Recorded TypeSafe usage</dt>
          <dd>
            $
            {Number(
              data.usage?.find(
                (u) => u.month === new Date().toISOString().slice(0, 7),
              )?.cost || 0,
            ).toFixed(4)}{" "}
            this month (includes reserved requests)
          </dd>
          <dt>EODHD</dt>
          <dd>
            {data.configuration.eodhd
              ? "Key configured; coverage depends on subscription"
              : "Not configured"}
          </dd>
          <dt>Data storage</dt>
          <dd>
            {cloud ? "Supabase · private account" : "SQLite · this computer"}
          </dd>
        </dl>
        <p className="muted">
          Missing financial data stays blank. Model probabilities are screening
          signals, not calibrated investment probabilities. Your full research
          notes are not sent to TypeSafe; screening uses company identity,
          thesis, watch points and the supplied article.
        </p>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
