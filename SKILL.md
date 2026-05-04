# Allbridge Bridge Flow

Use this MCP server for bridge planning and execution only. Do not use it for docs consulting or signing setup guidance when the question is about the repository, SDK, or integration examples; use `allbridge-dev-mcp` for that.

## Use This Server When

Use `allbridge-mcp` when the task is to:

- discover bridgeable routes
- evaluate quote options
- validate sender balances before execution
- build an execution job or raw bridge transactions
- handle destination prerequisites such as Stellar trustlines or Algorand opt-ins
- track bridge transfers
- inspect past transfer history through the explorer

Do not use it as a wallet signer.

## Default Workflow

1. Call `plan_bridge_transfer`. The default `protocol: "auto"` returns options for both Allbridge Core and Allbridge NEXT side by side under `core` and `next` keys; pass `protocol: "core"` or `"next"` only when the user explicitly pins a protocol.
2. If the token symbol is ambiguous on the chain, supply the exact token address before planning again.
3. Review the options under `core` and/or `next`. Decide between protocols based on what the user cares about (output amount, speed, supported messengers, fee asset).
4. **If the user picks a Core route:**
   1. Call `check_sender_balances` as a sender balance preflight.
   2. If the preflight says balances are short, warn the user. Do not treat that response as a hard stop unless the user wants you to stop.
   3. Call `create_bridge_execution_job` for the normal execution path.
   4. Use `build_bridge_transactions` only when you need the lower-level raw transaction flow.
   5. Hand each step to `local-signer-mcp` or another signer.
   6. Use `broadcast_signed_transaction` for already-signed payloads.
5. **If the user picks a NEXT route:**
   1. Pass the chosen route plus `sourceAddress`, `destinationAddress`, and the chosen `relayerFee` to `build_next_transaction`.
   2. Hand the unsigned `tx` to a signer.
   3. Use `broadcast_signed_transaction` for the signed payload.
6. Call `get_transfer_status` (Core) or track on the source chain explorer (NEXT) until the transfer reaches a terminal state.

## Rules

- Prefer `plan_bridge_transfer` over directly calling lower-level quote and route tools. Default `protocol: "auto"` returns options from both Core and NEXT in one call.
- Use `protocol: "core"` or `protocol: "next"` only when the user explicitly pins a protocol.
- The `plan_bridge_transfer` response is always wrapped: `{ protocols, core, next, errors }`. Read fields from `result.core.*` / `result.next.*`. Both protocols may be present, only one, or neither (when both fail).
- For NEXT-only flows: `list_next_chains`, `list_next_tokens`, `quote_next_swap`, `build_next_transaction`. NEXT uses `tokenId` (not address) as primary identifier.
- NEXT does not have an execution-job equivalent. After `build_next_transaction`, sign and broadcast directly.
- Prefer `check_sender_balances` before `create_bridge_execution_job` and `build_bridge_transactions`.
- Treat `check_sender_balances` as advisory preflight, not a hard blocker.
- Prefer `create_bridge_execution_job` over manually assembling the raw transaction flow.
- Treat `build_bridge_transactions` as a lower-level tool for debugging and custom integration work.
- Use `broadcast_signed_transaction` only for already signed payloads with a supported `chainFamily`.
- Do not assume a single-step flow. Approval and bridge can be separate steps.
- Do not assume bridge execution is EVM-only. The source chain family can be EVM, Solana, Tron, Algorand, Stacks, Soroban/Stellar, or Sui, and the returned handoff reflects that family.
- For destination chains that need account setup, use `check_stellar_trustline` / `build_stellar_trustline_transaction` or `check_algorand_optin` / `build_algorand_optin_transaction` before the main bridge step when `destinationSetup.required` is true.
- Do not mark a transfer complete until `get_transfer_status` shows the receive side or another terminal transfer state.
- Use `search_allbridge_transfers` for account history, transfer search, and explorer filtering.
- Use `get_allbridge_transfer` when the transfer ID is already known.
- When more than one wallet exists for a family, include `walletId` on the signed payload so the correct wallet can be selected deterministically.
- For EVM, resolve broadcast RPC by `walletId` first when present, then by `chainSymbol`, then `chainId`, then the default RPC env var.

## Expected Inputs

Planning usually requires:

- source chain
- destination chain
- token symbol or token address
- amount
- sender address
- recipient address
- confirm source token and destination token when the route is ambiguous or when the UI needs explicit token selection

Execution job creation usually requires:

- source token address
- destination token address
- sender address
- recipient address
- amount
- chosen messenger
- chosen fee payment method

## Expected Outputs

The normal output of this MCP is one of:

- a route and quote plan
- an execution job
- a broadcast result for a signed transaction
- a transfer status payload
- an explorer transfer record or filtered transfer list
