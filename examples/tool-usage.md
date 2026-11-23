# Tool Usage Examples

Request payloads for each tool. Full responses and the end-to-end flow are in [`docs/usage.md`](../docs/usage.md).

## Discover

```json
{ "name": "list_supported_chains", "arguments": {} }
```

```json
{ "name": "list_supported_tokens", "arguments": { "chain": "Base" } }
```

```json
{ "name": "find_bridge_routes", "arguments": { "sourceChain": "TRX", "destinationChain": "ARB", "sourceTokenSymbol": "USDT", "destinationTokenSymbol": "USD₮0" } }
```

## Plan

```json
{ "name": "plan_bridge_transfer", "arguments": { "sourceChain": "ARB", "destinationChain": "SOL", "sourceTokenSymbol": "USDC", "amount": "50" } }
```

Native currency (shared EVM address, so the chain is required with addresses):

```json
{
  "name": "quote_bridge_transfer",
  "arguments": {
    "sourceTokenAddress": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    "sourceChain": "ARB",
    "destinationTokenAddress": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    "destinationChain": "BAS",
    "amount": "0.01"
  }
}
```

```json
{
  "name": "check_sender_balances",
  "arguments": {
    "sourceTokenAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "destinationTokenAddress": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "senderAddress": "0x1111111111111111111111111111111111111111",
    "amount": "10",
    "messenger": "CCTP_V2",
    "feePaymentMethod": "WITH_NATIVE_CURRENCY"
  }
}
```

## Execute

```json
{
  "name": "create_bridge_execution_job",
  "arguments": {
    "sourceTokenAddress": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "destinationTokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "senderAddress": "0x1111111111111111111111111111111111111111",
    "recipientAddress": "0x1111111111111111111111111111111111111111",
    "amount": "100",
    "messenger": "LIFI_INTENTS",
    "maxSlippagePercent": 0.5,
    "walletId": "MAIN"
  }
}
```

Pass a step transaction to the signer as is:

```json
{ "name": "sign_and_broadcast_transaction", "arguments": { "chainFamily": "EVM", "chainId": 42161, "chainSymbol": "ARB", "walletId": "MAIN", "from": "0x1111…", "to": "0xaf88…", "data": "0x095ea7b3…", "value": "0" } }
```

LI.FI Intents bridge step, right before signing:

```json
{
  "name": "create_lifi_intents_order",
  "arguments": {
    "sourceTokenAddress": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "sourceChain": "ARB",
    "destinationTokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "destinationChain": "BAS",
    "senderAddress": "0x1111111111111111111111111111111111111111",
    "recipientAddress": "0x1111111111111111111111111111111111111111",
    "amount": "100000000",
    "amountUnit": "base",
    "minAmountToReceive": "99383169"
  }
}
```

NEAR Intents, after broadcasting the deposit:

```json
{ "name": "submit_near_intents_deposit", "arguments": { "depositAddress": "0xbC56…1e5D", "txId": "0x…" } }
```

Broadcast a transaction signed elsewhere:

```json
{ "name": "broadcast_signed_transaction", "arguments": { "chainFamily": "SOLANA", "signedTransactionHex": "01ab…" } }
```

## Recipient setup

```json
{ "name": "check_stellar_trustline", "arguments": { "address": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "tokenAddress": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" } }
```

```json
{ "name": "build_stellar_trustline_transaction", "arguments": { "accountAddress": "GA5Z…", "tokenAddress": "CCW6…" } }
```

## Track

```json
{ "name": "get_transfer_status", "arguments": { "sourceChain": "BSC", "txId": "0x5121170758690f871d667d33e47e0641c6397ad2b691f7b8af7a15bdd126f5b7" } }
```

```json
{ "name": "search_allbridge_transfers", "arguments": { "query": "0x5121170758690f871d667d33e47e0641c6397ad2b691f7b8af7a15bdd126f5b7" } }
```

```json
{ "name": "search_allbridge_transfers", "arguments": { "from": "ETH", "to": "TRX", "status": "Complete", "limit": 5 } }
```

```json
{ "name": "get_allbridge_transfer", "arguments": { "transferId": "0x9df22df8986ce94ce5b66f41bfddc54c304ddeaf61b2883a0aa2f4d6829a625e" } }
```
