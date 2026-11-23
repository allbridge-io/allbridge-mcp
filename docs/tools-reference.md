# Tools Reference

Every tool returns `structuredContent`. Failures return `isError: true` with:

```json
{ "ok": false, "error": { "code": "amount_too_low", "message": "...", "details": { } } }
```

Error codes: `missing_input`, `unsupported_chain`, `unsupported_token`, `ambiguous_token`, `invalid_amount`, `invalid_address`, `unsupported_route`, `amount_too_low`, `amount_too_high`, `quote_unavailable`, `price_changed`, `approval_required`, `rpc_unavailable`, `upstream_error`, `validation_error`.

Amounts in results always come as `{ inBaseUnits, inHumanUnits }`. Inputs take `amount` plus `amountUnit` (`human` by default, or `base`).

Tokens are addressed in two ways:

- by chain and symbol (`sourceChain`, `sourceTokenSymbol`, …) in `plan_bridge_transfer` and `find_bridge_routes`;
- by address (`sourceTokenAddress`, `destinationTokenAddress`) in the other tools. Native currencies of EVM chains share the placeholder address `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`, so pass `sourceChain` / `destinationChain` with them.

## Discovery

### `list_supported_chains`

No input. Returns `chains[]` with `chainSymbol`, `chainName`, `chainType`, `tokenCount` and `aliases` (e.g. `Ethereum`, `Base`, `Tron`).

### `list_supported_tokens`

| Input | Notes |
|-------|-------|
| `chain` | Optional chain symbol or alias; omit for every chain |

With `chain`, returns that `chain` (with its `aliases`) and its `tokens`; without it, `chains[]`, each with its `tokens`. Token fields: `symbol`, `name`, `tokenAddress`, `decimals`, `chainSymbol`, `chainName`, `chainType`, `isNative`.

### `find_bridge_routes`

| Input | Notes |
|-------|-------|
| `sourceChain`, `destinationChain` | Required |
| `sourceTokenSymbol` | Required |
| `sourceTokenAddress`, `destinationTokenSymbol`, `destinationTokenAddress` | Optional; the destination symbol defaults to the source symbol |

Returns `availableMessengers` for the pair, without quoting.

## Planning

### `plan_bridge_transfer`

Same inputs as `find_bridge_routes` plus `amount` and `amountUnit`. Quotes every available messenger:

- `options[]` — sorted by the amount received. Each option has `messenger`, `kind` (`bridge` or `intent`), `estimatedTimeMs` and `amountToReceive`.
  - bridge options: `feePaymentOptions[]` with `feePaymentMethod`, `fee` (`asset`: `native`, `source_token` or `abr`) and the `amountToReceive` for that method;
  - intent options: `provider`, `minAmountToReceive` (NEAR Intents), `allbridgeFee` (LI.FI Intents), `estimated` and `notes`.
- `recommendedOption` — the first option.
- `unavailableOptions[]` — messengers that could not quote, with the error `code` and `details` (for example `amount_too_low` with `minAmount`).
- `bridgePortalDeepLink` — the same transfer in the Allbridge Core web app.

### `quote_bridge_transfer`

Same output as `plan_bridge_transfer`, addressed by token addresses (`sourceTokenAddress`, `destinationTokenAddress`, optional `sourceChain`, `destinationChain`), `amount`, `amountUnit`.

### `check_sender_balances`

| Input | Notes |
|-------|-------|
| token addresses, `amount`, `amountUnit` | As in `quote_bridge_transfer` |
| `senderAddress` | Validated for the source chain |
| `messenger` | `CCTP_V2`, `OFT`, `X_RESERVE`, `NEAR_INTENTS`, `LIFI_INTENTS` |
| `feePaymentMethod` | `WITH_NATIVE_CURRENCY` (default), `WITH_STABLECOIN`, `WITH_ABR`; ignored by intents |

Returns `requiredBalances[]` (`kind`: `source_token`, `source_native`, `fee_native`, `fee_abr`; `requiredBaseUnits`, `availableBaseUnits`, `satisfied`, and `error` when a balance could not be read), `canProceed`, `notes` and `nextAction`. A stablecoin gas fee is deducted from the amount, so it needs no extra balance. Network transaction fees are not included.

