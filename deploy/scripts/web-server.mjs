import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const publicRoot = join(root, "apps/web/public");
const compiledRoot = join(root, "apps/web/dist");
const maximumApiBytes = 1024 * 1024;
const apiOrigin = parseApiOrigin(process.env.WEATHER_API_ORIGIN);
const port = parsePort(process.env.PORT ?? "3000");
const assets = new Map([
  ["/", { cache: "no-cache", path: join(publicRoot, "index.html"), type: "text/html; charset=utf-8" }],
  ["/index.html", { cache: "no-cache", path: join(publicRoot, "index.html"), type: "text/html; charset=utf-8" }],
  ["/styles.css", { cache: "public, max-age=300", path: join(publicRoot, "styles.css"), type: "text/css; charset=utf-8" }],
  ["/client.js", { cache: "public, max-age=300", path: join(compiledRoot, "client.js"), type: "text/javascript; charset=utf-8" }],
]);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://weather.invalid");

    // proxy only the same-origin API namespace
    if (requestUrl.pathname === "/api" || requestUrl.pathname.startsWith("/api/")) {
      await proxyApi(request, response, requestUrl);
      return;
    }

    // serve only the explicit static allowlist
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "method not allowed\n", { Allow: "GET, HEAD" });
      return;
    }

    const asset = assets.get(requestUrl.pathname);

    // reject traversal and unknown files uniformly
    if (asset === undefined || requestUrl.pathname.includes("\\")) {
      sendText(response, 404, "not found\n");
      return;
    }

    const body = await readFile(asset.path);
    setSecurityHeaders(response);
    response.writeHead(200, {
      "Cache-Control": asset.cache,
      "Content-Length": String(body.byteLength),
      "Content-Type": asset.type,
    });

    // omit response bodies for HEAD
    if (request.method === "HEAD") {
      response.end();
    } else {
      response.end(body);
    }
  } catch {
    sendText(response, 500, "internal server error\n");
  }
});

server.listen(port, "0.0.0.0");

// validate the internal upstream origin
function parseApiOrigin(value) {
  const origin = new URL(value ?? "http://api:3001");

  // reject credentials, non-HTTP protocols, and path prefixes
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error("WEATHER_API_ORIGIN must be a credential-free HTTP origin");
  }

  return origin;
}

// validate the listener port
function parsePort(value) {
  const parsed = Number(value);

  // reject invalid listener configuration
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new RangeError("PORT must be between 1 and 65535");
  }

  return parsed;
}

// proxy one bounded API request
async function proxyApi(request, response, requestUrl) {
  // keep the edge read-only
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "method not allowed\n", { Allow: "GET, HEAD" });
    return;
  }

  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, apiOrigin);

  try {
    const upstream = await fetch(target, {
      headers: { Accept: request.headers.accept ?? "application/json" },
      method: request.method,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    const body = request.method === "HEAD" ? Buffer.alloc(0) : await readBoundedBody(upstream);
    setSecurityHeaders(response);
    response.writeHead(upstream.status, {
      "Cache-Control": "no-store",
      "Content-Length": String(body.byteLength),
      "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
    });
    response.end(body);
  } catch {
    sendText(response, 502, "upstream unavailable\n");
  }
}

// read an upstream response within the edge limit
async function readBoundedBody(upstream) {
  const reader = upstream.body?.getReader();
  const chunks = [];
  let length = 0;

  // allow legitimate empty responses
  if (reader === undefined) {
    return Buffer.alloc(0);
  }

  // stop before buffering an oversized response
  for (;;) {
    const { done, value } = await reader.read();

    // finish on upstream EOF
    if (done) {
      break;
    }

    length += value.byteLength;

    // reject oversized API bodies
    if (length > maximumApiBytes) {
      await reader.cancel();
      throw new Error("upstream response exceeded the edge limit");
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, length);
}

// apply response hardening
function setSecurityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

// send one bounded text response
function sendText(response, status, body, headers = {}) {
  const content = Buffer.from(body);
  setSecurityHeaders(response);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(content.byteLength),
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(content);
}

// close without accepting new work
async function shutdown() {
  await new Promise((resolveShutdown, rejectShutdown) => {
    server.close((error) => {
      // surface unexpected close failures
      if (error) {
        rejectShutdown(error);
      } else {
        resolveShutdown();
      }
    });
  });
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
