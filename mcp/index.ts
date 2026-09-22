import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.ts";
import { configuredClient } from "../client/config.ts";
try {
  const client = configuredClient();
  const handle = serveStdio(() => createServer(client));
  process.on("SIGINT", () => {
    void handle.close();
  });
  process.on("SIGTERM", () => {
    void handle.close();
  });
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
