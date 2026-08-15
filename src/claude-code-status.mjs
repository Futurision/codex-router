import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

const SUBSCRIPTION_ENVIRONMENT_ALLOWLIST = [
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_CONFIG_DIR",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "COLORTERM",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_TELEMETRY",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "ComSpec",
  "SystemRoot",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];

export function claudeSubscriptionEnvironment(source = process.env) {
  // The router process carries unrelated provider and internal service secrets.
  // Build the CLI environment from an allowlist so none become Claude child env.
  const environment = {};
  for (const key of SUBSCRIPTION_ENVIRONMENT_ALLOWLIST) {
    if (typeof source[key] === "string" && source[key]) environment[key] = source[key];
  }
  const pathEntries = [
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    ...(String(environment.PATH || "")
      .split(path.delimiter)
      .filter((entry) => path.isAbsolute(entry))),
  ].filter((entry) => path.isAbsolute(entry));
  environment.PATH = [...new Set(pathEntries)].join(path.delimiter);
  environment.CLAUDE_CODE_SAFE_MODE = "1";
  return environment;
}

function executable(candidate) {
  if (typeof candidate !== "string" || !candidate || !path.isAbsolute(candidate)) return undefined;
  try {
    accessSync(candidate, constants.X_OK);
    return path.resolve(candidate);
  } catch {
    return undefined;
  }
}

function pathCandidates(name, source) {
  return String(source.PATH || "")
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.join(entry, name));
}

export function claudeCodeBinary(source = process.env) {
  if (source.CLAUDE_CODE_BIN !== undefined) {
    return executable(source.CLAUDE_CODE_BIN);
  }
  const executableName = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [
    ...pathCandidates(executableName, source),
    path.join(path.dirname(process.execPath), executableName),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(os.homedir(), ".npm-global", "bin", "claude"),
    path.join(os.homedir(), ".local", "bin", "claude"),
    path.join(os.homedir(), ".volta", "bin", "claude"),
    path.join(os.homedir(), ".asdf", "shims", "claude"),
    path.join(os.homedir(), ".local", "share", "mise", "shims", "claude"),
    ...(process.platform === "win32"
      ? [
          path.join(source.APPDATA || "", "npm", "claude.cmd"),
          path.join(os.homedir(), ".local", "bin", "claude.exe"),
        ]
      : []),
  ];
  return candidates.map(executable).find(Boolean);
}

function readJson(command, args, options = {}) {
  const output = execFileSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 5_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    env: claudeSubscriptionEnvironment(options.env),
  });
  return JSON.parse(output);
}

// The CLI is a Node program: a cold spawn costs ~300ms on an idle machine, and
// this host routinely runs at load 10+ with parallel builds. A 1.5s budget has
// no headroom there, and every expiry used to surface as a bogus 401.
const DEFAULT_STATUS_PROBE_TIMEOUT_MS = 10_000;
const STATUS_PROBE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.MODEL_ROUTER_CLAUDE_CODE_STATUS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STATUS_PROBE_TIMEOUT_MS;
})();

function readJsonAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      timeout: options.timeout ?? STATUS_PROBE_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: claudeSubscriptionEnvironment(options.env),
    }, (error, stdout) => {
      if (error) reject(error);
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      }
    });
  });
}

function statusPayload(status, executable) {
  const authMethod = String(status?.authMethod || "none");
  const subscriptionType = String(status?.subscriptionType || "").toLowerCase();
  const configured = status?.loggedIn === true && authMethod === "claude.ai";
  return {
    installed: true,
    configured,
    // The CLI answered, so this verdict is authoritative either way.
    determinate: true,
    authMethod,
    subscriptionType: subscriptionType || undefined,
    executable,
    ...(configured
      ? {}
      : {
          error: status?.loggedIn === true
            ? "Claude Code is not using Claude.ai subscription authentication; run `claude auth login --claudeai`."
            : "Claude Code subscription login is unavailable; run `claude auth login --claudeai`.",
        }),
  };
}

function unavailableStatus(executable, error) {
  if (!executable) {
    return {
      installed: false,
      configured: false,
      determinate: true,
      authMethod: "none",
      error: "Claude Code is not installed.",
    };
  }
  // A missing binary is a definitive verdict. Anything else -- a spawn timeout
  // under load, a killed child, unparseable output -- means the probe could not
  // reach a verdict. Reporting that as "not signed in" turns a slow machine
  // into a fake authentication failure, so callers must be able to tell the
  // two apart and keep using their last known-good status.
  const missing = error?.code === "ENOENT";
  return {
    installed: !missing,
    configured: false,
    determinate: missing,
    authMethod: "none",
    executable,
    error: missing
      ? "Claude Code is not installed."
      : "Claude Code subscription status could not be determined; the CLI probe did not answer.",
  };
}

export function claudeCodeStatus() {
  const executable = claudeCodeBinary();
  if (!executable) return unavailableStatus();
  try {
    return statusPayload(readJson(executable, ["auth", "status", "--json"]), executable);
  } catch (error) {
    return unavailableStatus(executable, error);
  }
}

export async function claudeCodeStatusAsync(options = {}) {
  const executable = claudeCodeBinary();
  if (!executable) return unavailableStatus();
  try {
    const status = await readJsonAsync(executable, ["auth", "status", "--json"], options);
    return statusPayload(status, executable);
  } catch (error) {
    return unavailableStatus(executable, error);
  }
}

export function claudeCodeVersion() {
  const executable = claudeCodeBinary();
  if (!executable) return undefined;
  try {
    return execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: claudeSubscriptionEnvironment(),
    }).trim();
  } catch {
    return undefined;
  }
}

export function claudeCodeVersionAsync(options = {}) {
  const executable = claudeCodeBinary();
  if (!executable) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(executable, ["--version"], {
      encoding: "utf8",
      timeout: options.timeout ?? STATUS_PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: claudeSubscriptionEnvironment(),
    }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
  });
}
