# Quickstart

This page gets `allbridge-mcp` running from a checkout against the public Allbridge Core API. It assumes Node.js 22.12+ and `pnpm`.

Without a checkout, register the published package instead and skip to step 5:

```bash
claude mcp add allbridge -- npx -y @allbridge/allbridge-mcp@1.0.1
```

## 1. Install and build

```bash
pnpm install
pnpm build
```

## 2. Configure RPCs (recommended)

The server works out of the box with public RPC endpoints, but they are rate limited. Copy `.env.example` to `.env` and set your own RPC for the chains you use:

```env
ALLBRIDGE_ETH_RPC_URL=https://your-eth-rpc.example.com
ALLBRIDGE_ARB_RPC_URL=https://your-arb-rpc.example.com
ALLBRIDGE_SOL_RPC_URL=https://your-solana-rpc.example.com
ALLBRIDGE_TRX_RPC_URL=https://your-tron-rpc.example.com
```

See [Configuration](./configuration.md) for the full list.

## 3. Start the server

```bash
pnpm start
```

The process runs on `stdio`, which is what local MCP clients expect.

## 4. Register it with a client

### Claude Code

```bash
claude mcp add allbridge -- node /absolute/path/to/allbridge-mcp/dist/index.js
```

### Cursor

```json
{
  "mcpServers": {
    "allbridge": {
      "command": "node",
      "args": ["/absolute/path/to/allbridge-mcp/dist/index.js"],
      "env": {
        "ALLBRIDGE_ETH_RPC_URL": "https://your-eth-rpc.example.com"
      }
    }
  }
}
```

More clients: [Client Integrations](./client-integrations.md).

## 5. Try it

Ask the agent:

> How much USDC would I receive on Arbitrum if I send 100 USDC from Ethereum?

The agent calls `plan_bridge_transfer` and compares the messengers. To execute a transfer, add [`local-signer-mcp`](https://github.com/allbridge-io/local-signer-mcp) and follow [Bridge Workflow](./bridge-workflow.md).

## 6. Inspect the tools

```bash
pnpm inspect
```

Opens the MCP Inspector with live input and output schemas.
