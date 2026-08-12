#!/usr/bin/env node

/**
 * Discover and call tools exposed by configured Streamable HTTP MCP servers.
 *
 * The CLI intentionally owns no domain behavior. It loads one local server
 * map, opens a short-lived MCP session, and renders the result for an agent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const VERSION = "0.2.0";
const PROTOCOL_VERSION = "2025-03-26";
const DESCRIPTION_PREVIEW = 180;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SAFE_TOKEN = /^[A-Za-z_][A-Za-z0-9_.\-/]*$/;

class UsageError extends Error {}
class CallError extends Error {}

/**
 * Follow the XDG config convention while retaining a stable default on
 * platforms where XDG_CONFIG_HOME is not set.
 */
function defaultConfigPath() {
  if (process.env.MCP_CONFIG) {
    return expandHome(process.env.MCP_CONFIG);
  }
  const configHome = process.env.XDG_CONFIG_HOME
    ? expandHome(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "mcp-call", "mcp.json");
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function quote(value) {
  if (
    value &&
    SAFE_TOKEN.test(value) &&
    !["true", "false", "null"].includes(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function scalar(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return quote(value);
  return JSON.stringify(value);
}

function isScalar(value) {
  return value === null || (typeof value !== "object" && value !== undefined);
}

/**
 * Encode JSON-compatible values as TOON.
 *
 * Uniform object arrays use TOON's tabular form. Other arrays fall back to the
 * list form so nested and mixed values remain unambiguous.
 */
function toonLines(value, indent = 0, key = null) {
  const prefix = " ".repeat(indent);
  const label = key === null ? "" : `${quote(key)}: `;

  if (isScalar(value)) return [`${prefix}${label}${scalar(value)}`];

  if (!Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return [key === null ? `${prefix}{}` : `${prefix}${quote(key)}:`];
    }
    const lines = key === null ? [] : [`${prefix}${quote(key)}:`];
    const childIndent = key === null ? indent : indent + 2;
    for (const [childKey, childValue] of entries) {
      lines.push(...toonLines(childValue, childIndent, childKey));
    }
    return lines;
  }

  if (value.length === 0) {
    return [key === null ? `${prefix}[]` : `${prefix}${quote(key)}: []`];
  }

  if (value.every(isScalar)) {
    const name = key === null ? "" : quote(key);
    return [`${prefix}${name}[${value.length}]: ${value.map(scalar).join(",")}`];
  }

  if (
    value.every(
      (item) =>
        item &&
        !Array.isArray(item) &&
        typeof item === "object",
    )
  ) {
    const fields = Object.keys(value[0]);
    const tabular =
      fields.length > 0 &&
      value.every(
        (item) =>
          JSON.stringify(Object.keys(item)) === JSON.stringify(fields) &&
          Object.values(item).every(isScalar),
      );
    if (tabular) {
      const name = key === null ? "" : quote(key);
      const lines = [
        `${prefix}${name}[${value.length}]{${fields.map(quote).join(",")}}:`,
      ];
      for (const item of value) {
        lines.push(`${prefix}  ${fields.map((field) => scalar(item[field])).join(",")}`);
      }
      return lines;
    }
  }

  const name = key === null ? "" : quote(key);
  const lines = [`${prefix}${name}[${value.length}]:`];
  for (const item of value) {
    if (isScalar(item)) {
      lines.push(`${prefix}  - ${scalar(item)}`);
      continue;
    }
    if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${prefix}  - [0]:`);
        continue;
      }
      const nested = toonLines(item, indent + 2);
      const itemPrefix = `${prefix}  `;
      lines.push(`${itemPrefix}- ${nested[0].slice(itemPrefix.length)}`);
      lines.push(...nested.slice(1));
      continue;
    }
    const entries = Object.entries(item);
    if (entries.length > 0 && isScalar(entries[0][1])) {
      lines.push(`${prefix}  - ${quote(entries[0][0])}: ${scalar(entries[0][1])}`);
      for (const [childKey, childValue] of entries.slice(1)) {
        lines.push(...toonLines(childValue, indent + 4, childKey));
      }
      continue;
    }
    lines.push(`${prefix}  -`);
    lines.push(...toonLines(item, indent + 4));
  }
  return lines;
}

function emit(value, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(value));
    return;
  }
  const lines = toonLines(value);
  if (lines.length > 0) console.log(lines.join("\n"));
}

function emitError(message, help = null, asJson = false) {
  if (asJson) {
    const output = { error: message };
    if (help) output.help = help;
    emit(output, true);
    return;
  }
  console.log(`error: ${quote(message)}`);
  if (help) console.log(`help: ${quote(help)}`);
}

function parseTimeout(value) {
  if (typeof value === "number") return value * 1000;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(value));
  if (!match) return 30_000;
  const amount = Number(match[1]);
  if (match[2] === "ms") return amount;
  if (match[2] === "m") return amount * 60_000;
  return amount * 1000;
}

/**
 * Accept the flat server map used by some MCP clients and the common
 * { mcpServers: ... } wrapper without mutating either representation.
 */
function loadServers(configPath) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new CallError(`config not found: ${configPath}`);
    throw new CallError(`cannot read config: ${configPath}: ${error.message}`);
  }
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new CallError(`invalid MCP config: ${configPath}`);
  }
  const servers = config.mcpServers ?? config;
  if (!servers || Array.isArray(servers) || typeof servers !== "object") {
    throw new CallError(`invalid MCP config: ${configPath}`);
  }
  return servers;
}

/** Validate the persisted subset understood by this HTTP-only client. */
function validateServer(name, server) {
  if (!server || Array.isArray(server) || typeof server !== "object") {
    throw new UsageError(`invalid config for MCP server ${name}`);
  }
  const url = server.url ?? server.baseUrl;
  if (typeof url !== "string" || !url) {
    throw new UsageError(`MCP server ${name} has no URL`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`MCP server ${name} has an invalid URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new UsageError(`MCP server ${name} URL must use http or https`);
  }
  if (
    server.headers !== undefined &&
    (!server.headers ||
      Array.isArray(server.headers) ||
      typeof server.headers !== "object" ||
      Object.values(server.headers).some((value) => typeof value !== "string"))
  ) {
    throw new UsageError(`MCP server ${name} headers must contain string values`);
  }
  if (
    server.excludeTools !== undefined &&
    (!Array.isArray(server.excludeTools) ||
      server.excludeTools.some((value) => typeof value !== "string"))
  ) {
    throw new UsageError(`MCP server ${name} excludeTools must be a string array`);
  }
  if (server.disabled !== undefined && typeof server.disabled !== "boolean") {
    throw new UsageError(`MCP server ${name} disabled must be a boolean`);
  }
  if (
    server.timeout !== undefined &&
    typeof server.timeout !== "string" &&
    typeof server.timeout !== "number"
  ) {
    throw new UsageError(`MCP server ${name} timeout must be a string or number`);
  }
}

function validateServers(servers) {
  for (const [name, server] of Object.entries(servers)) {
    validateServer(name, server);
  }
}

/**
 * Persist a complete server map atomically. The temporary file is private
 * before content is written, so credentials are never exposed with broad
 * default permissions.
 */
function saveServers(configPath, servers) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.tmp-${process.pid}`;
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    );
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, configPath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.chmodSync(configPath, 0o600);
}

function loadServersOrEmpty(configPath) {
  if (!fs.existsSync(configPath)) return {};
  return loadServers(configPath);
}

/**
 * Decode either a plain JSON response or the last complete data event in an
 * SSE response. MCP servers may use either response form for POST requests.
 */
function decodeResponse(text) {
  let payload = text;
  if (/^\s*(data:|event:|id:|retry:|:)/.test(text)) {
    const payloads = [];
    let dataLines = [];
    for (const line of text.split(/\r?\n/)) {
      if (line === "") {
        if (dataLines.length > 0) payloads.push(dataLines.join("\n"));
        dataLines = [];
      } else if (line.startsWith("data:")) {
        const data = line.slice(5);
        dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
      }
    }
    if (dataLines.length > 0) payloads.push(dataLines.join("\n"));
    if (payloads.length === 0) throw new CallError("MCP server returned an empty event stream");
    payload = payloads.at(-1);
  }
  try {
    const value = JSON.parse(payload);
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new CallError("MCP server returned a non-object response");
    }
    return value;
  } catch (error) {
    if (error instanceof CallError) throw error;
    throw new CallError("MCP server returned an invalid response");
  }
}

/**
 * A deliberately short-lived MCP client.
 *
 * Each command initializes a fresh session. The session ID returned by the
 * server is forwarded on discovery and call requests, then discarded when the
 * process exits.
 */
class Client {
  constructor(config, timeout) {
    const url = config.url ?? config.baseUrl;
    if (typeof url !== "string" || !url) {
      throw new CallError("selected MCP server has no URL");
    }
    if (
      config.headers !== undefined &&
      (!config.headers || Array.isArray(config.headers) || typeof config.headers !== "object")
    ) {
      throw new CallError("MCP server headers must be an object");
    }
    this.url = url;
    this.headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(config.headers ?? {}),
    };
    this.timeout = timeout ?? parseTimeout(config.timeout ?? 30);
    this.excludedTools = new Set(config.excludeTools ?? []);
    this.sessionId = null;
    this.nextId = 1;
  }

  async post(payload, notification = false) {
    const headers = { ...this.headers };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const body = JSON.stringify(payload);
    let target = new URL(this.url);
    let response = null;

    // Redirects are handled explicitly so credentials and tool arguments can
    // never cross an origin boundary through fetch's automatic redirect mode.
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      try {
        response = await fetch(target, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeout),
        });
      } catch (error) {
        const detail = error.name === "TimeoutError" ? "request timed out" : error.message;
        throw new CallError(`cannot reach MCP server: ${detail}`);
      }
      if (!REDIRECT_STATUSES.has(response.status)) break;

      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new CallError("MCP server returned a redirect without a location");
      const redirected = new URL(location, target);
      if (redirected.origin !== target.origin) {
        throw new CallError("MCP server attempted a cross-origin redirect");
      }
      if (redirects === MAX_REDIRECTS) {
        throw new CallError(`MCP server exceeded ${MAX_REDIRECTS} redirects`);
      }
      target = redirected;
    }
    if (response === null) throw new CallError("MCP server returned no response");
    if (!response.ok) throw new CallError(`MCP server returned HTTP ${response.status}`);
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    const responseBody = await response.text();
    if (notification || !responseBody) return {};
    return decodeResponse(responseBody);
  }

  async request(method, params) {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    if ("error" in response) {
      const error = response.error;
      throw new CallError(
        error && typeof error === "object" ? error.message ?? JSON.stringify(error) : String(error),
      );
    }
    if (!("result" in response)) throw new CallError("MCP response has no result");
    return response.result;
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-call", version: VERSION },
    });
    await this.post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      true,
    );
  }
}

/**
 * Unwrap the common single text-content result. JSON text is parsed so the
 * normal output encoder can preserve its structure.
 */
function simplifyResult(result) {
  if (!result || Array.isArray(result) || typeof result !== "object") return result;
  const content = result.content;
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    content[0]?.type === "text"
  ) {
    const text = content[0].text ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

/** Keep discovery output small while making truncation explicit to the agent. */
function descriptionPreview(description, full) {
  const compact = String(description ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (full || compact.length <= DESCRIPTION_PREVIEW) return compact;
  return `${compact.slice(0, DESCRIPTION_PREVIEW).trimEnd()}… (${compact.length} chars)`;
}

/** Render the no-argument home view without contacting any MCP server. */
function home(servers, configPath, asJson) {
  const executable = fs.realpathSync(process.argv[1]).replace(os.homedir(), "~");
  emit(
    {
      bin: executable,
      version: VERSION,
      config: configPath,
      servers: Object.entries(servers).map(([name, config]) => ({
        name,
        disabled: Boolean(config?.disabled),
      })),
      help: [
        "mcp-call <server> tools",
        "mcp-call <server> tools <tool>",
        "mcp-call <server> <tool> '<json-object>'",
      ],
    },
    asJson,
  );
}

function helpOutput() {
  console.log(`usage: mcp-call [flags] [<server> [tools [<tool>] | <tool> [<arguments>]]]

Call a configured Streamable HTTP MCP server.

flags:
  --config <path>     MCP JSON config (default: ~/.config/mcp-call/mcp.json)
  --json              emit compact JSON instead of TOON
  --full              show full descriptions with the tools command
  --timeout <seconds> override the configured request timeout
  --version           show version
  --help              show this help

examples:
  mcp-call config add example --url https://example.com/mcp
  mcp-call config import ./mcp.json
  mcp-call example tools
  mcp-call example tools fetch
  mcp-call example tools fetch --full
  mcp-call example fetch '{"id":"123"}'`);
}

function configHelpOutput() {
  console.log(`usage: mcp-call config <list | add | import | remove> [options]

Manage the local MCP server map without printing endpoints or credentials.

commands:
  list
  add <name> --url <url> [--header KEY=VALUE] [--timeout <value>]
             [--exclude-tool <name>] [--disabled]
  import <path>
  remove <name>

flags:
  --config <path>       override the target config file
  --header KEY=VALUE    attach an HTTP header (repeatable)
  --exclude-tool <name> hide a tool from discovery (repeatable)
  --timeout <value>     server timeout, for example 60 or 500ms
  --disabled            add the server in a disabled state
  --help                show this help

examples:
  mcp-call config list
  mcp-call config add example --url https://example.com/mcp
  mcp-call config import ./mcp.json
  mcp-call config remove example`);
}

function parseHeader(raw) {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw new UsageError("--header must use KEY=VALUE syntax");
  }
  return [raw.slice(0, separator), raw.slice(separator + 1)];
}

function parseConfigArgs(argv) {
  let configPath = defaultConfigPath();
  const positional = [];
  const options = {
    url: null,
    headers: {},
    timeout: null,
    excludeTools: [],
    disabled: false,
  };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help") {
      configHelpOutput();
      throw new ExitSignal(0);
    }
    if (["--config", "--url", "--header", "--timeout", "--exclude-tool"].includes(arg)) {
      index++;
      if (index === argv.length) throw new UsageError(`${arg} requires a value`);
      const value = argv[index];
      if (arg === "--config") configPath = expandHome(value);
      else if (arg === "--url") options.url = value;
      else if (arg === "--timeout") options.timeout = value;
      else if (arg === "--exclude-tool") options.excludeTools.push(value);
      else {
        const [name, headerValue] = parseHeader(value);
        options.headers[name] = headerValue;
      }
    } else if (arg === "--disabled") {
      options.disabled = true;
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown config flag ${arg}; run mcp-call config --help`);
    } else {
      positional.push(arg);
    }
  }
  return { configPath, positional, options };
}

