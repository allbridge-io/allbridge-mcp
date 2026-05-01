# Usage

End-to-end walkthrough for driving `allbridge-mcp` from an AI agent. The running example bridges **50 USDC from Ethereum to Solana** using `local-signer-mcp` to sign.

For configuration (env vars, transports, auth), see the [repo README](../README.md).

If you pair this server with `local-signer-mcp`, configure the signer first. The signer reads its own `.env` file or client `env` block and needs a matching private key and RPC URL for the chain family you plan to sign on. For example, an EVM local setup uses `LOCAL_SIGNER_EVM_PRIVATE_KEY` and `LOCAL_SIGNER_EVM_RPC_URL`. For Docker, pass the same variables through `--env-file /absolute/path/to/local-signer.env`.

## The five-step flow

1. **Plan** — pick a route and messenger.
2. **Preflight** — verify sender balances and fees.
3. **Build** — materialize an execution job with ready-to-sign steps.
4. **Sign and broadcast** — hand each step to `local-signer-mcp`.
5. **Track** — poll until the receive side lands.

Steps 1, 2, 3, and 5 are this server. Step 4 is the signer.

## 1. Plan the route

```json
{
  "name": "plan_bridge_transfer",
  "arguments": {
    "sourceChain": "ETH",
    "destinationChain": "SOL",
    "sourceTokenSymbol": "USDC",
    "amount": "50",
    "amountUnit": "human"
  }
}
```

Response carries a normalized amount, source/destination token details, messenger options, a recommended option, `bridgePortalUrl`, and a `nextAction` hint. If you don't know the symbols yet, call `list_supported_chains` and `list_supported_tokens` first. For a direct route comparison or a cheaper slice, use `find_bridge_routes` or `quote_bridge_transfer`.

If a chain exposes more than one token with the same symbol, provide the exact token address on the planning call so the server does not have to guess between contracts.

## 2. Preflight balances

```json
{
  "name": "check_sender_balances",
  "arguments": {
    "sourceTokenAddress": "0xA0b8...eB48",
    "destinationTokenAddress": "EPj...Dt1v",
    "senderAddress": "0xSender...",
    "recipientAddress": "SolRecipient...",
    "amount": "50",
    "amountUnit": "human",
    "messenger": "ALLBRIDGE",
    "feePaymentMethod": "WITH_NATIVE_CURRENCY"
  }
}
```

Treat `check_sender_balances` as a preflight, not a hard stop for the rest of the flow. If `canProceed` is `false`, the response still tells you exactly which balance is short so the agent can warn the user or continue with job construction if that is the intended behavior.

## 3. Build the execution job

```json
{
  "name": "create_bridge_execution_job",
  "arguments": {
    "sourceTokenAddress": "0xA0b8...eB48",
    "destinationTokenAddress": "EPj...Dt1v",
    "senderAddress": "0xSender...",
    "recipientAddress": "SolRecipient...",
    "amount": "50",
    "amountUnit": "human",
    "messenger": "ALLBRIDGE",
    "feePaymentMethod": "WITH_NATIVE_CURRENCY",
    "walletId": "main"
  }
}
```

The job response contains:

- `jobId`
- ordered `steps` (typically approval + bridge, or just bridge)
- ready-to-sign transaction payloads per step
- `balanceValidation` so the agent can see whether the preflight passed or needs user attention
- a `handoff` block per step (below)
- `walletSelector` — matches the `walletId` input
- `destinationSetup` — hints for Stellar trustlines / Algorand opt-ins when needed
- `tracking` — how to follow up
- `bridgePortalUrl` — web fallback

Every step looks like this:

```json
{
  "stepId": "step_1",
  "description": "Approve USDC spend",
  "transaction": { /* EVM/Solana/etc. family-specific payload */ },
  "handoff": {
    "executionTarget": "local-signer-mcp",
    "executionTool": "sign_and_broadcast_transaction",
    "broadcastTarget": "allbridge-mcp",
    "broadcastTool": "broadcast_signed_transaction",
    "walletSelector": { "walletId": "main" },
    "transactionShape": "evm"
  }
}
```

`handoff` is the agent's instruction manual: whichever server is named in `executionTarget`, call the tool named in `executionTool` and pass the transaction plus the `walletSelector`.

Passing `walletId` on the input pins every step's `walletSelector` to that wallet, so the signer's choice is deterministic.

If the signer is not configured yet, stop here and ask the user to set up `local-signer-mcp` with a `.env` file or client environment variables before trying to sign.

## 4. Sign and broadcast

For each step, call the tool `handoff` points at. For a normal local-wallet flow:

```json
{
  "name": "sign_and_broadcast_transaction",
  "arguments": {
    "chainFamily": "EVM",
    "walletId": "main",
    "transaction": { /* step.transaction */ }
  }
}
```

The signer signs, submits, and returns the transaction hash. If the payload was signed elsewhere, route it back through this server:

```json
{
  "name": "broadcast_signed_transaction",
  "arguments": {
    "chainFamily": "EVM",
    "signedTransaction": "0x..."
  }
}
```

### Destination setup (if needed)

When the destination is **Stellar** and `destinationSetup.required` is `true`, run before the main transfer:

```json
{ "name": "check_stellar_trustline", "arguments": { "account": "G...", "assetCode": "USDC", "assetIssuer": "G..." } }
```

If the trustline is missing, build it with `build_stellar_trustline_transaction` and sign it the same way as any other step.

Same shape for **Algorand**: `check_algorand_optin` + `build_algorand_optin_transaction`.

## 5. Track the transfer

```json
{
  "name": "get_transfer_status",
  "arguments": {
    "sourceChain": "ETH",
    "txId": "0xSourceTransactionHash"
  }
}
```

Returns signature progress, send and receive transactions, the Allbridge history URL, and a terminal-state flag. Poll until the receive side lands.

When the user references an older transfer, `search_allbridge_transfers` can either:

- resolve a `query` through the explorer search index and expand address or transfer hits
- or list transfers directly with explorer filters such as `account` (alone or with `chain`), `from`, `to`, `status`, `minFromAmount`, `maxFromAmount`, `page`, and `limit`

If the address history spans multiple networks, add `chain`, `from`, or `to` to narrow it to one network or one direction.

## Error shape

All tools return the same envelope:

```json
{
  "ok": false,
  "error": {
    "code": "insufficient_balance",
    "message": "Sender cannot cover the bridged amount",
    "details": { "token": "USDC", "needed": "50", "available": "10" }
  }
}
```

Common codes: `invalid_chain`, `invalid_token`, `insufficient_balance`, `route_not_found`, `messenger_unavailable`. Use `error.code` and `error.details` to ask the user the right follow-up question instead of retrying blindly.

## Tool catalogue

**Bridge flow.** `plan_bridge_transfer`, `list_supported_chains`, `list_supported_tokens`, `find_bridge_routes`, `quote_bridge_transfer`, `check_sender_balances`, `create_bridge_execution_job`, `build_bridge_transactions`, `get_transfer_status`, `search_allbridge_transfers`, `get_allbridge_transfer`.

**Destination prerequisites.** `check_stellar_trustline`, `build_stellar_trustline_transaction`, `check_algorand_optin`, `build_algorand_optin_transaction`.

**Broadcast.** `broadcast_signed_transaction`.

Run `pnpm inspect` to see the live input/output schema for each tool.
