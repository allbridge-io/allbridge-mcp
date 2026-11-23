# Usage

End-to-end walkthrough for driving `allbridge-mcp` from an AI agent, with `local-signer-mcp` signing. The responses below are trimmed outputs of the live Core API.

Configure `local-signer-mcp` first: it needs a private key and RPC for the chain family you sign on (for EVM, `LOCAL_SIGNER_EVM_PRIVATE_KEY` and `LOCAL_SIGNER_EVM_RPC_URL`). See its README for the full variable matrix.

## The flow

1. **Plan** — compare messengers for the amount.
2. **Build** — create the execution job for the chosen messenger.
3. **Sign and broadcast** — hand each step to `local-signer-mcp`.
4. **Track** — check the transfer until it lands.

Intent messengers add one call: `create_lifi_intents_order` (LI.FI Intents, before signing) or `submit_near_intents_deposit` (NEAR Intents, optional, after broadcasting).

## Example A — 100 USDC from Ethereum to Arbitrum

### 1. Plan

```json
{
  "name": "plan_bridge_transfer",
  "arguments": { "sourceChain": "Ethereum", "destinationChain": "Arbitrum", "sourceTokenSymbol": "USDC", "amount": "100" }
}
```

```json
{
  "availableMessengers": ["CCTP_V2"],
  "options": [
    {
      "messenger": "CCTP_V2",
      "kind": "bridge",
      "estimatedTimeMs": 120000,
      "amountToReceive": { "inBaseUnits": "99885015", "inHumanUnits": "99.885015" },
      "feePaymentOptions": [
        { "feePaymentMethod": "WITH_NATIVE_CURRENCY", "fee": { "inHumanUnits": "0.000135346499447952", "asset": "native", "symbol": "ETH" }, "amountToReceive": { "inHumanUnits": "99.885015" } },
        { "feePaymentMethod": "WITH_STABLECOIN", "fee": { "inHumanUnits": "0.239043", "asset": "source_token", "symbol": "USDC" }, "amountToReceive": { "inHumanUnits": "99.646247" } },
        { "feePaymentMethod": "WITH_ABR", "fee": { "inHumanUnits": "1.912337760000003399", "asset": "abr", "symbol": "ABR" }, "amountToReceive": { "inHumanUnits": "99.885015" } }
      ]
    }
  ],
  "unavailableOptions": [],
  "bridgePortalDeepLink": "https://core.allbridge.io/?f=ETH&t=ARB&ft=USDC&tt=USDC&send=100&messenger=CCTP_V2"
}
```

The user picks `CCTP_V2` and pays the gas fee in USDC (deducted from the amount).

### 2. Build

```json
{
  "name": "create_bridge_execution_job",
  "arguments": {
    "sourceTokenAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "destinationTokenAddress": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "senderAddress": "0x1111111111111111111111111111111111111111",
    "recipientAddress": "0x1111111111111111111111111111111111111111",
    "amount": "10",
    "messenger": "CCTP_V2",
    "feePaymentMethod": "WITH_STABLECOIN"
  }
}
```

```json
{
  "status": "awaiting_signature",
  "balanceValidation": {
    "canProceed": true,
    "requiredBalances": [{ "kind": "source_token", "label": "USDC balance on ETH", "requiredBaseUnits": "10000000", "availableBaseUnits": "1528855507", "satisfied": true }],
    "notes": ["The 0.239043 USDC gas fee is deducted from the transferred amount.", "Network transaction fees on ETH are paid in ETH on top of these amounts."]
  },
  "steps": [
    {
      "id": "approve",
      "status": "awaiting_signature",
      "waitForConfirmation": true,
      "transactionFormat": "unsignedEvmTransaction",
      "transaction": { "chainFamily": "EVM", "chainId": 1, "chainSymbol": "ETH", "from": "0x1111…", "to": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "data": "0x095ea7b3…", "value": "0" }
    },
    {
      "id": "bridge",
      "status": "blocked",
      "transactionFormat": "unsignedEvmTransaction",
      "transaction": { "chainFamily": "EVM", "chainId": 1, "chainSymbol": "ETH", "from": "0x1111…", "to": "0x7972d6907739593C00e6284c53C83dB3ECd15c33", "data": "0x7dfb08f1…", "value": "0" }
    }
  ]
}
```

### 3. Sign and broadcast

```json
{ "name": "sign_and_broadcast_transaction", "arguments": { "chainFamily": "EVM", "chainId": 1, "chainSymbol": "ETH", "from": "0x1111…", "to": "0xA0b8…", "data": "0x095ea7b3…", "value": "0" } }
```

