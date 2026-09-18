import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
const root = resolve(".local");
for (const name of [
  "supabase-keys.json",
  "edge-secrets.env",
  "install-schedule.sql",
]) {
  const path = resolve(root, name);
  if (dirname(path) !== root) throw new Error("Unexpected cleanup path.");
  if (existsSync(path)) unlinkSync(path);
}
const setupPath = resolve(root, "cloud-setup.json");
if (existsSync(setupPath)) {
  const setup = JSON.parse(readFileSync(setupPath, "utf8"));
  delete setup.cronSecret;
  writeFileSync(setupPath, JSON.stringify(setup, null, 2));
}
console.log(
  "Temporary server-key, scheduler-token and deployment-secret files removed. Private research and local data retained.",
);
