# Tool Usage Examples

## 1. Inspect supported chains and tokens

Request:

```json
{
  "name": "list_supported_chains",
  "arguments": {
    "tokenType": "swap"
  }
}
```

Expected result:

- supported chain symbols and aliases
- chain names and types
- token counts per chain

Request:

```json
{
  "name": "list_supported_tokens",
  "arguments": {
    "tokenType": "swap",
    "chain": "Ethereum"
  }
}
```

Expected result:

- supported token symbols and addresses for the selected chain
- token decimals and chain metadata

## 2. Plan a bridge transfer

Request:

```json
{
  "name": "plan_bridge_transfer",
  "arguments": {
    "sourceChain": "ETH",
    "destinationChain": "SOL",
    "amount": "1",
    "amountUnit": "human",
    "tokenType": "swap",
    "sourceTokenSymbol": "USDC"
  }
}
```

Expected result (envelope `{ protocols, core, next, errors }`):

- `protocols`: which protocols were queried (defaults to both Core and NEXT)
- `core` (when present): normalized amount, route details, available messengers, recommended quote option, next-action guidance
- `next` (when present): normalized amount, NEXT route details, NEXT route options
- `errors`: per-protocol failure descriptors when running `auto` and one protocol fails

Pass `protocol: "core"` or `protocol: "next"` to scope to a single protocol when the user has explicitly pinned one.

## 3. Create an execution job

Request:

```json
{
  "name": "create_bridge_execution_job",
  "arguments": {
    "sourceTokenAddress": "0xsource",
    "destinationTokenAddress": "0xdestination",
    "senderAddress": "0xsender",
    "walletId": "MAINNET",
    "recipientAddress": "0xrecipient",
    "amount": "1",
    "amountUnit": "human",
    "messenger": "ALLBRIDGE",
    "feePaymentMethod": "WITH_NATIVE_CURRENCY",
    "outputFormat": "json"
  }
}
```

Expected result:

- `jobId`
- `summary`
- top-level `handoff` metadata
- ordered `steps`
- `tracking`
- `nextAction`

Example source-family coverage:

- Solana source routes produce a `handoff.walletSelector.chainFamily` of `SOLANA`
- Tron source routes produce a `handoff.walletSelector.chainFamily` of `TRX`
- EVM source routes produce a `handoff.walletSelector.chainFamily` of `EVM`

Each step also includes:

- `handoff.executionTarget`
- `handoff.executionTool`
- `handoff.broadcastTarget`
- `handoff.broadcastTool`
- `handoff.walletSelector`
- `handoff.transactionShape`

## 4. Track the transfer

Request:

```json
{
  "name": "get_transfer_status",
  "arguments": {
    "sourceChain": "ETH",
    "txId": "0xsourceTransactionHash"
  }
}
```

Expected result:

- send details
- receive details when available
- signature progress
- source and destination chain symbols

## 5. Broadcast an already signed transaction

Request:

```json
{
  "name": "broadcast_signed_transaction",
  "arguments": {
    "chainFamily": "EVM",
    "chainId": 11155111,
    "chainSymbol": "ETH",
    "walletId": "MAINNET",
    "signedTransaction": "0xdeadbeef"
  }
}
```

Expected result:

- `txHash`
- `receipt`

Requirements:

- configure the RPC URL for the selected chain family
- include `walletId` when more than one wallet exists for that family
- pass the matching signed payload shape for that family

## 6. Broadcast an already signed Solana transaction

Request:

```json
{
  "name": "broadcast_signed_transaction",
  "arguments": {
    "chainFamily": "SOLANA",
    "walletId": "SOL_MAIN",
    "signedTransactionHex": "0xdeadbeef"
  }
}
```

Expected result:

- `txHash`
- `receipt`

Requirements:

- configure `ALLBRIDGE_SOL_RPC_URL`
- include `walletId` when more than one Solana wallet exists
- pass a Solana signed transaction in hex form

## 7. Hand off a job step to `local-signer-mcp`

`allbridge-mcp` returns the execution step. A client can then send that step to `local-signer-mcp` for signing and optional broadcast.

Request:

```json
{
  "name": "sign_and_broadcast_transaction",
  "arguments": {
    "chainFamily": "SOLANA",
    "walletId": "SOL_MAIN",
    "serializedTransactionHex": "0xdeadbeef"
  }
}
```

Expected result:

- signed payload and/or `txHash`, depending on the signer path

Requirements:

- run `local-signer-mcp` alongside `allbridge-mcp`
- pass the unsigned step payload returned by `create_bridge_execution_job`
- include `walletId` when multiple wallets exist for the same family
- include `walletId` on `create_bridge_execution_job` when you want the job pinned to a specific wallet

The same step can also be broadcast later with `allbridge-mcp.broadcast_signed_transaction` if the client only signs locally and submits separately.