Wait for the approval to confirm, then send the `bridge` step the same way and keep its `txHash`.

### 4. Track

```json
{ "name": "get_transfer_status", "arguments": { "sourceChain": "ETH", "txId": "0x…bridge hash…" } }
```

`state` moves from `not_found` (not indexed yet) to `pending` and `completed`.

## Example B — 20 USDC from Arbitrum to Base through NEAR Intents

`create_bridge_execution_job` with `"messenger": "NEAR_INTENTS"` creates a deposit and returns one step, a USDC `transfer` to the deposit address:

```json
{
  "route": { "messenger": "NEAR_INTENTS", "feePaymentMethod": null },
  "intent": {
    "provider": "NEAR Intents",
    "depositAddress": "0xbC56Aa6E947148a63A617Df97090E1bEA9731e5D",
    "depositMemo": null,
    "deadline": "2026-11-23T10:52:28.000Z",
    "amountToSend": { "inHumanUnits": "20" },
    "amountToReceive": { "inHumanUnits": "19.975602" },
    "minAmountToReceive": { "inHumanUnits": "19.775845" },
    "submitDepositTool": "submit_near_intents_deposit",
    "submitDepositArguments": { "depositAddress": "0xbC56…1e5D", "txId": "<bridge step transaction hash>" }
  },
  "steps": [{ "id": "bridge", "transaction": { "chainFamily": "EVM", "chainId": 42161, "to": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "data": "0xa9059cbb…" } }]
}
```

Sign and broadcast the step before the deadline, then optionally:

```json
{ "name": "submit_near_intents_deposit", "arguments": { "depositAddress": "0xbC56…1e5D", "txId": "0x…hash…" } }
```

## Example C — 100 USDC from Arbitrum to Base through LI.FI Intents

`create_bridge_execution_job` with `"messenger": "LIFI_INTENTS"` returns the approval and a bridge step without a transaction:

```json
{
  "intent": { "provider": "LI.FI Intents", "minAmountToReceive": { "inHumanUnits": "99.383169" }, "maxSlippagePercent": 0.5, "bridgeContract": "0xf01C98b3BEf6cc96BD484E092Cc2A56016ac2eD6" },
  "quote": { "kind": "intent", "amountToReceive": { "inHumanUnits": "99.882582" }, "allbridgeFee": { "inHumanUnits": "0.1", "symbol": "USDC" } },
  "steps": [
    { "id": "approve", "status": "awaiting_signature", "transaction": { "chainFamily": "EVM", "to": "0xaf88…5831", "data": "0x095ea7b3…" } },
    {
      "id": "bridge",
      "status": "blocked",
      "transaction": null,
      "build": {
        "tool": "create_lifi_intents_order",
        "arguments": {
          "sourceTokenAddress": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "sourceChain": "ARB",
          "destinationTokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "destinationChain": "BAS",
          "senderAddress": "0x1111…", "recipientAddress": "0x1111…",
          "amount": "100000000", "amountUnit": "base", "minAmountToReceive": "99383169"
        }
      }
    }
  ]
}
```

1. Sign the `approve` step and wait for it to confirm.
2. Call `create_lifi_intents_order` with `build.arguments`. It returns `order` (`orderId`, `validUntil`, `secondsToSign`) and `step.transaction`, a call to `LifiIntentsBridge`.
3. Sign `step.transaction` at once. If it fails with `price_changed`, ask the user about the new amount; if the order expired, call `create_lifi_intents_order` again.

Track with `get_transfer_status` as in example A.

## Without a signer

When no signer is connected, or the agent does not sign transactions itself, it gives the user `bridgePortalDeepLink` from the plan or the job. The link opens the transfer in the Allbridge Core web app with the chains, tokens, amount and messenger filled in; the user connects a wallet, checks the recipient (not part of the link) and the fee payment method, and signs there. The server instructions and every `nextAction` tell the agent to do this.

## Handling errors

| Code | What to do |
|------|-----------|
| `ambiguous_token` | Repeat with the exact token address (or `sourceChain` for native currencies) |
| `amount_too_low` / `amount_too_high` | Use `details.minAmount` / `details.maxAmount` |
| `quote_unavailable` | No solver quotes the amount now; try another messenger or later |
| `approval_required` | The approve step has not confirmed yet |
| `price_changed` | Ask the user; call again with the new `minAmountToReceive` |
| `rpc_unavailable`, `upstream_error` with status 429 | The operator should set `ALLBRIDGE_<CHAIN>_RPC_URL` |
