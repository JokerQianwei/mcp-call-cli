# cfw-mcp-call

## Scope

- 公开发布的通用 Streamable HTTP MCP CLI，不包含任何 CFW 领域逻辑或配置。
- 禁止提交 MCP 地址、认证 Header、Token、内部域名、IP 或用户配置。
- CFW 的 `mcp.json` 与 Skill 归私有 `cfw-plugins` 仓库维护。

## Commands

```bash
npm test
npm run check
npm pack --dry-run
```

发布前检查 tarball 文件列表，并扫描内部地址与凭据；真实执行 `npm publish` 前需人工确认。
