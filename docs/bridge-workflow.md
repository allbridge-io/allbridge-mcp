# Bridge Workflow

The same five stages cover every messenger. Intent messengers add one call each.

```
plan_bridge_transfer ─► create_bridge_execution_job ─► sign & broadcast steps ─► get_transfer_status
                                                      │
                     LIFI_INTENTS: create_lifi_intents_order right before signing the bridge step
                     NEAR_INTENTS: submit_near_intents_deposit after broadcasting (optional)
```

## 1. Plan

Call `plan_bridge_transfer` with the chains, the token symbol and the amount:

```json
{ "sourceChain": "Ethereum", "destinationChain": "Arbitrum", "sourceTokenSymbol": "USDC", "amount": "100" }
```

- Pass `destinationTokenSymbol` when the destination token differs (intent messengers can turn USDC into USDT or ETH).
- When a chain has several tokens with the same symbol, the tool returns `ambiguous_token` with the candidates; repeat with the exact token address.
- `options` are sorted by the amount received. `unavailableOptions` explains the rest — typically `amount_too_low` / `amount_too_high` with the limit, or `quote_unavailable` when no solver quotes the amount right now.

## 2. Choose

Show the user, for each option, the amount to receive, the time and the fees:

- **Bridge messengers** (`CCTP_V2`, `OFT`, `X_RESERVE`) list `feePaymentOptions`: the destination gas fee in the native currency (paid on top), in the source token (deducted from the amount) or in ABR.
- **Intent messengers** (`NEAR_INTENTS`, `LIFI_INTENTS`) are market-priced. NEAR Intents states a `minAmountToReceive` after slippage; LI.FI Intents states the `allbridgeFee` included in the amount. Both refund the sender if the transfer cannot complete (NEAR Intents minus a refund fee; LI.FI keeps the Allbridge fee).

Then collect the sender and recipient addresses.

## 3. Build the Job

Call `create_bridge_execution_job` with token addresses, addresses, amount, messenger and fee payment method. Before signing, check:

- `balanceValidation.canProceed` — whether the sender holds the amount and the gas fee. The job is built either way.
- `destinationSetup` — whether the recipient must act first:
  - `stellar_trustline` — a Stellar recipient needs a trustline for the token; `build_stellar_trustline_transaction` builds it for the recipient to sign;
  - `solana_token_account` — a Solana recipient of a LI.FI Intents order needs a token account, otherwise the order is not filled and is refunded.
- `steps` — in order. A step with `waitForConfirmation: true` must confirm on chain before the next one.

## 4. Execute

For each step, pass `step.transaction` to `local-signer-mcp` `sign_and_broadcast_transaction`. To sign elsewhere, sign the same payload and call `broadcast_signed_transaction` here.

### NEAR Intents

The job created a one-time deposit (`intent.depositAddress`, `intent.deadline`) and the bridge step is a plain transfer of the amount to it (with `depositMemo` on Stellar). Send it before the deadline: funds arriving later may be lost. After broadcasting, `submit_near_intents_deposit` with `intent.submitDepositArguments` and the real hash makes NEAR Intents pick it up sooner.

### LI.FI Intents

A LI.FI order is valid for 40-120 seconds, so the bridge step has no transaction yet:

1. Sign the `approve` step if there is one (EVM tokens) and wait for it to confirm.
2. Call `create_lifi_intents_order` with the bridge step `build.arguments`.
3. Sign `step.transaction` from the result immediately (`order.secondsToSign` says how long is left).

`create_lifi_intents_order` protects the user:

- `approval_required` — the allowance is not in place yet; wait for the approve step.
- `price_changed` — the order pays less than `minAmountToReceive` (the quote minus `maxSlippagePercent`, 0.5% by default). Show the new amount; if the user accepts, call again with `minAmountToReceive` set to the new amount.
- It refuses an EVM transaction that does not call the Allbridge `LifiIntentsBridge` contract from the sender.

If the order expires before it is signed, call `create_lifi_intents_order` again.

### Expiring transactions

- Solana transactions carry a blockhash valid for about a minute, Tron transactions expire after 60 seconds. `local-signer-mcp` refreshes both when it signs an unsigned transaction; other signers should sign right away or rebuild the job.
- Ethereum USDT needs its allowance reset to zero before a new approval; the job adds a `reset_allowance` step when needed.

## 5. Track

Call `get_transfer_status` with the source chain and the bridge step transaction hash:

- `pending` — sent, not delivered yet;
- `completed` — delivered (`receive` has the destination transaction);
- `refunded` — an intent transfer could not complete; `refundTxId` and `refundedAmount` describe the refund;
- `not_found` — the Core API has not indexed the transaction yet; retry in 30-60 seconds.

`historyUrl` opens the transfer in the Allbridge Core web app. For older transfers, `search_allbridge_transfers` finds them by address or hash.
