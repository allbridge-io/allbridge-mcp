# Allbridge MCP

`allbridge-mcp` is an MCP server for Allbridge bridge workflows.

It connects to the Allbridge REST API and exposes an agent-oriented interface for:

- transfer planning
- route discovery
- execution job creation
- broadcast of already signed transactions for supported chain families
- transfer status tracking
- read-only developer assistant tools for docs search and implementation references

It does not sign transactions.

It can run in two transports:

- `stdio` for local MCP clients
- `streamable-http` for Docker and hosted deployments

When running as a hosted server, it can also expose OAuth discovery and token endpoints so remote MCP clients can authenticate over HTTP.

## Features

- Agent-friendly planning with `plan_bridge_transfer`
- Supported chain and token directory tools:
  - `list_supported_chains`
  - `list_supported_tokens`
- Structured execution jobs with ordered transaction steps
- Explicit execution handoff metadata for each step
- Lower-level route, quote, and raw-transaction tools for debugging and integration work
- Developer-assistant tools for documentation search and resource lookup
- Allowlisted documentation scopes for project docs, SDK integration, REST API integration, and examples
- Transfer status lookup from source transaction hash

## Capability Boundary

`allbridge-mcp` can do the following on its own:

- discover routes
- quote transfers
- build execution jobs
- broadcast already signed transactions
- track transfer status

`allbridge-mcp` cannot:

- sign transactions
- hold private keys
- choose a local wallet by itself when the signed payload does not include enough information

For signing, use `local-signer-mcp` alongside this server.

## Tools

### Bridge

- `plan_bridge_transfer`
- `list_supported_chains`
- `list_supported_tokens`
- `find_bridge_routes`
- `quote_bridge_transfer`
- `check_bridge_balances`
- `create_bridge_execution_job`
- `build_bridge_transactions`
- `get_transfer_status`

### Dev

- `search_allbridge_documentation`
- `get_allbridge_product_summary`
- `list_available_coding_resources`
- `get_coding_resource_details`

### Broadcast

- `broadcast_signed_transaction`

## How It Works

Recommended flow:

1. Call `plan_bridge_transfer`
2. If you need to inspect the directory first, call `list_supported_chains` or `list_supported_tokens`
3. Choose `messenger` and `feePaymentMethod`
4. Call `create_bridge_execution_job`
5. Read each step's `handoff` metadata to see the recommended execution path:
   - `local-signer-mcp.sign_and_broadcast_transaction` for unsigned steps
   - `allbridge-mcp.broadcast_signed_transaction` for already signed payloads
   - `walletSelector` for `walletId` / sender hints when multiple wallets exist
   - optional `walletId` input on `create_bridge_execution_job` when you want to pin the execution job to a specific wallet
6. Execute the next step with a local signer or broadcast a signed payload with `broadcast_signed_transaction`
7. Call `get_transfer_status` with the source-chain transaction hash

When a tool input is wrong or incomplete, the server returns a structured tool error with:

- `ok: false`
- `error.code`
- `error.message`
- `error.details`

Use those details to ask the user for the missing chain, token, amount, or address instead of retrying blindly.

The package is intentionally separated from signing. If you need a local signing flow, use a separate signer service such as `local-signer-mcp`.

Combined flow:

1. `allbridge-mcp` returns the execution job and ordered steps
2. A client sends the next step to `local-signer-mcp`
3. `local-signer-mcp` signs or signs-and-broadcasts the step
4. `allbridge-mcp` tracks the resulting source-chain transaction

Each returned step includes explicit handoff metadata:

- `executionTarget`
- `executionTool`
- `broadcastTarget`
- `broadcastTool`
- `walletSelector`
- `transactionShape`

## Installation

```bash
pnpm install
pnpm build
```

## Configuration

Copy `.env.example` to `.env` if needed.

