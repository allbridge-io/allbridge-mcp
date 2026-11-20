# Allbridge Bridge Flow

Use this MCP server to plan, build and track Allbridge Core transfers. It never signs: pair it with `local-signer-mcp` (or any external signer) for signing. For questions about the repository, the SDK or integration code, use `allbridge-dev-mcp` instead.

## Use This Server When

- the user wants to move tokens between chains
- you need the supported chains, tokens or routes
- you need quotes, fees or the expected received amount
- you need to check the sender's balance before a transfer
- you need ready-to-sign transactions for a transfer
- the recipient needs a Stellar trustline
- you need the status of a transfer or its history in the explorer

## Default Workflow

1. **Plan.** Call `plan_bridge_transfer` with the chains, token symbol and amount. If a symbol is ambiguous on a chain, pass the exact token address. Options are sorted by the amount received; `unavailableOptions` explains messengers that cannot quote (amount limits, no liquidity).
2. **Choose with the user.** Show the amount to receive, the time and the fees. For bridge messengers (`CCTP_V2`, `OFT`, `X_RESERVE`) also choose the fee payment method. For intent messengers (`NEAR_INTENTS`, `LIFI_INTENTS`) explain that they are market-priced and refund the sender if they cannot complete.
3. **Collect addresses.** Ask for the sender and recipient addresses. Never invent them; with `local-signer-mcp`, `get_accounts` lists the local wallets.
4. **Build the job.** Call `create_bridge_execution_job` with the token addresses (and `sourceChain` / `destinationChain` for native currencies, which share an address across EVM chains), the addresses, the amount, the messenger and the fee payment method.
5. **Check the job.** If `balanceValidation.canProceed` is false, tell the user what is missing. If `destinationSetup.required` is true, the recipient must act first (for Stellar, sign `build_stellar_trustline_transaction`).
6. **Execute the steps in order.** Pass each step's `transaction` to `local-signer-mcp` `sign_and_broadcast_transaction`. Wait for a step with `waitForConfirmation: true` to confirm before the next one.
7. **Track.** Call `get_transfer_status` with the source chain and the bridge step transaction hash. `state` is `pending`, `completed`, `refunded` or `not_found` (not indexed yet: retry in 30-60 seconds).

## Intent Messengers

- **NEAR_INTENTS.** The job creates a one-time deposit and its bridge step is a plain transfer to the deposit address. Send it before `intent.deadline`. After broadcasting, you may call `submit_near_intents_deposit` with `intent.submitDepositArguments` and the real transaction hash.
- **LIFI_INTENTS.** The bridge step has `transaction: null` and a `build` block. After any approve step confirms, call `create_lifi_intents_order` with `build.arguments` and sign the returned `step.transaction` immediately: the order is valid for 40-120 seconds (`order.secondsToSign`). On `price_changed`, show the new amount and call again with the new `minAmountToReceive` only if the user accepts. On `approval_required`, the approve step has not confirmed yet.

## Rules

- Confirm the route, amount, recipient and fees with the user before signing anything.
- Do not reuse an old job: Solana and Tron transactions expire about a minute after they are built (the local signer refreshes unsigned ones), NEAR deposits have a deadline and LI.FI orders last seconds. When in doubt, build a new job.
- Amounts are human units by default (`amountUnit: "human"`); results always give both `inBaseUnits` and `inHumanUnits`.
- `feePaymentMethod: WITH_STABLECOIN` deducts the gas fee from the amount; `WITH_NATIVE_CURRENCY` needs the native currency on top.
- On `rpc_unavailable` or rate-limit errors, the operator should set `ALLBRIDGE_<CHAIN>_RPC_URL`.

## Do Not

- Do not sign, and do not ask the user for private keys.
- Do not call `create_lifi_intents_order` before the approve step has confirmed, or long before signing.
- Do not treat `not_found` from `get_transfer_status` as a failure right after broadcasting.
