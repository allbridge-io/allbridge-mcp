# Tools Reference

Every tool in `allbridge-mcp` returns a structured envelope. On success it carries the tool-specific payload. On failure it returns:

```json
{
  "ok": false,
  "error": {
    "code": "string",
    "message": "string",
    "details": {}
  }
}
```

Tools are grouped by responsibility: Bridge, Destination prerequisites, Broadcast.

## Bridge

### `plan_bridge_transfer`

Entry-point planner. Symbol-first input.

Inputs:

- `sourceChain`
- `destinationChain`
- `sourceTokenSymbol`
- `destinationTokenSymbol` (optional)
- `amount`
- `amountUnit` (`"human"` or `"atomic"`)
- `tokenType` (optional; e.g. `"swap"`)

Returns:

- normalized amount
- source and destination token details
- messenger options
- a recommended option
- next-action guidance
- `bridgePortalName`, `bridgePortalUrl`
- `bridgePortalDeepLink` when the route and messenger are known

Use this as the default entry point even if `find_bridge_routes` or `quote_bridge_transfer` look like a closer match; `plan_bridge_transfer` returns the agent guidance those do not.

### `list_supported_chains`

Inputs: `tokenType` (optional).

Returns supported chain symbols, aliases, names, types, and per-chain token counts.

### `list_supported_tokens`

Inputs: `tokenType` (optional), `chain` (optional).

Returns supported token symbols, addresses, decimals, and chain metadata.

### `find_bridge_routes`

Lower-level route discovery. Use when you already have token addresses and want the raw set of routes between them.

### `quote_bridge_transfer`

Token-address-first quote for a known pair.

Returns:

- route token details
- normalized amount
- quote options
- `bridgePortalName`, `bridgePortalUrl`, `bridgePortalDeepLink`

### `check_sender_balances`

Preflight for the sender wallet. Never broadcasts anything. Called implicitly by `create_bridge_execution_job` and `build_bridge_transactions`.

Use this tool when the user asks whether a transfer can proceed, when the sender balance is unknown, or before building any bridge transaction.

Returns:

- source and destination token details
- normalized amount
- selected messenger and fee payment method
- balance requirements for source asset and relayer fee asset
- `canProceed`
- `nextAction`

The `requiredBalances` list shows the balance returned by the API, the required amount, and whether each requirement is satisfied. The tool compares balances in base units internally, but the reported `availableHumanUnits` value keeps the API's human-readable token balance.

### `create_bridge_execution_job`

Builds an ordered, ready-to-sign execution job.

Inputs:

- `sourceTokenAddress`
- `destinationTokenAddress`
- `senderAddress`
- `recipientAddress`
- `amount`, `amountUnit`
- `messenger`
- `feePaymentMethod`
- `walletId` (optional; pins the job to a specific local wallet)
- `outputFormat` (optional; e.g. `"json"`)

Returns:

- `jobId`
- ordered `steps`
- per-step transaction payloads
- top-level and per-step `handoff` metadata
- `walletSelector` hints
- `tracking`
- `destinationSetup` hints when the destination chain is Stellar or Algorand
- a source-chain history URL template
- `summary`
- `bridgePortalName`, `bridgePortalUrl`, `bridgePortalDeepLink`

### `build_bridge_transactions`

Lower-level transaction builder. Use it when you want raw approval and bridge transactions without the higher-level job wrapper, e.g. for debugging or when integrating with a custom execution pipeline.

Returns raw approval and bridge transactions, transaction shape hints, approval requirement metadata, the same `destinationSetup` hints as the job tool, and the balance validation summary used to build them.

Balance validation is advisory in this tool. If you want a hard preflight before signing, call `check_sender_balances` first and inspect `canProceed`.

### `get_transfer_status`

Inputs: `sourceChain`, `txId`.

Returns:

- source and destination chain symbols
- signature progress
- send transaction details
- receive transaction details when available
- a direct Allbridge history URL when the source chain and source transaction hash are known

### `search_allbridge_transfers`

Inputs (all optional): `query`, `account`, `chain`, `from`, `to`, `minFromAmount`, `maxFromAmount`, `status`, `page`, `limit`.

Searches or lists transfers through the public explorer:

- `query` resolves typed hits
- address hits expand into transfer history without forcing a chain
- direct filters such as `account`, `chain`, `from`, `to`, `status`, `minFromAmount`, `maxFromAmount`, `page`, and `limit` list matching transfers directly
- `account` can be queried on its own; no chain is required when you want all transfers for one address across chains
- `status` is normalized to explorer values such as `Complete` and `Pending`

If you want to focus the account history to one chain or one direction, add `chain`, `from`, or `to`.

Omit the query to list recent transfers.

Returns typed explorer hits, matched transfer summaries, explorer URL per transfer, the direct Allbridge history URL when available, and the fields that matched the search query.

### `get_allbridge_transfer`

Inputs: `transferId`.

Returns the normalized transfer summary, the raw explorer record, the explorer URL, and the direct Allbridge history URL when the source chain and source transaction hash are available.

## Destination Prerequisites

These exist because Stellar and Algorand require the recipient account to opt into an asset before it can receive it.

### `check_stellar_trustline`

Verifies that the recipient Stellar account already holds a trustline for the destination token.

### `build_stellar_trustline_transaction`

Builds the trustline transaction when `check_stellar_trustline` says it is missing. The payload is meant to be signed by the Stellar account holder, not by the sender.

### `check_algorand_optin`

Verifies that the recipient Algorand account is already opted into the destination asset or app.

### `build_algorand_optin_transaction`

Builds the opt-in transaction when `check_algorand_optin` reports it is missing.

## Broadcast

### `broadcast_signed_transaction`

Broadcasts an already-signed transaction.

Inputs depend on the chain family:

- EVM: `chainFamily: "EVM"`, `chainId`, optional `chainSymbol`, optional `walletId`, `signedTransaction` (hex string).
- Solana: `chainFamily: "SOLANA"`, optional `walletId`, `signedTransactionHex`.
- Tron, Algorand, Stacks, Soroban / Stellar, Sui: same shape with family-appropriate signed payload.

Returns `txHash` and `receipt` when available.

RPC resolution (EVM):

1. `ALLBRIDGE_EVM_RPC_URL_<walletId>` when `walletId` is present
2. `ALLBRIDGE_EVM_RPC_URL_<chainSymbol>`
3. `ALLBRIDGE_EVM_RPC_URL_<chainId>`
4. `ALLBRIDGE_EVM_RPC_URL`

For non-EVM families, set the matching `ALLBRIDGE_<FAMILY>_RPC_URL` variable.

Include `walletId` on the signed payload when more than one wallet exists for the family so the broadcast layer can pick deterministically.
