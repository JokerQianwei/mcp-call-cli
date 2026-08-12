import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "bin", "mcp-call.js");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-call-test-"));
const configPath = path.join(temporary, "mcp.json");
let server;
let url;

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
  // A minimal in-process MCP server keeps protocol tests deterministic and
  // prevents the public test suite from depending on private infrastructure.
  server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
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
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            tools: [
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
          },
        }),
      );
      return;
    }
    if (payload.method === "tools/call") {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ echoed: payload.params.arguments.value }),
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
      },
    }),
  );
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("shows configured servers without network access", async () => {
  const result = await execute([]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /servers\[2\]\{name,disabled\}/);
  assert.match(result.stdout, /example,false/);
  assert.equal(result.stderr, "");
});

test("lists only visible tools", async () => {
  const result = await execute(["example", "tools"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /echo/);
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

test("rejects unknown flags before network access", async () => {
  const result = await execute(["example", "tools", "--schema"]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /error: "unknown flag --schema/);
  assert.match(result.stdout, /run mcp-call --help/);
});

test("check reports enabled servers only", async () => {
  const result = await execute(["check", "--json"]);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.servers.length, 1);
  assert.deepEqual(output.summary, { passed: 1, failed: 0 });
});
