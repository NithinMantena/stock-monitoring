// Remote MCP endpoint for connectors that only take a URL (claude.ai and
// ChatGPT on the web and mobile). It serves exactly the desktop MCP server's
// tools by running its createServer() (mcp/server.ts) here. Each tool call is
// sent through this function's own authenticated /v1 pipeline with the
// connector's integration token, so scopes, validation, versions and
// idempotency are the same as for the desktop MCP and the website.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { DeskClient } from "../../../client/desk-client.ts";
import { createServer } from "../../../mcp/server.ts";

// Never fetched over the network: requests go straight to `api`.
const INTERNAL_BASE = "https://desk.internal/desk/v1";

export function createRemoteMcp(
  api: (request: Request) => Response | Promise<Response>,
) {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const token = authInfo?.token ?? "";
      return createServer(
        new DeskClient(INTERNAL_BASE, () => token, (input, init) =>
          Promise.resolve(api(new Request(input, init))),
        ),
      );
    },
  );
  return (request: Request, token: string) =>
    handler.fetch(request, {
      authInfo: { token, clientId: "remote-mcp", scopes: [] },
    });
}
