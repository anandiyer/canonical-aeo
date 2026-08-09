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
import worker from "./src/worker.js";

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

const env = {
  ALLOWED_ORIGIN: "*",
  DAILY_LIMIT: process.env.DAILY_LIMIT || "1000",
  RL: memoryKV(),
  CACHE: memoryKV(),
};

const server = http.createServer(async (req, res) => {
  const url = `http://${req.headers.host || "localhost"}${req.url}`;

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

server.listen(PORT, () => console.log(`AEO worker (dev) → http://localhost:${PORT}`));
