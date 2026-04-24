# Configuration

All configuration is environment-variable based. Copy `.env.example` to `.env` for local development; pass the same variables through your process manager, Docker flags, or client `env` block in production.

## REST API

| Variable | Purpose | Default |
|----------|---------|---------|
| `ALLBRIDGE_API_BASE_URL` | REST API base URL | `http://127.0.0.1:3000` |
| `ALLBRIDGE_API_TIMEOUT_MS` | Outbound request timeout in ms | `20000` |
| `ALLBRIDGE_EXPLORER_API_BASE_URL` | Public explorer API used by transfer-lookup tools | `https://explorer.api.allbridgecoreapi.net` |

## Transport

| Variable | Purpose | Default |
|----------|---------|---------|
| `MCP_TRANSPORT` | `stdio` or `streamable-http` | `stdio` |
| `MCP_HOST` | HTTP bind host (when `streamable-http`) | `0.0.0.0` |
| `MCP_PORT` | HTTP bind port | `3000` |
| `PORT` | Optional hosting fallback. Overrides `MCP_PORT` when set | — |
| `MCP_PUBLIC_BASE_URL` | Public HTTPS base URL. Used to build OAuth metadata and redirect URLs. Recommended for hosted deployments | — |

## Authentication (HTTP mode)

| Variable | Purpose | Default |
|----------|---------|---------|
| `MCP_AUTH_MODE` | `none`, `bearer`, or `oauth` | `none` |
| `MCP_BEARER_TOKEN` | Static bearer token (when `MCP_AUTH_MODE=bearer`) | — |
| `MCP_OAUTH_ISSUER_NAME` | Human-readable name in OAuth metadata and consent pages | `Allbridge MCP` |
| `MCP_OAUTH_SCOPE` | Scope advertised by the server | `allbridge.mcp` |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | Access token lifetime | `3600` |
| `MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | Refresh token lifetime | `2592000` |
| `MCP_OAUTH_AUTH_CODE_TTL_SECONDS` | Authorization code lifetime | `600` |

When auth is enabled, `/` is the primary MCP endpoint and `/mcp` remains a compatibility alias. Both require `Authorization: Bearer <token>` on every request.

## Broadcast RPC (signed-transaction submission)

The broadcast path for already-signed transactions uses per-family RPC URLs. The server never signs, but it needs a reachable node for the family in question.

### EVM

| Variable | Purpose |
|----------|---------|
| `ALLBRIDGE_EVM_RPC_URL` | Default EVM RPC URL used to broadcast |
| `ALLBRIDGE_EVM_RPC_URL_<chainSymbol>` | Scoped RPC override per EVM chain symbol |
| `ALLBRIDGE_EVM_RPC_URL_<chainId>` | Scoped RPC override per EVM chain id |
| `ALLBRIDGE_EVM_RPC_URL_<walletId>` | Scoped RPC override for a specific wallet slot |

EVM resolution order when broadcasting:

1. `ALLBRIDGE_EVM_RPC_URL_<walletId>` if `walletId` is on the signed payload
2. `ALLBRIDGE_EVM_RPC_URL_<chainSymbol>`
3. `ALLBRIDGE_EVM_RPC_URL_<chainId>`
4. `ALLBRIDGE_EVM_RPC_URL`

Set `walletId` explicitly when more than one EVM wallet shares a chain.

### Non-EVM families

| Family | Variable | Notes |
|--------|----------|-------|
| Solana | `ALLBRIDGE_SOL_RPC_URL` | — |
| Tron | `ALLBRIDGE_TRX_RPC_URL` | — |
| Algorand | `ALLBRIDGE_ALG_RPC_URL` | — |
| Stacks | `ALLBRIDGE_STX_RPC_URL` | — |
| Soroban / Stellar | `ALLBRIDGE_SRB_RPC_URL` | Pair with `ALLBRIDGE_SRB_NETWORK_PASSPHRASE` |
| Sui | `ALLBRIDGE_SUI_RPC_URL` | — |

`ALLBRIDGE_SRB_NETWORK_PASSPHRASE` is required for Soroban / Stellar so the server can encode broadcasts against the correct network.

## Minimal `.env` for local development

```env
ALLBRIDGE_API_BASE_URL=http://127.0.0.1:3000
ALLBRIDGE_API_TIMEOUT_MS=20000
ALLBRIDGE_EXPLORER_API_BASE_URL=https://explorer.api.allbridgecoreapi.net
MCP_TRANSPORT=stdio
```

## Minimal `.env` for a hosted HTTP deployment with bearer auth

```env
ALLBRIDGE_API_BASE_URL=https://your-allbridge-rest-api.example
MCP_TRANSPORT=streamable-http
MCP_HOST=0.0.0.0
MCP_PORT=3000
MCP_PUBLIC_BASE_URL=https://your-mcp-host.example.com
MCP_AUTH_MODE=bearer
MCP_BEARER_TOKEN=replace-me
ALLBRIDGE_EVM_RPC_URL=https://your-evm-rpc.example
ALLBRIDGE_SOL_RPC_URL=https://your-solana-rpc.example
```

See [`transport-and-auth.md`](./transport-and-auth.md) for the full OAuth flow, HTTPS notes, and security considerations.
