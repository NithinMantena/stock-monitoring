# Research Desk API v1

The website, MCP server and OpenClaw client use one authenticated Hono API. Domain logic lives on the server; neither integration writes directly to the database.

- Hosted base: `https://tcfricxifanwwzgxgexj.supabase.co/functions/v1/desk/v1`
- Local base: `http://127.0.0.1:8787/api/v1`
- Machine-readable contract: [OpenAPI](../public/openapi.json), served at `/openapi.json` on the website.
- Shared request transport: `client/desk-client.ts`; typed operation definitions: `client/operations.ts`.

## Authentication and permissions

Send `Authorization: Bearer <token>`. The website uses its existing owner session. Integrations use separate, expiring `smt_` credentials created in Settings & digest. Only SHA-256 hashes are stored; the secret is returned once. Revocation takes effect on the next request. Never give a client a Supabase service key.

| Scope | Permitted work |
| --- | --- |
| `read` | Search and read companies, developments, article text, settings, health, job status |
| `research:write` | Create companies, edit research, append notes, archive |
| `monitoring:write` | Change cadence, sources, watch points, numerical rules, supplied quotes |
| `news:write` | Save, review and label developments |
| `jobs:start` | Queue monitoring, news discovery or supplied-article analysis; may spend AI budget |
| `jobs:control` | Pause/cancel work; resume/advance also requires `jobs:start` |
| `settings:write` | Change digest settings |
| `backup:read` | Read backups and export research |
| `import:write` | Preview/commit imports and roll back untouched imported records |

Owner sessions alone manage integrations, audit records, full restore and website compatibility endpoints. Local access without a token is an owner session only on the loopback server protected by Host/Origin checks.

## Reads and writes

List responses are `{ items, nextCursor, total }`. Default page size is 25, maximum 100. Pass `cursor=nextCursor` with the same filters. If the cursor disappears after an edit, restart pagination. Company search returns summaries; fetch an individual company for full notes. Development summaries omit raw article text. `/changes?since=<ISO timestamp>` returns only changed IDs, versions and timestamps.

Each existing company edit supplies the current `version`. A stale edit returns HTTP 409; read the latest version and reconcile the intended change. Granular note append and watch-point/rule/feed upserts preserve unrelated fields. Group feedback first reads the development's `versions` map and submits all member versions. All existing members update in one database transaction, or none do.

Every write requires a unique `Idempotency-Key` for that logical operation, except credential creation/revocation. Reuse the key and exact payload to retrieve a completed response. Reusing a key for different arguments returns 409. The shared client generates keys but never retries writes automatically. `DeskError.requestKey` preserves the key after uncertain outcomes.

The request ledger and audit entry are committed together after the domain operation. A crash between the domain write and recording its response leaves an uncertain request: inspect current state before proceeding. This deliberately prevents automatic duplicate work; it is not a claim of exactly-once execution across process crashes. Audit entries store actor/channel, path, method, status and time, not research payloads or credentials.

## Main resources

| Route | Operations |
| --- | --- |
| `/me` | Connection identity and scopes |
| `/companies`, `/companies/{id}` | Search, create, fetch, versioned partial update |
| `/companies/{id}/notes` | Append research with a version check |
| `/companies/{id}/watch-points`, `/rules`, `/feeds` | Upsert/remove one configured item |
| `/companies/{id}/quote`, `/revisions`, `/markdown` | Supplied quote, note history, Markdown export |
| `/developments`, `/developments/{id}` | Filter/group coverage, inspect members, atomic feedback |
| `/events/{id}`, `/events/{id}/content` | Article metadata and available extracted text |
| `/jobs`, `/jobs/{id}`, `/jobs/{id}/control` | Enqueue, inspect, pause/resume/cancel. Hosted: enqueue and resume run the first bounded step immediately in the background; later steps run on the scheduler, which ticks every minute while a job is queued or running |
| `/jobs/{id}/advance` | Explicit bounded worker step; requires both job scopes |
| `/settings`, `/health`, `/digest` | Settings, monitoring/usage health, digest preview |
| `/import/preview`, `/import/commit`, `/import/{id}/rollback` | Research import lifecycle |
| `/backups`, `/backups/{id}`, `/export`, `/restore` | Research recovery; restore is owner-only |
| `/integrations`, `/integrations/{id}/revoke`, `/audit` | Owner connection administration |

See OpenAPI for exact methods, input schemas and parameters. Some owner-only website routes retain compatibility with the original API. They call the same domain implementation and are not exposed as integration shortcuts.

## Jobs and limits

Enqueue returns quickly with a job ID; poll separately. Monitoring, re-screening and supplied-article analysis persist a company snapshot, cursor, status, errors and recent result. The hosted scheduler advances one bounded step; the local server advances queued jobs while running. News searches retain their existing durable article queue and archive earlier batch summaries. Pause/cancel keep completed results; an in-flight unit may finish. Cancelled/completed jobs are terminal; a failed job can be resumed explicitly.

News discovery defaults to up to ten Google News results for each of the last seven UTC calendar days (including today) per selected company, plus configured primary sources. Discovery limits are not a promise that every publisher supplies ten results. AI budget reservations, retrieval protections and evidence policy remain server-side and apply equally to all channels.

Normal request bodies are limited to 2.5 MB, restore to 100 MB/20,000 records. Article analysis is limited by the shared article-size policy. Credentials, request/audit ledgers and active jobs are intentionally excluded from portable research exports. Export/restore moves research, not integration authorization.

List responses are bounded, but current server implementations still scan owner records for some filters/grouping. This is appropriate for this desk's scale; database-indexed pagination is the next scaling step. Replay/audit history currently has no automated retention cleanup.

## Validation

Run `npm run check`, `npm test -- --maxWorkers=2`, and `npm run build`. API tests cover scoped access, revocation, conflict detection, replay, atomic group updates, queue controls and small change responses. MCP tests launch the actual stdio server against a disposable local API and verify cross-channel writes without paid model calls. Regenerate the contract with `node scripts/generate-api-docs.ts` after changing operations.