function configResult(action, names) {
  emit({
    action,
    count: names.length,
    servers: names,
  });
}

function hasAddOptions(options) {
  return (
    options.url !== null ||
    Object.keys(options.headers).length > 0 ||
    options.timeout !== null ||
    options.excludeTools.length > 0 ||
    options.disabled
  );
}

function runConfig(argv) {
  const { configPath, positional, options } = parseConfigArgs(argv);
  const [command, operand, ...extra] = positional;
  if (!command) throw new UsageError("config requires a command");
  if (extra.length > 0) throw new UsageError("too many config arguments");

  if (command === "list") {
    if (operand !== undefined) throw new UsageError("config list accepts no arguments");
    if (hasAddOptions(options)) {
      throw new UsageError("config list does not accept server options");
    }
    const servers = loadServersOrEmpty(configPath);
    configResult("list", Object.keys(servers));
    return 0;
  }

  if (command === "add") {
    if (!operand) throw new UsageError("config add requires a server name");
    if (!options.url) throw new UsageError("config add requires --url");
    const server = { url: options.url };
    if (Object.keys(options.headers).length > 0) server.headers = options.headers;
    if (options.timeout !== null) server.timeout = options.timeout;
    if (options.excludeTools.length > 0) server.excludeTools = options.excludeTools;
    if (options.disabled) server.disabled = true;
    validateServer(operand, server);
    const servers = loadServersOrEmpty(configPath);
    const action = operand in servers ? "updated" : "added";
    const updated = { ...servers, [operand]: server };
    validateServers(updated);
    saveServers(configPath, updated);
    configResult(action, [operand]);
    return 0;
  }

  if (command === "import") {
    if (!operand) throw new UsageError("config import requires a path");
    if (hasAddOptions(options)) {
      throw new UsageError("config import does not accept server options");
    }
    const imported = loadServers(expandHome(operand));
    validateServers(imported);
    const servers = loadServersOrEmpty(configPath);
    const updated = { ...servers, ...imported };
    validateServers(updated);
    saveServers(configPath, updated);
    configResult("imported", Object.keys(imported));
    return 0;
  }

  if (command === "remove") {
    if (!operand) throw new UsageError("config remove requires a server name");
    if (hasAddOptions(options)) {
      throw new UsageError("config remove does not accept server options");
    }
    const servers = loadServersOrEmpty(configPath);
    if (!(operand in servers)) {
      configResult("absent", [operand]);
      return 0;
    }
    delete servers[operand];
    validateServers(servers);
    saveServers(configPath, servers);
    configResult("removed", [operand]);
    return 0;
  }

  throw new UsageError(`unknown config command ${command}`);
}

