# Developer Assistant

`allbridge-mcp` ships a small, read-only helper surface so an agent can answer "how do I integrate X?" without leaving the MCP session. It does not touch any blockchain state.

## Surfaces

- `search_allbridge_documentation` — ranked snippet search across allowlisted scopes.
- `get_allbridge_product_summary` — per-group summary of capabilities, boundaries, and recommended tools.
- `list_available_coding_resources` — docs and code references scoped to a group.
- `get_coding_resource_details` — full content for one or more listed resources.

## Allowlisted Scopes

The search and resource tools only see content from a curated set:

- project documentation
- SDK integration guides
- REST API integration guides
- worked examples and recipe files

This keeps results focused on content that is safe to cite in an agent answer.

## Recommended Usage Pattern

1. `search_allbridge_documentation` — narrow from a natural-language question to the most relevant snippets.
2. `get_allbridge_product_summary` — pick the right group (`bridge`, `dev`, or `broadcast`) based on which snippets looked most relevant.
3. `list_available_coding_resources` — pull the top-level list of resources for that group.
4. `get_coding_resource_details` — fetch full content for the specific resources you want to cite.

This staged pattern keeps per-call payloads small and makes the agent's reasoning easier to audit.

## Example

```json
{
  "name": "search_allbridge_documentation",
  "arguments": {
    "query": "how do I approve an ERC-20 before a bridge"
  }
}
```

Follow-up:

```json
{
  "name": "get_allbridge_product_summary",
  "arguments": {
    "group": "bridge"
  }
}
```

Then:

```json
{
  "name": "list_available_coding_resources",
  "arguments": {
    "group": "bridge"
  }
}
```

Finally, when you know which resource you want:

```json
{
  "name": "get_coding_resource_details",
  "arguments": {
    "ids": ["approval-before-bridge"]
  }
}
```

## Groups

| Group | What it covers |
|-------|----------------|
| `bridge` | Route discovery, planning, execution, destination prerequisites, tracking |
| `dev` | Documentation search and resource lookup — the assistant surface itself |
| `broadcast` | Signed-transaction submission across chain families |

## When to Use the Assistant

Reach for the developer assistant when the agent needs:

- an implementation reference for an SDK call
- a REST API endpoint contract
- an example of a concrete bridge flow
- clarification on the boundary between `allbridge-mcp` and `local-signer-mcp`
- a worked sample for an edge case (Stellar trustlines, Algorand opt-ins, EVM approval flow, multi-wallet selection)

Skip it when you already have the correct tool in mind — call that tool directly instead.
