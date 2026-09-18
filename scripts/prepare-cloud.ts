import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
const keys = JSON.parse(
  readFileSync(".local/supabase-keys.json", "utf8").replace(/^\uFEFF/, ""),
);
const service = keys.find((k: any) => k.name === "service_role")?.api_key;
const anon = keys.find((k: any) => k.name === "anon")?.api_key;
if (!service || !anon)
  throw new Error(
    "Legacy service-role and public anon keys were not returned.",
  );
const url = "https://tcfricxifanwwzgxgexj.supabase.co";
const admin = createClient(url, service, { auth: { persistSession: false } });
const { data: users, error: listError } = await admin.auth.admin.listUsers();
if (listError) throw new Error("Account lookup failed.");
let owner = users.users.find((u) => u.email === "nithin@mantena.com");
if (!owner) {
  const { data, error } = await admin.auth.admin.createUser({
    email: "nithin@mantena.com",
    email_confirm: true,
    user_metadata: { name: "Nithin", application: "Research Desk" },
  });
  if (error) throw new Error("Private app account could not be created.");
  owner = data.user;
}
const existing = existsSync(".local/cloud-setup.json")
  ? JSON.parse(readFileSync(".local/cloud-setup.json", "utf8"))
  : {};
const setup = {
  ...existing,
  owner: owner.id,
  url,
  cronSecret: existing.cronSecret || randomBytes(40).toString("base64url"),
};
writeFileSync(".local/cloud-setup.json", JSON.stringify(setup, null, 2));
writeFileSync(
  ".env.production.local",
  `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anon}\nVITE_API_URL=${url}/functions/v1/desk\n`,
);
const secrets: Record<string, string> = {
  OWNER_EMAIL: "nithin@mantena.com",
  MONITOR_OWNER_ID: owner.id,
  CRON_SECRET: setup.cronSecret,
  APP_ORIGIN: "http://127.0.0.1:5173,http://127.0.0.1:8787",
  TYPESAFE_MODEL: "jev-1.13.0",
  TYPESAFE_MONTHLY_BUDGET_USD: "2",
  ENABLE_EMAIL_DELIVERY: "false",
  DIGEST_TO: "nithin@mantena.com",
  ALLOWED_FEED_HOSTS:
    "news.google.com,www.sec.gov,investors.progressive.com,investors.molinahealthcare.com",
};
if (process.env.TYPESAFE_API_KEY)
  secrets.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;
writeFileSync(
  ".local/edge-secrets.env",
  Object.entries(secrets)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n",
);
console.log(
  JSON.stringify({
    accountReady: true,
    ownerId: owner.id,
    typesafeConfigured: !!secrets.TYPESAFE_API_KEY,
    publicBuildConfigured: true,
    emailSent: false,
  }),
);
