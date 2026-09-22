import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Field, chicagoDate } from "./ui";
type Token = {
  id: string;
  name: string;
  channel: string;
  scopes: string[];
  expiresAt: string;
  revokedAt: string;
};
const labels: Record<string, string> = {
  read: "Read research and news",
  "research:write": "Edit companies and research",
  "monitoring:write": "Edit watch points, rules and sources",
  "news:write": "Save, review and label developments",
  "jobs:start": "Start searches and analysis (may use paid AI)",
  "jobs:control": "Pause, resume and cancel jobs",
  "settings:write": "Change digest settings",
  "backup:read": "Download private exports and backups",
  "import:write": "Import research and roll back imports",
};
export function IntegrationsPanel() {
  const [tokens, setTokens] = useState<Token[]>([]),
    [available, setAvailable] = useState<string[]>([]),
    [secret, setSecret] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => {
    const data = await api<{ items: Token[]; scopes: string[] }>(
      "/integrations",
    );
    setTokens(data.items);
    setAvailable(data.scopes);
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-card">
      <h2>MCP & OpenClaw integrations</h2>
      <p>
        Create a separate credential for each connection. Choose its permissions
        and revoke it here at any time. The secret is shown once.
      </p>
      {error && <p role="alert">{error}</p>}
      {secret && (
        <div className="integration-secret">
          <Field label="New integration token — copy now">
            <input
              readOnly
              value={secret}
              autoComplete="off"
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
          <button onClick={() => setSecret("")}>I have stored the token</button>
          <p>
            Use the local setup prompt; do not paste this token into an AI
            conversation.
          </p>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void run(async () => {
            const result = await api<{ token: string }>("/integrations", {
              name: f.get("name"),
              channel: f.get("channel"),
              scopes: f.getAll("scope"),
              expiresAt: new Date(
                Date.now() + Number(f.get("days")) * 86400000,
              ).toISOString(),
            });
            setSecret(result.token);
          });
        }}
      >
        <div className="form-grid">
          <Field label="Connection name">
            <input
              name="name"
              maxLength={100}
              required
              placeholder="Desktop MCP"
            />
          </Field>
          <Field label="Channel">
            <select name="channel">
              <option value="mcp">MCP</option>
              <option value="openclaw">OpenClaw</option>
              <option value="integration">Other API client</option>
            </select>
          </Field>
          <Field label="Expires after">
            <select name="days">
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
            </select>
          </Field>
        </div>
        <fieldset>
          <legend>Permissions</legend>
          {available.map((scope) => (
            <label className="check" key={scope}>
              <input
                type="checkbox"
                name="scope"
                value={scope}
                defaultChecked={[
                  "read",
                  "research:write",
                  "monitoring:write",
                  "news:write",
                  "jobs:control",
                ].includes(scope)}
              />
              {labels[scope] || scope}
            </label>
          ))}
        </fieldset>
        <button disabled={busy}>Create integration token</button>
      </form>
      {tokens.map((token) => (
        <article className="integration-record" key={token.id}>
          <strong>{token.name}</strong>
          <p>
            {token.channel} ·{" "}
            {token.revokedAt
              ? "Revoked"
              : Date.parse(token.expiresAt) < Date.now()
                ? "Expired"
                : `Expires ${chicagoDate(token.expiresAt)}`}
          </p>
          <p>{token.scopes.map((s) => labels[s] || s).join(" · ")}</p>
          {!token.revokedAt && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(`/integrations/${token.id}/revoke`, {});
                  setSecret("");
                })
              }
            >
              Revoke {token.name}
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
export function JobsPanel() {
  const expanded = useRef(false);
  const [jobs, setJobs] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const result = await api("/jobs?limit=25");
        if (live) {
          setJobs((old) =>
            expanded.current
              ? [
                  ...result.items,
                  ...old.filter(
                    (j) => !result.items.some((n: any) => n.id === j.id),
                  ),
                ]
              : result.items,
          );
          if (!expanded.current) setCursor(result.nextCursor);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const control = async (id: string, action: string) => {
    setBusy(id);
    try {
      await api(`/jobs/${id}/control`, { action });
      const result = await api("/jobs?limit=25");
      setJobs(result.items);
      setCursor(result.nextCursor);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="settings-card">
      <h2>Background job history</h2>
      <p>
        Pause and Cancel retain completed results. An in-flight article or
        company check may finish. Hosted work continues on scheduler ticks.
      </p>
      {error && <p role="alert">{error}</p>}
      {!jobs.length && <p>No saved jobs.</p>}
      {jobs.map((j) => (
        <article className="integration-record" key={j.id}>
          <strong>{j.label || j.type}</strong>
          <p>
            {j.status} · {j.completedCompanies ?? j.cursor ?? 0}/
            {j.totalCompanies} companies · {chicagoDate(j.createdAt)}
          </p>
          {j.error && <p>{j.error}</p>}
          {!["completed", "cancelled"].includes(j.status) && (
            <div className="actions">
              <button
                disabled={busy === j.id}
                onClick={() =>
                  void control(
                    j.id,
                    j.status === "paused" || j.status === "failed"
                      ? "resume"
                      : "pause",
                  )
                }
              >
                {j.status === "paused" || j.status === "failed"
                  ? "Resume"
                  : "Pause"}
              </button>
              <button
                disabled={busy === j.id}
                onClick={() => void control(j.id, "cancel")}
              >
                Cancel job
              </button>
            </div>
          )}
        </article>
      ))}
      {cursor && (
        <button
          onClick={async () => {
            expanded.current = true;
            try {
              const result = await api(
                `/jobs?limit=25&cursor=${encodeURIComponent(cursor)}`,
              );
              setJobs((old) => [
                ...old,
                ...result.items.filter(
                  (j: any) => !old.some((x) => x.id === j.id),
                ),
              ]);
              setCursor(result.nextCursor);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Show older jobs
        </button>
      )}
    </section>
  );
}
