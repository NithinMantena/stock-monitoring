import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { dockerCommand } from "./setup-lib.ts";
const { values } = parseArgs({ options: { profile: { type: "string" } } });
const transport = new StdioClientTransport({
  command: values.profile ? dockerCommand() : process.execPath,
  args: values.profile
    ? [
        "mcp",
        "gateway",
        "run",
        "--profile",
        values.profile,
        "--tools",
        "stocks_get_account",
        "--log-calls=false",
      ]
    : [fileURLToPath(new URL("index.ts", import.meta.url))],
  stderr: "pipe",
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        [
          "PATH",
          "SYSTEMROOT",
          "PROGRAMDATA",
          "PROGRAMFILES",
          "ALLUSERSPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
          "USERPROFILE",
          "HOME",
          "DOCKER_CONFIG",
          "DOCKER_HOST",
          "DOCKER_CONTEXT",
          "TEMP",
          "TMP",
          "STOCK_DESK_CONFIG",
        ].includes(key.toUpperCase()),
    ),
  ) as Record<string, string>,
});
let diagnostics = "";
transport.stderr?.on("data", (chunk) => {
  diagnostics = (diagnostics + chunk.toString()).slice(-4000);
});
const client = new Client({
  name: "stock-desk-connection-check",
  version: "1.0.0",
});
try {
  await client.connect(transport, { timeout: 120000 });
  const list = await client.listTools();
  if (!list.tools.some((t) => t.name === "stocks_get_account"))
    throw new Error("Stock tools were not discovered.");
  const result = await client.callTool({
    name: "stocks_get_account",
    arguments: {},
  });
  if (result.isError)
    throw new Error("The stock API rejected the connection check.");
  console.log(
    JSON.stringify({ connected: true, account: result.structuredContent }),
  );
} catch (error) {
  console.error((error as Error).message);
  if (diagnostics)
    console.error(
      diagnostics
        .replace(/smt_[a-f0-9-]+_[a-f0-9]+/g, "[redacted]")
        .replace(/(Bearer\s+)\S+/gi, "$1[redacted]"),
    );
  process.exitCode = 1;
} finally {
  await client.close();
}
