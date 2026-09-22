import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeskClient } from "../client/desk-client.ts";
import {
  dockerCommand,
  imageName,
  run,
  serverDefinition,
  writePrivateConfig,
} from "./setup-lib.ts";
const { values } = parseArgs({
  options: {
    local: { type: "boolean" },
    profile: { type: "string" },
    channel: { type: "string", default: "mcp" },
    url: {
      type: "string",
      default: "https://tcfricxifanwwzgxgexj.supabase.co/functions/v1/desk/v1",
    },
  },
});
async function readToken(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode)
    throw new Error(
      "Run setup in an interactive terminal for the hidden token prompt.",
    );
  process.stdout.write(
    "Paste the integration token (hidden), then press Enter: ",
  );
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (cancel = false) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      cancel ? reject(new Error("Setup cancelled.")) : resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\u0003") {
          finish(true);
          return;
        }
        if (c === "\r" || c === "\n") {
          finish();
          return;
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else if (c >= " ") value += c;
      }
    };
    process.stdin.on("data", onData);
  });
}
try {
  const channel = values.channel!;
  if (!["mcp", "openclaw"].includes(channel))
    throw new Error("Choose mcp or openclaw.");
  const token = await readToken(),
    url = values.url!;
  const account = await new DeskClient(url, () => token).request("GET", "/me");
  if (account.channel !== channel)
    throw new Error("The token channel does not match this setup.");
  if (values.local || channel === "openclaw") {
    const path = writePrivateConfig(channel, { url, token });
    console.log(`Private ${channel} configuration saved to ${path}`);
  } else {
    if (!values.profile)
      throw new Error(
        "Specify your existing Docker MCP profile with --profile.",
      );
    const docker = dockerCommand();
    run(docker, ["mcp", "profile", "show", values.profile]);
    run(docker, [
      "build",
      "-f",
      fileURLToPath(new URL("Dockerfile", import.meta.url)),
      "-t",
      imageName,
      fileURLToPath(new URL("..", import.meta.url)),
    ]);
    run(
      docker,
      ["pass", "set", "docker/mcp/stock-monitoring.api_token", "--force"],
      token,
    );
    const dir = join(homedir(), ".docker", "mcp", "catalogs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "stock-monitoring.json"),
      JSON.stringify(serverDefinition(url), null, 2),
    );
    run(docker, [
      "mcp",
      "profile",
      "server",
      "add",
      values.profile,
      "--server",
      "file://stock-monitoring.json",
    ]);
    writePrivateConfig("mcp", {
      url,
      profile: values.profile,
      mode: "docker",
      authenticated: true,
    });
    console.log(
      "Stock Monitoring added to the existing Docker profile. Restart connected clients.",
    );
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