/**
 * Parse global flags before any network request. Unknown input is rejected
 * instead of being silently dropped from a potentially sensitive query.
 */
function parseArgs(argv) {
  let asJson = false;
  let full = false;
  let timeout = null;
  let configPath = defaultConfigPath();
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help") {
      helpOutput();
      throw new ExitSignal(0);
    }
    if (arg === "--version") {
      console.log(`mcp-call ${VERSION}`);
      throw new ExitSignal(0);
    }
    if (arg === "--json") asJson = true;
    else if (arg === "--full") full = true;
    else if (arg === "--config" || arg === "--timeout") {
      index++;
      if (index === argv.length) throw new UsageError(`${arg} requires a value`);
      if (arg === "--config") configPath = expandHome(argv[index]);
      else {
        const seconds = Number(argv[index]);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new UsageError("--timeout must be a positive number");
        }
        timeout = seconds * 1000;
      }
    } else if (arg.startsWith("--")) {
      throw new UsageError(
        `unknown flag ${arg}; valid flags: --config, --json, --full, --timeout, --version, --help`,
      );
    } else positional.push(arg);
  }
  if (positional.length > 3) throw new UsageError("too many arguments");
  return { asJson, full, timeout, configPath, positional };
}

class ExitSignal extends Error {
  constructor(code) {
    super();
    this.code = code;
  }
}

