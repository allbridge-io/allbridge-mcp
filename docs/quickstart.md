# Quickstart

This page gets `allbridge-mcp` running against a local REST API in under a minute. It assumes you already have Node.js 20+ and `pnpm` installed.

## 1. Install and build

```bash
pnpm install
pnpm build
```

## 2. Point at the REST API

By default the server calls `http://127.0.0.1:3000`. If your Allbridge REST API is elsewhere, copy `.env.example` to `.env` and set:

```env
ALLBRIDGE_API_BASE_URL=https://your-allbridge-rest-api.example
```

## 3. Start the server

```bash
pnpm start
```

The process runs on `stdio`, which is what local MCP clients expect.

## 4. Register it with a client

### Claude Code

```bash
claude mcp add allbridge \
  --env ALLBRIDGE_API_BASE_URL=http://127.0.0.1:3000 \
  -- node /absolute/path/to/allbridge-mcp/dist/index.js
```

### Cursor

Save as `~/.cursor/mcp.json` (user-wide) or as `.cursor/mcp.json` in the project:

```json
{
  "mcpServers": {
    "allbridge": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/allbridge-mcp",
      "env": {
        "ALLBRIDGE_API_BASE_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

### Claude Desktop

`Settings → Developer → Local MCP servers → Edit Config`, then merge this entry into `mcpServers`:

```json
{
  "mcpServers": {
    "allbridge": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/allbridge-mcp/dist/index.js"],
      "env": {
        "ALLBRIDGE_API_BASE_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

Use an absolute path to the Node binary if you manage versions with `nvm`, `asdf`, or `volta`. GUI clients do not inherit your shell PATH.

## 5. First calls from an agent

Once the server is registered, the agent can start with:

```json
{
  "name": "plan_bridge_transfer",
  "arguments": {
    "sourceChain": "ETH",
    "destinationChain": "SOL",
    "amount": "1",
    "amountUnit": "human",
    "tokenType": "swap",
    "sourceTokenSymbol": "USDC"
  }
}
```

See the full walk-through in [`examples/tool-usage.md`](../examples/tool-usage.md).

## Running in HTTP Mode

If the client needs a URL instead of a local process:

```bash
MCP_TRANSPORT=streamable-http \
MCP_HOST=0.0.0.0 \
MCP_PORT=3000 \
pnpm start
```

Add auth with `MCP_AUTH_MODE=bearer` (plus `MCP_BEARER_TOKEN`) or `MCP_AUTH_MODE=oauth` when the client requires discovery. Details in [`transport-and-auth.md`](./transport-and-auth.md).

## Docker

```bash
docker build -t allbridge-mcp .
docker run --rm -p 3000:3000 \
  -e MCP_TRANSPORT=streamable-http \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_PORT=3000 \
  -e ALLBRIDGE_API_BASE_URL=http://host.docker.internal:3000 \
  allbridge-mcp
```

Published image: `allbridge/io.allbridge.mcp:latest`.
