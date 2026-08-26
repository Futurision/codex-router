import { PassThrough, Readable, Transform, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

import { secretEqual } from "./caller-auth.mjs";
import { TARGET } from "./paths.mjs";

export const MAX_BODY_BYTES = Number(
  process.env.MODEL_ROUTER_MAX_BODY_BYTES ||
    (TARGET === "codex"
      ? process.env.CODEX_ROUTER_MAX_BODY_BYTES || process.env.KIMI_PROXY_MAX_BODY_BYTES
      : undefined) ||
    64 * 1024 * 1024,
);

// Codex compresses large Responses payloads before sending them to the local
// router. Keep the on-the-wire cap tight, but allow the authenticated loopback
// request to expand far enough to carry image-rich native histories. Using the
// same 64 MiB limit for both made a valid 44 MiB zstd request fail only because
// its decoded JSON was 76 MiB. The separate decoded ceiling still bounds
// decompression and JSON parsing, including compression-bomb inputs.
export const MAX_DECODED_BODY_BYTES = Number(
  process.env.MODEL_ROUTER_MAX_DECODED_BODY_BYTES ||
    (TARGET === "codex"
      ? process.env.CODEX_ROUTER_MAX_DECODED_BODY_BYTES ||
        process.env.KIMI_PROXY_MAX_DECODED_BODY_BYTES
      : undefined) ||
    128 * 1024 * 1024,
);

export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export async function readRequestBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function writeJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

export function httpErrorStatus(error, fallback = 502) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : fallback;
}

export function copyResponseHeaders(upstream, response, denylist = HOP_BY_HOP_HEADERS) {
  for (const [name, value] of upstream.headers.entries()) {
    if (!denylist.has(name.toLowerCase())) response.setHeader(name, value);
  }
}

export const STALL_TIMEOUT_MS = Number(
  process.env.MODEL_ROUTER_STALL_MS ||
    process.env.CODEX_ROUTER_STALL_MS ||
    300_000,
);

function clientDisconnectedError() {
  const error = new Error("The downstream client disconnected.");
  error.name = "AbortError";
  error.code = "CLIENT_DISCONNECTED";
  return error;
}

function stalledResponseError(timeoutMs) {
  const error = new Error(
    `Upstream stream stalled: no model events for ${timeoutMs}ms.`,
  );
  error.code = "UPSTREAM_STREAM_STALLED";
  error.status = 504;
  return error;
}

function sseProgressParser(onProgress) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let eventName = "";
  const consume = (flush = false) => {
    const lines = buffered.split(/\r?\n/);
    buffered = flush ? "" : lines.pop() || "";
    for (const line of lines) {
      if (!line) {
        eventName = "";
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim().toLowerCase();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      if (["ping", "heartbeat"].includes(eventName)) continue;
      if (/^(?:ping|heartbeat)$/i.test(data)) continue;
      if (
        data.length < 256 &&
        /"type"\s*:\s*"(?:ping|heartbeat)"/i.test(data)
      ) {
        continue;
      }
      onProgress();
    }
  };
  return {
    write(chunk) {
      buffered += decoder.write(chunk);
      consume();
    },
    end() {
      buffered += decoder.end();
      consume(true);
    },
  };
}

function progressWatchdog(contentType, timeoutMs = STALL_TIMEOUT_MS) {
  const isSse = String(contentType).toLowerCase().includes("text/event-stream");
  let timer;
  let watchdog;
  const disarm = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const arm = () => {
    if (!(timeoutMs > 0)) return;
    disarm();
    timer = setTimeout(() => watchdog.destroy(stalledResponseError(timeoutMs)), timeoutMs);
    timer.unref?.();
  };
  const sse = isSse ? sseProgressParser(arm) : undefined;
  watchdog = new Transform({
    transform(chunk, _encoding, callback) {
      // SSE comments and explicit ping events are transport liveness, not
      // model progress. Every other complete data field is progress across
      // Responses and Chat Completions protocols, including split chunks.
      if (sse) sse.write(chunk);
      else arm();
      callback(null, chunk);
    },
    flush(callback) {
      sse?.end();
      callback();
    },
    destroy(error, callback) {
      disarm();
      callback(error);
    },
  });
  arm();
  return { watchdog, disarm };
}

export async function pipeResponse(
  upstream,
  response,
  denylist,
  transform,
  { stallTimeoutMs = STALL_TIMEOUT_MS } = {},
) {
  if (response.destroyed || response.writableEnded) {
    await upstream.body?.cancel().catch(() => {});
    throw clientDisconnectedError();
  }
  response.statusCode = upstream.status;
  copyResponseHeaders(upstream, response, denylist);
  if (!upstream.body) {
    response.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body);
  const { watchdog, disarm } = progressWatchdog(
    upstream.headers.get("content-type") || "",
    stallTimeoutMs,
  );
  const bridge = new PassThrough();
  // The pipeline only listens for bridge errors while it is running. If the
  // downstream client disconnects in the window after the pipeline settled
  // (response still flushing), bridge.destroy(error) would otherwise be an
  // unhandled 'error' event and crash the whole router process — killing every
  // in-flight turn across all threads. Late downstream errors are harmless:
  // the client is already gone.
  bridge.on("error", () => {});
  const downstreamClosed = () => {
    if (!response.writableEnded) bridge.destroy(clientDisconnectedError());
  };
  const downstreamFailed = (error) => bridge.destroy(error);
  response.once("close", downstreamClosed);
  response.once("error", downstreamFailed);
  const running = transform
    ? pipeline(stream, watchdog, transform, bridge)
    : pipeline(stream, watchdog, bridge);
  bridge.pipe(response);
  try {
    await running;
    await finished(response, { cleanup: true, readable: false });
  } finally {
    disarm();
    response.removeListener("close", downstreamClosed);
    response.removeListener("error", downstreamFailed);
    bridge.unpipe(response);
  }
}

export async function readResponseBody(
  upstream,
  { maxBytes = 32 * 1024 * 1024, stallTimeoutMs = STALL_TIMEOUT_MS } = {},
) {
  if (!upstream.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  const stream = Readable.fromWeb(upstream.body);
  const { watchdog, disarm } = progressWatchdog(
    upstream.headers.get("content-type") || "",
    stallTimeoutMs,
  );
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error(`Upstream response exceeds ${maxBytes} bytes.`);
        error.code = "UPSTREAM_RESPONSE_TOO_LARGE";
        error.status = 502;
        callback(error);
        return;
      }
      chunks.push(chunk);
      callback();
    },
  });
  try {
    await pipeline(stream, watchdog, sink);
    return Buffer.concat(chunks);
  } finally {
    disarm();
  }
}

export function requireInternalAuth(request, response, secret) {
  const authorized = secretEqual(
    request.headers.authorization,
    `Bearer ${secret}`,
  ) || secretEqual(request.headers["x-api-key"], secret);
  if (!authorized) {
    writeJson(response, 401, {
      error: {
        type: "authentication_error",
        message: "This internal loopback route requires the router service key.",
      },
    });
  }
  return authorized;
}
