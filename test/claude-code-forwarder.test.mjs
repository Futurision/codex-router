import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildClaudeBridgePrompt,
  buildClaudeBridgeSystemPrompt,
  claudeBridgeSchema,
  parseClaudeBridgeOutput,
  validateClaudeBridgeRequest,
} from "../src/claude-code-adapter.mjs";
import {
  claudeCodeStatus,
  claudeCodeVersion,
  claudeSubscriptionEnvironment,
} from "../src/claude-code-status.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_FIXTURE_PATH = path.join(
  root,
  "test",
  "fixtures",
  "claude-code-cli-cases.json",
);
const CLAUDE_FIXTURE_MANIFEST_PATH = path.join(
  root,
  "test",
  "fixtures",
  "claude-code-fixture-manifest.json",
);
const CLAUDE_REAL_FIXTURE_PATH = path.join(
  root,
  "test",
  "fixtures",
  "claude-code-2.1.221-real-redacted.json",
);
const INTERNAL_KEY = "test-claude-internal-service-key-with-sufficient-length";
const SUBSCRIPTION_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
];
const FUNCTION_TOOLS = [
  {
    type: "function",
    function: {
      name: "add",
      description: "Add two numbers",
      parameters: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "multiply",
      description: "Multiply two numbers",
      parameters: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
  },
];

function fakeClaudeProgram() {
  return async function runFakeClaude(config) {
    const { appendFileSync, readFileSync, statSync } = await import("node:fs");
    const args = process.argv.slice(2);
    const logPath = config.logPath;
    const forbiddenKeys = [
      "KEEP_ME",
      "MODEL_ROUTER_INTERNAL_KEY",
      "CODEX_ROUTER_INTERNAL_KEY",
      "KIMI_API_KEY",
      "ROUTER_TEST_TOKEN",
      "ROUTER_TEST_SECRET",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_PROFILE",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_VERTEX",
    ];
    const log = (record) => {
      if (!logPath) return;
      appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
    };
    const environmentRecord = {
      environmentKeys: Object.keys(process.env).sort(),
      safeMode: process.env.CLAUDE_CODE_SAFE_MODE,
      leakedEnvironmentKeys: forbiddenKeys.filter(
        (key) => process.env[key] !== undefined,
      ),
    };

    if (args.join("\u0000") === ["auth", "status", "--json"].join("\u0000")) {
      // Simulate a loaded machine: once the configured number of status probes
      // has been answered, later probes hang past the caller's timeout.
      if (config.statusStallAfterCalls !== undefined) {
        let answered = 0;
        try {
          for (const line of readFileSync(logPath, "utf8").split("\n")) {
            if (line.includes('"kind":"status"')) answered += 1;
          }
        } catch {
          answered = 0;
        }
        if (answered >= config.statusStallAfterCalls) {
          await new Promise((resolve) => setTimeout(resolve, config.statusStallMs || 5_000));
          return;
        }
      }
      log({ kind: "status", args, ...environmentRecord });
      process.stdout.write(JSON.stringify({
        loggedIn: config.loggedIn !== false,
        authMethod: config.authMethod || "claude.ai",
        subscriptionType: config.subscriptionType || "MAX",
      }));
      return;
    }
    if (args.length === 1 && args[0] === "--version") {
      log({ kind: "version", args, ...environmentRecord });
      process.stdout.write("9.9.9 (fake Claude Code)\n");
      return;
    }

    let stdin = "";
    for await (const chunk of process.stdin) stdin += chunk;
    const request = JSON.parse(stdin);
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const serializedMessages = JSON.stringify(messages);
    const toolResult = messages.find((message) => message?.role === "tool");
    const fixture = JSON.parse(
      readFileSync(config.fixturePath, "utf8"),
    );
    const selectedCase = fixture.cases.find(
      (candidate) => candidate.when === "tool_result" && toolResult,
    ) || fixture.cases.find(
      (candidate) => candidate.marker && serializedMessages.includes(candidate.marker),
    ) || fixture.cases.find((candidate) => candidate.default);
    const systemPromptPath = args[args.indexOf("--system-prompt-file") + 1];
    const systemPrompt = readFileSync(systemPromptPath, "utf8");
    const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
    log({
      kind: "inference",
      caseId: selectedCase.id,
      args,
      stdin,
      pid: process.pid,
      cwd: process.cwd(),
      schema,
      systemPrompt,
      systemPromptMode: statSync(systemPromptPath).mode & 0o777,
      ...environmentRecord,
    });

    if (selectedCase.behavior === "hang") {
      for (const signal of ["SIGTERM", "SIGINT"]) {
        process.once(signal, () => {
          log({ kind: "signal", signal, pid: process.pid, stdin });
          process.exit(0);
        });
      }
      setInterval(() => {}, 1_000);
      return;
    }
    if (selectedCase.behavior === "exit") {
      process.stderr.write(selectedCase.stderr || "fixture failure");
      process.exitCode = selectedCase.exit_code || 1;
      return;
    }
    if (typeof selectedCase.stdout === "string") {
      process.stdout.write(selectedCase.stdout);
      return;
    }
    process.stdout.write(JSON.stringify(selectedCase.result || {
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: selectedCase.envelope,
      usage: fixture.usage,
    }));
  };
}

function createFakeClaude(directory, options = {}) {
  const executable = path.join(directory, options.fileName || "fake-claude.mjs");
  const config = {
    authMethod: options.authMethod,
    fixturePath: CLAUDE_FIXTURE_PATH,
    loggedIn: options.loggedIn,
    logPath: options.logPath || path.join(directory, "fake-claude.jsonl"),
    subscriptionType: options.subscriptionType,
    statusStallAfterCalls: options.statusStallAfterCalls,
    statusStallMs: options.statusStallMs,
  };
  const program = fakeClaudeProgram().toString();
  writeFileSync(
    executable,
    `#!/usr/bin/env node\n(${program})(${JSON.stringify(config)}).catch((error) => { console.error(error); process.exit(1); });\n`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
  return executable;
}

function withEnvironment(overrides, run) {
  const previous = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForLog(logPath, predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = readLog(logPath).find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for fake Claude log: ${logPath}`);
}

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function waitHealth(base, child, errors) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Claude forwarder exited (${child.exitCode}): ${errors()}`);
    }
    try {
      const response = await fetch(`${base}/health`, {
        headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
      });
      if (response.ok) return response.json();
    } catch {
      // The forwarder has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for Claude forwarder: ${errors()}`);
}

async function healthPayload(base) {
  const response = await fetch(`${base}/health`, {
    headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForConcurrency(base, predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const health = await healthPayload(base);
    if (predicate(health.concurrency)) return health.concurrency;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for Claude concurrency state.");
}

async function withForwarder(run, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "claude-code-forwarder-"));
  const logPath = path.join(directory, "fake-claude.jsonl");
  const executable = createFakeClaude(directory, {
    authMethod: options.authMethod,
    loggedIn: options.loggedIn,
    logPath,
    subscriptionType: options.subscriptionType,
    statusStallAfterCalls: options.statusStallAfterCalls,
    statusStallMs: options.statusStallMs,
  });
  const port = await openPort();
  const child = spawn(
    process.execPath,
    [path.join(root, "src", "claude-code-forwarder.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "cursor",
        MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
        MODEL_ROUTER_CLAUDE_CODE_PORT: String(port),
        MODEL_ROUTER_QUIET: "1",
        ...(options.concurrency === undefined
          ? {}
          : { MODEL_ROUTER_CLAUDE_CODE_CONCURRENCY: String(options.concurrency) }),
        ...(options.queueLimit === undefined
          ? {}
          : { MODEL_ROUTER_CLAUDE_CODE_QUEUE_LIMIT: String(options.queueLimit) }),
        ...(options.statusTimeoutMs === undefined
          ? {}
          : { MODEL_ROUTER_CLAUDE_CODE_STATUS_TIMEOUT_MS: String(options.statusTimeoutMs) }),
        CLAUDE_CODE_BIN: executable,
        KEEP_ME: "must-not-reach-claude",
        KIMI_API_KEY: "must-not-reach-claude",
        ROUTER_TEST_TOKEN: "must-not-reach-claude",
        ROUTER_TEST_SECRET: "must-not-reach-claude",
        ANTHROPIC_API_KEY: "must-not-reach-claude",
        ANTHROPIC_AUTH_TOKEN: "must-not-reach-claude",
        ANTHROPIC_BASE_URL: "https://must-not-reach-claude.invalid",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-claude",
        CLAUDE_CODE_USE_BEDROCK: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await waitHealth(base, child, () => stderr);
    await run({ base, child, health, logPath, stderr: () => stderr });
  } finally {
    await stop(child);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function postCompletion(base, payload, options = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${INTERNAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
}

function claudeResult(envelope) {
  return JSON.stringify({
    structured_output: envelope,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function functionTool(name, parameters) {
  return {
    type: "function",
    function: { name, parameters },
  };
}

function privatePromptContract(systemPrompt) {
  const begin = /(?:^|\n)BEGIN_UNTRUSTED_TOOL_DEFINITIONS_JSON bytes=(\d+)\n/.exec(
    systemPrompt,
  );
  assert.ok(begin, "private prompt must start a length-delimited tool-data block");
  const serializedStart = begin.index + begin[0].length;
  const endMarker = "\nEND_UNTRUSTED_TOOL_DEFINITIONS_JSON";
  const serializedEnd = systemPrompt.indexOf(endMarker, serializedStart);
  assert.notEqual(serializedEnd, -1, "private prompt must end its tool-data block");
  const serializedTools = systemPrompt.slice(serializedStart, serializedEnd);
  assert.equal(
    Buffer.byteLength(serializedTools, "utf8"),
    Number(begin[1]),
    "declared tool-data byte length must match the exact JSON block",
  );
  return {
    contract: JSON.parse(systemPrompt.split("\n").at(-1)),
    tools: JSON.parse(serializedTools),
  };
}

test("Claude subscription environment removes every API and alternate-backend override", () => {
  const source = {
    HOME: "/safe/test-home",
    LANG: "en_US.UTF-8",
    PATH: "/safe/test-bin",
    KEEP_ME: "yes",
    MODEL_ROUTER_INTERNAL_KEY: "router-secret",
    ROUTER_TEST_TOKEN: "router-token",
    ROUTER_TEST_SECRET: "router-secret",
    CLAUDE_CODE_BIN: "/must/not/reach/child",
    ...Object.fromEntries(SUBSCRIPTION_KEYS.map((key) => [key, `secret-${key}`])),
  };
  const environment = claudeSubscriptionEnvironment(source);

  assert.equal(environment.HOME, "/safe/test-home");
  assert.equal(environment.LANG, "en_US.UTF-8");
  assert.ok(environment.PATH.split(path.delimiter).includes("/safe/test-bin"));
  assert.equal(environment.CLAUDE_CODE_SAFE_MODE, "1");
  for (const key of [
    "KEEP_ME",
    "MODEL_ROUTER_INTERNAL_KEY",
    "ROUTER_TEST_TOKEN",
    "ROUTER_TEST_SECRET",
    "CLAUDE_CODE_BIN",
  ]) {
    assert.equal(key in environment, false, key);
  }
  for (const key of SUBSCRIPTION_KEYS) assert.equal(key in environment, false, key);
  assert.equal(source.ANTHROPIC_API_KEY, "secret-ANTHROPIC_API_KEY");
});

test("Claude bridge keeps authoritative roles and tool policy out of conversation stdin", () => {
  const payload = {
    messages: [
      { role: "system", content: "SYSTEM_AUTHORITY_MARKER" },
      { role: "developer", content: "DEVELOPER_AUTHORITY_MARKER" },
      { role: "user", content: "USER_CONVERSATION_MARKER" },
      { role: "assistant", content: "Earlier answer" },
      { role: "tool", tool_call_id: "call_prior", content: "Prior tool output" },
    ],
    tools: FUNCTION_TOOLS,
    tool_choice: { type: "function", function: { name: "add" } },
    parallel_tool_calls: false,
  };
  const conversation = JSON.parse(buildClaudeBridgePrompt(payload));
  const systemPrompt = buildClaudeBridgeSystemPrompt(payload);
  const { contract, tools } = privatePromptContract(systemPrompt);

  assert.deepEqual(
    conversation.messages.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  assert.doesNotMatch(JSON.stringify(conversation), /SYSTEM_AUTHORITY_MARKER/);
  assert.doesNotMatch(JSON.stringify(conversation), /DEVELOPER_AUTHORITY_MARKER/);
  assert.deepEqual(contract.authoritative_messages, [
    { sequence: 0, ...payload.messages[0] },
    { sequence: 1, ...payload.messages[1] },
  ]);
  assert.deepEqual(tools, FUNCTION_TOOLS);
  assert.deepEqual(contract.trusted_tool_policy, {
    available_tool_names: ["add", "multiply"],
    mode: "required",
    selected_name: "add",
    parallel_tool_calls: false,
  });
  assert.equal("available_tools" in contract, false);
  assert.equal("tool_choice" in contract, false);
  assert.doesNotMatch(systemPrompt, /USER_CONVERSATION_MARKER/);
});

test("Claude bridge schema constrains disabled, required, and named tool choices", () => {
  const auto = claudeBridgeSchema({ tools: FUNCTION_TOOLS });
  const autoCalls = auto.properties.tool_calls;
  assert.deepEqual(autoCalls.items.properties.name.enum, ["add", "multiply"]);
  assert.equal(autoCalls.maxItems, 16);
  assert.equal("minItems" in autoCalls, false);

  const disabled = claudeBridgeSchema({ tools: FUNCTION_TOOLS, tool_choice: "none" });
  assert.equal(disabled.properties.tool_calls.maxItems, 0);
  assert.equal("minItems" in disabled.properties.tool_calls, false);

  const required = claudeBridgeSchema({ tools: FUNCTION_TOOLS, tool_choice: "required" });
  assert.equal(required.properties.tool_calls.minItems, 1);
  assert.equal(required.properties.tool_calls.maxItems, 16);

  const named = claudeBridgeSchema({
    tools: FUNCTION_TOOLS,
    tool_choice: { type: "function", function: { name: "add" } },
  });
  assert.equal(named.properties.tool_calls.items.properties.name.const, "add");
  assert.equal(named.properties.tool_calls.minItems, 1);

  const serial = claudeBridgeSchema({
    tools: FUNCTION_TOOLS,
    parallel_tool_calls: false,
  });
  assert.equal(serial.properties.tool_calls.maxItems, 1);
  assert.doesNotMatch(JSON.stringify(serial), /Add two numbers|parameters/);

  assert.throws(
    () => claudeBridgeSchema({
      tools: FUNCTION_TOOLS,
      tool_choice: { type: "function", function: { name: "not_supplied" } },
    }),
    (error) => error?.status === 400 && /unavailable/.test(error.message),
  );
});

test("Claude custom tool choice is trusted, normalized, and rejects malformed policy", () => {
  const tools = [
    functionTool("apply_patch", {
      type: "object",
      properties: { patch: { type: "string" } },
      required: ["patch"],
      additionalProperties: false,
    }),
    functionTool("other_tool", {
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
  ];
  const payload = {
    messages: [{ role: "user", content: "Patch the file" }],
    tools,
    tool_choice: { type: "custom", name: "apply_patch" },
  };
  const schema = claudeBridgeSchema(payload);

  assert.equal(
    schema.properties.tool_calls.items.properties.name.const,
    "apply_patch",
  );
  assert.equal(schema.properties.tool_calls.minItems, 1);
  assert.throws(
    () => parseClaudeBridgeOutput(
      claudeResult({
        text: "",
        tool_calls: [{ name: "other_tool", arguments: {} }],
      }),
      payload,
    ),
    /did not honor tool_choice for apply_patch/,
  );

  for (const toolChoice of [
    { type: "custom", name: "apply_patch", extra: true },
    { type: "custom", name: { nested: true } },
    { type: "function", function: { name: "apply_patch", extra: true } },
  ]) {
    assert.throws(
      () => validateClaudeBridgeRequest({
        messages: payload.messages,
        tools,
        tool_choice: toolChoice,
      }),
      (error) => error?.status === 400 && /tool_choice/.test(error.message),
    );
  }
});

test("Claude tool argument validation uses exact decimal multipleOf arithmetic", () => {
  const numericPayload = (name, multipleOf) => ({
    messages: [],
    tools: [functionTool(name, {
      type: "object",
      properties: { value: { type: "number", multipleOf } },
      required: ["value"],
      additionalProperties: false,
    })],
  });

  assert.throws(
    () => parseClaudeBridgeOutput(
      claudeResult({
        text: "",
        tool_calls: [{ name: "large_multiple", arguments: { value: 1e16 } }],
      }),
      numericPayload("large_multiple", 3),
    ),
    /must be a multiple of 3/,
  );
  const accepted = parseClaudeBridgeOutput(
    claudeResult({
      text: "",
      tool_calls: [{ name: "decimal_multiple", arguments: { value: 0.3 } }],
    }),
    numericPayload("decimal_multiple", 0.1),
  );
  assert.equal(accepted.toolCalls[0].function.arguments, '{"value":0.3}');
});

test("Claude rejects unbounded schema keywords before inference", () => {
  const cases = [
    ["pattern", { type: "string", pattern: "^safe$" }],
    [
      "patternProperties",
      { type: "object", patternProperties: { "^safe$": { type: "string" } } },
    ],
    ["uniqueItems", { type: "array", items: { type: "string" }, uniqueItems: true }],
  ];

  for (const [keyword, valueSchema] of cases) {
    assert.throws(
      () => validateClaudeBridgeRequest({
        messages: [],
        tools: [functionTool(`reject_${keyword}`, {
          type: "object",
          properties: { value: valueSchema },
        })],
      }),
      (error) => error?.status === 400 && error.message.includes(keyword),
    );
  }
});

test("Claude resolves percent-decoded local refs and rejects unsafe ref forms", () => {
  const validPayload = {
    messages: [],
    tools: [functionTool("local_ref", {
      type: "object",
      $defs: { "space key": { type: "number" } },
      properties: { value: { $ref: "#/$defs/space%20key" } },
      required: ["value"],
      additionalProperties: false,
    })],
  };
  assert.equal(validateClaudeBridgeRequest(validPayload), validPayload);
  const accepted = parseClaudeBridgeOutput(
    claudeResult({
      text: "",
      tool_calls: [{ name: "local_ref", arguments: { value: 4 } }],
    }),
    validPayload,
  );
  assert.equal(accepted.toolCalls[0].function.arguments, '{"value":4}');

  const invalidRefs = [
    ["#anchor", /anchor/],
    ["#\/$defs\/%ZZ", /Malformed local JSON Schema reference/],
    ["#\/$defs\/tuple\/prefixItems\/not-index", /Invalid array index/],
  ];
  for (const [reference, expected] of invalidRefs) {
    assert.throws(
      () => validateClaudeBridgeRequest({
        messages: [],
        tools: [functionTool("invalid_ref", {
          type: "object",
          $defs: {
            tuple: {
              type: "array",
              prefixItems: [{ type: "number" }],
            },
          },
          properties: { value: { $ref: reference } },
        })],
      }),
      (error) => error?.status === 400 && expected.test(error.message),
    );
  }
});

test("Claude redacts encoded image values and rejects unsafe or overlong metadata", () => {
  const encodedImage =
    "before data%3Aimage%2Fpng%3Bbase64%2CQUJD%0A%20RA%3D%3D. after";
  const prompt = buildClaudeBridgePrompt({
    messages: [{ role: "user", content: encodedImage }],
  });
  assert.match(prompt, /embedded tool image omitted by Claude subscription bridge/);
  assert.doesNotMatch(prompt, /QUJD|RA%3D%3D/);
  assert.match(prompt, /\. after/);

  const invalidMessages = [
    {
      message: {
        role: "user",
        content: { "data:image/png;base64,QQ==": "value" },
      },
      expected: /object key cannot contain an embedded data URI/,
    },
    {
      message: { role: "user", content: { ["k".repeat(1_025)]: "value" } },
      expected: /object key exceeds.*size limit/,
    },
    {
      message: { role: "user", name: "data:image/png;base64,QQ==", content: "x" },
      expected: /name cannot contain an embedded data URI/,
    },
    {
      message: { role: "user", name: "n".repeat(129), content: "x" },
      expected: /name exceeds.*size limit/,
    },
    {
      message: {
        role: "tool",
        tool_call_id: "data:image/png;base64,QQ==",
        content: "x",
      },
      expected: /tool_call_id cannot contain an embedded data URI/,
    },
    {
      message: { role: "tool", tool_call_id: "c".repeat(513), content: "x" },
      expected: /tool_call_id exceeds.*size limit/,
    },
  ];
  for (const { message, expected } of invalidMessages) {
    assert.throws(
      () => validateClaudeBridgeRequest({ messages: [message] }),
      (error) => error?.status === 400 && expected.test(error.message),
    );
  }
});

test("Claude fails closed when returned array combinators exhaust validation work", () => {
  const payload = {
    messages: [],
    tools: [functionTool("bounded_validation", {
      type: "object",
      properties: {
        values: {
          type: "array",
          items: {
            anyOf: [{ const: -1 }, { type: "integer" }],
          },
        },
      },
      required: ["values"],
      additionalProperties: false,
    })],
  };

  assert.throws(
    () => parseClaudeBridgeOutput(
      claudeResult({
        text: "",
        tool_calls: [{
          name: "bounded_validation",
          arguments: { values: Array.from({ length: 30_000 }, () => 0) },
        }],
      }),
      payload,
    ),
    /validation work exceeds the bridge limit/,
  );
});

test("Claude request validation rejects malformed roles and unsupported tool schemas", () => {
  assert.throws(
    () => validateClaudeBridgeRequest({ messages: [{ role: "root", content: "no" }] }),
    (error) => error?.status === 400 && /unsupported role/.test(error.message),
  );
  assert.throws(
    () => validateClaudeBridgeRequest({
      messages: [{ role: "user", content: "test" }],
      tools: [{
        type: "function",
        function: {
          name: "unsupported_schema",
          parameters: {
            type: "object",
            unevaluatedProperties: false,
          },
        },
      }],
    }),
    (error) => error?.status === 400 && /unevaluatedProperties/.test(error.message),
  );
  assert.throws(
    () => validateClaudeBridgeRequest({
      messages: [{ role: "user", content: "test" }],
      tools: [{
        type: "function",
        function: {
          name: "tuple_schema",
          parameters: { type: "object", properties: { values: { items: [] } } },
        },
      }],
    }),
    (error) => error?.status === 400 && /tuple-form items/.test(error.message),
  );
});

test("Claude fixture manifest never presents simulated cases as provider evidence", () => {
  const manifest = JSON.parse(readFileSync(CLAUDE_FIXTURE_MANIFEST_PATH, "utf8"));
  const realCapture = JSON.parse(readFileSync(CLAUDE_REAL_FIXTURE_PATH, "utf8"));
  const simulatedCases = new Set(
    JSON.parse(readFileSync(CLAUDE_FIXTURE_PATH, "utf8"))
      .cases.map((fixtureCase) => fixtureCase.id),
  );
  const real = manifest.corpora.find(
    (corpus) => corpus.evidence_type === "captured_real_provider_output",
  );
  const simulated = manifest.corpora.find(
    (corpus) => corpus.evidence_type === "simulated_adapter_contract",
  );

  assert.equal(manifest.provider_version, "2.1.221");
  assert.match(manifest.evidence_notice, /simulated records remain adapter-contract evidence only/i);
  assert.equal(real.status, "observed");
  assert.deepEqual(real.raw, ["claude-code-2.1.221-real-redacted.json"]);
  assert.equal(realCapture.provider_version, "2.1.221");
  assert.deepEqual(
    realCapture.native_cli_cases.map((entry) => entry.id),
    ["opus_text_max", "fable_tool_max"],
  );
  assert.equal(
    realCapture.native_cli_cases[0].raw_redacted.modelUsage["claude-opus-5"].provider,
    "firstParty",
  );
  assert.equal(
    realCapture.native_cli_cases[1].raw_redacted.structured_output.tool_calls[0].name,
    "add",
  );
  assert.equal(
    realCapture.isolated_bridge_observations.find(
      (entry) => entry.id === "fable_tool_and_result_max",
    ).tool_result_continuation.content,
    "RESULT=42",
  );
  assert.equal(simulated.status, "observed");
  assert.match(simulated.evidence, /never use.*provider/i);
  assert.deepEqual(
    new Set(manifest.cases.map((entry) => entry.status)),
    new Set(["observed", "unsupported", "not_observed"]),
  );
  for (const entry of manifest.cases) {
    if (entry.status === "observed") assert.ok(entry.raw.length > 0, entry.id);
    for (const reference of entry.simulated || []) {
      const [, caseId] = reference.split("#");
      assert.equal(simulatedCases.has(caseId), true, reference);
    }
  }
});

test(
  "Claude status accepts only a Claude.ai subscription and strips auth overrides from the CLI",
  { skip: process.platform === "win32" },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-code-status-"));
    const logPath = path.join(directory, "fake-claude.jsonl");
    const executable = createFakeClaude(directory, { logPath });
    const apiExecutable = createFakeClaude(directory, {
      authMethod: "api_key",
      fileName: "fake-claude-api.mjs",
      logPath,
    });
    const common = {
      CLAUDE_CODE_BIN: executable,
      ...Object.fromEntries(SUBSCRIPTION_KEYS.map((key) => [key, `secret-${key}`])),
    };
    try {
      withEnvironment(common, () => {
        assert.deepEqual(claudeCodeStatus(), {
          installed: true,
          configured: true,
          determinate: true,
          authMethod: "claude.ai",
          subscriptionType: "max",
          executable,
        });
        assert.equal(claudeCodeVersion(), "9.9.9 (fake Claude Code)");
      });
      withEnvironment(
        { ...common, CLAUDE_CODE_BIN: apiExecutable },
        () => {
          const status = claudeCodeStatus();
          assert.equal(status.installed, true);
          assert.equal(status.configured, false);
          assert.equal(status.authMethod, "api_key");
        },
      );

      const invocations = readLog(logPath);
      assert.ok(invocations.some((entry) => entry.kind === "status"));
      assert.ok(invocations.some((entry) => entry.kind === "version"));
      for (const invocation of invocations) {
        assert.equal(invocation.safeMode, "1");
        assert.deepEqual(invocation.leakedEnvironmentKeys, []);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("Claude adapter rejects unavailable tools and non-object arguments", () => {
  const payload = { tools: FUNCTION_TOOLS };
  assert.throws(
    () => parseClaudeBridgeOutput(
      claudeResult({
        text: "",
        tool_calls: [{ name: "not_supplied", arguments: {} }],
      }),
      payload,
    ),
    /unavailable tool: not_supplied/,
  );
  assert.throws(
    () => parseClaudeBridgeOutput(
      claudeResult({
        text: "",
        tool_calls: [{ name: "add", arguments: [2, 3] }],
      }),
      payload,
    ),
    /invalid arguments for add/,
  );
  assert.throws(
    () => parseClaudeBridgeOutput(
      claudeResult({
        text: "",
        tool_calls: [{ name: "add", arguments: { a: 2, b: 3 } }],
      }),
      { ...payload, tool_choice: "none" },
    ),
    /tool use was disabled/,
  );
  assert.throws(
    () => parseClaudeBridgeOutput(
      claudeResult({ text: "No tool", tool_calls: [] }),
      { ...payload, tool_choice: "required" },
    ),
    /did not return the required tool call/,
  );
  assert.throws(
    () => parseClaudeBridgeOutput(
      claudeResult({
        text: "",
        tool_calls: [{ name: "multiply", arguments: { a: 2, b: 3 } }],
      }),
      {
        ...payload,
        tool_choice: { type: "function", function: { name: "add" } },
      },
    ),
    /did not honor tool_choice for add/,
  );
  assert.throws(
    () => parseClaudeBridgeOutput(
      claudeResult({
        text: "",
        tool_calls: [
          { name: "add", arguments: { a: 2, b: 3 } },
          { name: "multiply", arguments: { a: 4, b: 5 } },
        ],
      }),
      { ...payload, parallel_tool_calls: false },
    ),
    /parallel tool calls when they were disabled/,
  );
  assert.throws(
    () => parseClaudeBridgeOutput(
      claudeResult({
        text: "",
        tool_calls: [{ name: "add", arguments: { a: "two", b: 3 } }],
      }),
      payload,
    ),
    /do not match its JSON schema.*expected number/,
  );
});

test(
  "Claude forwarder keeps the prompt on stdin and handles text, tool rounds, rejection, and SSE",
  { skip: process.platform === "win32" },
  async (t) => withForwarder(async ({ base, health, logPath }) => {
    assert.equal(health.ok, true);
    assert.equal(health.ready, true);
    assert.equal(health.service, "codex-router-claude-code-forwarder");
    assert.equal(health.cli_installed, true);
    assert.equal(health.credential_present, true);
    assert.equal(health.auth_method, "claude.ai");
    assert.equal(health.subscription_type, "max");
    assert.equal(health.cli_version, "9.9.9 (fake Claude Code)");
    assert.deepEqual(health.concurrency, {
      active: 0,
      queued: 0,
      limit: 2,
      queue_limit: 8,
    });

    await t.test("plain text uses safe flags and stdin", async () => {
      const promptMarker = "__plain_text__ PROMPT_MUST_NOT_BE_AN_ARGV_VALUE";
      const response = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: promptMarker }],
      });
      assert.equal(response.status, 200);
      const completion = await response.json();
      assert.equal(completion.choices[0].message.content, "Plain text reply.");
      assert.equal(completion.choices[0].finish_reason, "stop");
      assert.deepEqual(completion.usage, {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        prompt_tokens_details: { cached_tokens: 3 },
      });

      const invocation = readLog(logPath)
        .filter((entry) => entry.kind === "inference")
        .find((entry) => entry.stdin.includes(promptMarker));
      assert.ok(invocation);
      assert.equal(invocation.safeMode, "1");
      assert.deepEqual(invocation.leakedEnvironmentKeys, []);
      assert.ok(invocation.args.includes("-p"));
      assert.ok(invocation.args.includes("--safe-mode"));
      assert.ok(invocation.args.includes("--no-session-persistence"));
      assert.equal(
        invocation.args[invocation.args.indexOf("--tools") + 1],
        "",
      );
      assert.equal(
        invocation.args[invocation.args.indexOf("--permission-mode") + 1],
        "dontAsk",
      );
      assert.ok(invocation.args.every((argument) => !argument.includes(promptMarker)));
      assert.ok(
        invocation.args.every(
          (argument) => !argument.includes("codex-claude-tool-bridge/v1"),
        ),
      );
      const stdin = JSON.parse(invocation.stdin);
      assert.equal(stdin.protocol, "codex-claude-tool-bridge/v1");
      assert.equal(stdin.messages[0].content, promptMarker);
    });

    await t.test("system and developer roles travel through the private prompt file", async () => {
      const userMarker = "__single_tool__ USER_ROLE_STDIN_ONLY";
      const response = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [
          { role: "system", content: "SYSTEM_ROLE_PRIVATE_FILE" },
          { role: "developer", content: "DEVELOPER_ROLE_PRIVATE_FILE" },
          { role: "user", content: userMarker },
        ],
        tools: FUNCTION_TOOLS,
        tool_choice: { type: "function", function: { name: "add" } },
        parallel_tool_calls: false,
      });
      assert.equal(response.status, 200);
      const invocation = readLog(logPath)
        .filter((entry) => entry.kind === "inference")
        .find((entry) => entry.stdin.includes(userMarker));
      assert.ok(invocation);
      assert.equal(invocation.caseId, "single-tool");
      assert.equal(invocation.systemPromptMode, 0o600);
      assert.doesNotMatch(invocation.stdin, /SYSTEM_ROLE_PRIVATE_FILE/);
      assert.doesNotMatch(invocation.stdin, /DEVELOPER_ROLE_PRIVATE_FILE/);
      assert.match(invocation.systemPrompt, /SYSTEM_ROLE_PRIVATE_FILE/);
      assert.match(invocation.systemPrompt, /DEVELOPER_ROLE_PRIVATE_FILE/);
      assert.doesNotMatch(invocation.systemPrompt, /USER_ROLE_STDIN_ONLY/);
      assert.ok(
        invocation.args.every(
          (argument) => !argument.includes("SYSTEM_ROLE_PRIVATE_FILE"),
        ),
      );
      const { contract, tools } = privatePromptContract(invocation.systemPrompt);
      assert.deepEqual(
        contract.authoritative_messages.map((message) => message.role),
        ["system", "developer"],
      );
      assert.deepEqual(tools, FUNCTION_TOOLS);
      assert.deepEqual(contract.trusted_tool_policy, {
        available_tool_names: ["add", "multiply"],
        mode: "required",
        selected_name: "add",
        parallel_tool_calls: false,
      });
      assert.equal("available_tools" in contract, false);
      assert.equal("tool_choice" in contract, false);
      assert.equal(
        invocation.schema.properties.tool_calls.items.properties.name.const,
        "add",
      );
      assert.equal(invocation.schema.properties.tool_calls.minItems, 1);
      assert.equal(invocation.schema.properties.tool_calls.maxItems, 1);
      assert.doesNotMatch(
        JSON.stringify(invocation.schema),
        /Add two numbers|Multiply two numbers|parameters/,
      );
      assert.match(invocation.systemPrompt, /Add two numbers/);
    });

    await t.test("single tool call returns a Codex-owned function call", async () => {
      const firstResponse = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "__single_tool__" }],
        tools: FUNCTION_TOOLS,
      });
      assert.equal(firstResponse.status, 200);
      const first = await firstResponse.json();
      assert.equal(first.choices[0].finish_reason, "tool_calls");
      assert.equal(first.choices[0].message.content, null);
      assert.equal(first.choices[0].message.tool_calls.length, 1);
      const call = first.choices[0].message.tool_calls[0];
      assert.match(call.id, /^call_[0-9a-f]{32}$/);
      assert.equal(call.type, "function");
      assert.equal(call.function.name, "add");
      assert.equal(call.function.arguments, '{"a":2,"b":3}');

      const secondResponse = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [
          { role: "user", content: "__single_tool__" },
          first.choices[0].message,
          {
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: "5",
          },
        ],
        tools: FUNCTION_TOOLS,
      });
      assert.equal(secondResponse.status, 200);
      const second = await secondResponse.json();
      assert.equal(second.choices[0].finish_reason, "stop");
      assert.equal(second.choices[0].message.content, "Final answer from tool result: 5");
      assert.equal("tool_calls" in second.choices[0].message, false);

      const secondInvocation = readLog(logPath)
        .filter((entry) => entry.kind === "inference")
        .find((entry) => entry.stdin.includes(call.id));
      assert.ok(secondInvocation);
      assert.ok(secondInvocation.args.every((argument) => !argument.includes(call.id)));
    });

    await t.test("a later turn resumes by replaying history into a fresh isolated child", async () => {
      const firstResponse = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "__resume_first__" }],
      });
      assert.equal(firstResponse.status, 200);
      const first = await firstResponse.json();
      assert.equal(first.choices[0].message.content, "First turn reply.");

      const secondResponse = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [
          { role: "user", content: "__resume_first__" },
          first.choices[0].message,
          { role: "user", content: "__resume_second__" },
        ],
      });
      assert.equal(secondResponse.status, 200);
      const second = await secondResponse.json();
      assert.equal(
        second.choices[0].message.content,
        "Second turn saw the first assistant reply.",
      );

      const invocations = readLog(logPath).filter(
        (entry) => entry.kind === "inference" &&
          ["resume-first", "resume-second"].includes(entry.caseId),
      );
      assert.equal(invocations.length, 2);
      assert.notEqual(invocations[0].pid, invocations[1].pid);
      assert.deepEqual(
        JSON.parse(invocations[1].stdin).messages.map((message) => message.role),
        ["user", "assistant", "user"],
      );
      assert.match(invocations[1].stdin, /First turn reply/);
      assert.ok(invocations[1].args.includes("--no-session-persistence"));
      assert.equal(invocations[1].args.includes("--resume"), false);
      assert.equal(invocations[1].args.includes("--session-id"), false);
    });

    await t.test("parallel tool calls retain independent call IDs", async () => {
      const response = await postCompletion(base, {
        model: "claude-fable-5",
        messages: [{ role: "user", content: "__parallel_tools__" }],
        tools: FUNCTION_TOOLS,
      });
      assert.equal(response.status, 200);
      const completion = await response.json();
      const calls = completion.choices[0].message.tool_calls;
      assert.equal(completion.choices[0].finish_reason, "tool_calls");
      assert.deepEqual(calls.map((call) => call.function.name), ["add", "multiply"]);
      assert.deepEqual(calls.map((call) => call.function.arguments), [
        '{"a":2,"b":3}',
        '{"a":4,"b":5}',
      ]);
      assert.equal(new Set(calls.map((call) => call.id)).size, 2);
    });

    await t.test("unknown and malformed fake tool calls are rejected", async () => {
      for (const marker of [
        "__unknown_tool__",
        "__invalid_tool__",
        "__schema_invalid_tool__",
      ]) {
        const response = await postCompletion(base, {
          model: "claude-opus-5",
          messages: [{ role: "user", content: marker }],
          tools: FUNCTION_TOOLS,
        });
        assert.equal(response.status, 502);
        const body = await response.json();
        assert.equal(body.error.type, "claude_code_bridge_error");
        assert.equal(body.error.message, "The Claude Code bridge could not complete the request.");
      }
    });

    await t.test("tool policy is enforced both in the CLI schema and after parsing", async () => {
      const noneResponse = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "__single_tool__ choice-none" }],
        tools: FUNCTION_TOOLS,
        tool_choice: "none",
      });
      assert.equal(noneResponse.status, 502);
      const noneInvocation = readLog(logPath)
        .filter((entry) => entry.kind === "inference")
        .find((entry) => entry.stdin.includes("choice-none"));
      assert.equal(noneInvocation.schema.properties.tool_calls.maxItems, 0);

      const requiredResponse = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "required-without-tool" }],
        tools: FUNCTION_TOOLS,
        tool_choice: "required",
      });
      assert.equal(requiredResponse.status, 502);
      const requiredInvocation = readLog(logPath)
        .filter((entry) => entry.kind === "inference")
        .find((entry) => entry.stdin.includes("required-without-tool"));
      assert.equal(requiredInvocation.schema.properties.tool_calls.minItems, 1);

      const parallelResponse = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "__parallel_tools__ disabled-parallel" }],
        tools: FUNCTION_TOOLS,
        parallel_tool_calls: false,
      });
      assert.equal(parallelResponse.status, 502);

      const beforeUnavailable = readLog(logPath).filter(
        (entry) => entry.kind === "inference",
      ).length;
      const unavailableResponse = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "unavailable-choice" }],
        tools: FUNCTION_TOOLS,
        tool_choice: {
          type: "function",
          function: { name: "not_supplied" },
        },
      });
      assert.equal(unavailableResponse.status, 400);
      assert.equal((await unavailableResponse.json()).error.type, "invalid_request_error");
      assert.equal(
        readLog(logPath).filter((entry) => entry.kind === "inference").length,
        beforeUnavailable,
      );

      const unsupportedSchemaResponse = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "unsupported-schema" }],
        tools: [{
          type: "function",
          function: {
            name: "unsupported_schema",
            parameters: {
              type: "object",
              unevaluatedProperties: false,
            },
          },
        }],
      });
      assert.equal(unsupportedSchemaResponse.status, 400);
      assert.equal(
        (await unsupportedSchemaResponse.json()).error.type,
        "invalid_request_error",
      );
      assert.equal(
        readLog(logPath).filter((entry) => entry.kind === "inference").length,
        beforeUnavailable,
      );
    });

    await t.test("streaming responses use complete SSE records and a DONE sentinel", async () => {
      const response = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "__plain_sse__" }],
        stream: true,
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /^text\/event-stream/);
      assert.match(response.headers.get("cache-control"), /no-cache/);
      const raw = await response.text();
      assert.equal(raw.endsWith("\n\n"), true);
      const records = raw.split("\n\n").filter(Boolean);
      assert.equal(records.at(-1), "data: [DONE]");
      assert.ok(records.every((record) => record.startsWith("data: ")));
      const chunks = records
        .slice(0, -1)
        .map((record) => JSON.parse(record.slice("data: ".length)));
      assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant" });
      assert.deepEqual(chunks[1].choices[0].delta, { content: "Plain text reply." });
      assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
      assert.equal(chunks.at(-1).usage.total_tokens, 17);
    });

    await t.test("streaming tool calls include stable call and parallel indices", async () => {
      const response = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "__parallel_tools__ stream" }],
        tools: FUNCTION_TOOLS,
        stream: true,
      });
      assert.equal(response.status, 200);
      const records = (await response.text()).split("\n\n").filter(Boolean);
      assert.equal(records.at(-1), "data: [DONE]");
      const chunks = records
        .slice(0, -1)
        .map((record) => JSON.parse(record.slice("data: ".length)));
      const toolDelta = chunks.find((chunk) => chunk.choices[0].delta.tool_calls);
      const calls = toolDelta.choices[0].delta.tool_calls;
      assert.deepEqual(calls.map((call) => call.index), [0, 1]);
      assert.deepEqual(calls.map((call) => call.function.name), ["add", "multiply"]);
      assert.ok(calls.every((call) => /^call_[0-9a-f]{32}$/.test(call.id)));
      assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
    });

    await t.test("CLI and provider failures return bounded bridge errors", async () => {
      const authentication = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "__auth_exit__" }],
      });
      assert.equal(authentication.status, 401);
      const authenticationBody = await authentication.json();
      assert.equal(authenticationBody.error.type, "authentication_error");
      assert.match(authenticationBody.error.message, /claude auth login --claudeai/);

      const genericExit = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "__generic_exit__" }],
      });
      assert.equal(genericExit.status, 502);
      assert.match((await genericExit.json()).error.message, /\(7\)/);

      for (const marker of ["__provider_error__", "__malformed_output__"]) {
        const response = await postCompletion(base, {
          model: "claude-opus-5",
          messages: [{ role: "user", content: marker }],
        });
        assert.equal(response.status, 502);
        const body = await response.json();
        assert.equal(body.error.type, "claude_code_bridge_error");
        assert.equal(
          body.error.message,
          "The Claude Code bridge could not complete the request.",
        );
      }
    });
  }),
);

