import http from "node:http";

import {
  HOP_BY_HOP_HEADERS,
  httpErrorStatus,
  pipeResponse,
  readRequestBody,
  requireInternalAuth,
  writeJson,
} from "./http-utils.mjs";
import {
  ensureFreshKimiOAuthToken,
  kimiIdentityHeaders,
  readKimiOAuthToken,
} from "./kimi-oauth-session.mjs";
import { PORTS, TARGET } from "./paths.mjs";

const API_BASE = (
  process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1"
).replace(/\/+$/, "");
const LISTEN_HOST =
  process.env.MODEL_ROUTER_OAUTH_HOST ||
  (TARGET === "codex"
    ? process.env.CODEX_ROUTER_OAUTH_HOST || process.env.KIMI_FORWARD_HOST
    : undefined) ||
  "127.0.0.1";
const LISTEN_PORT = Number(
  process.env.MODEL_ROUTER_OAUTH_PORT ||
    (TARGET === "codex"
      ? process.env.CODEX_ROUTER_OAUTH_PORT || process.env.KIMI_FORWARD_PORT
      : undefined) ||
    PORTS.oauth,
);
const INTERNAL_KEY =
  process.env.MODEL_ROUTER_INTERNAL_KEY ||
  (TARGET === "codex"
    ? process.env.CODEX_ROUTER_INTERNAL_KEY || process.env.KIMI_INTERNAL_KEY
    : undefined);
const QUIET =
  process.env.MODEL_ROUTER_QUIET === "1" ||
  (TARGET === "codex" &&
    (process.env.CODEX_ROUTER_QUIET === "1" || process.env.KIMI_PROXY_QUIET === "1"));

if (!INTERNAL_KEY) throw new Error("MODEL_ROUTER_INTERNAL_KEY is required.");

function foldInterveningAssistantMessages(messages) {
  if (!Array.isArray(messages)) return;
  for (let index = 0; index < messages.length; index += 1) {
    const callingMessage = messages[index];
    const callIds = new Set(
      Array.isArray(callingMessage?.tool_calls)
        ? callingMessage.tool_calls.map((call) => call?.id).filter(Boolean)
        : [],
    );
    if (callingMessage?.role !== "assistant" || callIds.size === 0) continue;
    let cursor = index + 1;
    const intervening = [];
    while (
      messages[cursor]?.role === "assistant" &&
      !Array.isArray(messages[cursor]?.tool_calls)
    ) {
      intervening.push(messages[cursor]);
      cursor += 1;
    }
    if (intervening.length === 0) continue;
    const followingIds = new Set();
    while (messages[cursor]?.role === "tool") {
      if (messages[cursor]?.tool_call_id) followingIds.add(messages[cursor].tool_call_id);
      cursor += 1;
    }
    if (![...callIds].every((id) => followingIds.has(id))) continue;
    const text = [callingMessage, ...intervening]
      .flatMap((message) => {
        if (typeof message.content === "string") return [message.content];
        if (!Array.isArray(message.content)) return [];
        return message.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text);
      })
      .filter((value) => value.trim());
    if (text.length) callingMessage.content = text.join("\n");
    messages.splice(index + 1, intervening.length);
  }
}

function repairChatToolPairing(messages) {
  if (!Array.isArray(messages)) return;
  // Kimi requires strict positional pairing: every assistant tool_call must
  // be answered immediately after its own message, in call order. Upstream
  // layers (Codex replay, LiteLLM conversion) can group all responses after
  // the last of several consecutive assistant messages, which Kimi rejects.
  // Reorder responses to directly follow their call, synthesize missing
  // ones, and drop answerless tool messages.
  const responsesByCallId = new Map();
  for (const message of messages) {
    if (message?.role === "tool" && message.tool_call_id) {
      responsesByCallId.set(message.tool_call_id, message);
    }
  }
  const result = [];
  const emitted = new Set();
  for (const message of messages) {
    if (message?.role === "tool" && message.tool_call_id) {
      if (!emitted.has(message.tool_call_id) && responsesByCallId.get(message.tool_call_id) === message) {
        // emitted when its call is processed; drop strays otherwise
        continue;
      }
      if (emitted.has(message.tool_call_id)) continue;
      continue;
    }
    result.push(message);
    if (Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!call?.id) continue;
        const resp = responsesByCallId.get(call.id);
        if (resp) {
          result.push(resp);
          emitted.add(call.id);
        } else {
          result.push({
            role: "tool",
            tool_call_id: call.id,
            content:
              "[output unavailable — the turn was interrupted before this tool call produced a result]",
          });
        }
      }
    }
  }
  messages.splice(0, messages.length, ...result);
}

