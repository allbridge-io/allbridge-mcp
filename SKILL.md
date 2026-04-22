# Allbridge Bridge Flow

Use this MCP server for bridge orchestration, not for signing.

## When To Use

Use `allbridge-mcp` when the task is to:

- discover bridgeable routes
- evaluate quote options
- validate sender and fee balances before execution
- build an execution job
- track a bridge transfer

Do not use it as a wallet signer.

## Default Workflow

1. Call `plan_bridge_transfer`
2. Choose the route option
3. Call `check_bridge_balances`
4. Only if `canProceed` is true, call `create_bridge_execution_job`
5. Execute the returned steps with a signer
6. If needed, call `broadcast_signed_transaction` for a signed step
7. Call `get_transfer_status` until the transfer resolves

## Rules

- Prefer `plan_bridge_transfer` over directly calling lower-level quote and route tools.
- Prefer `check_bridge_balances` before `create_bridge_execution_job` and `build_bridge_transactions`.
- Prefer `create_bridge_execution_job` over manually assembling the raw transaction flow.
- Treat `build_bridge_transactions` as a lower-level tool for debugging and integration work.
- Use `broadcast_signed_transaction` only for already signed payloads with a supported `chainFamily`.
- Do not assume a single-step flow. Approval and bridge can be separate steps.
- Do not assume bridge execution is EVM-only. The source chain family can be EVM, Solana, Tron, Algorand, Stacks, Soroban/Stellar, or Sui, and the returned handoff reflects that family.
- Do not mark a transfer complete until `get_transfer_status` shows the receive side or other terminal transfer state.
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