test(
  "aborting one client request terminates only its Claude child",
  { skip: process.platform === "win32" },
  async () => withForwarder(async ({ base, child, logPath }) => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = postCompletion(
      base,
      {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "__slow_first__" }],
      },
      { signal: firstController.signal },
    ).then(
      () => undefined,
      (error) => error,
    );
    const second = postCompletion(
      base,
      {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "__slow_second__" }],
      },
      { signal: secondController.signal },
    ).then(
      () => undefined,
      (error) => error,
    );

    try {
      const firstStarted = await waitForLog(
        logPath,
        (entry) => entry.kind === "inference" && entry.stdin.includes("__slow_first__"),
      );
      const secondStarted = await waitForLog(
        logPath,
        (entry) => entry.kind === "inference" && entry.stdin.includes("__slow_second__"),
      );
      assert.notEqual(firstStarted.pid, secondStarted.pid);

      firstController.abort();
      const firstError = await first;
      assert.equal(firstError?.name, "AbortError");
      const firstSignal = await waitForLog(
        logPath,
        (entry) => entry.kind === "signal" && entry.pid === firstStarted.pid,
      );
      assert.equal(firstSignal.signal, "SIGTERM");
      assert.equal(
        readLog(logPath).some(
          (entry) => entry.kind === "signal" && entry.pid === secondStarted.pid,
        ),
        false,
      );
      assert.equal(child.exitCode, null);

      const followup = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "forwarder-still-alive" }],
      });
      assert.equal(followup.status, 200);
      assert.equal((await followup.json()).choices[0].message.content, "Plain text reply.");
    } finally {
      firstController.abort();
      secondController.abort();
      await Promise.all([first, second]);
      await waitForLog(
        logPath,
        (entry) => entry.kind === "signal" && entry.stdin.includes("__slow_second__"),
      );
    }
  }),
);