/** Read tool arguments from a literal JSON object or stdin when raw is "-". */
function parseToolArguments(raw) {
  const source = raw === "-" ? fs.readFileSync(0, "utf8") : raw;
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new UsageError(`arguments must be valid JSON: ${error.message}`);
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new UsageError("arguments must be a JSON object");
  }
  return value;
}

async function visibleTools(client) {
  const tools = [];
  const cursors = new Set();
  let cursor = null;

  // MCP tool discovery is cursor-paginated. Consume every page so schema
  // lookup and health-check counts describe the complete server surface.
  do {
    const params = cursor === null ? {} : { cursor };
    const result = await client.request("tools/list", params);
    if (Array.isArray(result?.tools)) tools.push(...result.tools);
    cursor =
      Object.hasOwn(result ?? {}, "nextCursor") &&
      typeof result.nextCursor === "string"
        ? result.nextCursor
        : null;
    if (cursor !== null) {
      if (cursors.has(cursor)) {
        throw new CallError("MCP server repeated a tools/list cursor");
      }
      cursors.add(cursor);
    }
  } while (cursor !== null);

  return tools.filter(
    (tool) =>
      tool &&
      typeof tool === "object" &&
      !client.excludedTools.has(tool.name),
  );
}

/** Probe enabled servers concurrently; one failure does not hide other results. */
async function checkServers(servers, timeout, asJson) {
  const names = Object.entries(servers)
    .filter(([, config]) => !config?.disabled)
    .map(([name]) => name);
  const probes = await Promise.all(
    names.map(async (name) => {
      const started = performance.now();
      try {
        const config = servers[name];
        if (!config || Array.isArray(config) || typeof config !== "object") {
          throw new CallError(`invalid config for MCP server ${name}`);
        }
        const client = new Client(config, timeout);
        await client.initialize();
        const tools = await visibleTools(client);
        return {
          row: {
            name,
            status: "ok",
            tools: tools.length,
            latency_ms: Math.round(performance.now() - started),
          },
          error: null,
        };
      } catch (error) {
        return {
          row: {
            name,
            status: "error",
            tools: 0,
            latency_ms: Math.round(performance.now() - started),
          },
          error: descriptionPreview(error.message, false),
        };
      }
    }),
  );
  const errors = Object.fromEntries(
    probes
      .map((probe, index) => [names[index], probe.error])
      .filter(([, error]) => error !== null),
  );
  const output = {
    servers: probes.map((probe) => probe.row),
    summary: { passed: names.length - Object.keys(errors).length, failed: Object.keys(errors).length },
  };
  if (Object.keys(errors).length > 0) output.errors = errors;
  emit(output, asJson);
  return Object.keys(errors).length === 0;
}

