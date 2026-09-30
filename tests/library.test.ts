import { afterEach, describe, expect, it } from "vitest";
import { LocalStore } from "../server/store.ts";
import { createV1Api } from "../supabase/functions/_shared/api-v1.ts";
import {
  newCompany,
  type Company,
  type DeskEvent,
} from "../supabase/functions/_shared/model.ts";
import {
  applySavePatch,
  companyMatchScore,
  emptyCriteria,
  eventLists,
  matchCriteria,
  tagCounts,
} from "../supabase/functions/_shared/library.ts";
import {
  batchSearchDays,
  searchWindow,
  selectBatchArticles,
  startNewsBatch,
  type NewsBatch,
} from "../supabase/functions/_shared/news-batch.ts";
import { validateRestoreRecords } from "../supabase/functions/_shared/restore.ts";

const stores: LocalStore[] = [];
afterEach(() => {
  stores.forEach((s) => s.db.close());
  stores.length = 0;
});
const setup = () => {
  const store = new LocalStore(":memory:");
  stores.push(store);
  return { store, app: createV1Api(store, {}, "local") };
};
const send = (
  app: ReturnType<typeof createV1Api>,
  path: string,
  body: unknown,
  method = "POST",
) =>
  app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
const news = (id: string, companyId: string, extra: Partial<DeskEvent> = {}): DeskEvent => ({
  id,
  companyId,
  kind: "news",
  title: `Story ${id}`,
  body: "",
  url: `https://example.com/${id}`,
  publishedAt: "2026-09-20T10:00:00Z",
  discoveredAt: "2026-09-20T10:00:00Z",
  reviewed: false,
  priority: "normal",
  ...extra,
});
const company = (name: string, patch: Partial<Company> = {}) => ({
  ...newCompany(name),
  ...patch,
});

describe("saved lists", () => {
  it("treats articles saved before lists as Review later", () => {
    expect(eventLists({ saved: true })).toEqual(["review-later"]);
    expect(eventLists({ saved: false })).toEqual([]);
    expect(eventLists({ saved: true, lists: ["favorites"] })).toEqual([
      "favorites",
    ]);
  });
  it("keeps saved equal to membership of at least one list", () => {
    expect(applySavePatch({ saved: false }, { saved: true })).toEqual({
      saved: true,
      lists: ["review-later"],
    });
    expect(
      applySavePatch({ saved: true, lists: ["favorites"] }, { saved: true }),
    ).toEqual({ saved: true, lists: ["favorites"] });
    expect(
      applySavePatch({ saved: true, lists: ["a", "b"] }, { saved: false }),
    ).toEqual({ saved: false, lists: [] });
    expect(
      applySavePatch({ saved: false }, { lists: ["a", "a", "b"] }),
    ).toEqual({ saved: true, lists: ["a", "b"] });
    expect(applySavePatch({ saved: true }, {})).toEqual({ saved: true });
  });
  it("saves a development into lists and unsaves when a list is deleted", async () => {
    const { store, app } = setup();
    const c = newCompany("Acme");
    await store.put("company", c.id, c, 0);
    await store.put("event", "a", news("a", c.id, { clusterId: "k" }), 0);
    await store.put("event", "b", news("b", c.id, { clusterId: "k" }), 0);
    await store.put("event", "old", news("old", c.id, { saved: true, reviewed: true }), 0);

    const boot = await (await app.request("/bootstrap?events=none")).json();
    expect(boot.library.lists.map((l: any) => l.id)).toEqual([
      "review-later",
      "favorites",
    ]);
    const lib = await send(
      app,
      "/library",
      {
        version: 0,
        data: {
          lists: [...boot.library.lists, { id: "great-reads", name: "Great reads" }],
          tags: [],
        },
      },
      "PUT",
    );
    expect(lib.status).toBe(200);
    const { version } = await lib.json();

    const detail = await (await app.request("/developments/a")).json();
    const saved = await send(
      app,
      "/developments/a",
      {
        versions: detail.versions,
        patch: { lists: ["favorites", "great-reads"], reviewed: true },
      },
      "PATCH",
    );
    expect(saved.status).toBe(200);
    for (const id of ["a", "b"]) {
      const e = (await store.get<DeskEvent>("event", id))!.data;
      expect(e.saved).toBe(true);
      expect(e.lists).toEqual(["favorites", "great-reads"]);
    }

    // Deleting Great reads keeps Favorites; deleting Review later unsaves the
    // legacy article whose only list it was.
    const deleted = await send(
      app,
      "/library",
      {
        version,
        data: { lists: [{ id: "favorites", name: "Favorites" }], tags: [] },
      },
      "PUT",
    );
    expect(deleted.status).toBe(200);
    expect((await store.get<DeskEvent>("event", "a"))!.data).toMatchObject({
      saved: true,
      lists: ["favorites"],
    });
    expect((await store.get<DeskEvent>("event", "old"))!.data).toMatchObject({
      saved: false,
      lists: [],
    });
    // A stale version is refused rather than overwriting another device.
    expect(
      (await send(app, "/library", { version, data: { lists: [], tags: [] } }, "PUT"))
        .status,
    ).toBe(409);
  });
  it("restores the library record with its own schema", () => {
    const [record] = validateRestoreRecords([
      {
        kind: "settings",
        id: "library",
        data: { lists: [{ id: "favorites", name: "Favorites" }], tags: ["Moats"] },
      },
    ]);
    expect(record.data).toEqual({
      lists: [{ id: "favorites", name: "Favorites" }],
      tags: ["Moats"],
    });
  });
});