test(
  "health stays live but reports an unready non-subscription CLI honestly",
  { skip: process.platform === "win32" },
  async () => withForwarder(async ({ base, health, logPath }) => {
    assert.equal(health.ok, true);
    assert.equal(health.ready, false);
    assert.equal(health.cli_installed, true);
    assert.equal(health.credential_present, false);
    assert.equal(health.auth_method, "api_key");
    assert.match(health.error, /Claude\.ai subscription authentication/);
    assert.deepEqual(health.concurrency, {
      active: 0,
      queued: 0,
      limit: 2,
      queue_limit: 8,
    });

    const live = await fetch(`${base}/health`, {
      headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
    });
    assert.equal(live.status, 200);
    const inference = await postCompletion(base, {
      model: "claude-opus-5",
      messages: [{ role: "user", content: "must-not-run" }],
    });
    assert.equal(inference.status, 401);
    assert.equal(readLog(logPath).some((entry) => entry.kind === "inference"), false);
  }, { authMethod: "api_key" }),
);

test(
  "Claude concurrency settings enforce their documented bounds before listen",
  { skip: process.platform === "win32" },
  async () => {
    for (const [options, message] of [
      [{ concurrency: 0 }, /between 1 and 8/],
      [{ concurrency: 9 }, /between 1 and 8/],
      [{ queueLimit: 0 }, /between 1 and 32/],
      [{ queueLimit: 33 }, /between 1 and 32/],
    ]) {
      await assert.rejects(withForwarder(async () => {}, options), message);
    }
  },
);

