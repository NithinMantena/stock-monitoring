import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { createApi } from "../supabase/functions/_shared/api.ts";
import { createV1Api } from "../supabase/functions/_shared/api-v1.ts";
import { authenticateIntegration } from "../supabase/functions/_shared/integrations.ts";
import { LocalStore } from "./store.ts";
import { advanceJob } from "../supabase/functions/_shared/job-queue.ts";
if (existsSync(".env")) process.loadEnvFile(".env");
const store = new LocalStore();
// Work is explicitly enqueued by a client; the local worker survives closing the browser.
let working = false;
setInterval(async () => {
  if (working) return;
  working = true;
  try {
    await advanceJob(store, process.env);
  } catch {
    console.warn(
      "Background worker tick failed; persisted job status is available in Settings.",
    );
  } finally {
    working = false;
  }
}, 3000).unref();
const app = new Hono();
app.use("*", async (c, next) => {
  const host = c.req.header("host") || "";
  const origin = c.req.header("origin");
  if (
    ![
      "127.0.0.1:8787",
      "localhost:8787",
      "127.0.0.1:5173",
      "localhost:5173",
    ].includes(host) ||
    (origin &&
      ![
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8787",
        "http://localhost:8787",
      ].includes(origin))
  )
    return c.json({ error: "Local access only." }, 403);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  await next();
});
app.all("/api/v1/*", async (c) => {
  const token = c.req.header("authorization")?.replace(/^Bearer /i, "");
  const actor = token ? await authenticateIntegration(store, token) : undefined;
  if (token && !actor)
    return c.json(
      { error: "Invalid integration credential.", code: "unauthorized" },
      401,
    );
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/api\/v1/, "") || "/";
  return createV1Api(store, process.env, "local", actor || undefined).fetch(
    new Request(url, c.req.raw),
  );
});
app.route("/api", createApi(store, process.env, "local"));
app.use("*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 8787 }, () =>
  console.log(
    "Research Desk API: http://127.0.0.1:8787 (local storage; hosted scheduling is separate)",
  ),
);
