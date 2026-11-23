# Client Integrations

Copy-paste recipes for the most common MCP clients. Replace every `/absolute/path/...` with the real path on the machine running the client.

## Which Transport To Use

- `stdio` — the client can launch a local process on the same machine.
- `streamable-http` — the client can only accept a URL, or the MCP lives in a different environment than the client.

When in doubt, start with `stdio`.

## Path Or npx

The recipes below start a local checkout (`node /absolute/path/to/allbridge-mcp/dist/index.js`), which suits development. To run the published package instead, replace the command with `npx` and pin the version:

```json
{ "command": "npx", "args": ["-y", "@allbridge/allbridge-mcp@0.2.0"] }
```

The `env` block stays the same.

## Codex

```bash
codex mcp add allbridge -- npx -y @allbridge/allbridge-mcp@0.2.0
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.allbridge]
command = "npx"
args = ["-y", "@allbridge/allbridge-mcp@0.2.0"]
```

## Claude Desktop

1. Open `Settings`.
2. Go to `Developer`.
3. Open `Local MCP servers`.
4. Click `Edit Config`.
5. Merge the block below into the existing JSON. Keep any `preferences` or other keys already there.

```json
{
  "mcpServers": {
    "allbridge": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/allbridge-mcp/dist/index.js"],
      "env": {
        "ALLBRIDGE_ETH_RPC_URL": "https://your-eth-rpc.example.com"
      }
    }
  }
}
```

Notes:

- Use an absolute path to the Node binary if you manage versions with `nvm`, `asdf`, or `volta`. The desktop client does not inherit your shell PATH.
- Run `which node` after selecting the desired version and paste that path into `command`.
- If you bump Node versions later, update this path. It will not auto-resolve.

## Claude Code

```bash
claude mcp add allbridge \
  --env ALLBRIDGE_ETH_RPC_URL=https://your-eth-rpc.example.com \
  -- /absolute/path/to/node /absolute/path/to/allbridge-mcp/dist/index.js
```

## Cursor

Save as `~/.cursor/mcp.json` (user-wide) or `.cursor/mcp.json` in the project root:

```json
{
  "mcpServers": {
    "allbridge": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/allbridge-mcp",
      "env": {
        "ALLBRIDGE_ETH_RPC_URL": "https://your-eth-rpc.example.com"
      }
    }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "allbridge": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/allbridge-mcp/dist/index.js"],
      "env": {
        "ALLBRIDGE_ETH_RPC_URL": "https://your-eth-rpc.example.com"
      }
    }
  }
}
```

## Continue

`~/.continue/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "allbridge",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/allbridge-mcp/dist/index.js"],
      "env": {
        "ALLBRIDGE_ETH_RPC_URL": "https://your-eth-rpc.example.com"
      }
    }
  ]
}
```

## Zed

`~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "allbridge": {
      "command": {
        "path": "/absolute/path/to/node",
        "args": ["/absolute/path/to/allbridge-mcp/dist/index.js"],
        "env": {
          "ALLBRIDGE_ETH_RPC_URL": "https://your-eth-rpc.example.com"
        }
      }
    }
  }
}
```

## Cline

Paste into the Cline MCP settings UI:

```json
{
  "mcpServers": {
    "allbridge": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/allbridge-mcp/dist/index.js"],
      "env": {
        "ALLBRIDGE_ETH_RPC_URL": "https://your-eth-rpc.example.com"
      }
    }
  }
}
```

## Remote connector / hosted agent

Use `streamable-http` only when the client requires a URL. Example bearer setup:

```json
{
  "mcpServers": {
    "allbridge": {
      "url": "https://your-allbridge-mcp.example.com",
      "headers": {
        "Authorization": "Bearer replace-me"
      }
    }
  }
}
```

If the client insists on `https://`, terminate TLS at a reverse proxy in front of the MCP. The server speaks plain HTTP on the configured port.

## Docker-based client registration

```json
{
  "mcpServers": {
    "allbridge": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--env-file",
        "/absolute/path/to/allbridge.env",
        "allbridge/io.allbridge.mcp:latest",
        "node",
        "dist/index.js"
      ],
      "env": {}
    }
  }
}
```

Prefer `--env-file` over inline `env` so you are not pasting keys into client config.

## Pairing with `local-signer-mcp`

Most real flows run `local-signer-mcp` next to `allbridge-mcp`. The same client config normally lists both entries:

```json
{
  "mcpServers": {
    "allbridge": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/allbridge-mcp/dist/index.js"],
      "env": { "ALLBRIDGE_ETH_RPC_URL": "https://your-eth-rpc.example.com" }
    },
    "local-signer": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/local-signer-mcp/dist/index.js"],
      "env": {
        "LOCAL_SIGNER_EVM_PRIVATE_KEY": "0xyourprivatekey",
        "LOCAL_SIGNER_EVM_RPC_URL": "https://your-rpc.example"
      }
    }
  }
}
```

See the [`local-signer-mcp` README](https://github.com/allbridge-io/local-signer-mcp) for signer-side configuration details.