## Execution

### `create_bridge_execution_job`

| Input | Notes |
|-------|-------|
| token addresses, `amount`, `amountUnit`, `messenger`, `feePaymentMethod` | As above |
| `senderAddress`, `recipientAddress` | Validated for their chains |
| `walletId` | Optional `local-signer-mcp` wallet id, copied into every step |
| `maxSlippagePercent` | `LIFI_INTENTS` only: accepted drop from the quote before `create_lifi_intents_order` stops, 0 to 5 (default 0.5) |

Returns the execution job (contract: [handoff.md](./handoff.md)): `quote`, `balanceValidation`, `destinationSetup`, `intent`, ordered `steps[]`, `tracking`, `nextAction` and `bridgePortalDeepLink` (the same transfer in the Allbridge Core web app, for a user who signs in their own wallet). Steps:

- `reset_allowance` — Ethereum USDT only, when a non-zero allowance must be reset before approving;
- `approve` — EVM and Tron tokens without enough allowance (EVM only for `LIFI_INTENTS`); none for native currencies, `NEAR_INTENTS`, or Solana, Stacks and Stellar sources;
- `bridge` — the transfer. For `LIFI_INTENTS` it has `transaction: null` and a `build` block.

### `create_lifi_intents_order`

Build step for LI.FI Intents. Takes the job bridge step `build.arguments`: token addresses and chains, `senderAddress`, `recipientAddress`, `amount`, `amountUnit`, `minAmountToReceive` (destination base units), optional `walletId`. Without `minAmountToReceive` there is no `price_changed` check, so always pass the one from the job.

Returns `order` (`orderId`, `validUntil`, `fillDeadline`, `secondsToSign`), the order `quote`, a signer-ready `step` and `tracking` (`explorerTransferId` is the order id). Stops with:

- `approval_required` — the allowance for the LI.FI Intents bridge is missing (the approve step has not confirmed);
- `price_changed` — the order pays less than `minAmountToReceive`; `details.orderAmountToReceive` has the new amount;
- `validation_error` — the transaction does not call the Allbridge `LifiIntentsBridge` contract from the sender, or the order asks for an approval to another spender.

### `submit_near_intents_deposit`

| Input | Notes |
|-------|-------|
| `depositAddress`, `depositMemo` | From the job `intent.submitDepositArguments` |
| `txId` | Hash of the broadcast deposit transaction |

Optional: tells NEAR Intents about the deposit so it is detected sooner.

### `broadcast_signed_transaction`

| `chainFamily` | Payload |
|---------------|---------|
| `EVM` | `chainId`, optional `chainSymbol`, `signedTransaction` (hex) |
| `SOLANA` | `signedTransactionHex` |
| `TRX` | `signedTransaction` (signed transaction object) |
| `STX` | `signedTransactionHex` |
| `SRB` | `signedTransactionXdr` |

Returns `txHash` and a `receipt` when the chain provides one. The payload is validated against its family before broadcasting.

## Recipient Setup

### `check_stellar_trustline`

`address`, `tokenAddress` (a non-native Stellar token from `list_supported_tokens`). Returns `required` (true when the trustline is missing) and the balance line.

### `build_stellar_trustline_transaction`

`accountAddress`, `tokenAddress`, optional `limit` and `walletId`. Returns an unsigned Stellar `changeTrust` transaction the recipient signs.

## Tracking

### `get_transfer_status`

`sourceChain`, `txId` (the bridge step transaction hash). Returns `state` (`pending`, `completed`, `refunded`, or `not_found` while the Core API has not indexed the transaction), the send and receive transactions, refund details (`refundTxId`, `refundedAmount`) and `historyUrl`.

### `search_allbridge_transfers`

Either `query` (address, transaction hash or transfer id) or list filters, not both. Filters: `account`, `chain` or `from` / `to`, `status` (`Complete`, `Pending`), `minFromAmount`, `maxFromAmount`, `page` (default 1), `limit` (default 10, at most 20). Returns normalized transfers with the raw explorer record.

### `get_allbridge_transfer`

`transferId`. Returns one explorer transfer with its transactions.
