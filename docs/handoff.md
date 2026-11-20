# Execution Job Contract (v2)

`create_bridge_execution_job` returns a job that tells the client exactly what to sign, in which order, and with which wallet. `allbridge-mcp` never signs; `local-signer-mcp` never plans. The contract is validated by `validateBridgeExecutionJobContract` in [`src/execution-job-contract.ts`](../src/execution-job-contract.ts).

## Shape

```json
{
  "jobId": "4f2c…",
  "kind": "bridge_transfer",
  "version": "v2",
  "mode": "external_signer",
  "status": "awaiting_signature",
  "summary": "Bridge 10 USDC from ETH to ARB to 0x2222…",
  "route": { "source": { … }, "destination": { … }, "messenger": "CCTP_V2", "feePaymentMethod": "WITH_NATIVE_CURRENCY" },
  "participants": { "senderAddress": "0x1111…", "recipientAddress": "0x2222…" },
  "amount": { "amountInBaseUnits": "10000000", "amountInHumanUnits": "10" },
  "quote": { "messenger": "CCTP_V2", "kind": "bridge", "amountToReceive": { … }, "feePaymentOptions": [ … ] },
  "intent": null,
  "balanceValidation": { "canProceed": true, "requiredBalances": [ … ], "notes": [ … ] },
  "destinationSetup": null,
  "handoff": { "executionTool": "sign_and_broadcast_transaction", "stepId": "approve", "stepCount": 2, "stepIds": ["approve", "bridge"], … },
  "steps": [ … ],
  "tracking": {
    "sourceChain": "ETH",
    "destinationChain": "ARB",
    "transferStatusTool": "get_transfer_status",
    "transferStatusArguments": { "sourceChain": "ETH", "txId": "<bridge step transaction hash>" },
    "historyUrlTemplate": "https://core.allbridge.io/history/ETH/{txId}"
  },
  "nextAction": "…"
}
```

`status` is `requires_build` when the first step must be built first (LI.FI Intents from Solana), otherwise `awaiting_signature`.

## Steps

```json
{
  "id": "approve",
  "order": 1,
  "type": "sign_and_submit_transaction",
  "status": "awaiting_signature",
  "required": true,
  "summary": "Approve USDC spending on ETH for CCTP_V2.",
  "transactionFormat": "unsignedEvmTransaction",
  "transaction": {
    "chainFamily": "EVM",
    "chainId": 1,
    "chainSymbol": "ETH",
    "from": "0x1111…",
    "to": "0xA0b8…",
    "data": "0x095ea7b3…",
    "value": "0"
  },
  "build": null,
  "waitForConfirmation": true,
  "handoff": { "stepId": "approve", "nextStepId": "bridge", … },
  "nextOnSuccess": "bridge"
}
```

- `id` — `reset_allowance`, `approve` or `bridge`.
- `status` — `awaiting_signature` for the first step, `blocked` for later ones, `requires_build` for a first step without a transaction.
- `transaction` — the unsigned transaction, ready for `local-signer-mcp` `sign_and_broadcast_transaction`; `null` when the step has a `build` block.
- `build` — `{ tool, arguments, reason }`: call `tool` with `arguments` right before signing to get the transaction (`create_lifi_intents_order`).
- `waitForConfirmation` — wait for the transaction to confirm before the next step.

### Transaction formats

| `transactionFormat` | `transaction` |
|---------------------|---------------|
| `unsignedEvmTransaction` | `chainFamily: "EVM"`, `chainId`, `chainSymbol`, `from`, `to`, `data`, `value` (wei, decimal) |
| `serializedSolanaTransactionHex` | `chainFamily: "SOLANA"`, `serializedTransactionHex` (versioned transaction) |
| `tronRawTransaction` | `chainFamily: "TRX"`, `rawTransaction` (TronWeb transaction object) |
| `serializedStacksTransactionHex` | `chainFamily: "STX"`, `serializedTransactionHex` |
| `stellarTransactionXdr` | `chainFamily: "SRB"`, `serializedTransactionXdr` |

When `walletId` is passed to `create_bridge_execution_job`, every transaction carries it so the signer picks that wallet.

## Handoff

Each step and the job carry a `handoff` block:

```json
{
  "executionTarget": "local-signer-mcp",
  "executionTool": "sign_and_broadcast_transaction",
  "executionAction": "sign_and_broadcast",
  "broadcastTarget": "allbridge-mcp",
  "broadcastTool": "broadcast_signed_transaction",
  "broadcastAction": "broadcast",
  "walletSelector": { "walletId": null, "senderAddress": "0x1111…", "chainFamily": "EVM", "chainSymbol": "ETH" },
  "stepId": "approve",
  "transactionFormat": "unsignedEvmTransaction",
  "nextStepId": "bridge"
}
```

Two valid paths:

- **Local signing** — send `transaction` to `local-signer-mcp` `sign_and_broadcast_transaction`; it returns the hash.
- **External signing** — sign `transaction` with any wallet that understands the format, then call `allbridge-mcp` `broadcast_signed_transaction`.

## Intent

`intent` describes the intent messenger part of the job:

- NEAR Intents — `depositAddress`, `depositMemo`, `deadline`, `amountToSend`, `amountToReceive`, `minAmountToReceive`, and `submitDepositArguments` for `submit_near_intents_deposit`.
- LI.FI Intents — `buildTool`, `minAmountToReceive`, `maxSlippagePercent`, `bridgeContract`.

## Destination Setup

```json
{
  "required": true,
  "type": "stellar_trustline",
  "chainSymbol": "SRB",
  "accountAddress": "GA5Z…",
  "tokenAddress": "CCW6…",
  "checkTool": "check_stellar_trustline",
  "buildTool": "build_stellar_trustline_transaction",
  "reason": "The recipient must add a Stellar trustline for USDC before it can receive the transfer."
}
```

`required: null` means the check itself failed (for example, the Stellar account does not exist yet). `type: "solana_token_account"` has no build tool: the recipient must create the token account themselves.
