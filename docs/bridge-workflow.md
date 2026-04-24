# Bridge Workflow

This page walks through the end-to-end bridge flow an agent is expected to drive with `allbridge-mcp`.

## The Mental Model

A bridge transfer is five conceptual steps:

1. Understand the ask — which chains, which token, how much.
2. Plan — pick a route and a messenger.
3. Preflight — verify the sender can cover the amount and fees.
4. Execute — sign and submit the source-chain transaction.
5. Track — wait for the receive side to confirm.

`allbridge-mcp` owns steps 1, 2, 3, and 5. Step 4 happens either through [`local-signer-mcp`](https://github.com/allbridge-io/local-signer-mcp) or via an external signer that hands back a signed payload for `broadcast_signed_transaction`.

## Recommended Flow

### 1. Describe the transfer

The user says something like "bridge 50 USDC from Ethereum to Solana". That is enough to start planning. If the agent does not know the symbols yet, it can first inspect the directory:

- `list_supported_chains`
- `list_supported_tokens`

### 2. Plan

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

The response includes:

- normalized amount
- source and destination token details
- messenger options
- a recommended option
- a next-action hint
- `bridgePortalName`, `bridgePortalUrl`, and `bridgePortalDeepLink` for the Allbridge Core web flow

If the user or agent needs to compare routes directly, `find_bridge_routes` and `quote_bridge_transfer` expose lower-level slices.

### 3. Preflight balances

Before building anything, validate that the sender can cover the move:

```json
{
  "name": "check_bridge_balances",
  "arguments": {
    "sourceTokenAddress": "0xsource",
    "destinationTokenAddress": "0xdestination",
    "senderAddress": "0xsender",
    "recipientAddress": "SOL_RECIPIENT",
    "amount": "50",
    "amountUnit": "human",
    "messenger": "ALLBRIDGE",
    "feePaymentMethod": "WITH_NATIVE_CURRENCY"
  }
}
```

The result carries `canProceed`. Stop and ask the user to top up if it is `false`.

### 4. Build the execution job

```json
{
  "name": "create_bridge_execution_job",
  "arguments": {
    "sourceTokenAddress": "0xsource",
    "destinationTokenAddress": "0xdestination",
    "senderAddress": "0xsender",
    "recipientAddress": "SOL_RECIPIENT",
    "amount": "50",
    "amountUnit": "human",
    "messenger": "ALLBRIDGE",
    "feePaymentMethod": "WITH_NATIVE_CURRENCY"
  }
}
```

The job returns:

- a `jobId`
- ordered `steps` (typically approval + bridge, or a single bridge step)
- transaction payloads for each step
- `handoff` metadata per step (see [handoff.md](./handoff.md))
- `walletSelector` hints
- `destinationSetup` hints for Stellar trustlines and Algorand opt-ins when the destination chain needs them
- a `tracking` block
- `bridgePortalName`, `bridgePortalUrl`, `bridgePortalDeepLink`

If the intended local wallet is already known, pass `walletId` on the input so the job gets pinned to that wallet.

### 5. Hand off each step

Inspect `handoff.executionTarget` and `handoff.executionTool` on each step:

- `local-signer-mcp.sign_and_broadcast_transaction` — the expected path for unsigned steps.
- `allbridge-mcp.broadcast_signed_transaction` — the expected path when the payload is already signed elsewhere.
- `walletSelector` — use `walletId` (or `from` for EVM) so the signer picks the right key.
- `transactionShape` — tells the signer which family-specific payload format to build.

### 6. Handle destination setup, if needed

If the destination chain is Stellar or Algorand and `destinationSetup.required` is `true`, use the helper tools before the main transfer:

- `check_stellar_trustline` / `build_stellar_trustline_transaction`
- `check_algorand_optin` / `build_algorand_optin_transaction`

### 7. Track

After the source-chain transaction is on-chain, call:

```json
{
  "name": "get_transfer_status",
  "arguments": {
    "sourceChain": "ETH",
    "txId": "0xsourceTransactionHash"
  }
}
```

The response carries signature progress, send and receive transaction details, and a direct Allbridge history URL when the source chain and transaction hash are both known. Poll until the receive side lands or the transfer reaches another terminal state.

## Error Handling

Tools return structured errors:

```json
{
  "ok": false,
  "error": {
    "code": "insufficient_balance",
    "message": "Sender cannot cover the bridged amount",
    "details": {}
  }
}
```

Use `error.code` and `error.details` to ask the user for the missing input instead of retrying blindly. Common codes include:

- `invalid_chain`
- `invalid_token`
- `insufficient_balance`
- `route_not_found`
- `messenger_unavailable`

## Orienting Around Past Transfers

When the user references an existing transfer, use the explorer-backed tools:

- `search_allbridge_transfers` — by `query` or by direct explorer filters. Address queries expand into account history without forcing a chain; transfer hashes resolve to a transfer record; direct filters can list transfers by account alone, by chain, by direction, by status, or by amount.
- `get_allbridge_transfer` — when the transfer ID is already known and you want the full record.

## One-Line Summary

> `allbridge-mcp` plans the route, checks balances, builds the job, and tracks the transfer. Signing belongs to `local-signer-mcp` or any other signer that can return a signed payload.
