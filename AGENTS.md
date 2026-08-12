# cfw-mcp-call

## Scope

- This is a public, general-purpose Streamable HTTP MCP CLI.
- Keep all source code, comments, documentation, tests, and commit messages in English.
- Never commit private MCP endpoints, authentication headers, tokens, internal domains, IP addresses, or user configuration.

## Commands

```bash
npm test
npm run check
npm pack --dry-run
```

Before publishing, inspect the tarball file list and scan it for private endpoints and credentials. Require explicit human confirmation before running `npm publish`.
