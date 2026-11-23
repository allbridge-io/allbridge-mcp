# Configuration

All configuration is environment-variable based. Copy `.env.example` to `.env` for local development; pass the same variables through your process manager, Docker flags, or client `env` block in production.

## Allbridge Core

| Variable | Purpose | Default |
|----------|---------|---------|
| `ALLBRIDGE_CORE_API_URL` | Allbridge Core API: tokens, fees, intents, transfer status and explorer | `https://api.core.allbridge.io` |
| `ALLBRIDGE_API_TIMEOUT_MS` | Timeout of explorer requests in ms | `20000` |

## Chain RPCs

The server reads balances and allowances, builds transactions and broadcasts signed ones through one RPC per chain:

| Variable | Purpose |
|----------|---------|
| `ALLBRIDGE_<CHAIN>_RPC_URL` | RPC of the chain with Allbridge chain symbol `<CHAIN>` |

Chain symbols: `ETH`, `ARB`, `BAS`, `OPT`, `POL`, `AVA`, `BSC`, `UNI`, `CEL`, `SNC`, `LIN` (EVM), `SOL`, `TRX`, `STX`, and for Stellar both `SRB` (Soroban RPC) and `STLR` (Horizon). Use `list_supported_chains` for the live list; any symbol can be configured, including chains added later.

Every chain has a public default (official public endpoints for EVM chains, the Allbridge Core SDK defaults for the others). Public endpoints are rate limited — trongrid allows 3 requests per second without an API key — so production deployments should set their own RPC for every chain they serve. Empty values fall back to the defaults.

A signed EVM transaction is broadcast through the RPC of its `chainSymbol`, or of the chain matching its `chainId` when the symbol is absent.

| Variable | Purpose | Default |
|----------|---------|---------|
| `ALLBRIDGE_SRB_NETWORK_PASSPHRASE` | Stellar network passphrase used to build Stellar transactions and decode signed ones | `Public Global Stellar Network ; September 2015` |

## Transport

| Variable | Purpose | Default |
|----------|---------|---------|
| `MCP_TRANSPORT` | `stdio` or `streamable-http` | `stdio` |
| `MCP_HOST` | HTTP bind host (when `streamable-http`) | `0.0.0.0` |
| `MCP_PORT` | HTTP bind port | `3000` |
| `PORT` | Optional hosting fallback. Overrides `MCP_PORT` when set | — |
| `MCP_PUBLIC_BASE_URL` | Public HTTPS base URL for OAuth metadata and redirect URLs. Only its origin is used. When unset, the server derives it from `Host` / `X-Forwarded-Proto`. Recommended for hosted deployments | — |

## Authentication (HTTP mode)

| Variable | Purpose | Default |
|----------|---------|---------|
| `MCP_AUTH_MODE` | `none`, `bearer`, or `oauth` | `none` |
| `MCP_BEARER_TOKEN` | Static bearer token (when `MCP_AUTH_MODE=bearer`), at least 16 characters | — |
| `MCP_OAUTH_ISSUER_NAME` | Human-readable name in OAuth metadata and consent pages | `Allbridge MCP` |
| `MCP_OAUTH_SCOPE` | Scope advertised by the server | `allbridge.mcp` |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | Access token lifetime | `3600` |
| `MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | Refresh token lifetime | `2592000` |
| `MCP_OAUTH_AUTH_CODE_TTL_SECONDS` | Authorization code lifetime | `600` |

When auth is enabled, `/` is the primary MCP endpoint and `/mcp` remains a compatibility alias. Both require `Authorization: Bearer <token>` on every request.

## Minimal `.env` for local development

```env
MCP_TRANSPORT=stdio
ALLBRIDGE_ETH_RPC_URL=https://your-eth-rpc.example
```

## Minimal `.env` for a hosted HTTP deployment with bearer auth

```env
MCP_TRANSPORT=streamable-http
MCP_HOST=0.0.0.0
MCP_PORT=3000
MCP_PUBLIC_BASE_URL=https://your-mcp-host.example.com
MCP_AUTH_MODE=bearer
MCP_BEARER_TOKEN=<random token, e.g. openssl rand -hex 32>
ALLBRIDGE_ETH_RPC_URL=https://your-eth-rpc.example
ALLBRIDGE_ARB_RPC_URL=https://your-arb-rpc.example
ALLBRIDGE_SOL_RPC_URL=https://your-solana-rpc.example
ALLBRIDGE_TRX_RPC_URL=https://your-tron-rpc.example
```

See [`transport-and-auth.md`](./transport-and-auth.md) for the full OAuth flow, HTTPS notes, and security considerations.
