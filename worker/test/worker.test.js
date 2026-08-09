import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

/* A fake site served entirely from memory — no network, so these stay fast
   and deterministic. */
const HOME = `<html><head>
  <title>Northwind Analytics | Demand Forecasting</title>
  <meta name="description" content="Northwind Analytics is demand forecasting software for mid-market retail supply chains.">
  <meta property="og:title" content="Northwind"><meta property="og:description" content="Forecasting">
  <meta property="og:image" content="https://northwind.io/og.png">
  <link rel="canonical" href="https://northwind.io/">
  </head><body><h1>Demand forecasting</h1><h2>How it works</h2>
  <p>${"Northwind Analytics is demand forecasting software for retail. ".repeat(40)}</p>
  <a href="/pricing">Pricing</a></body></html>`;

const ROUTES = {
  "https://northwind.io/": { status: 200, body: HOME, type: "text/html" },
  "https://northwind.io/pricing": { status: 200, body: "<html><head><title>Pricing</title></head><body><h1>Pricing</h1></body></html>", type: "text/html" },
  "https://northwind.io/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /", type: "text/plain" },
};

function installFetchStub() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = String(url);
    const hit = ROUTES[key];
    if (hit) {
      return new Response(hit.body, { status: hit.status, headers: { "content-type": hit.type } });
    }
    return new Response("<!doctype html><html><body>Not found</body></html>", {
      status: 404,
      headers: { "content-type": "text/html" },
    });
  };
  return () => { globalThis.fetch = real; };
}

const memoryKV = () => {
  const store = new Map();
  return {
    async get(k, t) { const v = store.get(k); return v === undefined ? null : t === "json" ? JSON.parse(v) : v; },
    async put(k, v) { store.set(k, v); },
  };
};

async function collect(response) {
  const events = [];
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() || "";
    for (const f of frames) {
      const line = f.split("\n").find((l) => l.startsWith("data:"));
      if (line) events.push(JSON.parse(line.slice(5).trim()));
    }
  }
  return events;
}

const post = (env) =>
  worker.fetch(
    new Request("https://aeo-api.canonical.cc/aeo", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://canonical.cc" },
      body: JSON.stringify({ input: "northwind.io" }),
    }),
    env
  );

test("the pipeline streams a complete report over SSE", async () => {
  const restore = installFetchStub();
  try {
    const events = await collect(await post({ ALLOWED_ORIGIN: "*", DAILY_LIMIT: "5" }));
    const types = events.map((e) => e.type);

    assert.ok(types.includes("site"));
    assert.ok(types.includes("score"));
    assert.ok(types.includes("fixes"));
    assert.equal(types.at(-1), "done");

    const site = events.find((e) => e.type === "site").site;
    assert.equal(site.hostname, "northwind.io");
    assert.equal(site.hasRobots, true);
    assert.equal(site.pagesCrawled, 2);

    // Blanket Disallow → every answer crawler blocked → critical fix, ranked first.
    const fixes = events.find((e) => e.type === "fixes").fixes;
    assert.equal(fixes[0].id, "bots");
    assert.equal(fixes[0].severity, "critical");
    assert.ok(fixes[0].artifact.added.includes("OAI-SearchBot"));

    // Unbuilt stages must be reported as skipped, never as done.
    const stages = Object.fromEntries(
      events.filter((e) => e.type === "stage").map((e) => [e.step, e.state])
    );
    assert.equal(stages.queries, "skipped");
    assert.equal(stages.engines, "skipped");
    assert.equal(stages.score, "done");
  } finally {
    restore();
  }
});

test("a cached replay reproduces the live run exactly", async () => {
  const restore = installFetchStub();
  try {
    const env = { ALLOWED_ORIGIN: "*", DAILY_LIMIT: "5", CACHE: memoryKV(), RL: memoryKV() };

    const live = await collect(await post(env));
    const cached = await collect(await post(env));

    assert.ok(cached.some((e) => e.type === "cached"), "second run should be served from cache");

    const pick = (evts, type) => evts.find((e) => e.type === type);

    // The bug this guards: the cache used to store only {hostname, origin}, so a
    // replayed report showed "undefined pages crawled" and "no robots.txt".
    assert.deepEqual(pick(cached, "site").site, pick(live, "site").site);

    const stripType = ({ type, ...rest }) => rest;
    assert.deepEqual(stripType(pick(cached, "score")), stripType(pick(live, "score")));
    assert.deepEqual(pick(cached, "fixes").fixes, pick(live, "fixes").fixes);

    // And the other half of the bug: a replay claimed every step ran.
    const cachedStages = Object.fromEntries(
      cached.filter((e) => e.type === "stage").map((e) => [e.step, e.state])
    );
    assert.equal(cachedStages.queries, "skipped");
    assert.equal(cachedStages.engines, "skipped");
  } finally {
    restore();
  }
});

test("a cache hit does not consume quota", async () => {
  const restore = installFetchStub();
  try {
    const env = { ALLOWED_ORIGIN: "*", DAILY_LIMIT: "1", CACHE: memoryKV(), RL: memoryKV() };
    await collect(await post(env)); // spends the only run
    const second = await post(env);
    assert.equal(second.status, 200, "cached read must not be rate-limited");
    assert.ok((await collect(second)).some((e) => e.type === "cached"));
  } finally {
    restore();
  }
});

test("quota is enforced once the cache is bypassed", async () => {
  const restore = installFetchStub();
  try {
    const env = { ALLOWED_ORIGIN: "*", DAILY_LIMIT: "1", RL: memoryKV() }; // no CACHE
    await collect(await post(env));
    const second = await post(env);
    assert.equal(second.status, 429);
  } finally {
    restore();
  }
});

test("a bad URL is rejected before any crawling or quota spend", async () => {
  const res = await worker.fetch(
    new Request("https://aeo-api.canonical.cc/aeo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "not a url" }),
    }),
    { ALLOWED_ORIGIN: "*" }
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /domain|URL/i);
});

test("CORS reflects an allowed origin and withholds a foreign one", async () => {
  const mk = (origin) =>
    worker.fetch(
      new Request("https://aeo-api.canonical.cc/aeo", { method: "OPTIONS", headers: { Origin: origin } }),
      { ALLOWED_ORIGIN: "https://canonical.cc,https://www.canonical.cc" }
    );
  assert.equal(
    (await mk("https://canonical.cc")).headers.get("Access-Control-Allow-Origin"),
    "https://canonical.cc"
  );
  assert.equal((await mk("https://evil.example")).headers.get("Access-Control-Allow-Origin"), "");
});
