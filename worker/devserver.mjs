#!/usr/bin/env node
/* Local dev server — runs the Worker's fetch handler on plain node.
 *
 * `wrangler dev` needs a live Cloudflare session; this doesn't, so the whole
 * frontend can be developed and tested offline. Node 23 already provides
 * Request/Response/TransformStream, so the only work is bridging node's
 * http req/res to the web types the Worker expects.
 *
 *   node devserver.mjs           # :8787
 *   PORT=9000 node devserver.mjs
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import worker from "./src/worker.js";

/* Load .dev.vars and the [vars] block from wrangler.toml, the same way
   `wrangler dev` does. Without this the dev server silently runs with no API
   key, and the paid stages report as "skipped" — which looks identical to a
   deliberate configuration choice. */
function loadEnvFile(path) {
  if (!fs.existsSync(path)) return {};
  return Object.fromEntries(
    fs.readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      })
  );
}

function loadWranglerVars(path) {
  if (!fs.existsSync(path)) return {};
  const text = fs.readFileSync(path, "utf8");
  const block = text.split(/^\[vars\]$/m)[1];
  if (!block) return {};
  return loadEnvFile.call(null, "/dev/null") && Object.fromEntries(
    block.split(/^\[/m)[0]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      })
  );
}

const PORT = Number(process.env.PORT || 8787);

// In-memory stand-ins for the KV bindings. Same surface, no persistence.
const memoryKV = () => {
  const store = new Map();
  return {
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
  };
};

// wrangler.toml [vars] first, then .dev.vars overrides, then local conveniences.
const env = {
  ...loadWranglerVars(new URL("./wrangler.toml", import.meta.url).pathname),
  ...loadEnvFile(new URL("./.dev.vars", import.meta.url).pathname),
  ALLOWED_ORIGIN: "*",
  DAILY_LIMIT: process.env.DAILY_LIMIT || "1000",
  RL: memoryKV(),
  CACHE: memoryKV(),
};

console.log(
  "  models:", env.MODEL_CHEAP || "(default)",
  "| engines:", env.OPENROUTER_API_KEY ? "enabled" : "DISABLED (no OPENROUTER_API_KEY)",
  "| subrequest budget:", env.SUBREQUEST_BUDGET || 45
);

/* Serve ../site from the same origin as the API. Same-origin means no CORS to
   configure and one URL to open — the two-server setup was the main friction in
   testing this locally. */
const SITE_DIR = new URL("../site/", import.meta.url).pathname;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
               ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel.endsWith("/")) rel += "index.html";
  // Resolve then confirm containment, so ../ can't escape the site directory.
  const file = path.resolve(SITE_DIR, "." + rel);
  if (!file.startsWith(path.resolve(SITE_DIR))) {
    res.writeHead(403).end("Forbidden");
    return true;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = `http://${req.headers.host || "localhost"}${req.url}`;

  // Anything that isn't an API route is a static asset request.
  const pathname = new URL(url).pathname;
  if (req.method === "GET" && !pathname.startsWith("/aeo") && !pathname.startsWith("/feedback")) {
    if (serveStatic(req, res)) return;
  }

  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }

  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: body && body.length ? body : undefined,
  });

  try {
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return res.end();
    // Stream SSE through rather than buffering, or the stepper won't animate.
    for await (const chunk of response.body) res.write(Buffer.from(chunk));
    res.end();
  } catch (err) {
    console.error("worker threw:", err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(PORT, () =>
  console.log(`\n  ▸ Open  http://localhost:${PORT}/   (page + API, same origin)\n`)
);
