# Examples

Concrete integrations and annotated walk-throughs. These sit in the repo `examples/` directory so they stay close to the code; this page catalogs them.

## Client Configs

- [`examples/claude-code.md`](../examples/claude-code.md) — one-liner CLI registration for Claude Code.
- [`examples/cursor.mcp.json`](../examples/cursor.mcp.json) — Cursor MCP config.

For more clients (Windsurf, Continue, Zed, Cline, Claude Desktop, Docker, remote HTTP), see [`client-integrations.md`](./client-integrations.md).

## Tool Usage Walk-Through

- [`examples/tool-usage.md`](../examples/tool-usage.md) — annotated JSON request and response samples for:
  1. Inspecting supported chains and tokens (`list_supported_chains`, `list_supported_tokens`)
  2. Planning a bridge transfer (`plan_bridge_transfer`)
  3. Creating an execution job (`create_bridge_execution_job`)
  4. Tracking a transfer (`get_transfer_status`)
  5. Broadcasting an already-signed EVM transaction (`broadcast_signed_transaction`)
  6. Broadcasting an already-signed Solana transaction
  7. Handing a step off to `local-signer-mcp` (`sign_and_broadcast_transaction`)

Each block shows both the request payload and the expected output fields.

## Pairing With `local-signer-mcp`

See the ["Pairing with local-signer-mcp" section of client-integrations.md](./client-integrations.md#pairing-with-local-signer-mcp) for a combined client config that lists both servers.

## Recommendations

- Start with `examples/tool-usage.md` when learning the flow.
- Use the Cursor config as a template — it is the minimum viable setup.
- Copy the Docker block from [`client-integrations.md`](./client-integrations.md) when you want the MCP out of your host environment.
