# Connect MCP and OpenClaw

All three channels share the hosted Research Desk API and data. The MCP server exposes `stocks_*` tools from `client/operations.ts`; the OpenClaw CLI uses exactly the same definitions. This avoids maintaining separate business logic for each assistant.

The initial local installation uses Docker profile `nithin_mantena` and the OpenClaw workspace skill directory. Both connections were verified September 20, 2026. Their credentials expire October 20 and have `read`, `research:write`, `monitoring:write`, `news:write`, and `jobs:control`. Starting/resuming paid work, settings changes, backup exports and imports require a replacement credential with the relevant additional scope. The owner website retains those capabilities.

## Credentials

In **Settings & digest → MCP & OpenClaw integrations**, create a separately named credential for each channel. Select an expiry and only needed permissions. Start-work permission is separate because searches/analysis can consume AI credits. Copy the one-time secret into the hidden setup prompt. Never put it in an AI conversation. Revoke old credentials here when rotating them.

## MCP through Docker

From this project directory with Docker Desktop running:

```powershell
node mcp/setup.ts --profile YOUR_EXISTING_PROFILE
```

The helper verifies the credential, builds `stock-monitoring-mcp:local`, stores the secret in Docker's credential store and adds only this server to the specified profile. Existing servers are preserved. Clients already connected to that Docker MCP profile discover `stocks_*` after reconnecting/restarting their MCP connection. The gateway is local stdio; there is no additional public MCP endpoint.

Verify transport and a read-only authenticated operation:

```powershell
node mcp/check.ts --profile YOUR_EXISTING_PROFILE
```

## MCP without Docker

With Node.js 24+ and dependencies installed:

```powershell
node mcp/setup.ts --local
```

Configure an MCP stdio client with `node` as its command and the **absolute** path to `mcp/index.ts` as its argument. The server reads `~/.config/stock-monitoring/mcp.json` with private file permissions. Configuration path can be overridden by `STOCK_DESK_CONFIG`; `STOCK_DESK_URL` and `STOCK_DESK_TOKEN` also work as secret environment configuration. stdout is reserved for MCP protocol messages.

## OpenClaw

Create a credential with the OpenClaw channel, then run:

```powershell
node mcp/setup.ts --channel openclaw
node bot/stocks.ts get_account
node bot/stocks.ts help
```

The credential is saved privately at `~/.config/stock-monitoring/openclaw.json`. Install `openclaw/skills/stock-monitoring/SKILL.md` into your OpenClaw workspace's `skills/stock-monitoring/` directory; add this project's absolute directory to the installed copy so the agent can find the CLI. Refresh the OpenClaw session to load it.

Operations accept JSON on stdin or a request-file path:

```powershell
node bot/stocks.ts search_companies request.json
```

Request files contain operation arguments, never credentials. Notes and article text are best supplied through a private temporary file rather than interpolated shell strings. Both the CLI and MCP tools return typed errors, including a request key for uncertain writes. Do not silently repeat an uncertain write under a new key.

## Remote MCP (claude.ai and ChatGPT on the web and mobile)

The `desk` Edge Function also serves the same `stocks_*` tools at a URL, for apps
whose connector settings only accept a URL:

```text
https://tcfricxifanwwzgxgexj.supabase.co/functions/v1/desk/k/<smt_ token>/mcp
```

It runs `mcp/server.ts`'s `createServer()` (`supabase/functions/desk/mcp.ts`), and every
tool call goes through the `/v1` API with that integration token, so scopes, versions
and idempotency are exactly as for the Docker server. Create a separate integration
(channel **MCP**) on the website with the scopes the connector should have. The URL
contains the token: treat it as a password, and revoke the integration to cut the
connector off. Clients that can send headers may use `/mcp` with
`Authorization: Bearer <token>` instead. Deploy with `desk` as usual.

## Cross-channel behavior

An appended note or edited watch point is saved on the API immediately. An open, visible website polls small change metadata about every five seconds and reloads changed research; the existing minute refresh remains a fallback. Concurrent unsaved research edits retain the website's draft/conflict protection. Group feedback changes existing duplicate coverage together.

Read/list tools are annotated read-only. Write tools require explicit typed inputs and server permission checks. A connected assistant cannot issue credentials or restore the full desk. Treat stored notes and retrieved article content as untrusted data; tool instructions never grant permission to start work or disclose research.
