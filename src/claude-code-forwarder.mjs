import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  CLAUDE_CODE_MODELS,
  buildClaudeBridgePrompt,
  buildClaudeBridgeSystemPrompt,
  chatCompletion,
  chatCompletionChunks,
  claudeBridgeSchema,
  claudeEffort,
  parseClaudeBridgeOutput,
  validateClaudeBridgeRequest,
} from "./claude-code-adapter.mjs";
import {
  claudeCodeBinary,
  claudeCodeStatusAsync,
  claudeCodeVersionAsync,
  claudeSubscriptionEnvironment,
} from "./claude-code-status.mjs";
import {
  httpErrorStatus,
  readRequestBody,
  requireInternalAuth,
  writeJson,
} from "./http-utils.mjs";
import { PORTS, TARGET } from "./paths.mjs";

const LISTEN_HOST =
  process.env.MODEL_ROUTER_CLAUDE_CODE_HOST ||
  (TARGET === "codex" ? process.env.CODEX_ROUTER_CLAUDE_CODE_HOST : undefined) ||
  "127.0.0.1";
const LISTEN_PORT = Number(
  process.env.MODEL_ROUTER_CLAUDE_CODE_PORT ||
    (TARGET === "codex" ? process.env.CODEX_ROUTER_CLAUDE_CODE_PORT : undefined) ||
    PORTS.claudeCode,
);
const INTERNAL_KEY =
  process.env.MODEL_ROUTER_INTERNAL_KEY ||
  (TARGET === "codex" ? process.env.CODEX_ROUTER_INTERNAL_KEY : undefined);
const QUIET =
  process.env.MODEL_ROUTER_QUIET === "1" ||
  (TARGET === "codex" && process.env.CODEX_ROUTER_QUIET === "1");
const MAX_CLAUDE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_CLAUDE_ERROR_BYTES = 256 * 1024;
const MAX_CONCURRENCY = 8;
const MAX_QUEUE_LIMIT = 32;
const activeClaudeRuns = new Set();
// How long a verdict the CLI actually gave us stays usable when a later probe
// cannot reach one. Long enough to ride out a loaded machine, short enough that
// a real logout still surfaces promptly.
const KNOWN_STATUS_GRACE_MS = 15 * 60 * 1000;
let healthProbe;
let healthSnapshot;
let lastDeterminateStatus;

if (!INTERNAL_KEY) throw new Error("MODEL_ROUTER_INTERNAL_KEY is required.");

class ClaudeBridgeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function configuredInteger(names, fallback, maximum) {
  const raw = names.map((name) => process.env[name]).find((value) => value !== undefined && value !== "");
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${names[0]} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function abortError(message = "Claude request was cancelled.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

class ClaudeConcurrencyGate {
  constructor(limit, queueLimit) {
    this.limit = limit;
    this.queueLimit = queueLimit;
    this.active = 0;
    this.queue = [];
    this.closedError = undefined;
  }

  snapshot() {
    return {
      active: this.active,
      queued: this.queue.length,
      limit: this.limit,
      queue_limit: this.queueLimit,
    };
  }

  acquire(signal) {
    if (this.closedError) return Promise.reject(this.closedError);
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseHandle());
    }
    if (this.queue.length >= this.queueLimit) {
      return Promise.reject(new ClaudeBridgeError("Claude Code inference queue is full.", 429));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, abort: undefined };
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index !== -1) this.queue.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
    });
  }

  releaseHandle() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  drain() {
    while (!this.closedError && this.active < this.limit && this.queue.length) {
      const entry = this.queue.shift();
      entry.signal?.removeEventListener("abort", entry.abort);
      if (entry.signal?.aborted) {
        entry.reject(abortError());
        continue;
      }
      this.active += 1;
      entry.resolve(this.releaseHandle());
    }
  }

  close(error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const entry of this.queue.splice(0)) {
      entry.signal?.removeEventListener("abort", entry.abort);
      entry.reject(error);
    }
  }
}

