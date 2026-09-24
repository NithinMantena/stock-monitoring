import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../server/store.ts";
import {
  newCompany,
  type Company,
  type DeskEvent,
  type Store,
} from "../supabase/functions/_shared/model.ts";
import type { NewsBatch } from "../supabase/functions/_shared/news-batch.ts";
import {
  tick,
  type ScheduleState,
} from "../supabase/functions/_shared/scheduler.ts";
import { SCREENING_VERSION } from "../supabase/functions/_shared/screening-policy.ts";
import { assessment, modelResponse } from "./screening-fixtures.ts";

const stores: LocalStore[] = [];
afterEach(() => {
  for (const s of stores) s.db.close();
  stores.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
// Chicago is UTC-5 in late September. 2026-09-22 is a Tuesday.
const TUE_2PM = "2026-09-22T19:00:00Z";
const WED_1AM = "2026-09-23T06:05:00Z";
const FRI_6PM = "2026-09-25T23:05:00Z"; // Friday 6:05pm Chicago.
const SAT_1AM = "2026-09-26T06:05:00Z";
const env = { ALLOW_PUBLIC_ARTICLE_HOSTS: "false" };

async function desk() {
  const s = new LocalStore(":memory:");
  stores.push(s);
  const make = async (
    name: string,
    status: Company["status"],
    cadence: Company["cadence"] = "auto",
  ) => {
    const c = { ...newCompany(name, status), cadence };
    c.lastNewsCheck = "2026-01-01T00:00:00Z";
    await s.put("company", c.id, c, 0);
    return c;
  };
  return {
    s,
    daily: [await make("Owned Co", "owned"), await make("Perpetual Co", "perpetual")],
    weekly: [await make("Beta Watch", "watchlist"), await make("Alpha Watch", "watchlist")],
    paused: await make("Paused Co", "watchlist", "paused"),
  };
}
// Google News search results: one dated article per company search.
function stubGoogle(at: string) {
  const fetcher = vi.fn(async (url: string) => {
    const q = new URL(url).searchParams.get("q") || "";
    const name = q.match(/"([^"]+)"/)?.[1] || "Company";
    return new Response(
      `<rss><channel><item><guid>${name}</guid><title>${name} reports results</title><link>https://example.com/${encodeURIComponent(name)}</link><pubDate>${new Date(Date.parse(at) - 3600000).toUTCString()}</pubDate></item></channel></rss>`,
    );
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function tickAt(s: Store, iso: string, extra: Record<string, string> = {}) {
  vi.setSystemTime(Date.parse(iso));
  return tick(s, { ...env, ...extra }, { now: new Date(iso), milliseconds: 60000 });
}
async function runUntilIdle(s: Store, iso: string) {
  for (let i = 0; i < 20; i++) {
    await tickAt(s, new Date(Date.parse(iso) + i * 60000).toISOString());
    const run = await s.get<NewsBatch>("news_batch", "scheduled");
    if (run?.data.status !== "running") return run?.data;
  }
  throw new Error("Scheduled run did not finish.");
}
const state = async (s: Store) =>
  (await s.get<ScheduleState>("run", "schedule"))!.data;

describe("nightly news schedule", () => {
  it("starts nothing at installation, then runs daily companies at 1am over the last day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { s, daily, weekly } = await desk();
    const fetcher = stubGoogle(TUE_2PM);
    await tickAt(s, TUE_2PM);
    expect(await s.get("news_batch", "scheduled")).toBeNull();
    expect(fetcher.mock.calls.some(([u]) => String(u).includes("news.google.com"))).toBe(false);

    stubGoogle(WED_1AM);
    const run = (await runUntilIdle(s, WED_1AM))!;
    expect(run).toMatchObject({ schedule: "daily", status: "completed", added: 2 });
    expect(run.companyIds).toEqual(daily.map((c) => c.id));
    // The last day plus a two-hour overlap.
    expect(Date.parse(WED_1AM) - Date.parse(run.since!)).toBe(26 * 3600000);
    for (const c of daily)
      expect((await s.get<Company>("company", c.id))!.data.lastNewsCheck).not.toBe(
        "2026-01-01T00:00:00Z",
      );
    for (const c of weekly)
      expect((await s.get<Company>("company", c.id))!.data.lastNewsCheck).toBe(
        "2026-01-01T00:00:00Z",
      );
    expect((await state(s)).history[0]).toMatchObject({
      schedule: "daily",
      status: "completed",
      companies: 2,
    });
    // Once per night: later ticks the same day start nothing new.
    const before = run.id;
    await tickAt(s, "2026-09-23T15:00:00Z");
    expect((await s.get<NewsBatch>("news_batch", "scheduled"))!.data.id).toBe(before);
  });

  it("sweeps every non-paused company Friday evening, daily companies first, and skips Saturday's daily run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { s, daily, weekly, paused } = await desk();
    stubGoogle(TUE_2PM);
    await tickAt(s, TUE_2PM);
    stubGoogle(FRI_6PM);
    const run = (await runUntilIdle(s, FRI_6PM))!;
    expect(run).toMatchObject({ schedule: "weekly", status: "completed", added: 4 });
    expect(run.companyIds).toEqual([
      ...daily.map((c) => c.id).sort((a, b) =>
        daily.find((c) => c.id === a)!.name.localeCompare(daily.find((c) => c.id === b)!.name),
      ),
      weekly[1].id, // Alpha Watch
      weekly[0].id, // Beta Watch
    ]);
    expect(run.companyIds).not.toContain(paused.id);
    expect(Date.parse(FRI_6PM) - Date.parse(run.since!)).toBe(7 * 86400000);

    await tickAt(s, SAT_1AM);
    expect((await s.get<NewsBatch>("news_batch", "scheduled"))!.data.id).toBe(run.id);
    expect((await state(s)).dailyRunDate).toBe("2026-09-26");
  });

  it("keeps an idle minute to a few small reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { s } = await desk();
    stubGoogle(TUE_2PM);
    await tickAt(s, TUE_2PM); // Installs state; nightly chores run once.
    let bytes = 0,
      calls = 0;
    const counted = new Proxy(s, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          const out = await value.apply(target, args);
          calls++;
          bytes += JSON.stringify(out ?? null).length;
          return out;
        };
      },
    });
    vi.setSystemTime(Date.parse("2026-09-22T19:30:00Z"));
    await tick(counted, env, { now: new Date("2026-09-22T19:30:00Z") });
    expect(calls).toBeLessThanOrEqual(8);
    expect(bytes).toBeLessThan(3000);
  });

  it("checks closing prices once per night without searching news", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { s, daily } = await desk();
    const fetcher = stubGoogle(TUE_2PM);
    await tickAt(s, TUE_2PM);
    expect((await state(s)).quotesDate).toBe("2026-09-22");
    expect(fetcher).not.toHaveBeenCalled();
    const c = (await s.get<Company>("company", daily[0].id))!.data;
    expect(c.lastQuoteCheck).not.toBe("");
    expect(c.lastNewsCheck).toBe("2026-01-01T00:00:00Z");
  });

  it("re-screens from stored data without contacting Google", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { s, daily } = await desk();
    const fetcher = vi.fn(async (url: string, init?: any) =>
      String(url).includes("api.typesafe.ai")
        ? new Response(JSON.stringify(modelResponse({}, JSON.parse(init.body))))
        : new Response("busy", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const e: DeskEvent = {
      id: `news-${daily[0].id}-old`,
      companyId: daily[0].id,
      kind: "news",
      title: "Old item",
      body: "",
      url: "https://news.google.com/rss/articles/CBMiXYZ",
      publishedAt: "2026-09-20T00:00:00Z",
      discoveredAt: "2026-09-20T00:00:00Z",
      reviewed: false,
      priority: "possible",
      screening: { ...assessment({ contentDepth: "snippet" }), version: "retired-version" },
    };
    await s.put("event", e.id, e, 0);
    await tickAt(s, TUE_2PM, { TYPESAFE_API_KEY: "test" });
    expect(
      fetcher.mock.calls.filter((c) => String(c[0]).includes("google.com")),
    ).toHaveLength(0);
    const after = (await s.get<DeskEvent>("event", e.id))!.data.screening!;
    expect(after.version).toBe("fundamental-v3");
    expect(after.retrievalNote).toContain("not fetched again");
  });
  it("queues re-screens once per night and works through the queue", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { s, daily } = await desk();
    stubGoogle(TUE_2PM);
    for (let i = 0; i < 14; i++) {
      const e: DeskEvent = {
        id: `news-${daily[0].id}-old${i}`,
        companyId: daily[0].id,
        kind: "news",
        title: `Old item ${i}`,
        body: "",
        url: "",
        publishedAt: "2026-09-20T00:00:00Z",
        discoveredAt: `2026-09-20T00:00:${String(i).padStart(2, "0")}Z`,
        reviewed: false,
        priority: "possible",
        screening: { ...assessment(), version: "retired-version" },
      };
      await s.put("event", e.id, e, 0);
    }
    await tickAt(s, TUE_2PM);
    expect((await state(s)).rescreenPending).toBe(4); // 10 re-screened this minute.
    await tickAt(s, "2026-09-22T19:01:00Z");
    expect((await state(s)).rescreenPending).toBe(0);
    const events = await s.list<DeskEvent>("event", { companyId: daily[0].id });
    expect(
      events.filter((d) => d.data.kind === "news").every(
        (d) => d.data.screening?.version === SCREENING_VERSION,
      ),
    ).toBe(true);
  });
});
