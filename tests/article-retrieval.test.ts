import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({ resolve4: vi.fn(), resolve6: vi.fn() }));
import { resolve4, resolve6 } from "node:dns/promises";
import {
  fetchDocument,
  publicAddress,
} from "../supabase/functions/_shared/article-content.ts";
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("reads a public publisher outside the old host list and checks its redirect", async () => {
  vi.mocked(resolve4).mockResolvedValue(["93.184.215.14"] as never);
  vi.mocked(resolve6).mockResolvedValue([] as never);
  const fetcher = vi.fn(async (url: string) =>
    url.includes("www.publisher.com")
      ? new Response("Available text")
      : new Response(null, {
          status: 302,
          headers: { location: "https://www.publisher.com/article" },
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  const doc = await fetchDocument(
    "https://publisher.com/article",
    new Set(),
    {},
  );
  expect(doc.url).toBe("https://www.publisher.com/article");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(resolve4).toHaveBeenCalledWith("www.publisher.com");
});

it("rejects a public-looking name resolving to private networks before fetching", async () => {
  vi.mocked(resolve4).mockResolvedValue(["93.184.215.14", "10.0.0.1"] as never);
  vi.mocked(resolve6).mockResolvedValue([] as never);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    fetchDocument("https://publisher.com/article", new Set(), {}),
  ).rejects.toThrow("public Internet");
  expect(fetcher).not.toHaveBeenCalled();
  for (const ip of [
    "127.0.0.1",
    "10.1.1.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.2.2",
    "192.168.0.1",
    "198.18.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    expect(publicAddress(ip), ip).toBe(false);
});

it("rejects a private redirect after a public response and preserves strict mode", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    fetchDocument(
      "https://publisher.com/article",
      new Set(["publisher.com"]),
      {},
    ),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(
    fetchDocument("https://another.com/article", new Set(), {
      ALLOW_PUBLIC_ARTICLE_HOSTS: "false",
    }),
  ).rejects.toThrow("not enabled");
});