- `ALLBRIDGE_API_BASE_URL`: REST API base URL. Default: `http://127.0.0.1:3000`
- `ALLBRIDGE_API_TIMEOUT_MS`: Request timeout in milliseconds. Default: `20000`
- `MCP_TRANSPORT`: Transport mode. Default: `stdio`
- `MCP_HOST`: HTTP bind host used when `MCP_TRANSPORT=streamable-http`. Default: `0.0.0.0`
- `MCP_PUBLIC_BASE_URL`: Public HTTPS base URL used to build OAuth metadata and redirect URLs. Recommended for hosted deployments
- `MCP_PORT`: HTTP bind port used when `MCP_TRANSPORT=streamable-http`. Default: `3000`
- `PORT`: Optional hosted-port fallback. If set, it takes priority over `MCP_PORT`
- `MCP_AUTH_MODE`: Authorization mode for the HTTP server. Default: `none`. Set to `bearer` for static bearer-token auth or `oauth` for OAuth 2.1 discovery and token exchange
- `MCP_BEARER_TOKEN`: Static bearer token used when `MCP_AUTH_MODE=bearer`
- `MCP_OAUTH_ISSUER_NAME`: Human-readable name used in OAuth metadata and consent pages. Default: `Allbridge MCP`
- `MCP_OAUTH_SCOPE`: OAuth scope advertised by the server. Default: `allbridge.mcp`
- `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS`: Access token lifetime in seconds. Default: `3600`
- `MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS`: Refresh token lifetime in seconds. Default: `2592000`
- `MCP_OAUTH_AUTH_CODE_TTL_SECONDS`: Authorization code lifetime in seconds. Default: `600`
- `ALLBRIDGE_EVM_RPC_URL`: Default RPC URL used to broadcast already signed EVM transactions
- `ALLBRIDGE_EVM_RPC_URL_<chainSymbol>` or `ALLBRIDGE_EVM_RPC_URL_<chainId>`: Optional scoped RPC overrides per EVM chain
- `ALLBRIDGE_EVM_RPC_URL_<walletId>`: Optional RPC override for a specific EVM wallet identifier
- `ALLBRIDGE_SOL_RPC_URL`: Optional RPC URL used to broadcast already signed Solana transactions
- `ALLBRIDGE_TRX_RPC_URL`: Optional RPC URL used to broadcast already signed Tron transactions
- `ALLBRIDGE_ALG_RPC_URL`: Optional RPC URL used to broadcast already signed Algorand transactions
- `ALLBRIDGE_STX_RPC_URL`: Optional RPC URL used to broadcast already signed Stacks transactions
- `ALLBRIDGE_SRB_RPC_URL`: Optional RPC URL used to broadcast already signed Soroban / Stellar transactions
- `ALLBRIDGE_SRB_NETWORK_PASSPHRASE`: Soroban / Stellar network passphrase
- `ALLBRIDGE_SUI_RPC_URL`: Optional RPC URL used to broadcast already signed Sui transactions

## Run

```bash
pnpm start
```

For local development:

```bash
pnpm start:dev
```

For Docker or hosted HTTP mode:

```bash
docker build -t allbridge-mcp .
docker run --rm -p 3000:3000 \
  -e MCP_TRANSPORT=streamable-http \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_PORT=3000 \
  -e ALLBRIDGE_API_BASE_URL=http://host.docker.internal:3000 \
  allbridge-mcp
```

When the API is running in another local container or on the host, set `ALLBRIDGE_API_BASE_URL` to that reachable URL.

OAuth endpoints exposed by the HTTP server when `MCP_AUTH_MODE` is set:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /register`
- `GET /authorize`
- `POST /authorize`
- `POST /token`

When auth is enabled, `/` is the primary MCP endpoint and `/mcp` remains a compatibility alias. Both require `Authorization: Bearer <token>` on every request.

Use `bearer` mode if the client can send a fixed access token directly. Use `oauth` mode if you want the client to discover metadata and complete an OAuth authorization-code flow.

For local inspection:

```bash
pnpm inspect
```

## Skills

- `SKILL.md`

## Instructions

- `docs/usage.md`
- `docs/gitbook/ai/README.md`

## Examples

- `examples/cursor.mcp.json`
- `examples/claude-code.md`
- `examples/tool-usage.md`

## Verification

```bash
pnpm build
pnpm test
```

The package also includes a smoke script for maintainers:

```bash
pnpm smoke
```