const concurrency = new ClaudeConcurrencyGate(
  configuredInteger(
    ["MODEL_ROUTER_CLAUDE_CODE_CONCURRENCY", "CODEX_ROUTER_CLAUDE_CODE_CONCURRENCY"],
    2,
    MAX_CONCURRENCY,
  ),
  configuredInteger(
    ["MODEL_ROUTER_CLAUDE_CODE_QUEUE_LIMIT", "CODEX_ROUTER_CLAUDE_CODE_QUEUE_LIMIT"],
    8,
    MAX_QUEUE_LIMIT,
  ),
);

function claudeArgs(payload, systemPromptPath) {
  return [
    "-p",
    "--safe-mode",
    "--model",
    payload.model,
    "--effort",
    claudeEffort(payload.reasoning_effort ?? payload.reasoning?.effort),
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--no-chrome",
    "--disable-slash-commands",
    "--system-prompt-file",
    systemPromptPath,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(claudeBridgeSchema(payload)),
  ];
}

function childRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function signalChild(child, signal) {
  // POSIX children are group leaders so cancellation also reaches descendants.
  if (process.platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
    }
  }
  if (!childRunning(child)) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function runClaude(payload, signal) {
  return new Promise((resolve, reject) => {
    const executable = claudeCodeBinary();
    if (!executable) {
      reject(new ClaudeBridgeError("Claude Code is not installed.", 503));
      return;
    }
    let invocationDirectory;
    let child;
    let systemPrompt;
    let prompt;
    let args;
    try {
      systemPrompt = buildClaudeBridgeSystemPrompt(payload);
      prompt = buildClaudeBridgePrompt(payload);
      invocationDirectory = mkdtempSync(path.join(os.tmpdir(), "codex-claude-bridge-"));
      const systemPromptPath = path.join(invocationDirectory, "system-prompt.txt");
      writeFileSync(systemPromptPath, systemPrompt, {
        encoding: "utf8",
        mode: 0o600,
      });
      args = claudeArgs(payload, systemPromptPath);
      child = spawn(executable, args, {
        cwd: os.tmpdir(),
        detached: process.platform !== "win32",
        env: claudeSubscriptionEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      if (invocationDirectory) rmSync(invocationDirectory, { recursive: true, force: true });
      reject(error);
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure;
    let spawnError;
    let forcedKill;
    let finished = false;
    let resolveClosed;
    const run = {
      child,
      closed: new Promise((closed) => { resolveClosed = closed; }),
      terminate(error = new ClaudeBridgeError("Claude Code forwarder is shutting down.", 503)) {
        if (!failure) failure = error;
        if (finished) return;
        signalChild(child, "SIGTERM");
        if (!forcedKill) {
          forcedKill = setTimeout(() => signalChild(child, "SIGKILL"), 2_000);
        }
      },
      forceKill() {
        if (finished) return;
        signalChild(child, "SIGKILL");
      },
    };
    activeClaudeRuns.add(run);

    const abort = () => {
      run.terminate(abortError());
    };
    child.once("error", (error) => {
      spawnError = error;
    });
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CLAUDE_OUTPUT_BYTES) {
        run.terminate(new ClaudeBridgeError("Claude Code output exceeded the bridge limit."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_CLAUDE_ERROR_BYTES) {
        stderr.push(chunk);
      } else if (stderrBytes - chunk.length < MAX_CLAUDE_ERROR_BYTES) {
        stderr.push(chunk.subarray(0, MAX_CLAUDE_ERROR_BYTES - (stderrBytes - chunk.length)));
      }
    });
    child.stdout.once("error", (error) => run.terminate(error));
    child.stderr.once("error", (error) => run.terminate(error));
    child.stdin.once("error", () => {
      // Early CLI exit is reported from the close event with its stderr and status.
    });
    child.once("close", (code, exitSignal) => {
      finished = true;
      activeClaudeRuns.delete(run);
      if (forcedKill) clearTimeout(forcedKill);
      signal?.removeEventListener("abort", abort);
      try {
        rmSync(invocationDirectory, { recursive: true, force: true });
      } catch {
        // Completion and child reaping must not depend on best-effort temp cleanup.
      }
      resolveClosed();

      if (failure) {
        reject(failure);
        return;
      }
      if (spawnError) {
        reject(
          spawnError?.code === "ENOENT"
            ? new ClaudeBridgeError("Claude Code is not installed.", 503)
            : spawnError,
        );
        return;
      }
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      const details = Buffer.concat(stderr).toString("utf8");
      const authenticationFailure = /login|authenticat|oauth|credential/i.test(details);
      reject(
        new ClaudeBridgeError(
          authenticationFailure
            ? "Claude Code subscription login is unavailable; run `claude auth login --claudeai`."
            : `Claude Code exited before completing the request (${String(code ?? exitSignal)}).`,
          authenticationFailure ? 401 : 502,
        ),
      );
    });

    if (signal?.aborted) abort();
    else {
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.end(prompt);
    }
  });
}

function writeStream(response, completion) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  for (const chunk of chatCompletionChunks(completion)) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function modelList() {
  const created = Math.floor(Date.now() / 1_000);
  return {
    object: "list",
    data: [...CLAUDE_CODE_MODELS].map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "anthropic",
    })),
  };
}

