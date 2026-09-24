import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../server/store.ts";
import { createApi } from "../supabase/functions/_shared/api.ts";
import {
  newCompany,
  type DeskEvent,
} from "../supabase/functions/_shared/model.ts";
import { sendRunEmail } from "../supabase/functions/_shared/jobs.ts";

const stores: LocalStore[] = [];
const store = () => {
  const s = new LocalStore(":memory:");
  stores.push(s);
  return s;
};
afterEach(() => {
  vi.unstubAllGlobals();
  stores.forEach((s) => s.db.close());
  stores.length = 0;
});
const emailEnv = {
  RESEND_API_KEY: "test",
  DIGEST_FROM: "desk@example.com",
  ENABLE_EMAIL_DELIVERY: "true",
};
const news = (id: string, companyId: string, discoveredAt: string): DeskEvent => ({
  id,
  companyId,
  kind: "news",
  title: `Development ${id}`,
  body: "Details.",
  url: `https://example.com/${id}`,
  publishedAt: discoveredAt,
  discoveredAt,
  reviewed: false,
  priority: "normal",
  feedback: "useful",
});

describe("custom manual screen scope", () => {
  it("starts a manual screen with the chosen days and articles per day", async () => {
    const s = store(),
      c = newCompany("Acme");
    await s.put("company", c.id, c, 0);
    const response = await createApi(s, {}, "local").request("/news/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        label: "Acme · last 3 days · 5/day",
        companyIds: [c.id],
        lookbackDays: 3,
        articleLimit: 5,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      lookbackDays: 3,
      articleLimit: 5,
      totalCompanies: 1,
    });
  });
  it("rejects a scope outside the allowed range", async () => {
    const s = store(),
      c = newCompany("Acme");
    await s.put("company", c.id, c, 0);
    const response = await createApi(s, {}, "local").request("/news/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        label: "Too big",
        companyIds: [c.id],
        lookbackDays: 90,
      }),
    });
    expect(response.status).toBe(400);
  });
});

describe("email the latest screen", () => {
  it("emails only developments found during the run", async () => {
    const s = store(),
      c = newCompany("Acme");
    await s.put("company", c.id, c, 0);
    await s.put("event", "inside", news("inside", c.id, "2026-09-23T10:05:00Z"), 0);
    await s.put("event", "before", news("before", c.id, "2026-09-22T10:00:00Z"), 0);
    const sent: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        sent.push({ body: JSON.parse(init.body), headers: init.headers });
        return new Response(JSON.stringify({ id: "email-1" }));
      }),
    );
    const result = await sendRunEmail(
      s,
      emailEnv,
      {
        id: "run-1",
        label: "Daily companies · last 1 day",
        status: "completed",
        createdAt: "2026-09-23T10:00:00Z",
        finishedAt: "2026-09-23T10:30:00Z",
      },
      new Date("2026-09-23T11:00:00Z"),
    );
    expect(result).toMatchObject({ sent: true, developments: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].body.subject).toContain("Daily companies · last 1 day");
    expect(sent[0].body.text).toContain("Development inside");
    expect(sent[0].body.text).not.toContain("Development before");
  });
  it("refuses when email delivery is not configured", async () => {
    await expect(
      sendRunEmail(store(), {}, {
        id: "run-1",
        label: "Run",
        status: "completed",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("not configured");
  });
  it("reports when no screen has run today", async () => {
    const response = await createApi(store(), emailEnv, "local").request(
      "/digest/latest-run",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(response.status).toBe(404);
  });
});

describe("essential export for off-site backups", () => {
  it("keeps research and acted-on articles, without stored text or model internals", async () => {
    const s = store(),
      c = newCompany("Acme");
    await s.put("company", c.id, c, 0);
    const acted = {
      ...news("acted", c.id, "2026-09-23T10:00:00Z"),
      rawText: "Full article text",
      screening: {
        version: "fundamental-v3",
        at: "2026-09-23T10:00:00Z",
        disposition: "relevant",
        reason: "news_report",
        category: "earnings",
        identity: 0.95,
        materiality: 3,
        quality: 2,
        addedValue: 2,
        evidenceSufficiency: 0.9,
        primary: false,
        contentDepth: "snippet",
        charactersRead: 0,
        availableCharacters: 0,
        retrievalNote: "",
        possibleMajor: false,
        sourceUrl: "https://example.com/acted",
        comparisons: [{ id: "other", relation: "same", probability: 0.9 }],
        rawAnswers: { a: 1 },
        probabilities: { a: 0.5 },
      } as any,
    };
    await s.put("event", "acted", acted, 0);
    await s.put(
      "event",
      "ignored",
      { ...news("ignored", c.id, "2026-09-23T10:00:00Z"), feedback: undefined },
      0,
    );
    const app = createApi(s, {}, "local");
    const backup = await (await app.request("/export?scope=essential")).json();
    const events = backup.records.filter((r: any) => r.kind === "event");
    expect(backup.records.some((r: any) => r.kind === "company")).toBe(true);
    expect(events.map((r: any) => r.id)).toEqual(["acted"]);
    expect(events[0].data.rawText).toBeUndefined();
    expect(events[0].data.screening.reason).toBe("news_report");
    expect(events[0].data.screening.rawAnswers).toBeUndefined();
    expect(events[0].data.screening.probabilities).toBeUndefined();
    expect(events[0].data.screening.comparisons).toBeUndefined();
    const restore = await app.request("/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(backup),
    });
    expect(restore.status, await restore.clone().text()).toBe(200);
  });
});
