# Examples

Concrete integrations and annotated walk-throughs. These sit in the repo `examples/` directory so they stay close to the code; this page catalogs them.

## Client Configs

- [`examples/claude-code.md`](../examples/claude-code.md) — one-liner CLI registration for Claude Code.
- [`examples/cursor.mcp.json`](../examples/cursor.mcp.json) — Cursor MCP config.

For more clients (Windsurf, Continue, Zed, Cline, Claude Desktop, Docker, remote HTTP), see [`client-integrations.md`](./client-integrations.md).

## Tool Usage Walk-Through

- [`examples/tool-usage.md`](../examples/tool-usage.md) — request payloads for every tool: discovery, planning, execution (bridge, NEAR Intents, LI.FI Intents), recipient setup, broadcast and tracking.
- [`docs/usage.md`](./usage.md) — end-to-end walkthroughs with live responses.


## Pairing With `local-signer-mcp`

See the ["Pairing with local-signer-mcp" section of client-integrations.md](./client-integrations.md#pairing-with-local-signer-mcp) for a combined client config that lists both servers.

## Recommendations

- Start with `examples/tool-usage.md` when learning the flow.
- Use the Cursor config as a template — it is the minimum viable setup.
- Copy the Docker block from [`client-integrations.md`](./client-integrations.md) when you want the MCP out of your host environment.