function normalizeKimiBody(buffer, contentType) {
  if (!buffer.length || !String(contentType || "").includes("application/json")) {
    return buffer;
  }
  const payload = JSON.parse(buffer.toString("utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return buffer;
  foldInterveningAssistantMessages(payload.messages);
  repairChatToolPairing(payload.messages);
  payload.thinking = { type: "enabled" };
  if (payload.model === "k3") {
    const effort = {
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
      ultra: "max",
    }[payload.reasoning_effort];
    if (effort) payload.reasoning_effort = effort;
    else delete payload.reasoning_effort;
  } else {
    delete payload.reasoning_effort;
  }
  return Buffer.from(JSON.stringify(payload), "utf8");
}

function upstreamHeaders(requestHeaders, body) {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "authorization") continue;
    if (lower.startsWith("x-msh-") || lower.startsWith("x-codex-")) continue;
    if (lower.startsWith("x-openai-") || lower === "chatgpt-account-id") continue;
    if (lower === "originator" || lower === "user-agent" || lower === "accept-encoding") continue;
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  Object.assign(headers, kimiIdentityHeaders());
  headers["Accept-Encoding"] = "identity";
  if (body.length) headers["Content-Length"] = String(body.length);
  return headers;
}

function tokenHealth() {
  try {
    const token = readKimiOAuthToken();
    return {
      credential_present: true,
      scope: token.scope,
      expires_in_seconds: Math.max(
        0,
        token.expires_at - Math.floor(Date.now() / 1_000),
      ),
    };
  } catch {
    return {
      credential_present: false,
      error: "Kimi OAuth credential is unavailable; run `kimi login`.",
    };
  }
}

async function requestUpstream(request, target, body, token, signal) {
  const upstream = await fetch(target, {
    method: request.method,
    headers: {
      ...upstreamHeaders(request.headers, body),
      Authorization: `Bearer ${token}`,
    },
    body: body.length ? body : undefined,
    signal,
  });
  return upstream;
}

async function handleRequest(request, response) {
  const startedAt = Date.now();
  const requestUrl = new URL(
    request.url || "/",
    `http://${request.headers.host || LISTEN_HOST}`,
  );
  if (!requireInternalAuth(request, response, INTERNAL_KEY)) return;
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      service: "codex-router-oauth-forwarder",
      ...tokenHealth(),
    });
    return;
  }

  const route = requestUrl.pathname.replace(/^\/v1(?=\/|$)/, "");
  if (
    !(
      (request.method === "POST" && route === "/chat/completions") ||
      (request.method === "GET" && route === "/models")
    )
  ) {
    writeJson(response, 404, {
      error: { type: "proxy_route_not_found", message: "Unsupported OAuth route." },
    });
    return;
  }

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  let body = await readRequestBody(request);
  if (route === "/chat/completions") {
    body = normalizeKimiBody(body, request.headers["content-type"]);
  }
  const target = `${API_BASE}${route}${requestUrl.search}`;
  let token = await ensureFreshKimiOAuthToken();
  let upstream = await requestUpstream(request, target, body, token, controller.signal);
  if (upstream.status === 401) {
    await upstream.arrayBuffer();
    token = await ensureFreshKimiOAuthToken({ force: true });
    upstream = await requestUpstream(request, target, body, token, controller.signal);
    if (upstream.status === 401) {
      await upstream.arrayBuffer();
      writeJson(response, 401, {
        error: {
          type: "authentication_error",
          message: "Kimi OAuth was rejected; run `kimi login` again.",
        },
      });
      return;
    }
  }
  await pipeResponse(upstream, response);
  if (!QUIET) {
    console.error(
      `[kimi-oauth] ${request.method} ${route} -> ${upstream.status} ${Date.now() - startedAt}ms`,
    );
  }
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const status = httpErrorStatus(error);
    const authenticationFailure = status === 401;
    console.error("[kimi-oauth] request failed");
    if (!response.headersSent) {
      writeJson(response, status, {
        error: {
          type: authenticationFailure ? "authentication_error" : "kimi_oauth_proxy_error",
          message: authenticationFailure
            ? "Kimi OAuth could not be refreshed; run `kimi login` again."
            : "The Kimi OAuth forwarder could not complete the request.",
        },
      });
    } else if (!response.writableEnded) {
      response.destroy();
    }
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.error("[kimi-oauth] listening");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
