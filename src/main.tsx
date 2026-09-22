import { api, apiText, setAccessToken } from "./api";
import { IntegrationsPanel, JobsPanel } from "./integrations-panel";
import { Field, chicagoDate } from "./ui";
import { NewsBatchStatus, EventList, type EventUpdate } from "./news-panel";
import { mergeDocuments, latestBatch } from "./sync";
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
const ReactMarkdown = React.lazy(() => import("react-markdown"));
import {
  defaultSettings,
  statusLabels,
  statuses,
} from "../supabase/functions/_shared/constants";
import {
  type Company,
  type DeskEvent,
  type Doc,
  type Settings,
  type Status,
  type Rule,
} from "../supabase/functions/_shared/model";
import {
  cadenceOf,
  formatMoney,
  quoteState,
} from "../supabase/functions/_shared/engine";
import type { ImportPreview } from "../supabase/functions/_shared/importer";
import "./style.css";
import { loadDrafts, saveDraft, type Draft } from "./drafts";
import {
  eventGroupKey,
  filterCompanies,
  inEventFolder,
} from "../supabase/functions/_shared/event-inbox";
import type { NewsBatchSummary } from "../supabase/functions/_shared/news-batch";
import {
  groupNews,
  MAX_ARTICLE_CHARS,
} from "../supabase/functions/_shared/screening-policy";
import {
  companyNewsQuery,
  newsBucket,
} from "../supabase/functions/_shared/news";

