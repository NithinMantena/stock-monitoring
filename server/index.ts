import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { createApi } from "../supabase/functions/_shared/api.ts";
import { LocalStore } from "./store.ts";
if (existsSync(".env")) process.loadEnvFile(".env");
const store = new LocalStore();
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
app.route("/api", createApi(store, process.env, "local"));
app.use("*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 8787 }, () =>
  console.log(
    "Research Desk API: http://127.0.0.1:8787 (local storage; hosted scheduling is separate)",
  ),
);
