# Overview

`allbridge-mcp` is the coordination layer for Allbridge Core transfers driven by an AI agent.

It wraps the [Allbridge Core SDK](https://www.npmjs.com/package/@allbridge/bridge-core-sdk) and the Allbridge Core API in agent-friendly tools. An agent can discover routes, compare quotes across messengers, check that the sender can cover the transfer, build ready-to-sign transactions, broadcast signed ones and track the result — without ever touching a private key.

## Role in the Two-Server Split

- `allbridge-mcp` plans, validates, builds and tracks. It is the "what should happen" surface.
- [`local-signer-mcp`](https://github.com/allbridge-io/local-signer-mcp) signs and broadcasts. It is the "sign this now" surface.

Every step of an execution job carries an unsigned transaction in the shape `local-signer-mcp` accepts, so the agent forwards it without conversion. A client can also sign elsewhere (hardware wallet, remote signer) and hand the signed payload back to `broadcast_signed_transaction`.

## Messengers

- **Bridge messengers** — `CCTP_V2`, `OFT`, `X_RESERVE`: deterministic Allbridge fee; the destination gas fee is paid in the native currency, the source token or ABR.
- **Intent messengers** — `NEAR_INTENTS`, `LIFI_INTENTS`: market-priced quotes from solver networks; they can deliver a different token or a native currency, and refund the sender when they cannot complete.

## Capability Boundary

`allbridge-mcp` can:

- list chains and tokens and find the messengers for a pair
- quote every messenger for an amount
- check sender balances for the amount and the gas fee
- build execution jobs with approvals and signer-ready transactions
- create NEAR Intents deposits and LI.FI Intents orders
- check and build Stellar trustlines for recipients
- broadcast signed transactions
- track transfers and search the explorer

`allbridge-mcp` cannot:

- sign transactions or hold private keys
- choose a wallet for the user

## When to Reach For It

Use `allbridge-mcp` when the task is to move tokens across chains, compare routes and fees, prepare transactions, or check what happened to a transfer. Skip it when you only need signing or wallet management — that is `local-signer-mcp`.

## Related Pages

- [Quickstart](./quickstart.md)
- [Bridge Workflow](./bridge-workflow.md)
- [Tools Reference](./tools-reference.md)
- [Execution Job Contract](./handoff.md)
