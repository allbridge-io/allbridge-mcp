# Allbridge MCP

`allbridge-mcp` is an MCP server for Allbridge bridge workflows. It helps an AI agent plan a transfer, build execution jobs, broadcast signed payloads, and track the result — without holding private keys.

- Repository: [github.com/allbridge-io/allbridge-mcp](https://github.com/allbridge-io/allbridge-mcp)
- Docker image: [allbridge/io.allbridge.mcp](https://hub.docker.com/repository/docker/allbridge/io.allbridge.mcp/tags?name=latest)
- End-to-end usage walkthrough: [`docs/usage.md`](./docs/usage.md)
- Pairs with: [`local-signer-mcp`](https://github.com/allbridge-io/local-signer-mcp)

If the bridge flow will be signed locally, configure `local-signer-mcp` first:

- Copy `local-signer-mcp/.env.example` to `.env`, or pass the same variables through the MCP client `env` block.
- Set the matching family-specific private key and RPC URL pair. For EVM, that means `LOCAL_SIGNER_EVM_PRIVATE_KEY` and `LOCAL_SIGNER_EVM_RPC_URL`.
- Keep the signer config separate from this server; `allbridge-mcp` only coordinates the bridge flow and never signs.

See the signer repo README for the full variable matrix and client-specific recipes.

Outbound REST API and explorer requests from `allbridge-mcp` include `X-Allbridge-Client: allbridge-mcp` so the backend can identify MCP traffic in logs and metrics.

## What It Does

- Discovers routes, tokens, and chains
- Plans bridge transfers across **Allbridge Core and Allbridge NEXT** in one call (`plan_bridge_transfer`); pass `protocol: "core"` or `"next"` to query only one
- Returns structured quote options
- Builds execution jobs with ordered, ready-to-sign transaction steps (Core)
- Quotes and builds NEXT swap transactions (NEXT)
- Checks sender balances before building a job
- Broadcasts already-signed transactions for supported chain families
- Tracks transfer status from the source-chain transaction hash
- Searches public explorer records by transfer hash or address
- Provides Stellar trustline and Algorand opt-in helpers for destination prerequisites

## Capability Boundary

`allbridge-mcp` does not sign transactions, does not hold private keys, and cannot choose a local wallet on its own. For signing, pair it with [`local-signer-mcp`](https://github.com/allbridge-io/local-signer-mcp), which owns the local wallet surface.

If the sender's balance is unknown, call `check_sender_balances` before `create_bridge_execution_job` for bridge-specific fee validation. `check_sender_balances` returns the available balance, the required balance, and a `canProceed` flag, but it does not have to block job construction.

## Requirements

- Node.js 20+
- `pnpm` (the repo is pnpm-workspaced)
- Optional: Docker, if you prefer the hosted HTTP transport

## Quick Start

```bash
pnpm install
pnpm build
pnpm start
```

That starts the server on `stdio` against the default `ALLBRIDGE_API_BASE_URL=http://127.0.0.1:3000`.

Minimal Claude Code registration:

```bash
claude mcp add allbridge \
  --env ALLBRIDGE_API_BASE_URL=http://127.0.0.1:3000 \
  -- node /absolute/path/to/allbridge-mcp/dist/index.js
```

More client recipes live in [`examples/`](./examples).

## Configuration

Copy `.env.example` to `.env` and edit. The most common knobs:

| Variable | Purpose | Default |
|----------|---------|---------|
| `ALLBRIDGE_API_BASE_URL` | Core REST API base URL | `http://127.0.0.1:3000` |
| `ALLBRIDGE_API_TIMEOUT_MS` | Request timeout (shared by Core, Explorer, NEXT) | `20000` |
| `ALLBRIDGE_EXPLORER_API_BASE_URL` | Public explorer API | `https://explorer.api.allbridgecoreapi.net` |
| `ALLBRIDGE_NEXT_API_BASE_URL` | Allbridge NEXT REST API base URL | `https://api.next.allbridge.io` |
| `MCP_TRANSPORT` | `stdio` or `streamable-http` | `stdio` |
| `MCP_AUTH_MODE` | `none`, `bearer`, or `oauth` | `none` |
| `MCP_PORT` | HTTP bind port | `3000` |
| `ALLBRIDGE_EVM_RPC_URL` | Default RPC used for EVM broadcast | — |

The full list (OAuth TTLs, per-chain RPC overrides, Soroban / Stellar passphrase, and so on) is in [`.env.example`](./.env.example).

## Transport Modes

- `stdio` — default. Ideal for Claude Desktop, Claude Code, Cursor, Windsurf, and any local MCP client.
- `streamable-http` — for Docker, hosted agents, and remote MCP connectors. Supports bearer-token auth and OAuth 2.1 discovery when `MCP_AUTH_MODE` is set.

When auth is on, `/` is the primary MCP endpoint and `/mcp` is a compatibility alias; both require `Authorization: Bearer <token>`.

## Client Integrations

| Client | Transport | Notes |
|--------|-----------|-------|
| Claude Desktop | `stdio` | Settings → Developer → Local MCP servers |
| Claude Code | `stdio` | `claude mcp add allbridge -- node ...` |
| Cursor | `stdio` | `~/.cursor/mcp.json` or project `.cursor/mcp.json` |
| Remote connector | `streamable-http` | Point at `https://your-host/` with bearer or OAuth |

Full client recipes in [`examples/`](./examples).

## Tools

Grouped surfaces exposed by the server. Each tool returns structured errors (`ok`, `error.code`, `error.message`, `error.details`) so agents can recover without guessing.

- **Bridge (Core + NEXT):** `plan_bridge_transfer` — protocol-aware (`protocol: "core" | "next" | "auto"`, default `auto`); always wraps the response as `{ protocols, core, next, errors }`.
- **Bridge (Core):** `list_supported_chains`, `list_supported_tokens`, `find_bridge_routes`, `quote_bridge_transfer`, `check_sender_balances`, `create_bridge_execution_job`, `build_bridge_transactions`, `get_transfer_status`, `search_allbridge_transfers`, `get_allbridge_transfer`
- **Bridge (NEXT):** `list_next_chains`, `list_next_tokens`, `quote_next_swap`, `build_next_transaction`
- **Destination prerequisites:** `check_stellar_trustline`, `build_stellar_trustline_transaction`, `check_algorand_optin`, `build_algorand_optin_transaction`
- **Broadcast:** `broadcast_signed_transaction`

End-to-end walkthrough for every tool: [`docs/usage.md`](./docs/usage.md). Live input/output schemas: `pnpm inspect`.

## Handoff Model

`allbridge-mcp` plans and tracks; `local-signer-mcp` signs. Each execution step returned by `create_bridge_execution_job` carries explicit handoff metadata (`executionTarget`, `executionTool`, `broadcastTarget`, `broadcastTool`, `walletSelector`, `transactionShape`) so the client knows exactly which server owns the next action. See [`docs/usage.md`](./docs/usage.md#3-build-the-execution-job).

## Run

Development:

```bash
pnpm start:dev
```

Docker / HTTP:

```bash
docker build -t allbridge-mcp .
docker run --rm -p 3000:3000 \
  -e MCP_TRANSPORT=streamable-http \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_PORT=3000 \
  -e ALLBRIDGE_API_BASE_URL=http://host.docker.internal:3000 \
  allbridge-mcp
```

Or pull the published image: `allbridge/io.allbridge.mcp:latest`.

Inspect the server locally:

```bash
pnpm inspect
```

## Examples

- [`examples/claude-code.md`](./examples/claude-code.md) — one-liner CLI registration
- [`examples/cursor.mcp.json`](./examples/cursor.mcp.json) — Cursor config
- [`examples/tool-usage.md`](./examples/tool-usage.md) — annotated JSON request / response walk-through

## Verification

```bash
pnpm build
pnpm test
```

Maintainers can also run the smoke script:

```bash
pnpm smoke
```

## Documentation

- End-to-end usage walkthrough: [`docs/usage.md`](./docs/usage.md)
- Technical docs: [`docs/`](./docs)
- Runnable examples: [`examples/`](./examples)
- Agent skill note: [`SKILL.md`](./SKILL.md)