/**
 * Return compact names and descriptions by default, but always include the
 * exact input schema when a single tool is requested.
 */
async function listTools(client, serverName, toolName, asJson, full) {
  const tools = await visibleTools(client);
  if (toolName !== null) {
    const tool = tools.find((item) => item.name === toolName);
    if (!tool) {
      throw new CallError(
        `unknown tool ${toolName}; available tools: ${tools.map((item) => item.name ?? "").join(", ")}`,
      );
    }
    const detail = {
      name: tool.name ?? "",
      description: descriptionPreview(tool.description, full),
      inputSchema: tool.inputSchema ?? {},
    };
    if (full) {
      for (const field of ["outputSchema", "annotations"]) {
        if (field in tool) detail[field] = tool[field];
      }
    }
    emit({ server: serverName, tool: detail }, asJson);
    return;
  }
  const output = {
    server: serverName,
    tools: tools.map((tool) => ({
      name: tool.name ?? "",
      description: descriptionPreview(tool.description, full),
    })),
  };
  if (
    !full &&
    tools.some(
      (tool) =>
        String(tool.description ?? "").split(/\s+/).filter(Boolean).join(" ").length >
        DESCRIPTION_PREVIEW,
    )
  ) {
    output.help = `mcp-call ${serverName} tools --full`;
  }
  emit(output, asJson);
}

