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

/* ── the downloadable fix plan ──────────────────────────────────────────── */

const HOOK = "https://hooks.slack.test/aeo";

/** installFetchStub, plus a record of everything posted to the Slack webhook. */
function installFetchStubWithSlack() {
  const posts = [];
  const restore = installFetchStub();
  const stubbed = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === HOOK) {
      posts.push(JSON.parse(init.body).text);
      return new Response("ok", { status: 200 });
    }
    return stubbed(url, init);
  };
  return { posts, restore: () => { globalThis.fetch = stubbed; restore(); } };
}

const getPlan = (env, domain = "northwind.io", headers = {}) =>
  worker.fetch(
    new Request(`https://aeo-api.canonical.cc/aeo/${domain}/plan.md`, {
      headers: { Origin: "https://canonical.cc", ...headers },
    }),
    env
  );

test("the fix plan downloads as Markdown once a report exists", async () => {
  const { restore } = installFetchStubWithSlack();
  try {
    const env = { ALLOWED_ORIGIN: "*", DAILY_LIMIT: "5", CACHE: memoryKV(), RL: memoryKV() };
    await collect(await post(env));

    const res = await getPlan(env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/markdown/);
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="aeo-fix-plan-northwind.io.md"'
    );
    // The client reads the filename back off this header via fetch+blob.
    assert.match(res.headers.get("access-control-expose-headers") || "", /Content-Disposition/i);

    const body = await res.text();
    assert.match(body, /^# AEO Fix Plan — northwind\.io/);
    assert.match(body, /### Task 1 — AI answer crawlers can reach the site/);
  } finally {
    restore();
  }
});

test("/plan.md is matched before the cached-report route", async () => {
  const { restore } = installFetchStubWithSlack();
  try {
    const env = { ALLOWED_ORIGIN: "*", DAILY_LIMIT: "5", CACHE: memoryKV(), RL: memoryKV() };
    await collect(await post(env));

    // The bug this guards: /aeo/ prefix matching read the domain as
    // "northwind.io/plan.md", missed the cache, and 404'd every download.
    assert.equal((await getPlan(env)).status, 200);

    // And the plain cached-report route still returns JSON, not Markdown.
    const jsonRes = await worker.fetch(
      new Request("https://aeo-api.canonical.cc/aeo/northwind.io", { headers: { Origin: "https://canonical.cc" } }),
      env
    );
    assert.match(jsonRes.headers.get("content-type"), /application\/json/);
  } finally {
    restore();
  }
});

test("downloading with no report is a 404, not a broken file", async () => {
  const env = { ALLOWED_ORIGIN: "*", CACHE: memoryKV(), RL: memoryKV() };
  const res = await getPlan(env, "never-scanned.example");
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /run a scan first/i);
});

test("a download posts to Slack exactly once per person", async () => {
  const { posts, restore } = installFetchStubWithSlack();
  try {
    const env = {
      ALLOWED_ORIGIN: "*", DAILY_LIMIT: "5", CACHE: memoryKV(), RL: memoryKV(),
      SEARCH_WEBHOOK: HOOK,
    };
    await collect(await post(env));
    const scanPosts = posts.length;

    const headers = { "CF-Connecting-IP": "203.0.113.7", "CF-IPCountry": "US" };
    await getPlan(env, "northwind.io", headers);
    assert.equal(posts.length, scanPosts + 1, "download should post once");
    assert.match(posts.at(-1), /AEO fix plan downloaded/);
    assert.match(posts.at(-1), /northwind\.io/);
    assert.match(posts.at(-1), /US/);

    // A prefetch, a retry or a link scanner must not post again.
    await getPlan(env, "northwind.io", headers);
    assert.equal(posts.length, scanPosts + 1, "repeat download should be deduped");

    // A different person is a different signal and must still post.
    await getPlan(env, "northwind.io", { "CF-Connecting-IP": "198.51.100.4" });
    assert.equal(posts.length, scanPosts + 2);
  } finally {
    restore();
  }
});

test("a Slack outage never costs the user their download", async () => {
  const restore = installFetchStub();
  const stubbed = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url) === HOOK ? Promise.reject(new Error("slack down")) : stubbed(url, init);
  try {
    const env = {
      ALLOWED_ORIGIN: "*", DAILY_LIMIT: "5", CACHE: memoryKV(), RL: memoryKV(),
      SEARCH_WEBHOOK: HOOK,
    };
    await collect(await post(env));
    const res = await getPlan(env);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /# AEO Fix Plan/);
  } finally {
    globalThis.fetch = stubbed;
    restore();
  }
});

test("the report is cached before `done`, so the download can never race it", async () => {
  const restore = installFetchStub();
  try {
    const cache = memoryKV();
    let cachedAtDone = null;
    const env = {
      ALLOWED_ORIGIN: "*", DAILY_LIMIT: "5", RL: memoryKV(),
      CACHE: cache,
    };
    const res = await post(env);

    // Read the cache at the instant `done` arrives — that's when the client
    // reveals the download button.
    const reader = res.body.getReader();
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
        if (line && JSON.parse(line.slice(5).trim()).type === "done") {
          cachedAtDone = await cache.get("report:v2:northwind.io", "json");
        }
      }
    }
    assert.ok(cachedAtDone, "the report must already be cached when `done` fires");
    assert.ok(cachedAtDone.fixes.length > 0);
  } finally {
    restore();
  }
});
