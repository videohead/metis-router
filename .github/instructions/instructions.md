# Metis Router Agent Instructions

Metis is an intelligent MCP router and web-based MCP client. Three runtime
pieces run in Docker on the shared `metis-network`:

- `metis-frontend` (Next.js, `127.0.0.1:5000`) — web UI, also the Traefik
  homepage fallback for `videohead.duckdns.org`
- `metis-backend` (FastAPI, `127.0.0.1:14000`) — OpenAI Agents SDK chat agent
- `metis-server` (Node.js MCP router, `127.0.0.1:9999`) — the cross-service
  MCP gateway. It aggregates the downstream servers in `server/config.json`
  / `server/mcp-registry.json` (`ubuntu-controller`, `github`, `comfyui`,
  `docker-mcp`) and exposes their tools with `<server>__` name prefixes
  (double underscore; hosted model APIs reject colons in tool names). It is also published
  externally at `https://videohead.duckdns.org/metis-mcp/mcp` for remote MCP
  clients such as VS Code.
- `docker-mcp-gateway` (`docker/mcp-gateway` image, internal-only) — Docker's
  MCP Toolkit gateway. Runs catalog MCP servers (github, notion, etc.), each
  isolated in its own container, selected via `DOCKER_MCP_SERVERS` in `.env`.
  Requires `/var/run/docker.sock` — root-equivalent host access, kept off any
  published port.
- Raw `docker ...` CLI commands (build/compose/ps/logs) are run through
  `ubuntu-controller`'s `execute_command`, not through the gateway. Its image
  bundles the `docker` CLI and its compose service also bind-mounts
  `/var/run/docker.sock`.

The gateway uses a single long-lived shared transport per process: new
clients `initialize` onto the existing session and client session `DELETE`s
must not tear it down (see `server/src/http-streaming.ts`). It is an MCP
gateway only — not an LLM inference proxy.

## Chatbot execution ownership (verified 2026-10-16)

- The chatbot AI SDK executes application functions such as
  `delegateToAgentFramework`. Agent Framework connects directly to Metis for
  host tools and separately to LiteLLM for inference.
- Do not advise restoring implicit LiteLLM MCP injection in the chatbot.
  Mixed gateway auto-execution and application functions produced false
  delegation failures. Injected tools with an empty SDK active-tool list
  produced `AI_NoSuchToolError`, not a host permissions error.
- `filesystem__*` tools are aliases of the default Ubuntu controller routes,
  alongside `ubuntu-controller__*`. Their absence as a separate upstream in
  `/health?detail=true` does not mean filesystem tools are missing.
- MCP clients initialize before listing/calling tools and retain the returned
  session header. Do not tear down the shared router transport on client exit.
- Use a real routed tool result to verify host access. A read-only
  `filesystem__filesystem_diagnostics` call with `probe_write: false` reports
  path, identity, policy, and permission checks without proving a write.
  Test writes only with approval, a uniquely named fixture, exact readback,
  and targeted cleanup, including tool-created backups.
- The harness rejects overlapping requests to the same conversation with
  HTTP 409. Wait for active work; do not start competing edits.
- HTTP 200 or model progress narration does not prove completed edits or
  passing tests. Check harness `status`, `pending_tasks`, `finish_reason`,
  and the actual final report. Incomplete work may already have changed files.

## Tool execution rule

All tool calls that invoke `python`, `node`, `vite`, or `php` MUST run inside
Docker — never on the host. The host has no project runtimes installed.

- Node for the router server runs in the `server` compose service
  (`node:22-alpine`), e.g.
  `docker compose -f /opt/metis-router/docker-compose.yml exec server node ...`
- TypeScript builds without host Node:
  `docker run --rm -v /opt/metis-router/server:/srv -w /srv node:22-alpine node node_modules/typescript/bin/tsc -p tsconfig.json`
- Python for the backend runs in the `backend` compose service
  (container `metis-backend`).
- Production runs compiled output from `server/build`; after editing
  `server/src`, recompile (as above) and redeploy with
  `docker compose -f /opt/metis-router/docker-compose.yml up -d --build server`.

## Observability

`metis-server` emits structured one-JSON-per-line logs (`event`, `level`,
`service: "metis-router"`, `timestamp`) for every routed tool call via
`mcpStructuredLog` in `server/src/mcp-proxy.ts`:

- `metis.tool.call.start` / `metis.tool.call.complete` — routed call received
  and upstream result returned (`routedName`, `upstreamServer`,
  `upstreamToolName`, `attempt`, `durationMs`)
- `metis.tool.call.attempt_failed` — one upstream attempt failed (retryable)
- `metis.tool.call.failed` — retries exhausted; the tool result carries a
  structured `error` payload back to the caller

Persisted via `docker logs metis-server` (json-file, rotated). For the current
chatbot -> Agent Framework -> Metis tool path, correlate with
`docker logs agent-framework` and `docker logs chatbot-web-1`. LiteLLM logs
model inference separately. The full cross-service map and event dictionary
is in [tool-chain logging](../../../chatbot/docs/tool-chain-logging.md).

## Key paths

- `server/src/http-streaming.ts` — shared-session Streamable HTTP transport
- `server/src/mcp-registry.ts`, `server/mcp-registry.json` — server registry
- `server/config.json` — active downstream MCP upstreams
- `client/backend/` — FastAPI agent backend
- `client/frontend/` — Next.js web UI