test(
  "Claude concurrency queues, rejects overflow, and removes an aborted waiter",
  { skip: process.platform === "win32" },
  async () => withForwarder(async ({ base, health, logPath }) => {
    assert.deepEqual(health.concurrency, {
      active: 0,
      queued: 0,
      limit: 1,
      queue_limit: 1,
    });
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const replacementController = new AbortController();
    const active = postCompletion(
      base,
      {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "__slow_active__" }],
      },
      { signal: activeController.signal },
    ).then(
      () => undefined,
      (error) => error,
    );
    let queued;
    let replacement;

    try {
      const activeInvocation = await waitForLog(
        logPath,
        (entry) => entry.kind === "inference" && entry.stdin.includes("__slow_active__"),
      );
      queued = postCompletion(
        base,
        {
          model: "claude-opus-5",
          messages: [{ role: "user", content: "__slow_queued__" }],
        },
        { signal: queuedController.signal },
      ).then(
        () => undefined,
        (error) => error,
      );
      assert.deepEqual(
        await waitForConcurrency(
          base,
          (snapshot) => snapshot.active === 1 && snapshot.queued === 1,
        ),
        { active: 1, queued: 1, limit: 1, queue_limit: 1 },
      );
      assert.equal(
        readLog(logPath).some(
          (entry) => entry.kind === "inference" && entry.stdin.includes("__slow_queued__"),
        ),
        false,
      );

      const overflow = await postCompletion(base, {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "queue-overflow" }],
      });
      assert.equal(overflow.status, 429);
      const overflowBody = await overflow.json();
      assert.equal(overflowBody.error.type, "rate_limit_error");
      assert.match(overflowBody.error.message, /queue is full/);

      queuedController.abort();
      assert.equal((await queued)?.name, "AbortError");
      await waitForConcurrency(
        base,
        (snapshot) => snapshot.active === 1 && snapshot.queued === 0,
      );
      assert.equal(
        readLog(logPath).some(
          (entry) => entry.kind === "inference" && entry.stdin.includes("__slow_queued__"),
        ),
        false,
      );

      replacement = postCompletion(
        base,
        {
          model: "claude-opus-5",
          messages: [{ role: "user", content: "replacement-after-abort" }],
        },
        { signal: replacementController.signal },
      );
      await waitForConcurrency(
        base,
        (snapshot) => snapshot.active === 1 && snapshot.queued === 1,
      );
      activeController.abort();
      assert.equal((await active)?.name, "AbortError");
      const activeSignal = await waitForLog(
        logPath,
        (entry) => entry.kind === "signal" && entry.pid === activeInvocation.pid,
      );
      assert.equal(activeSignal.signal, "SIGTERM");
      const replacementResponse = await replacement;
      assert.equal(replacementResponse.status, 200);
      await waitForConcurrency(
        base,
        (snapshot) => snapshot.active === 0 && snapshot.queued === 0,
      );
    } finally {
      activeController.abort();
      queuedController.abort();
      replacementController.abort();
      await Promise.allSettled([active, queued, replacement].filter(Boolean));
    }
  }, { concurrency: 1, queueLimit: 1 }),
);

