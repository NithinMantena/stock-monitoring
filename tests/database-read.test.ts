import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DatabaseReadError,
  readDatabase,
} from "../supabase/functions/_shared/database-read";
import { createApi } from "../supabase/functions/_shared/api";
import { LocalStore } from "../server/store";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("database read recovery", () => {
  it("recovers from a temporary connection failure without losing the result", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: "PGRST000", message: "private error details" },
        status: 503,
      })
      .mockResolvedValueOnce({
        data: [{ id: "retained" }],
        error: null,
        status: 200,
      });
    const result = readDatabase("list:company", query);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([{ id: "retained" }]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "private error details",
    );
  });

  it("does not retry permission errors or expose database details", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = vi
      .fn()
      .mockResolvedValue({
        data: null,
        error: { code: "42501", message: "private table" },
        status: 403,
      });
    await expect(readDatabase("get:settings", query)).rejects.toMatchObject({
      status: 500,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("bounds retries and reports temporary unavailability instead of empty records", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = vi
      .fn()
      .mockResolvedValue({ data: null, error: { code: "" }, status: 0 });
    const checked = expect(
      readDatabase("list:company", query),
    ).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await checked;
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("returns HTTP 503 for a failed startup read", async () => {
    const store = new LocalStore(":memory:");
    try {
      vi.spyOn(store, "list").mockRejectedValue(new DatabaseReadError(true));
      const response = await createApi(store, {}, "local").request(
        "/bootstrap",
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "The database is temporarily unavailable. Please try again.",
      });
    } finally {
      store.db.close();
    }
  });
});