const cloud = !!import.meta.env.VITE_SUPABASE_URL;
const supabase = cloud
  ? createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_ANON_KEY,
    )
  : null;
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
function Root() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!cloud);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState("");
  useEffect(() => {
    if (!supabase) return;
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (error) setError(error.message);
        setAccessToken(data.session?.access_token || "");
        setSession(data.session);
        setReady(true);
      })
      .catch((error: Error) => {
        setError(
          error.message || "Unable to open your session. Please sign in again.",
        );
        setReady(true);
      });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setAccessToken(next?.access_token || "");
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
        <h2>Sign in with your email</h2>
        <p>We’ll email you a secure sign-in link. No password needed.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const email = String(form.get("email")).trim();
            setSending(true);
            setError("");
            setSentTo("");
            try {
              const { error } = await supabase!.auth.signInWithOtp({
                email,
                options: {
                  shouldCreateUser: false,
                  emailRedirectTo: window.location.origin,
                },
              });
              if (error) throw error;
              setSentTo(email);
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setSending(false);
            }
          }}
        >
          <Field label="Email">
            <input
              autoComplete="email"
              type="email"
              name="email"
              placeholder="you@example.com"
              autoFocus
              required
            />
          </Field>
          <button className="primary" disabled={sending}>
            {sending
              ? "Sending link…"
              : sentTo
                ? "Send another sign-in link"
                : "Email me a sign-in link"}
          </button>
          {sentTo && (
            <p role="status">
              Check <b>{sentTo}</b> and open the sign-in link to continue. If it
              hasn’t arrived, check your spam folder.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
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
  newsBatch?: NewsBatchSummary | null;
  imports: any[];
  usage?: { month: string; cost: number; tokens: number; requests: number }[];
}
function App({ onLogout, owner }: { onLogout?: () => void; owner: string }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [section, setSection] = useState("companies");
  const [filter, setFilter] = useState<Status | "all" | "archived">("all");
  const [group, setGroup] = useState("");
  const [query, setQuery] = useState("");
  const [newsCompany, setNewsCompany] = useState("");
  const search = useDeferredValue(query.toLowerCase());
  const [selected, setSelected] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("company") || "",
  );
  const [tab, setTab] = useState("research");
  const openCompany = useCallback((id: string) => {
    setSelected(id);
    history.replaceState(null, "", "#company=" + encodeURIComponent(id));
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
  const eventWrites = useRef(new Map<string, Doc<DeskEvent>>());
  const [savingEvents, setSavingEvents] = useState(new Set<string>());
  const [batchStarting, setBatchStarting] = useState(false);
  const [batchControlBusy, setBatchControlBusy] = useState(false);
  const newsCursor = useRef("");
  const newsRefresh = useRef<Promise<void> | null>(null);
  const reloadNews = useCallback(() => {
    if (newsRefresh.current) return newsRefresh.current;
    newsRefresh.current = (async () => {
      try {
        const result = await api<{
          events: Doc<DeskEvent>[];
          batch: NewsBatchSummary | null;
          cursor: string;
        }>(
          `/news/updates${newsCursor.current ? `?since=${encodeURIComponent(newsCursor.current)}` : ""}`,
        );
        newsCursor.current = result.cursor;
        setData(
          (old) =>
            old && {
              ...old,
              events: mergeDocuments(
                old.events,
                result.events,
                eventWrites.current,
              ),
              newsBatch: latestBatch(old.newsBatch, result.batch),
            },
        );
      } catch (error) {
        setError(`Could not refresh news: ${(error as Error).message}`);
      } finally {
        newsRefresh.current = null;
      }
    })();
    return newsRefresh.current;
  }, []);
  const reload = useCallback(async () => {
    setLoadError("");
    try {
      const next = await api<Bootstrap>(
        state.current ? "/bootstrap?events=none" : "/bootstrap",
      );
      setData((old) => {
        const known = new Map(old?.companies.map((d) => [d.id, d]) || []);
        return {
          ...next,
          companies: next.companies.map((incoming) => {
            const current = known.get(incoming.id);
            const latest =
              current && current.version > incoming.version
                ? current
                : incoming;
            const draft = pending.current.get(latest.id);
            return draft ? { ...latest, data: draft.data } : latest;
          }),
          events: mergeDocuments(
            old?.events || [],
            next.events,
            eventWrites.current,
          ),
          newsBatch: latestBatch(old?.newsBatch, next.newsBatch),
          ...(old && old.settingsVersion > next.settingsVersion
            ? { settings: old.settings, settingsVersion: old.settingsVersion }
            : {}),
        };
      });
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void reload();
        void reloadNews();
      }
    };
    const timer = setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload, reloadNews]);
  useEffect(() => {
    let live = true,
      busy = false,
      cursor = new Date().toISOString();
    const versions = new Map<string, number>();
    const tick = async () => {
      if (!live || busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const result = await api<{
          cursor: string;
          items: { kind: string; id: string; version: number }[];
        }>("/changes?since=" + encodeURIComponent(cursor));
        if (!live) return;
        cursor = result.cursor;
        const changed = result.items.filter(
          (d) => d.version > (versions.get(d.kind + ":" + d.id) || 0),
        );
        result.items.forEach((d) =>
          versions.set(d.kind + ":" + d.id, d.version),
        );
        if (changed.some((d) => d.kind !== "event")) await reload();
        if (changed.some((d) => d.kind === "event" || d.kind === "news_batch"))
          await reloadNews();
      } catch {
        /* The minute refresh still reports connectivity errors. */
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(tick, 5000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [reload, reloadNews]);
  useEffect(() => {
    const batch = data?.newsBatch;
    if (!batch || batch.status !== "running") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const advance = async () => {
      try {
        if (document.visibilityState !== "visible") {
          timer = setTimeout(advance, 15000);
          return;
        }
        const result = await api<{ batch: NewsBatchSummary | null }>(
          `/news/batches/${batch.id}/advance`,
          {},
        );
        if (!live) return;
        setData(
          (old) =>
            old && {
              ...old,
              newsBatch: latestBatch(old.newsBatch, result.batch),
            },
        );
        await reloadNews();
        if (result.batch?.status === "running" && live)
          timer = setTimeout(advance, 2000);
      } catch (error) {
        if (live) {
          setError(
            `News batch progress could not refresh: ${(error as Error).message} Saved progress will be retried automatically.`,
          );
          timer = setTimeout(advance, 15000);
        }
      }
    };
    timer = setTimeout(advance, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [data?.newsBatch?.id, data?.newsBatch?.status, reloadNews]);
  useEffect(() => {
    if (data && (selected || section === "news")) void reloadNews();
  }, [!!data, selected, section, reloadNews]);
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
      await Promise.all([reload(), reloadNews()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const updateEvent: EventUpdate = async (
    doc,
    patch,
    scope = "development",
  ) => {
    const members = (state.current?.events || []).filter((d) =>
      scope === "article"
        ? d.id === doc.id
        : eventGroupKey(d.data) === eventGroupKey(doc.data),
    );
    if (members.some((d) => eventWrites.current.has(d.id))) return;
    for (const d of members)
      eventWrites.current.set(d.id, { ...d, data: { ...d.data, ...patch } });
    setSavingEvents(new Set(eventWrites.current.keys()));
    const replace = (items: Doc<DeskEvent>[]) =>
      setData(
        (old) =>
          old && {
            ...old,
            events: old.events.map(
              (d) => items.find((x) => x.id === d.id) || d,
            ),
          },
      );
    replace(members.map((d) => eventWrites.current.get(d.id)!));
    setError("");
    try {
      const result = await api<{ items: Doc<DeskEvent>[] }>(
        `/developments/${encodeURIComponent(doc.id)}`,
        {
          versions: Object.fromEntries(members.map((d) => [d.id, d.version])),
          scope,
          patch: {
            ...patch,
            ...(Object.hasOwn(patch, "feedback")
              ? { feedback: patch.feedback ?? null }
              : {}),
          },
        },
        "PATCH",
      );
      replace(result.items);
    } catch (error) {
      replace(members);
      setError(`Could not save development: ${(error as Error).message}`);
    } finally {
      for (const d of members) eventWrites.current.delete(d.id);
      setSavingEvents(new Set(eventWrites.current.keys()));
    }
  };
  const docs = data?.companies || [];
  const filtered = useMemo(
    () => filterCompanies(docs, { status: filter, group, search }),
    [docs, filter, group, search],
  );
  const activeNewsCompany = filtered.some((d) => d.id === newsCompany)
    ? newsCompany
    : "";
  const batchCompanies =
    section === "news" && activeNewsCompany
      ? filtered.filter((d) => d.id === activeNewsCompany)
      : filtered;
  const startBatch = async () => {
    if (
      batchStarting ||
      data?.newsBatch?.status === "running" ||
      data?.newsBatch?.status === "paused" ||
      !batchCompanies.length
    )
      return;
    setBatchStarting(true);
    setError("");
    const label = [
      filter === "all"
        ? "All companies"
        : filter === "archived"
          ? "Archived"
          : statusLabels[filter],
      group,
      query && `Search: ${query}`,
      section === "news" && activeNewsCompany && batchCompanies[0]?.data.name,
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 300);
    try {
      const batch = await api<NewsBatchSummary>("/news/batches", {
        id: crypto.randomUUID(),
        label,
        companyIds: batchCompanies.map((d) => d.id),
      });
      setData((old) => old && { ...old, newsBatch: batch });
      setNotice("");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBatchStarting(false);
    }
  };
  const controlBatch = async (action: "pause" | "resume" | "cancel") => {
    if (!data?.newsBatch || batchControlBusy) return;
    setBatchControlBusy(true);
    try {
      const batch = await api<NewsBatchSummary>(
        `/news/batches/${data.newsBatch.id}/control`,
        { action },
      );
      setData((old) => old && { ...old, newsBatch: batch });
      await reload();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBatchControlBusy(false);
    }
  };
  const batchButton = (
    <button
      className="primary"
      disabled={
        batchStarting ||
        data?.newsBatch?.status === "running" ||
        data?.newsBatch?.status === "paused" ||
        !batchCompanies.length
      }
      onClick={startBatch}
      title={`Up to 10 articles per day for each of the last 7 UTC calendar days, including today; up to ${(batchCompanies.length * 70).toLocaleString()} Google News articles across this selection, plus configured primary sources.`}
    >
      {batchStarting
        ? "Starting…"
        : data?.newsBatch?.status === "running"
          ? "News batch running…"
          : data?.newsBatch?.status === "paused"
            ? "News search paused"
            : `Search news · ${batchCompanies.length} ${batchCompanies.length === 1 ? "company" : "companies"}`}
    </button>
  );
  const companyFilters = (
    <CompanyScopeFilters
      docs={docs}
      filter={filter}
      setFilter={(value) => {
        setFilter(value);
        setNewsCompany("");
      }}
      group={group}
      setGroup={setGroup}
    />
  );
  const selectedDoc = docs.find((c) => c.id === selected);
  const unseen = groupNews(
    (data?.events || []).filter(
      (e) =>
        inEventFolder(e.data, "inbox") && newsBucket(e.data) === "relevant",
    ),
  ).length;
  if (!data)
    return (
      <main className="login">
        <div className="brand">RESEARCH DESK</div>
        <p role="status">{loadError || "Opening your desk…"}</p>
        {loadError && <button onClick={reload}>Retry</button>}
        {loadError && onLogout && <button onClick={onLogout}>Sign out</button>}
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
          {loadError && (
            <div className="notice" role="alert">
              {loadError} <button onClick={reload}>Retry</button>
            </div>
          )}
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
              {companyFilters}
              <div className="batch-toolbar">
                {batchButton}
                <span className="muted">
                  News only, for companies matching these filters.
                </span>
              </div>
              <NewsBatchStatus
                batch={data.newsBatch}
                onControl={controlBatch}
                controlBusy={batchControlBusy}
              />
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
                    close={() => {
                      setSelected("");
                      history.replaceState(
                        null,
                        "",
                        location.pathname + location.search,
                      );
                    }}
                    events={data.events.filter(
                      (e) => e.data.companyId === selected,
                    )}
                    config={data.configuration}
                    busy={busy || pending.current.has(selected)}
                    action={action}
                    updateEvent={updateEvent}
                    savingEvents={savingEvents}
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
                {batchButton}
              </div>
              <p className="muted">
                New items appear at the top. Review to clear your inbox, or save
                to keep. Unsaved unread items leave the inbox after 30 days.
              </p>
              <input
                className="search"
                aria-label="Search companies for news"
                placeholder="Filter companies, tickers, notes…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {companyFilters}
              <NewsBatchStatus
                batch={data.newsBatch}
                onControl={controlBatch}
                controlBusy={batchControlBusy}
              />
              <EventList
                docs={data.events}
                companies={filtered}
                companyFilter={activeNewsCompany}
                onCompanyFilterChange={setNewsCompany}
                updateEvent={updateEvent}
                savingEvents={savingEvents}
              />
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
                      () => api("/jobs", { type: "monitor" }),
                      "Monitoring queued. Track it under Settings & digest → Background job history.",
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
              <div
                className="table-scroll"
                role="region"
                aria-label="Company monitoring coverage"
                tabIndex={0}
              >
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
              </div>
            </>
          )}
          {section === "import" && (
            <ImportPanel batches={data.imports} action={action} busy={busy} />
          )}
          {section === "settings" && (
            <>
              <SettingsPanel data={data} action={action} busy={busy} />
              <IntegrationsPanel />
              <JobsPanel />
            </>
          )}
        </main>
      </div>
      {adding && (
        <dialog
          className="modal-backdrop"
          aria-labelledby="add-company-title"
          ref={(node) => {
            if (node && !node.open) {
              node.showModal();
              node
                .querySelector<HTMLInputElement>('input[name="name"]')
                ?.focus();
            }
          }}
          onCancel={(e) => {
            e.preventDefault();
            if (!busy) setAdding(false);
          }}
        >
          <form
            className="modal"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              await action(async () => {
                const doc = await api<Doc<Company>>("/companies", {
                  name: f.get("name"),
                  ticker: f.get("ticker"),
                  ideaSource: f.get("ideaSource"),
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
              disabled={busy}
              onClick={() => setAdding(false)}
            >
              ×
            </button>
            <p className="eyebrow">CAPTURE AN IDEA</p>
            <h2 id="add-company-title">Add company</h2>
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
            <Field label="Where did you find this idea?">
              <input
                name="ideaSource"
                maxLength={2000}
                placeholder="Screener, newsletter, person, podcast or link…"
              />
            </Field>
            <button className="primary" disabled={busy}>
              {busy ? "Adding…" : "Add company"}
            </button>
          </form>
        </dialog>
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
  updateEvent: EventUpdate;
  savingEvents: Set<string>;
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
  updateEvent,
  savingEvents,
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
            <Field label="Where did you find this idea?">
              <textarea
                rows={2}
                maxLength={2000}
                placeholder="Screener, newsletter, person, podcast or link…"
                value={c.ideaSource || ""}
                onChange={(e) => edit({ ideaSource: e.target.value })}
              />
            </Field>
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
                <React.Suspense fallback={<p>Formatting notes…</p>}>
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
                </React.Suspense>
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
              onClick={() =>
                action(async () => {
                  setHistory(await api(`/companies/${c.id}/revisions`));
                })
              }
            >
              Note history
            </button>
            <button
              onClick={() =>
                action(async () => {
                  const markdown = await apiText(`/companies/${c.id}/markdown`);
                  download(
                    `${c.name.replace(/[^a-z0-9 -]/gi, "")}.md`,
                    markdown,
                    "text/markdown",
                  );
                })
              }
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
                    api("/jobs", {
                      type: "analyze",
                      companyId: c.id,
                      article: Object.fromEntries(f),
                    }),
                  "Article analysis queued. Track it under Settings & digest → Background job history.",
                );
              }}
            >
              <Field label="Headline">
                <input name="title" required />
              </Field>
              <Field label="Article text">
                <textarea
                  name="text"
                  rows={5}
                  maxLength={MAX_ARTICLE_CHARS}
                  required
                />
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
                const rule: Rule = {
                  id: crypto.randomUUID(),
                  metric: f.get("metric") as Rule["metric"],
                  threshold: Number(f.get("threshold")),
                  currency: String(f.get("currency")).toUpperCase(),
                  baseline: f.get("baseline")
                    ? Number(f.get("baseline"))
                    : null,
                  enabled: true,
                  triggered: false,
                  episode: 0,
                  lastSession: "",
                  lastFingerprint: "",
                  basis: "Trailing P/E",
                };
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
              updateEvent={updateEvent}
              savingEvents={savingEvents}
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
            <div className="form-grid">
              <Field label="Business scale for news screening">
                <select
                  value={c.businessScale}
                  onChange={(e) =>
                    edit({
                      businessScale: e.target.value as Company["businessScale"],
                    })
                  }
                >
                  <option value="unknown">Not established</option>
                  <option value="small">Small business</option>
                  <option value="medium">Medium business</option>
                  <option value="large">Large business</option>
                </select>
              </Field>
              <Field label="Context as of">
                <input
                  type="date"
                  value={c.contextAsOf}
                  onChange={(e) => edit({ contextAsOf: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Business and financial context">
              <textarea
                rows={4}
                maxLength={6000}
                value={c.businessContext}
                onChange={(e) => edit({ businessContext: e.target.value })}
                placeholder="Key profit drivers, segment exposure, revenue/earnings scale and financial capacity. Include units and dates for figures."
              />
            </Field>
            <Field label="Context source">
              <input
                value={c.contextSource}
                maxLength={2000}
                onChange={(e) => edit({ contextSource: e.target.value })}
                placeholder="Source URL or research reference"
              />
            </Field>
            <Field label="Primary document pages or RSS feeds (one URL per line)">
              <textarea
                rows={3}
                key={`${c.id}-primary`}
                defaultValue={c.primarySources.join("\n")}
                onBlur={(e) =>
                  edit({
                    primarySources: e.target.value
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="https://company.example/investors/results"
              />
            </Field>
            <Field label="SEC CIK (optional)">
              <input
                inputMode="numeric"
                maxLength={10}
                value={c.secCik}
                onChange={(e) =>
                  edit({ secCik: e.target.value.replace(/\D/g, "") })
                }
                placeholder="SEC company identifier for US filings"
              />
            </Field>
            <Field label="Additional publisher domains to read (one per line)">
              <textarea
                rows={2}
                key={`${c.id}-publishers`}
                defaultValue={c.articleHosts.join("\n")}
                onBlur={(e) =>
                  edit({
                    articleHosts: e.target.value
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="research-publication.example"
              />
            </Field>
            <p className="muted">
              Netflix, Progressive, Zoom and American Coastal have built-in
              investor-relations sources. Other companies use the sources
              entered here and official feeds below. Unreadable sources appear
              in Monitoring health.
            </p>
            <Field label="Excluded publishers (one name or domain per line)">
              <textarea
                rows={3}
                key={`${c.id}-excluded`}
                defaultValue={c.excludedNewsSources.join("\n")}
                onBlur={(e) =>
                  edit({
                    excludedNewsSources: e.target.value
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
            <Field label="Company news search">
              <input
                maxLength={500}
                value={c.newsQuery || ""}
                placeholder={companyNewsQuery({ ...c, newsQuery: "" })}
                onChange={(e) => edit({ newsQuery: e.target.value })}
              />
            </Field>
            <p className="muted">
              Optional: refine the search for names shared by other businesses.
              TypeSafe screens available article text for company-scale
              significance, evidence quality and original contribution.
              Incomplete evidence stays in Needs verification.
            </p>
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
                  () => api("/jobs", { type: "monitor", companyId: c.id }),
                  "Company check queued. Track it under Settings & digest → Background job history.",
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

function CompanyScopeFilters({
  docs,
  filter,
  setFilter,
  group,
  setGroup,
}: {
  docs: Doc<Company>[];
  filter: Status | "all" | "archived";
  setFilter: (value: Status | "all" | "archived") => void;
  group: string;
  setGroup: (value: string) => void;
}) {
  return (
    <div className="filters" role="group" aria-label="Filter companies">
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
        {[...new Set(docs.map((c) => c.data.originalGroup).filter(Boolean))]
          .sort()
          .map((g) => (
            <option key={g}>{g}</option>
          ))}
      </select>
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
          <dt>AI credential & pricing</dt>
          <dd>
            TypeSafe API key stored on the server · $0.042 per million input
            tokens; output is free. The app does not use ChatGPT sign-in or an
            OpenAI Platform key.
          </dd>
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
          <dt>Hosting & database billing</dt>
          <dd>
            Cloudflare Pages and Supabase. This app cannot read your provider
            invoices or account plan charges; check those dashboards for account
            totals.
          </dd>
          <dt>News retrieval</dt>
          <dd>
            Google News discovery + configured primary sources. Accessible
            HTML/PDF text is assessed up to 120,000 characters; unavailable text
            is labeled. No paid news API.
          </dd>
          <dt>Email digest</dt>
          <dd>
            {data.configuration.email
              ? "Resend configured; charged under your Resend plan"
              : "Delivery disabled · no Resend sending costs from this app"}
          </dd>
        </dl>
        <p className="muted">
          Missing financial data stays blank. Model probabilities are screening
          signals, not calibrated investment probabilities. Screening sends
          company identity, bounded excerpts of research notes and thesis,
          business context, watch points and the supplied article to TypeSafe.
        </p>
      </div>
    </>
  );
}

const root =
  import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
