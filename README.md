# mcp-call-cli

A lightweight Streamable HTTP MCP CLI for agents. It discovers tool definitions
on demand and emits compact TOON output by default.

## Install

```bash
npm install -g mcp-call-cli
```

Requires Node.js 18 or newer.

## Configure

The default configuration path is `~/.config/mcp-call/mcp.json`. Override it
with `MCP_CONFIG` or `--config <path>`.

```json
{
  "mcpServers": {
    "example": {
      "url": "https://example.com/mcp"
    }
  }
}
```

Both a top-level server map and a map nested under `mcpServers` are accepted.

Manage the local configuration without exposing endpoint or header values:

```bash
mcp-call config list
mcp-call config add example --url https://example.com/mcp
mcp-call config import ./mcp.json
mcp-call config remove example
```

## Use

```bash
mcp-call
mcp-call check
mcp-call example tools
mcp-call example tools tool_name
mcp-call example tool_name '{"key":"value"}'
```

Use `--json` for compact JSON. Use `--full` to show complete tool descriptions
and schemas.

Run `mcp-call --help` for the full command reference.
