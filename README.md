# cfw-mcp-call

面向 Agent 的轻量 Streamable HTTP MCP CLI。工具定义按需加载，默认以紧凑的
TOON 文本输出。

## 安装

```bash
npm install -g cfw-mcp-call
```

## 配置

默认读取 `~/.config/mcp-call/mcp.json`，也可通过 `MCP_CONFIG` 或
`--config <path>` 指定：

```json
{
  "mcpServers": {
    "example": {
      "url": "https://example.com/mcp"
    }
  }
}
```

## 使用

```bash
mcp-call
mcp-call check
mcp-call example tools
mcp-call example tools tool_name
mcp-call example tool_name '{"key":"value"}'
```

使用 `--json` 输出紧凑 JSON，使用 `--full` 查看完整工具说明和 Schema。
