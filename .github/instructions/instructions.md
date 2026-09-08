# Metis Router Agent Instructions

Metis is an intelligent MCP router and web-based MCP client. Three runtime
pieces run in Docker on the shared `metis-network`:

- `metis-frontend` (Next.js, `127.0.0.1:5000`) — web UI, also the Traefik
  homepage fallback for `videohead.duckdns.org`
- `metis-backend` (FastAPI, `127.0.0.1:14000`) — OpenAI Agents SDK chat agent
- `metis-server` (Node.js MCP router, `127.0.0.1:9999`) — the cross-service
  MCP gateway. It aggregates the downstream servers in `server/config.json`
  / `server/mcp-registry.json` (`ubuntu-controller`, `github`, `worldgraph`,
  `comfyui`, `morphazoid`, `videobrain`, `openharness`) and exposes their tools
  with `<server>:` name prefixes. It is also published externally at
  `https://videohead.duckdns.org/metis-mcp/mcp` for remote MCP clients such as
  VS Code.

The gateway uses a single long-lived shared transport per process: new
clients `initialize` onto the existing session and client session `DELETE`s
must not tear it down (see `server/src/http-streaming.ts`). It is an MCP
gateway only — not an LLM inference proxy.

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

## Key paths

- `server/src/http-streaming.ts` — shared-session Streamable HTTP transport
- `server/src/mcp-registry.ts`, `server/mcp-registry.json` — server registry
- `server/config.json` — active downstream MCP upstreams
- `client/backend/` — FastAPI agent backend
- `client/frontend/` — Next.js web UI
