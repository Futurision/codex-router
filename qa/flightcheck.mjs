import { spawn } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runsRoot = path.join(root, "qa", "runs");
const retentionMs = 7 * 24 * 60 * 60 * 1_000;

function runId(now = new Date()) {
  return now.toISOString().replaceAll(":", "").replaceAll("-", "").replace(/\.\d{3}Z$/, "Z");
}

function pruneRuns(now = Date.now()) {
  mkdirSync(runsRoot, { recursive: true });
  for (const name of readdirSync(runsRoot)) {
    const target = path.join(runsRoot, name);
    let stats;
    try {
      stats = statSync(target);
    } catch {
      continue;
    }
    if (stats.isDirectory() && now - stats.mtimeMs > retentionMs) {
      rmSync(target, { recursive: true, force: true });
    }
  }
}

function sterileEnvironment(runDirectory) {
  const environment = {
    ...process.env,
    MODEL_ROUTER_TARGET: "cursor",
    NODE_NO_WARNINGS: "1",
    CLAUDE_CODE_BIN: path.join(runDirectory, "real-claude-is-disabled"),
    CLAUDE_CONFIG_DIR: path.join(runDirectory, "empty-claude-config"),
  };
  for (const key of [
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
    "KIMI_API_KEY",
    "MODEL_ROUTER_INTERNAL_KEY",
  ]) {
    delete environment[key];
  }
  return environment;
}

function execute(command, args, environment) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const startedAt = Date.now();
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        duration_ms: Date.now() - startedAt,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

mkdirSync(runsRoot, { recursive: true });
const lockTarget = path.join(runsRoot, ".flightcheck-lock-target");
writeFileSync(lockTarget, "", { flag: "a", mode: 0o600 });
const releaseLock = await lockfile.lock(lockTarget, {
  realpath: false,
  stale: 30_000,
  update: 10_000,
  retries: {
    retries: 120,
    factor: 1.2,
    minTimeout: 250,
    maxTimeout: 1_000,
  },
});

pruneRuns();
const startedAt = new Date();
const directory = path.join(runsRoot, runId(startedAt));
mkdirSync(directory, { recursive: true });
const environment = sterileEnvironment(directory);

const checks = await execute(process.execPath, ["scripts-check.mjs"], environment);
const tests = await execute(process.execPath, [
  "--test",
  "test/claude-code-forwarder.test.mjs",
], environment);
writeFileSync(path.join(directory, "check.stdout.log"), checks.stdout, "utf8");
writeFileSync(path.join(directory, "check.stderr.log"), checks.stderr, "utf8");
writeFileSync(path.join(directory, "test.stdout.log"), tests.stdout, "utf8");
writeFileSync(path.join(directory, "test.stderr.log"), tests.stderr, "utf8");

const transcript = [
  `$ ${process.execPath} scripts-check.mjs`,
  checks.stdout,
  checks.stderr,
  `$ ${process.execPath} --test test/claude-code-forwarder.test.mjs`,
  tests.stdout,
  tests.stderr,
].join("\n");
writeFileSync(path.join(directory, "recording.txt"), transcript, "utf8");

const fatalLog = /\b(?:fatal|segmentation fault|uncaught|unhandled rejection|core dumped)\b/i;
const sharedPass = checks.code === 0 && tests.code === 0 && !fatalLog.test(transcript);
const flows = [
  {
    id: "state-0",
    name: "State 0",
    assertions: [
      "health stays live but reports an unready non-subscription CLI honestly",
      "Claude status accepts only a Claude.ai subscription",
    ],
  },
  {
    id: "aha-text",
    name: "Aha moment",
    assertions: [
      "plain text uses safe flags and stdin",
      "streaming responses use complete SSE records and a DONE sentinel",
    ],
  },
  {
    id: "core-tool-loop",
    name: "Core ritual",
    assertions: [
      "single tool call returns a Codex-owned function call",
      "a later turn resumes by replaying history into a fresh isolated child",
      "streaming tool calls include stable call and parallel indices",
    ],
  },
  {
    id: "gate-fail-closed",
    name: "Gate moment",
    assertions: [
      "unknown and malformed fake tool calls are rejected",
      "CLI and provider failures return bounded bridge errors",
      "aborting one client request terminates only its Claude child",
      "Claude concurrency queues, rejects overflow, and removes an aborted waiter",
    ],
  },
].map((flow) => {
  const evidence = Object.fromEntries(
    flow.assertions.map((assertion) => [assertion, tests.stdout.includes(assertion)]),
  );
  return {
    ...flow,
    evidence,
    passed: sharedPass && Object.values(evidence).every(Boolean),
  };
});

const summary = {
  schema_version: 1,
  run_id: path.basename(directory),
  started_at: startedAt.toISOString(),
  completed_at: new Date().toISOString(),
  sterile_environment: "temporary fake-Claude CLI plus random loopback ports",
  live_provider_called: false,
  evidence_scope: "simulated adapter contract; not real Claude provider evidence",
  commands: {
    static_check: { code: checks.code, signal: checks.signal, duration_ms: checks.duration_ms },
    focused_tests: { code: tests.code, signal: tests.signal, duration_ms: tests.duration_ms },
  },
  flows,
  passed: flows.every((flow) => flow.passed),
};
writeFileSync(
  path.join(directory, "assertions.json"),
  `${JSON.stringify({ flows }, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  path.join(directory, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);

const rows = flows.map((flow) => `
  <tr>
    <td>${flow.passed ? "PASS" : "FAIL"}</td>
    <td>${escapeHtml(flow.name)}</td>
    <td><ul>${flow.assertions.map((item) => `<li><strong>${flow.evidence[item] ? "PASS" : "FAIL"}</strong> ${escapeHtml(item)}</li>`).join("")}</ul></td>
  </tr>`).join("");
const report = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Claude bridge Flightcheck ${escapeHtml(summary.run_id)}</title>
<style>body{font:16px system-ui;max-width:1050px;margin:40px auto;padding:0 20px;color:#171717}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:12px;vertical-align:top}th{text-align:left;background:#f3f3f3}code{background:#eee;padding:2px 5px}a{color:#0645ad}</style></head>
<body><h1>Claude subscription bridge Flightcheck</h1>
<p><strong>${summary.passed ? "PASS" : "FAIL"}</strong> · ${escapeHtml(summary.completed_at)}</p>
<p>Sterile environment: ${escapeHtml(summary.sterile_environment)}. Live provider called: no.</p>
<p><strong>Evidence boundary:</strong> ${escapeHtml(summary.evidence_scope)}.</p>
<table><thead><tr><th>Status</th><th>Flow</th><th>API/contract assertions persisted in assertions.json</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Artifacts</h2><ul>
<li><a href="recording.txt">Terminal recording</a></li>
<li><a href="test.stdout.log">Focused test log</a> · <a href="test.stderr.log">stderr</a></li>
<li><a href="check.stdout.log">Static-check log</a> · <a href="check.stderr.log">stderr</a></li>
<li><a href="assertions.json">Data assertions</a> · <a href="summary.json">Summary</a></li>
</ul></body></html>\n`;
writeFileSync(path.join(directory, "report.html"), report, "utf8");

process.stdout.write(`${summary.passed ? "PASS" : "FAIL"} ${path.join(directory, "report.html")}\n`);
await releaseLock();
if (!summary.passed) process.exitCode = 1;
