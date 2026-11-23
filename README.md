# Allbridge MCP

`allbridge-mcp` is an MCP server for Allbridge Core transfers. It lets an AI agent find a route, compare quotes, build ready-to-sign transactions, broadcast signed ones and track the result — without holding private keys.

- Repository: [github.com/allbridge-io/allbridge-mcp](https://github.com/allbridge-io/allbridge-mcp)
- npm: [`@allbridge/allbridge-mcp`](https://www.npmjs.com/package/@allbridge/allbridge-mcp) (`npx -y @allbridge/allbridge-mcp@0.2.0`)
- End-to-end walkthrough: [`docs/usage.md`](./docs/usage.md)
- Pairs with: [`local-signer-mcp`](https://github.com/allbridge-io/local-signer-mcp), which signs the transactions this server builds

The server runs on the [Allbridge Core SDK](https://www.npmjs.com/package/@allbridge/bridge-core-sdk) and the Allbridge Core API (`https://api.core.allbridge.io`). Requests to the Core API carry `X-Allbridge-Client: allbridge-mcp`.

## What It Does

- Lists supported chains and tokens (stablecoins and native currencies)
- Quotes every available messenger for a transfer and sorts them by the amount received
- Checks the sender's balances for the amount and the gas fee
- Builds an execution job: ordered steps with unsigned transactions in the exact shape `local-signer-mcp` signs
- Broadcasts already-signed transactions
- Tracks a transfer by its source transaction hash, including refunds
- Searches the Allbridge explorer by address, transaction hash or transfer id
- Checks and builds Stellar trustlines for recipients

## Messengers

| Messenger | Kind | Notes |
|-----------|------|-------|
| `CCTP_V2` | bridge | Circle CCTP V2 for USDC |
| `OFT` | bridge | LayerZero OFT (USDT0 and others) |
| `X_RESERVE` | bridge | Circle xReserve (USDC ↔ USDCx on Stacks) |
| `NEAR_INTENTS` | intent | NEAR Intents (1Click): transfer to a one-time deposit address, solvers deliver; any token pair except from Stacks, native currencies included |
| `LIFI_INTENTS` | intent | LI.FI Intents: escrow order filled by solvers within seconds; EVM and Solana sources |

**Bridge** messengers charge a deterministic Allbridge fee; the destination gas fee is paid in the native currency, in the source token (deducted from the amount) or in ABR. **Intent** messengers are market-priced: the quote already includes every fee, and an unfilled transfer is refunded to the sender.

Supported source chain families: EVM, Solana, Tron, Stacks, Stellar. The live route list comes from the Core API, so `list_supported_chains` and `find_bridge_routes` always reflect it.

## Capability Boundary

`allbridge-mcp` does not sign transactions and does not hold private keys. Every step of an execution job carries an unsigned transaction that `local-signer-mcp` `sign_and_broadcast_transaction` accepts as is; any other signer can use it too and hand the signed payload back to `broadcast_signed_transaction`.

## Requirements

- Node.js 22.12+
- `pnpm`, only to build from source (`npx` needs Node alone)
- Optional: Docker for the HTTP transport

## Quick Start

```bash
pnpm install
pnpm build
pnpm start
```

That starts the server on `stdio` against the public Core API. Register it in Claude Code:

```bash
claude mcp add allbridge -- node /absolute/path/to/allbridge-mcp/dist/index.js
```

### Run with npx

The package ships an `allbridge-mcp` binary, so a client can start the published version without a checkout. Pin the version:

```bash
claude mcp add allbridge -- npx -y @allbridge/allbridge-mcp@0.2.0
```

```json
{
  "mcpServers": {
    "allbridge": { "command": "npx", "args": ["-y", "@allbridge/allbridge-mcp@0.2.0"] }
  }
}
```

More client recipes live in [`docs/client-integrations.md`](./docs/client-integrations.md) and [`examples/`](./examples).

## Configuration

Copy `.env.example` to `.env`, or pass variables through the MCP client `env` block.

| Variable | Purpose | Default |
|----------|---------|---------|
| `ALLBRIDGE_CORE_API_URL` | Allbridge Core API | `https://api.core.allbridge.io` |
| `ALLBRIDGE_API_TIMEOUT_MS` | Explorer request timeout | `20000` |
| `ALLBRIDGE_<CHAIN>_RPC_URL` | RPC of a chain, by Allbridge chain symbol (`ETH`, `ARB`, `BAS`, `SOL`, `TRX`, `STX`, `SRB`, `STLR`, …) | public endpoints |
| `ALLBRIDGE_SRB_NETWORK_PASSPHRASE` | Stellar network passphrase | mainnet |
| `MCP_TRANSPORT` | `stdio` or `streamable-http` | `stdio` |
| `MCP_AUTH_MODE` | `none`, `bearer` or `oauth` | `none` |
| `MCP_PORT` | HTTP bind port | `3000` |

RPCs are used to read balances and allowances, build transactions and broadcast. The built-in public endpoints are rate limited (trongrid allows 3 requests per second), so set your own for every chain you use. Details: [`docs/configuration.md`](./docs/configuration.md).

## Tools

| Group | Tools |
|-------|-------|
| Discovery | `list_supported_chains`, `list_supported_tokens`, `find_bridge_routes` |
| Planning | `plan_bridge_transfer`, `quote_bridge_transfer`, `check_sender_balances` |
| Execution | `create_bridge_execution_job`, `create_lifi_intents_order`, `submit_near_intents_deposit`, `broadcast_signed_transaction` |
| Recipient setup | `check_stellar_trustline`, `build_stellar_trustline_transaction` |
| Tracking | `get_transfer_status`, `search_allbridge_transfers`, `get_allbridge_transfer` |

Every tool returns structured errors (`ok: false`, `error.code`, `error.message`, `error.details`) so agents can recover without guessing. Reference: [`docs/tools-reference.md`](./docs/tools-reference.md).

## Transfer Flow

1. `plan_bridge_transfer` — compare messengers for the amount.
2. `create_bridge_execution_job` — get the ordered steps for the chosen messenger.
3. Sign and broadcast each step with `local-signer-mcp` (or sign elsewhere and call `broadcast_signed_transaction`).
4. `get_transfer_status` with the bridge transaction hash.

Intent messengers add one step each:

- **NEAR Intents** — the job already contains the deposit transfer; after broadcasting, `submit_near_intents_deposit` (optional) speeds up detection.
- **LI.FI Intents** — an order is valid for 40-120 seconds, so the job's bridge step has no transaction yet: after any approval confirms, call `create_lifi_intents_order` with the step's `build.arguments` and sign the result at once. It stops with `price_changed` when the order pays less than the accepted slippage.

Full walkthrough: [`docs/bridge-workflow.md`](./docs/bridge-workflow.md) and [`docs/usage.md`](./docs/usage.md).

## Run

```bash
pnpm start:dev
```

Docker / HTTP:

```bash
docker build -t allbridge-mcp .
docker run --rm -p 127.0.0.1:3000:3000 \
  -e ALLBRIDGE_ETH_RPC_URL=https://your-eth-rpc.example.com \
  allbridge-mcp
```

The image runs `streamable-http` on port 3000 with no authentication, so the example publishes it on `127.0.0.1` only. To expose it, set `MCP_AUTH_MODE` first ([`docs/transport-and-auth.md`](./docs/transport-and-auth.md)). Inspect the server locally with `pnpm inspect`.

## Verification

```bash
pnpm build
pnpm lint
pnpm test
pnpm smoke
```

`pnpm smoke` drives the built server over stdio against the live Core API: it lists the tools and chains, plans a transfer, builds an execution job and checks it against the job contract. It never signs or sends anything. The default is 10 USDC from Ethereum to Arbitrum through `CCTP_V2`; override it with `SMOKE_SOURCE_CHAIN`, `SMOKE_DESTINATION_CHAIN`, `SMOKE_TOKEN_SYMBOL`, `SMOKE_DESTINATION_TOKEN_SYMBOL`, `SMOKE_AMOUNT`, `SMOKE_MESSENGER`, `SMOKE_FEE_PAYMENT_METHOD`, `SMOKE_SENDER_ADDRESS` and `SMOKE_RECIPIENT_ADDRESS`. Set `SMOKE_TX_ID` to also check that transfer's status.

## Releasing

CI (`.github/workflows/ci.yml`) runs lint, tests and the build on every pull request and on every push to `master`. On a push to `master` it publishes `@allbridge/allbridge-mcp` to npm when the `version` in `package.json` is not on npm yet, then tags `v<version>` and creates a GitHub release.

To release, bump `version` in the pull request ([semver](https://semver.org): while on `0.x`, a patch for fixes and a minor for features or breaking changes). Merging a pull request without a version bump publishes nothing.

Publishing uses npm trusted publishing (GitHub OIDC), so there is no npm token in the repository. One-time setup:

1. Publish the first version by hand from an account with access to the `@allbridge` organization: `npm publish --access public`.
2. On npmjs.com, open the package settings and add a trusted publisher: GitHub Actions, organization `allbridge-io`, repository `allbridge-mcp`, workflow `ci.yml`, environment `npm-registry`.
3. Create the `npm-registry` environment in the GitHub repository settings (optionally restricted to `master`).

## Documentation

- [`docs/overview.md`](./docs/overview.md) — role and boundaries
- [`docs/quickstart.md`](./docs/quickstart.md)
- [`docs/configuration.md`](./docs/configuration.md)
- [`docs/tools-reference.md`](./docs/tools-reference.md)
- [`docs/bridge-workflow.md`](./docs/bridge-workflow.md)
- [`docs/handoff.md`](./docs/handoff.md) — execution job contract
- [`docs/usage.md`](./docs/usage.md) — end-to-end walkthrough
- [`docs/transport-and-auth.md`](./docs/transport-and-auth.md)
- [`docs/client-integrations.md`](./docs/client-integrations.md)
- [`SKILL.md`](./SKILL.md) — agent guidance
