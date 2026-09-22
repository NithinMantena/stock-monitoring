import { afterEach, expect, it, vi } from "vitest";
import { LocalStore } from "../server/store.ts";
import { createV1Api } from "../supabase/functions/_shared/api-v1.ts";
import {
  authenticateIntegration,
  ownerActor,
  type Actor,
} from "../supabase/functions/_shared/integrations.ts";
import { newCompany } from "../supabase/functions/_shared/model.ts";
import { reviewFixture } from "./review-fixtures.ts";
import { DeskClient, DeskError } from "../client/desk-client.ts";
import { DatabaseReadError } from "../supabase/functions/_shared/database-read.ts";
const stores: LocalStore[] = [];
it("preserves unavailable-database errors and limits ordinary request bodies", async () => {
  const { store, app } = setup();
  const original = store.get;
  store.get = async () => {
    throw new DatabaseReadError(true);
  };
  expect((await app.request("/settings")).status).toBe(503);
  store.get = original;
  expect(
    (await send(app, "/companies", { name: "x".repeat(2500000) })).status,
  ).toBe(413);
});
it("requires start permission to resume and paginates compact company summaries", async () => {
  const { store, app } = setup();
  for (const name of ["Beta", "Alpha", "Gamma"]) {
    const c = newCompany(name);
    await store.put("company", c.id, c, 0);
  }
  const first = await (await app.request("/companies?limit=2")).json();
  expect(first.items.map((x: any) => x.name)).toEqual(["Alpha", "Beta"]);
  const second = await (
    await app.request(`/companies?limit=2&cursor=${first.nextCursor}`)
  ).json();
  expect(second.items.map((x: any) => x.name)).toEqual(["Gamma"]);
  const job = await (await send(app, "/jobs", { type: "monitor" })).json();
  const limited = createV1Api(store, {}, "local", {
    id: "controller",
    channel: "mcp",
    admin: false,
    scopes: ["read", "jobs:control"],
  });
  expect(
    (await send(limited, `/jobs/${job.id}/control`, { action: "pause" }))
      .status,
  ).toBe(200);
  expect(
    (await send(limited, `/jobs/${job.id}/control`, { action: "resume" }))
      .status,
  ).toBe(403);
  expect((await send(limited, `/jobs/${job.id}/advance`, {})).status).toBe(403);
  expect(
    (await send(limited, `/jobs/${job.id}/control`, { action: "cancel" }))
      .status,
  ).toBe(200);
});
const setup = (actor: Actor = ownerActor) => {
  const store = new LocalStore(":memory:");
  stores.push(store);
  return { store, app: createV1Api(store, {}, "local", actor) };
};
const send = (
  app: ReturnType<typeof createV1Api>,
  path: string,
  body: unknown,
  method = "POST",
  key = crypto.randomUUID(),
) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
afterEach(() => {
  stores.forEach((s) => s.db.close());
  stores.length = 0;
  vi.unstubAllGlobals();
});
it("creates once, replays writes and rejects changed arguments for a key", async () => {
  const { store, app } = setup(),
    key = crypto.randomUUID();
  const first = await send(app, "/companies", { name: "Example" }, "POST", key);
  expect(first.status).toBe(201);
  const original = await first.json(),
    replay = await send(app, "/companies", { name: "Example" }, "POST", key);
  expect(await replay.json()).toEqual(original);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(
    (await send(app, "/companies", { name: "Changed" }, "POST", key)).status,
  ).toBe(409);
  expect(await store.list("company")).toHaveLength(1);
  expect(await store.list("audit")).toHaveLength(1);
  expect(
    (
      await app.request("/companies", {
        method: "POST",
        body: '{"name":"No key"}',
        headers: { "Content-Type": "application/json" },
      })
    ).status,
  ).toBe(400);
});
it("enforces scope boundaries and credential expiry/revocation without leaking secrets", async () => {
  const { store, app } = setup();
  const made = await send(app, "/integrations", {
    name: "MCP",
    channel: "mcp",
    scopes: ["read", "research:write"],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const token = await made.json();
  expect(token.token).toMatch(/^smt_/);
  const actor = (await authenticateIntegration(store, token.token))!;
  expect(actor.channel).toBe("mcp");
  const api = createV1Api(store, {}, "local", actor),
    company = await (await send(api, "/companies", { name: "Private" })).json();
  expect(
    (
      await send(
        api,
        `/companies/${company.id}`,
        { version: 1, patch: { cadence: "paused" } },
        "PATCH",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await send(
        api,
        `/companies/${company.id}`,
        { version: 1, data: company.data },
        "PUT",
      )
    ).status,
  ).toBe(403);
  expect((await send(api, "/jobs", { type: "monitor" })).status).toBe(403);
  expect((await api.request("/integrations")).status).toBe(403);
  expect((await api.request("/export")).status).toBe(403);
  expect((await api.request("/scheduled")).status).toBe(403);
  const listing = JSON.stringify(
    await (await app.request("/integrations")).json(),
  );
  expect(listing).not.toContain(token.token);
  expect(listing).not.toContain('"hash"');
  await send(app, `/integrations/${token.id}/revoke`, {});
  expect(await authenticateIntegration(store, token.token)).toBeNull();
});
it("appends notes with versions and preserves unrelated fields and revision history", async () => {
  const { store, app } = setup(),
    c = newCompany("Acme");
  c.notes = "Original";
  await store.put("company", c.id, c, 0);
  const response = await send(app, `/companies/${c.id}/notes`, {
    version: 1,
    text: "Added from MCP",
  });
  expect(response.status).toBe(200);
  const doc = await response.json();
  expect(doc.data.notes).toBe("Original\n\nAdded from MCP");
  expect(doc.data.feeds).toEqual(c.feeds);
  expect(
    (await send(app, `/companies/${c.id}/notes`, { version: 1, text: "Stale" }))
      .status,
  ).toBe(409);
  expect(await store.list("revision")).toHaveLength(1);
  const read = await (await app.request("/companies?limit=1")).json();
  expect(read.items[0].notes).toBeUndefined();
  expect(read.items[0].url).toContain("#company=");
});
it("applies development feedback atomically and rejects stale coverage", async () => {
  const { store, app } = setup(),
    events = reviewFixture(2).events;
  for (const e of events)
    await store.put(
      "event",
      e.id,
      { ...e.data, companyId: "same", clusterId: "same" },
      0,
    );
  const detail = await (
    await app.request(`/developments/${events[0].id}`)
  ).json();
  const response = await send(
    app,
    `/developments/${events[0].id}`,
    { versions: detail.versions, patch: { saved: true, feedback: "noise" } },
    "PATCH",
  );
  expect(response.status).toBe(200);
  expect(
    (await store.list<any>("event")).every(
      (d) => d.data.saved && d.data.feedback === "noise",
    ),
  ).toBe(true);
  expect(
    (
      await send(
        app,
        `/developments/${events[0].id}`,
        { versions: detail.versions, patch: { saved: false } },
        "PATCH",
      )
    ).status,
  ).toBe(409);
  await expect(
    store.batch([
      { kind: "event", id: events[0].id, expected: 2, data: { broken: true } },
      { kind: "event", id: events[1].id, expected: 1, data: { broken: true } },
    ]),
  ).rejects.toThrow();
  expect((await store.get<any>("event", events[0].id))!.data.saved).toBe(true);
});
it("queues jobs without model calls and preserves pause and cancellation", async () => {
  const { store, app } = setup(),
    c = newCompany("Acme");
  c.feeds = [];
  await store.put("company", c.id, c, 0);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const response = await send(app, "/jobs", {
    type: "analyze",
    companyId: c.id,
    article: { title: "Test", text: "Test" },
  });
  expect(response.status).toBe(202);
  const job = await response.json();
  expect(job.status).toBe("queued");
  expect(fetcher).not.toHaveBeenCalled();
  await send(app, `/jobs/${job.id}/control`, { action: "pause" });
  await send(app, `/jobs/${job.id}/advance`, {});
  expect((await (await app.request(`/jobs/${job.id}`)).json()).status).toBe(
    "paused",
  );
  expect(fetcher).not.toHaveBeenCalled();
  await send(app, `/jobs/${job.id}/control`, { action: "cancel" });
  expect((await (await app.request(`/jobs/${job.id}`)).json()).status).toBe(
    "cancelled",
  );
  const news = await (
    await send(app, "/jobs", { type: "news", companyIds: [c.id] })
  ).json();
  await send(app, `/jobs/${news.id}/control`, { action: "cancel" });
  await send(app, "/jobs", { type: "news", companyIds: [c.id] });
  expect((await (await app.request(`/jobs/${news.id}`)).json()).status).toBe(
    "cancelled",
  );
});
it("reports incremental changes and makes uncertain client writes inspectable", async () => {
  const { store, app } = setup(),
    c = newCompany("Acme");
  await store.put("company", c.id, c, 0);
  const changes = await (
    await app.request("/changes?since=2000-01-01T00:00:00Z")
  ).json();
  expect(changes.items).toHaveLength(1);
  expect(changes.items[0].data).toBeUndefined();
  const client = new DeskClient(
    "https://example.com/v1",
    () => "",
    async () => {
      throw Error("offline");
    },
  );
  try {
    await client.request("POST", "/companies", {
      body: { name: "Test" },
      key: "retained-key",
    });
    throw Error("Expected error");
  } catch (e) {
    expect(e).toBeInstanceOf(DeskError);
    expect((e as DeskError).requestKey).toBe("retained-key");
  }
});
