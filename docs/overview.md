# Overview

`allbridge-mcp` is the coordination layer for bridge workflows driven by an AI agent.

It exposes an agent-friendly interface to the Allbridge REST API and the public explorer. An agent can use it to discover supported routes, plan a transfer, validate that the sender can cover the move, build execution jobs, broadcast already-signed payloads, and track the resulting transfer — without ever touching a private key.

## Role in the Two-Server Split

Allbridge deliberately separates orchestration from signing:

- `allbridge-mcp` plans, validates, builds, and tracks. It is the "what should happen" surface.
- [`local-signer-mcp`](https://github.com/allbridge-io/local-signer-mcp) signs and optionally broadcasts. It is the "sign this payload now" surface.

A client can use `allbridge-mcp` alone if the signing layer lives elsewhere (remote signer, external CLI, pre-signed payloads). It only needs `local-signer-mcp` when local signing is part of the flow.

## Capability Boundary

`allbridge-mcp` can:

- discover routes, tokens, and chains
- plan transfers and return normalized quote options
- check sender and fee balances before execution
- build ordered execution jobs with ready-to-sign steps
- broadcast payloads that are already signed
- track transfer status by source-chain transaction hash
- resolve past transfers from the public explorer

`allbridge-mcp` cannot:

- sign transactions
- hold private keys
- choose a local wallet deterministically when the signed payload does not carry enough context

## When to Reach For It

Use `allbridge-mcp` when the task is to:

- decide which route fits a transfer
- confirm a token pair is supported on both chains
- preflight a transfer against the sender's balance
- hand an agent the next ready-to-execute step
- track a transfer that was already submitted
- search Allbridge docs, SDK references, or example flows for implementation guidance

Skip it when you only need signing or wallet exposure. That is what `local-signer-mcp` is for.

## Related Pages

- [Quickstart](./quickstart.md)
- [Bridge Workflow](./bridge-workflow.md)
- [Tools Reference](./tools-reference.md)
- [Handoff](./handoff.md)