test(
  "an unanswered status probe is indeterminate, not a logged-out verdict",
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-code-indeterminate-"));
    const logPath = path.join(directory, "fake-claude.jsonl");
    const stalling = createFakeClaude(directory, {
      logPath,
      statusStallAfterCalls: 0,
      statusStallMs: 5_000,
    });
    try {
      withEnvironment(
        {
          CLAUDE_CODE_BIN: stalling,
          MODEL_ROUTER_CLAUDE_CODE_STATUS_TIMEOUT_MS: undefined,
        },
        () => {
          const status = claudeCodeStatus();
          assert.equal(status.installed, true, "a stalled probe does not mean uninstalled");
          assert.equal(status.configured, false);
          assert.equal(status.determinate, false, "a timeout reaches no verdict");
          assert.match(status.error, /could not be determined/);
          assert.doesNotMatch(status.error, /not signed into/);
        },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a missing CLI stays a determinate verdict",
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-code-missing-"));
    try {
      withEnvironment({ CLAUDE_CODE_BIN: path.join(directory, "absent") }, () => {
        const status = claudeCodeStatus();
        assert.equal(status.installed, false);
        assert.equal(status.configured, false);
        assert.equal(status.determinate, true, "absence is knowable");
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "the bridge keeps serving on a stalled probe instead of faking an auth failure",
  async () => withForwarder(async ({ base, health }) => {
    // The boot probe answered; every later probe now hangs past the timeout,
    // which is exactly the loaded-machine case that used to emit a bogus 401
    // and put the LiteLLM deployment into a 429 cooldown.
    assert.equal(health.ready, true);
    await new Promise((resolve) => setTimeout(resolve, 5_100));

    const response = await postCompletion(base, {
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(response.status, 200, "a valid subscription must not be rejected");

    const stale = await (await fetch(`${base}/v1/health`, {
      headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
    })).json();
    assert.equal(stale.ready, true);
    assert.equal(stale.status_stale, true, "health must admit the verdict is carried over");
  }, { statusStallAfterCalls: 1, statusStallMs: 3_000, statusTimeoutMs: 300 }),
);

test(
  "a genuine logout still fails closed with 401",
  async () => withForwarder(async ({ base }) => {
    const response = await postCompletion(base, {
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.type, "authentication_error");
  }, { loggedIn: false }),
);