describe("bulk tagging", () => {
  it("adds and removes one tag across companies without touching other tags", async () => {
    const { store, app } = setup();
    const a = company("Alpha", { tags: ["Moats"] }),
      b = company("Beta", { tags: ["serial acquirers", "Moats"] }),
      c = company("Gamma");
    for (const x of [a, b, c]) await store.put("company", x.id, x, 0);
    const response = await send(app, "/companies/tags", {
      tag: "  Serial   acquirers ",
      add: [a.id, c.id],
      remove: [b.id],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tag).toBe("Serial acquirers");
    expect(body.failed).toEqual([]);
    const tagsOf = async (id: string) =>
      (await store.get<Company>("company", id))!.data.tags;
    expect(await tagsOf(a.id)).toEqual(["Moats", "Serial acquirers"]);
    expect(await tagsOf(b.id)).toEqual(["Moats"]);
    expect(await tagsOf(c.id)).toEqual(["Serial acquirers"]);
    // Adding again is a no-op, not a duplicate.
    await send(app, "/companies/tags", { tag: "serial ACQUIRERS", add: [a.id] });
    expect(await tagsOf(a.id)).toEqual(["Moats", "Serial acquirers"]);
    expect((await store.get<Company>("company", a.id))!.data.revision).toBe(2);
  });
  it("reports companies it could not find", async () => {
    const { app } = setup();
    const body = await (
      await send(app, "/companies/tags", { tag: "x", add: ["missing"] })
    ).json();
    expect(body.failed).toEqual(["missing"]);
  });
  it("counts tags case-insensitively and includes created, unused tags", () => {
    const docs = [
      company("A", { tags: ["Moats", "moats "] }),
      company("B", { tags: ["MOATS"] }),
    ].map((data) => ({ id: data.id, kind: "company", version: 1, updatedAt: "", data }));
    expect(tagCounts(docs, { tags: ["Spin-offs", "moats"] })).toEqual([
      { tag: "Moats", count: 2 },
      { tag: "Spin-offs", count: 0 },
    ]);
  });
});

describe("company search matching", () => {
  it("ranks exact tickers and name prefixes first, then looser matches", () => {
    const score = (name: string, ticker: string, q: string) =>
      companyMatchScore({ name, ticker }, q);
    expect(score("Constellation Software", "CSU", "csu")).toBe(100);
    expect(score("Constellation Software", "CSU", "const")).toBeGreaterThan(
      score("Topicus.com", "TOI", "const") || 0,
    );
    expect(score("Constellation Software", "CSU", "software")).toBe(60);
    expect(score("Constellation Software", "CSU", "cnst sft")).toBe(10);
    expect(score("Constellation Software", "CSU", "xyz")).toBe(0);
  });
  it("selects custom-search companies by every filled-in category plus picks", () => {
    const mk = (name: string, patch: Partial<Company>) => {
      const data = company(name, patch);
      return { id: data.id, kind: "company", version: 1, updatedAt: "", data };
    };
    const docs = [
      mk("Alpha", { tags: ["Moats"], status: "watchlist" }),
      mk("Beta", { tags: ["Moats", "Spin-offs"], status: "owned" }),
      mk("Gamma", { tags: ["Spin-offs"], status: "watchlist" }),
      mk("Delta", { tags: ["Moats"], status: "watchlist", archived: true }),
    ];
    const size = () => "unknown";
    const names = (criteria: Partial<ReturnType<typeof emptyCriteria>>) =>
      matchCriteria(docs, { ...emptyCriteria(), ...criteria }, size).map(
        (d) => d.data.name,
      );
    expect(names({})).toEqual([]);
    expect(names({ tags: ["moats"] })).toEqual(["Alpha", "Beta"]);
    expect(names({ tags: ["Moats", "Spin-offs"], tagMode: "all" })).toEqual([
      "Beta",
    ]);
    expect(names({ tags: ["Moats"], statuses: ["watchlist"] })).toEqual([
      "Alpha",
    ]);
    expect(names({ companyIds: [docs[3].id] })).toEqual(["Delta"]);
    expect(
      names({ statuses: ["owned"], companyIds: [docs[2].id] }),
    ).toEqual(["Beta", "Gamma"]);
  });
});

describe("exact-date news searches", () => {
  it("searches each day of the window and keeps articles inside it", () => {
    const range = searchWindow("2026-09-01", "2026-09-03", new Date("2026-09-29"));
    expect(range).toEqual({ from: "2026-09-01", to: "2026-09-03", days: 3 });
    const batch = {
      from: range.from,
      to: range.to,
      lookbackDays: 3,
      articleLimit: 10,
      createdAt: "2026-09-29T00:00:00Z",
    } as NewsBatch;
    expect(batchSearchDays(batch)).toEqual([
      "2026-09-03",
      "2026-09-02",
      "2026-09-01",
    ]);
    const article = (id: string, publishedAt: string) =>
      ({ id, publishedAt, text: "", title: id, url: "" }) as any;
    expect(
      selectBatchArticles(
        [
          article("before", "2026-08-31T23:00:00Z"),
          article("first", "2026-09-01T00:00:00Z"),
          article("last", "2026-09-03T23:59:00Z"),
          article("after", "2026-09-04T00:00:00Z"),
        ],
        batch,
      ).map((a) => a.id),
    ).toEqual(["first", "last"]);
  });
  it("caps the end at today and rejects reversed or oversized windows", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    expect(searchWindow("2026-09-28", "2026-10-15", now).to).toBe("2026-09-29");
    expect(() => searchWindow("2026-09-10", "2026-09-01", now)).toThrow(
      /on or before/,
    );
    expect(() => searchWindow("2026-06-01", "2026-09-01", now)).toThrow(
      /at most 60/,
    );
  });
  it("starts a manual batch over an exact window", async () => {
    const { store } = setup();
    const c = newCompany("Acme");
    await store.put("company", c.id, c, 0);
    const batch = await startNewsBatch(store, {
      id: crypto.randomUUID(),
      label: "Acme · window",
      companyIds: [c.id],
      from: "2026-08-01",
      to: "2026-08-10",
    });
    expect(batch).toMatchObject({
      from: "2026-08-01",
      to: "2026-08-10",
      lookbackDays: 10,
    });
  });
});