async function currentHealthSnapshot() {
  if (healthSnapshot && Date.now() - healthSnapshot.checkedAt < 5_000) return healthSnapshot;
  if (healthProbe) return healthProbe;
  healthProbe = Promise.all([
    claudeCodeStatusAsync(),
    claudeCodeVersionAsync(),
  ]).then(([status, cliVersion]) => {
    // An indeterminate probe (spawn timeout, killed child, unparseable output)
    // says nothing about the credential. Falling back to "not signed in" would
    // reject a valid subscription and, worse, put the LiteLLM deployment into
    // cooldown so the NEXT request fails as 429. Reuse the last verdict the CLI
    // actually gave us while the login is still plausibly valid.
    if (!status.determinate && lastDeterminateStatus &&
        Date.now() - lastDeterminateStatus.at < KNOWN_STATUS_GRACE_MS) {
      return {
        status: { ...lastDeterminateStatus.status, stale: true, probeError: status.error },
        cliVersion: cliVersion ?? lastDeterminateStatus.cliVersion,
        checkedAt: Date.now(),
      };
    }
    if (status.determinate) lastDeterminateStatus = { status, cliVersion, at: Date.now() };
    return { status, cliVersion, checkedAt: Date.now() };
  });
  try {
    healthSnapshot = await healthProbe;
    return healthSnapshot;
  } finally {
    healthProbe = undefined;
  }
}