async function callTool(client, toolName, argumentsValue, asJson) {
  const result = await client.request("tools/call", {
    name: toolName,
    arguments: argumentsValue,
  });
  if (result?.isError) {
    const content = simplifyResult(result);
    throw new CallError(typeof content === "string" ? content : JSON.stringify(content));
  }
  emit(simplifyResult(result), asJson);
}

/** Map CLI grammar to one MCP session and one discovery or call operation. */
async function run(argv) {
  if (argv[0] === "config") return runConfig(argv);
  const { asJson, full, timeout, configPath, positional } = parseArgs(argv);
  const servers = loadServers(configPath);
  if (positional.length === 0) {
    if (full) throw new UsageError("--full requires the tools command");
    home(servers, configPath, asJson);
    return 0;
  }
  if (positional[0] === "check") {
    if (positional.length > 1) throw new UsageError("check does not accept a server name");
    if (full) throw new UsageError("--full is not valid with the check command");
    return (await checkServers(servers, timeout, asJson)) ? 0 : 1;
  }

  const serverName = positional[0];
  if (!(serverName in servers)) {
    throw new UsageError(
      `unknown server ${serverName}; configured servers: ${Object.keys(servers).join(", ")}`,
    );
  }
  const config = servers[serverName];
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new CallError(`invalid config for MCP server ${serverName}`);
  }
  if (config.disabled) throw new CallError(`MCP server ${serverName} is disabled`);

  const listCommand = positional.length === 1 || positional[1] === "tools";
  let toolName;
  let argumentsValue = null;
  if (listCommand) {
    toolName = positional.length === 3 ? positional[2] : null;
  } else {
    if (full) throw new UsageError("--full is only valid with the tools command");
    toolName = positional[1];
    if (new Set(config.excludeTools ?? []).has(toolName)) {
      throw new CallError(`tool ${toolName} is excluded by MCP configuration`);
    }
    argumentsValue = parseToolArguments(
      positional.length === 3 ? positional[2] : "{}",
    );
  }

  const client = new Client(config, timeout);
  await client.initialize();
  if (listCommand) {
    await listTools(client, serverName, toolName, asJson, full);
  } else {
    await callTool(client, toolName, argumentsValue, asJson);
  }
  return 0;
}

// Keep expected failures structured and reserve stderr for future diagnostics.
const jsonErrors = process.argv.slice(2).includes("--json");

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  if (error instanceof ExitSignal) {
    process.exitCode = error.code;
  } else if (error instanceof UsageError) {
    emitError(error.message, "run mcp-call --help", jsonErrors);
    process.exitCode = 2;
  } else if (error instanceof CallError) {
    emitError(error.message, null, jsonErrors);
    process.exitCode = 1;
  } else {
    emitError("unexpected internal error", null, jsonErrors);
    process.exitCode = 1;
  }
}
