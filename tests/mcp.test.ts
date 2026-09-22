import { afterAll, beforeAll, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { LocalStore } from "../server/store.ts";
import { createV1Api } from "../supabase/functions/_shared/api-v1.ts";
import { scopes } from "../supabase/functions/_shared/integrations.ts";
import { operations } from "../client/operations.ts";
import type { AddressInfo } from "node:net";
const store = new LocalStore(":memory:");
let server: ReturnType<typeof serve>, client: Client, base: string;
beforeAll(async () => {
  const ready = new Promise<void>((resolve) => {
    server = serve(
      {
        fetch: createV1Api(store, {}, "local", {
          id: "test-mcp",
          channel: "mcp",
          admin: false,
          scopes,
        }).fetch,
        hostname: "127.0.0.1",
        port: 0,
      },
      () => resolve(),
    );
  });
  await ready;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new Client({ name: "stock-integration-tests", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../mcp/index.ts", import.meta.url))],
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      STOCK_DESK_URL: base,
      STOCK_DESK_TOKEN: "test-only",
    },
  });
  await client.connect(transport);
}, 20000);
afterAll(async () => {
  await client?.close();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  store.db.close();
});
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name: `stocks_${name}`, arguments: args });
  let data: any = r.structuredContent;
  if (!data) {
    const text = (r.content as { text: string }[])[0].text;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  return { result: r, data };
};
it("discovers typed tools through a real stdio protocol connection", async () => {
  const tools = await client.listTools();
  expect(tools.tools).toHaveLength(operations.length);
  expect(
    tools.tools.find((t) => t.name === "stocks_get_company")?.annotations
      ?.readOnlyHint,
  ).toBe(true);
  expect(
    tools.tools.find((t) => t.name === "stocks_start_news_search")?.annotations
      ?.readOnlyHint,
  ).toBe(false);
});
it("writes through MCP, reads through the website API and returns version conflicts", async () => {
  const created = await call("add_company", {
    name: "MCP cross-channel fixture",
    requestKey: "create-fixture",
  });
  expect(created.result.isError).not.toBe(true);
  const replay = await call("add_company", {
    name: "MCP cross-channel fixture",
    requestKey: "create-fixture",
  });
  expect(replay.data.id).toBe(created.data.id);
  const id = created.data.id;
  const added = await call("append_note", {
    id,
    version: 1,
    text: "A persisted note.",
  });
  expect(added.result.isError).not.toBe(true);
  const web = await (await fetch(`${base}/companies/${id}`)).json();
  expect(web.data.notes).toBe("A persisted note.");
  const conflict = await call("append_note", {
    id,
    version: 1,
    text: "Stale edit",
  });
  expect(conflict.result.isError).toBe(true);
  expect(conflict.data.error.code).toBe("version_conflict");
  const watch = await call("set_watch_point", {
    id,
    version: web.version,
    action: "upsert",
    itemId: "watch-1",
    value: { text: "Margin deterioration", enabled: true },
  });
  expect(watch.result.isError).not.toBe(true);
  expect(await store.list("company")).toHaveLength(1);
  expect(
    (await store.list<any>("audit")).every((d) => d.data.channel === "mcp"),
  ).toBe(true);
});
it("rejects invalid arguments before writing and can queue/pause/cancel work", async () => {
  const before = (await store.list("company")).length;
  const invalid = await call("add_company", { name: "" });
  expect(invalid.result.isError).toBe(true);
  expect((await store.list("company")).length).toBe(before);
  const created = await call("analyze_article", {
    companyId: (await store.list("company"))[0].id,
    article: { title: "Synthetic", text: "Synthetic fixture." },
  });
  expect(created.data.status).toBe("queued");
  expect(
    (await call("control_job", { id: created.data.id, action: "pause" })).data
      .status,
  ).toBe("paused");
  expect(
    (await call("control_job", { id: created.data.id, action: "cancel" })).data
      .status,
  ).toBe("cancelled");
  expect((await call("get_job", { id: created.data.id })).data.status).toBe(
    "cancelled",
  );
});
