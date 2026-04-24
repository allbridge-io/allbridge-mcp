# Handoff Model

`allbridge-mcp` never signs. `local-signer-mcp` never plans. The handoff model lets a client move a step from one to the other deterministically.

## What the Agent Receives

Every step returned by `create_bridge_execution_job` carries a `handoff` block:

```json
{
  "handoff": {
    "executionTarget": "local-signer-mcp",
    "executionTool": "sign_and_broadcast_transaction",
    "broadcastTarget": "allbridge-mcp",
    "broadcastTool": "broadcast_signed_transaction",
    "walletSelector": {
      "chainFamily": "EVM",
      "chainSymbol": "ETH",
      "chainId": 1,
      "walletId": "MAINNET"
    },
    "transactionShape": {
      "format": "unsignedEvmTransaction"
    }
  }
}
```

Field meanings:

- `executionTarget` / `executionTool` — the server and tool that should own the next action. For unsigned steps this is `local-signer-mcp.sign_and_broadcast_transaction`.
- `broadcastTarget` / `broadcastTool` — the fallback when only broadcasting is needed (the payload is already signed elsewhere). This is `allbridge-mcp.broadcast_signed_transaction`.
- `walletSelector` — the hints the signer or broadcaster needs to pick a specific local wallet when multiple are configured.
- `transactionShape` — the family-specific payload format the signer should expect.

There is also a top-level `handoff` on the job itself that summarizes the primary execution target for the job as a whole.

## Two Valid Paths

### Path A — full local flow

1. `allbridge-mcp.create_bridge_execution_job` returns the next step.
2. The client forwards the step to `local-signer-mcp.sign_and_broadcast_transaction`.
3. `local-signer-mcp` signs, broadcasts, and returns `txHash`.
4. `allbridge-mcp.get_transfer_status` takes over from `txHash`.

This is the default local recommendation: `stdio` signer next to an `stdio` or HTTP bridge MCP.

### Path B — external signer, Allbridge broadcast

1. `allbridge-mcp.create_bridge_execution_job` returns the next step.
2. The client sends the step to whatever external signer owns the key (hardware wallet, mobile wallet, remote HSM).
3. The external signer returns a signed payload.
4. The client calls `allbridge-mcp.broadcast_signed_transaction` with that payload.
5. `allbridge-mcp.get_transfer_status` takes over from `txHash`.

Use this path when the key lives somewhere `local-signer-mcp` cannot reach.

## Wallet Selector

`walletSelector` is how the agent tells the signer which wallet to use when more than one is configured.

| Field | Meaning |
|-------|---------|
| `chainFamily` | `EVM`, `SOLANA`, `TRX`, `ALG`, `STX`, `SRB`, `SUI` |
| `chainSymbol` | Optional chain short name for EVM routes |
| `chainId` | Optional EVM chain id |
| `walletId` | Local wallet slot id; matches the signer's env-var naming |

When the source chain family exposes more than one wallet, always include `walletId`. The signer will refuse to guess.

Pass `walletId` as an input on `create_bridge_execution_job` to pin the entire job to a specific wallet up front.

## Destination Setup

If the destination chain is Stellar or Algorand, a `destinationSetup` hint can appear next to the execution steps:

```json
{
  "destinationSetup": {
    "required": true,
    "type": "stellar_trustline",
    "checkTool": "check_stellar_trustline",
    "buildTool": "build_stellar_trustline_transaction"
  }
}
```

Follow the `checkTool` first. If it says a trustline or opt-in is missing, the recipient account holder needs to sign the output of `buildTool` before the bridge step can succeed.

## Transaction Shape

The `transactionShape` hint lets the signer avoid guessing at the payload layout:

- `unsignedEvmTransaction` — EVM shape with from, to, data, gas hints, and nonce slot.
- `serializedSolanaTransactionHex` — hex-encoded Solana transaction.
- Analogous shapes for Tron, Algorand, Stacks, Soroban / Stellar, and Sui.

The signer inspects `transactionShape.format` before choosing which signing code path to run.

## One-Line Summary

> `handoff` is the contract the two servers use to make sure every step has exactly one owner.