async function handleRequest(request, response) {
  const startedAt = Date.now();
  const requestUrl = new URL(
    request.url || "/",
    `http://${request.headers.host || LISTEN_HOST}`,
  );
  if (!requireInternalAuth(request, response, INTERNAL_KEY)) return;

  const route = requestUrl.pathname.replace(/^\/v1(?=\/|$)/, "");
  if (request.method === "GET" && route === "/health") {
    const { status, cliVersion } = await currentHealthSnapshot();
    const ready = status.installed && status.configured;
    writeJson(response, 200, {
      ok: true,
      ready,
      service: "codex-router-claude-code-forwarder",
      installed: status.installed,
      configured: status.configured,
      cli_installed: status.installed,
      credential_present: status.configured,
      auth_method: status.authMethod,
      subscription_type: status.subscriptionType,
      cli_version: cliVersion,
      // Do not present a carried-over verdict as a fresh one.
      status_stale: status.stale === true ? true : undefined,
      status_probe_error: status.stale === true ? status.probeError : undefined,
      error: ready ? undefined : status.error,
      concurrency: concurrency.snapshot(),
    });
    return;
  }
  if (request.method === "GET" && route === "/models") {
    writeJson(response, 200, modelList());
    return;
  }
  if (!(request.method === "POST" && route === "/chat/completions")) {
    writeJson(response, 404, {
      error: { type: "proxy_route_not_found", message: "Unsupported Claude Code route." },
    });
    return;
  }

  const controller = new AbortController();
  let clientGone = request.aborted || response.destroyed;
  const cancel = () => {
    clientGone = true;
    controller.abort();
  };
  request.once("aborted", cancel);
  response.once("close", () => {
    if (!response.writableEnded) cancel();
  });
  if (clientGone) controller.abort();

  const { status } = await currentHealthSnapshot();
  if (clientGone) return;
  if (!status.configured) {
    // Only a verdict the CLI actually produced justifies an auth error. When
    // the probe merely failed to answer, say so with a retryable 503 instead of
    // accusing a valid subscription of being signed out.
    if (status.determinate) {
      writeJson(response, 401, {
        error: {
          type: "authentication_error",
          message: "Claude Code is not signed into a Claude.ai subscription; run `claude auth login --claudeai`.",
        },
      });
      return;
    }
    writeJson(response, 503, {
      error: {
        type: "claude_code_bridge_error",
        message: "Claude Code subscription status could not be determined; retry shortly.",
      },
    });
    return;
  }

  let payload;
  try {
    payload = JSON.parse((await readRequestBody(request)).toString("utf8"));
  } catch {
    throw new ClaudeBridgeError("Claude Code bridge requires a valid JSON request.", 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ClaudeBridgeError("Claude Code bridge requires a JSON object.", 400);
  }
  if (!CLAUDE_CODE_MODELS.has(payload.model)) {
    throw new ClaudeBridgeError(`Unsupported Claude Code model: ${String(payload.model)}.`, 400);
  }
  validateClaudeBridgeRequest(payload);

  let release;
  try {
    release = await concurrency.acquire(controller.signal);
    if (shuttingDown) {
      throw new ClaudeBridgeError("Claude Code forwarder is shutting down.", 503);
    }
    const stdout = await runClaude(payload, controller.signal);
    const bridge = parseClaudeBridgeOutput(stdout, payload);
    const completion = chatCompletion(payload.model, bridge);
    if (payload.stream) writeStream(response, completion);
    else writeJson(response, 200, completion);
    if (!QUIET) {
      console.error(
        `[claude-code] model=${payload.model} tools=${bridge.toolCalls.length} ${Date.now() - startedAt}ms`,
      );
    }
  } catch (error) {
    if (clientGone || error?.name === "AbortError") return;
    throw error;
  } finally {
    release?.();
  }
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const status = error?.status || httpErrorStatus(error);
    console.error("[claude-code] request failed");
    if (!response.headersSent) {
      writeJson(response, status, {
        error: {
          type: status === 401
            ? "authentication_error"
            : status === 429
              ? "rate_limit_error"
              : status === 400
                ? "invalid_request_error"
                : "claude_code_bridge_error",
          message: error instanceof ClaudeBridgeError
            ? error.message
            : "The Claude Code bridge could not complete the request.",
        },
      });
    } else if (!response.writableEnded) {
      response.destroy();
    }
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.error("[claude-code] listening");
});

let shuttingDown = false;
let shutdownPromise;

function closeServer() {
  return new Promise((resolve) => server.close(resolve));
}

async function shutdown() {
  shuttingDown = true;
  const shutdownError = new ClaudeBridgeError("Claude Code forwarder is shutting down.", 503);
  concurrency.close(shutdownError);
  const serverClosed = closeServer();
  server.closeIdleConnections?.();

  const runs = [...activeClaudeRuns];
  for (const run of runs) run.terminate(shutdownError);
  const forceTimer = setTimeout(() => {
    for (const run of activeClaudeRuns) run.forceKill();
  }, 2_000);
  await Promise.race([
    Promise.allSettled(runs.map((run) => run.closed)),
    new Promise((resolve) => setTimeout(resolve, 4_000)),
  ]);
  clearTimeout(forceTimer);
  for (const run of activeClaudeRuns) run.forceKill();
  if (activeClaudeRuns.size) {
    await Promise.race([
      Promise.allSettled([...activeClaudeRuns].map((run) => run.closed)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  const closed = await Promise.race([
    serverClosed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (!closed) server.closeAllConnections?.();
  process.exit(0);
}

function requestShutdown() {
  if (shutdownPromise) {
    for (const run of activeClaudeRuns) run.forceKill();
    server.closeAllConnections?.();
    return;
  }
  shutdownPromise = shutdown();
  shutdownPromise.catch(() => process.exit(1));
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, requestShutdown);
