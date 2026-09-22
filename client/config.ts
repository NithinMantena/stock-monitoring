import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeskClient } from "./desk-client.ts";
export function configuredClient(channel = "mcp") {
  let config: any = {};
  const path =
    process.env.STOCK_DESK_CONFIG ||
    join(homedir(), ".config", "stock-monitoring", `${channel}.json`);
  if (!process.env.STOCK_DESK_TOKEN || process.env.STOCK_DESK_CONFIG) {
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Private Stock Desk configuration cannot be read.");
    }
  }
  const url =
    process.env.STOCK_DESK_URL ||
    config.url ||
    "https://tcfricxifanwwzgxgexj.supabase.co/functions/v1/desk/v1";
  const token = process.env.STOCK_DESK_TOKEN || config.token;
  if (!token)
    throw new Error(
      "Stock Desk credential is not configured. Use the private setup prompt or STOCK_DESK_TOKEN.",
    );
  return new DeskClient(url, () => token);
}
