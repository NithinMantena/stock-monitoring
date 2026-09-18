import { Hono } from "hono";
import { createApi } from "../_shared/api.ts";
import { createClient, SupabaseStore } from "../_shared/supabase-store.ts";
const env = Deno.env.toObject();
const admin = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const app = new Hono();
app.all("*", async (c) => {
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
      "authorization,content-type,apikey",
    );
    headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  }
  if (c.req.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  const path =
    new URL(c.req.url).pathname.replace(/^\/(?:functions\/v1\/)?desk/, "") ||
    "/";
  let owner = "";
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
  if (!owner)
    return c.json({ error: "Monitoring owner is not configured." }, 503);
  const url = new URL(c.req.url);
  url.pathname = path;
  const response = await createApi(
    new SupabaseStore(admin, owner),
    env,
    "cloud",
  ).fetch(new Request(url, c.req.raw));
  for (const [key, value] of headers) response.headers.set(key, value);
  return response;
});
Deno.serve(app.fetch);
