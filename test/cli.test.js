import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "mcp-call.js");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-call-test-"));
const configPath = path.join(temporary, "mcp.json");
let server;
let redirectTarget;
let url;
let redirectTargetHits = 0;
let repeatedEmptyCursor = false;

function execute(args, input = "") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "--config", configPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

before(async () => {
  redirectTarget = http.createServer((_request, response) => {
    redirectTargetHits++;
    response.writeHead(500).end();
  });
  await new Promise((resolve) =>
    redirectTarget.listen(0, "127.0.0.1", resolve),
  );

  // A minimal in-process MCP server keeps protocol tests deterministic and
  // prevents the public test suite from depending on private infrastructure.
  server = http.createServer(async (request, response) => {
    if (request.url === "/same-origin-redirect") {
      response.writeHead(307, { Location: "/mcp" }).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    if (
      request.url === "/cross-origin-redirect" &&
      payload.method === "tools/call"
    ) {
      response
        .writeHead(307, {
          Location: `http://127.0.0.1:${redirectTarget.address().port}/mcp`,
        })
        .flushHeaders();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Mcp-Session-Id", "test-session");

    if (payload.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    if (payload.method === "initialize") {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-03-26", capabilities: {} },
        }),
      );
      return;
    }
    if (payload.method === "tools/list") {
      const secondPage =
        payload.params.cursor === "page-2" || payload.params.cursor === "";
      const emptyCursorPagination = request.url === "/empty-cursor";
      if (emptyCursorPagination && payload.params.cursor === "") {
        repeatedEmptyCursor = true;
      }
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            tools: secondPage
              ? [
                  {
                    name: "second",
                    description: "A tool from the second page",
                    inputSchema: { type: "object" },
                  },
                  {
                    name: "empty",
                    description: "Return an empty object",
                    inputSchema: { type: "object" },
                  },
                  {
                    name: "nested_empty",
                    description: "Return nested empty objects",
                    inputSchema: { type: "object" },
                  },
                ]
              : [
                  {
                    name: "echo",
                    description: "Return the provided value",
                    inputSchema: {
                      type: "object",
                      properties: { value: { type: "string" } },
                      required: ["value"],
                    },
                  },
                  {
                    name: "hidden",
                    description: "Excluded",
                    inputSchema: { type: "object" },
                  },
                ],
            ...(secondPage
              ? {}
              : { nextCursor: emptyCursorPagination ? "" : "page-2" }),
          },
        }),
      );
      return;
    }
    if (payload.method === "tools/call") {
      const result =
        payload.params.name === "empty"
          ? {}
          : payload.params.name === "nested_empty"
            ? { metadata: {}, values: [{}] }
          : { echoed: payload.params.arguments.value };
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result),
              },
            ],
          },
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/mcp`;
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        example: { url, excludeTools: ["hidden"] },
        disabled: { url, disabled: true },
        same_redirect: { url: `${url}/../same-origin-redirect` },
        cross_redirect: {
          url: `${url}/../cross-origin-redirect`,
          headers: { Authorization: "test-secret" },
        },
        empty_cursor: { url: `${url}/../empty-cursor` },
      },
    }),
  );
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => redirectTarget.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("shows configured servers without network access", async () => {
  const result = await execute([]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /servers\[5\]\{name,disabled\}/);
  assert.match(result.stdout, /example,false/);
  assert.equal(result.stderr, "");
});

test("lists only visible tools", async () => {
  const result = await execute(["example", "tools"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /echo/);
  assert.match(result.stdout, /second/);
  assert.doesNotMatch(result.stdout, /hidden/);
});

test("returns one exact tool schema as JSON", async () => {
  const result = await execute(["example", "tools", "echo", "--json"]);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.tool.name, "echo");
  assert.deepEqual(output.tool.inputSchema.required, ["value"]);
});

test("calls a tool with stdin JSON arguments", async () => {
  const result = await execute(["example", "echo", "-", "--json"], '{"value":"ok"}');
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { echoed: "ok" });
});

test("renders an empty object instead of empty output", async () => {
  const result = await execute(["example", "empty"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "{}\n");
});

test("preserves nested empty-object TOON semantics", async () => {
  const result = await execute(["example", "nested_empty"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /metadata:\n/);
  assert.doesNotMatch(result.stdout, /metadata: \{\}/);
  assert.match(result.stdout, /values\[1\]:\n\s+-\n/);
});

test("treats an empty tools/list cursor as opaque", async () => {
  const result = await execute(["empty_cursor", "tools", "--json"]);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).tools.length, 5);
  assert.equal(repeatedEmptyCursor, true);
});

test("follows same-origin redirects", async () => {
  const result = await execute(["same_redirect", "tools", "--json"]);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).tools.length, 5);
});

test("rejects cross-origin redirects before forwarding credentials", async () => {
  const result = await execute([
    "cross_redirect",
    "echo",
    '{"value":"private-argument"}',
    "--json",
  ]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    error: "MCP server attempted a cross-origin redirect",
  });
  assert.equal(redirectTargetHits, 0);
});

test("rejects unknown flags before network access", async () => {
  const result = await execute(["example", "tools", "--schema"]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /error: "unknown flag --schema/);
  assert.match(result.stdout, /run mcp-call --help/);
});

test("emits structured JSON errors with --json", async () => {
  const result = await execute(["missing", "tools", "--json"]);
  assert.equal(result.code, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    error:
      "unknown server missing; configured servers: example, disabled, same_redirect, cross_redirect, empty_cursor",
    help: "run mcp-call --help",
  });
});

test("check reports enabled servers only", async () => {
  const result = await execute(["check", "--json"]);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.servers.length, 4);
  assert.deepEqual(output.summary, { passed: 4, failed: 0 });
  assert.equal(output.servers[0].tools, 4);
});
