# Transport and Auth

`allbridge-mcp` supports two transports and three auth modes. Pick the combination that matches the client you want to connect.

## Transports

### `stdio` (default)

The server speaks MCP over standard input and output.

- Best for Claude Desktop, Claude Code, Cursor, Windsurf, Continue, Zed, Cline, and any local MCP client that can launch a process.
- No URL, no TLS, no network exposure.

Start it directly:

```bash
pnpm start
```

### `streamable-http`

The server binds an HTTP listener and speaks MCP over streamable responses.

- Best for hosted agents, remote MCP connectors, and Docker deployments.
- Required when the client only accepts a URL instead of launching a process.

Start it explicitly:

```bash
MCP_TRANSPORT=streamable-http \
MCP_HOST=0.0.0.0 \
MCP_PORT=3000 \
pnpm start
```

Paths:

- `/` is the primary MCP endpoint.
- `/mcp` remains available as a compatibility alias.

## Auth Modes

HTTP mode is unauthenticated by default. Enable auth by setting `MCP_AUTH_MODE`.

### `none`

No auth. Any caller that can reach the port can call the MCP. Safe only on trusted, local-only binds such as `127.0.0.1`.

### `bearer`

Static bearer token.

```env
MCP_AUTH_MODE=bearer
MCP_BEARER_TOKEN=<random token of at least 16 characters, e.g. openssl rand -hex 32>
```

A shorter token stops the server at startup.

Every HTTP request must carry:

```
Authorization: Bearer <token>
```

Use bearer mode when the client can store and send a fixed token (hosted agents, automation scripts, internal services).

### `oauth`

OAuth 2.1 discovery with dynamic client registration, the authorization-code flow (PKCE), refresh tokens and the client-credentials grant.

```env
MCP_AUTH_MODE=oauth
MCP_PUBLIC_BASE_URL=https://your-mcp-host.example.com
MCP_OAUTH_ISSUER_NAME=Allbridge MCP
MCP_OAUTH_SCOPE=allbridge.mcp
```

The server exposes:

- `GET /.well-known/oauth-protected-resource` (also at `/.well-known/oauth-protected-resource/mcp` and `/mcp/.well-known/oauth-protected-resource`)
- `GET /.well-known/oauth-authorization-server` (also at `/mcp/.well-known/oauth-authorization-server`)
- `POST /register`
- `GET /authorize`
- `POST /authorize`
- `POST /token`

Lifetimes are tunable:

| Variable | Default | Meaning |
|----------|---------|---------|
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | Access token lifetime |
| `MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh token lifetime |
| `MCP_OAUTH_AUTH_CODE_TTL_SECONDS` | `600` | Authorization code lifetime |

`MCP_PUBLIC_BASE_URL` is the HTTPS base the discovery documents advertise; only its origin is used. It needs to match the external URL the client resolves, otherwise redirect and token exchange will fail. When it is unset, the server derives the base from the `Host` and `X-Forwarded-Proto` headers.

Registered clients and issued tokens live in memory: a restart invalidates them, and clients have to connect again.

`GET /healthz` answers without auth in every mode, for container and load balancer health checks.

## HTTPS

`streamable-http` does not terminate TLS. If the client insists on `https://`, put the server behind a reverse proxy (Caddy, nginx, Traefik, Cloudflare Tunnel) that terminates TLS and forwards to the MCP port.

## Docker

Build the image from the repository. It runs `streamable-http` on `0.0.0.0:3000` by default (`MCP_TRANSPORT`, `MCP_HOST` and `MCP_PORT` are set in the image), with no auth unless you set it:

```bash
docker build -t allbridge-mcp .
docker run --rm -p 3000:3000 \
  -e MCP_AUTH_MODE=bearer \
  -e MCP_BEARER_TOKEN=<random token of at least 16 characters> \
  -e ALLBRIDGE_ETH_RPC_URL=https://your-eth-rpc.example.com \
  allbridge-mcp
```

To use the image as a local stdio server, pass `-i -e MCP_TRANSPORT=stdio` (see [client-integrations.md](./client-integrations.md#docker-based-client-registration)).

## Choosing

| Scenario | Transport | Auth |
|----------|-----------|------|
| Claude Desktop / Cursor / Claude Code on your laptop | `stdio` | — |
| Team-internal service on the same private network | `streamable-http` | `bearer` |
| Public-facing hosted MCP for third-party agents | `streamable-http` | `oauth` |

## Security Notes

- HTTP mode with `MCP_AUTH_MODE=none` on a public interface is unsafe. Bind to `127.0.0.1` or require auth.
- `allbridge-mcp` itself does not hold signing keys, so leaking an access token only exposes Allbridge Core API calls and your configured RPCs through the MCP, not private keys. Local signing keys live in [`local-signer-mcp`](https://github.com/allbridge-io/local-signer-mcp).
- Broadcast endpoints require a reachable RPC per family. Do not advertise those RPC URLs as trusted; the server calls them outbound only.
