import { Hono } from "hono";
import { createApi } from "../_shared/api.ts";
import { createV1Api } from "../_shared/api-v1.ts";
import {
  authenticateIntegration,
  type Actor,
} from "../_shared/integrations.ts";
import { createClient, SupabaseStore } from "../_shared/supabase-store.ts";
import { createRemoteMcp } from "./mcp.ts";
const env = Deno.env.toObject();
const admin = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const app = new Hono();
const remoteMcp = createRemoteMcp((request) => app.fetch(request));
app.all("*", async (c) => {
  // Remote MCP for URL-only connectors: /k/<integration token>/mcp, or /mcp
  // with a Bearer token. Called server to server, so no Origin/CORS handling.
  const remote = /^\/(?:k\/([^/]+)\/)?mcp\/?$/.exec(
    new URL(c.req.url).pathname.replace(/^\/(?:functions\/v1\/)?desk/, "") ||
      "/",
  );
  if (remote) {
    const token = remote[1]
      ? decodeURIComponent(remote[1])
      : c.req.header("authorization")?.replace(/^Bearer /i, "") || "";
    const actor =
      token.startsWith("smt_") && env.MONITOR_OWNER_ID
        ? await authenticateIntegration(
            new SupabaseStore(admin, env.MONITOR_OWNER_ID),
            token,
          )
        : null;
    if (!actor)
      return c.json(
        {
          error: "Integration expired, revoked or invalid.",
          code: "unauthorized",
        },
        401,
        { "Cache-Control": "no-store" },
      );
    return remoteMcp(c.req.raw, token);
  }
  const origin = c.req.header("origin");
  const allowed = (env.APP_ORIGIN || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (origin && !allowed.includes(origin))
    return c.json({ error: "Origin is not allowed." }, 403);
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set(
      "Access-Control-Allow-Headers",
      "authorization,content-type,apikey,idempotency-key",
    );
    headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS");
  }
  // Include CORS on early authentication failures, so the website can report them.
  for (const [key, value] of headers) c.header(key, value);
  if (c.req.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  const path =
    new URL(c.req.url).pathname.replace(/^\/(?:functions\/v1\/)?desk/, "") ||
    "/";
  let owner = "";
  let actor: Actor | undefined;
  if (path === "/scheduled") {
    // This endpoint is only available to the configured scheduler, never to a browser session.
    if (
      !env.CRON_SECRET ||
      c.req.header("authorization") !== `Bearer ${env.CRON_SECRET}` ||
      c.req.method !== "POST"
    )
      return c.json({ error: "Unauthorized scheduler." }, 401);
    owner = env.MONITOR_OWNER_ID || "";
  } else {
    const token = c.req.header("authorization")?.replace(/^Bearer /i, "");
    if (!token) return c.json({ error: "Sign in required." }, 401);
    if (token.startsWith("smt_")) {
      if (!path.startsWith("/v1/") || !env.MONITOR_OWNER_ID)
        return c.json(
          { error: "Integration credentials require the v1 API." },
          403,
        );
      owner = env.MONITOR_OWNER_ID;
      actor =
        (await authenticateIntegration(
          new SupabaseStore(admin, owner),
          token,
        )) || undefined;
      if (!actor)
        return c.json(
          {
            error: "Integration expired, revoked or invalid.",
            code: "unauthorized",
          },
          401,
        );
    } else {
      const { data, error } = await admin.auth.getUser(token);
      if (
        error ||
        !data.user ||
        !env.OWNER_EMAIL ||
        data.user.email?.toLowerCase() !== env.OWNER_EMAIL.toLowerCase() ||
        !data.user.email_confirmed_at
      )
        return c.json({ error: "This desk is private." }, 403);
      owner = data.user.id;
    }
  }
  if (!owner)
    return c.json({ error: "Monitoring owner is not configured." }, 503);
  const url = new URL(c.req.url);
  const versioned = path.startsWith("/v1/");
  url.pathname = versioned ? path.slice(3) : path;
  const store = new SupabaseStore(admin, owner);
  const response = await (
    versioned
      ? createV1Api(store, env, "cloud", actor)
      : createApi(store, env, "cloud")
  ).fetch(new Request(url, c.req.raw));
  for (const [key, value] of headers) response.headers.set(key, value);
  return response;
});
Deno.serve(app.fetch);
