/* Canonical Labs — AEO Readiness Check (Cloudflare Worker).
 *
 * Endpoints
 *   POST /aeo          → SSE stream of the pipeline
 *   GET  /aeo/:domain  → cached report JSON (free, no quota)
 *   POST /feedback     → thumbs / free-text, relayed to Slack
 *
 * Transport and conventions mirror canonical-lookalike so the two labs behave
 * identically from the browser's point of view.
 */

import { crawlSite, normalizeInput } from "./crawl.js";
import { runDeterministicAudit } from "./audit.js";
import { scoreReport, rankFixes } from "./score.js";

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (PRD §9)

/* ── CORS ───────────────────────────────────────────────────────────────── */

function corsHeaders(request, env) {
  const allowed = String(env.ALLOWED_ORIGIN || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const ok = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/* ── rate limiting ──────────────────────────────────────────────────────── */

const todayKey = () => new Date().toISOString().slice(0, 10); // UTC day

async function checkQuota(request, env) {
  const limit = Number(env.DAILY_LIMIT || 3);
  if (!env.RL) return { allowed: true, remaining: limit }; // no KV in local dev
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  const key = `aeo:${ip}:${todayKey()}`;
  const used = Number((await env.RL.get(key)) || 0);
  if (used >= limit) return { allowed: false, remaining: 0, key, used };
  return { allowed: true, remaining: limit - used, key, used };
}

async function consumeQuota(env, quota) {
  if (!env.RL || !quota.key) return;
  // 36h TTL comfortably covers one UTC day plus clock skew.
  await env.RL.put(quota.key, String(quota.used + 1), { expirationTtl: 60 * 60 * 36 });
}

/* ── SSE ────────────────────────────────────────────────────────────────── */

function sseStream(handler, request, env) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const send = async (event) => {
    try {
      await writer.write(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      /* client disconnected — the pipeline will notice on the next write */
    }
  };

  // Run detached so we can return the response immediately and stream into it.
  (async () => {
    try {
      await handler(send);
    } catch (err) {
      await send({ type: "error", message: String(err?.message || err) });
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...corsHeaders(request, env),
    },
  });
}

/* ── the pipeline ───────────────────────────────────────────────────────── */

const STEPS = ["fetch", "audit", "queries", "engines", "score", "fixes"];

/**
 * Milestone 1 runs the deterministic half only: fetch → audit → score.
 * The query/engine/fix stages are emitted as skipped so the frontend stepper
 * renders its final shape from day one.
 */
async function runPipeline(send, input, env, quota) {
  const stage = (step, state) => send({ type: "stage", step, state });
  const status = (text) => send({ type: "status", text });

  await send({ type: "quota", remaining: quota.remaining });

  // 1 — fetch
  await stage("fetch", "active");
  const crawl = await crawlSite(input, status);
  await send({
    type: "site",
    site: {
      hostname: crawl.hostname,
      origin: crawl.origin,
      pagesCrawled: crawl.pages.length,
      hasRobots: crawl.robotsTxt != null,
      sitemap: crawl.sitemap,
    },
  });
  await stage("fetch", "done");

  // 2 — deterministic audit
  await stage("audit", "active");
  await status("Checking crawler access, schema and agent readiness…");
  const pillars = runDeterministicAudit(crawl);
  for (const p of pillars) {
    await send({
      type: "audit",
      pillar: {
        id: p.id,
        label: p.label,
        max: p.max,
        score: p.checks.reduce((s, c) => s + c.points, 0),
        checks: p.checks.map(({ id, label, state, points, max, evidence }) => ({
          id, label, state, points, max, evidence,
        })),
      },
    });
  }
  await stage("audit", "done");

  // 3–4 — not built yet (milestones 3–4). Announced rather than silently absent.
  for (const step of ["queries", "engines"]) await stage(step, "skipped");

  // 5 — score
  await stage("score", "active");
  const report = scoreReport(pillars);
  await send({ type: "score", ...report });
  await stage("score", "done");

  // 6 — fixes: ranked now, artifact generation lands in milestone 5.
  await stage("fixes", "active");
  const fixes = rankFixes(pillars);
  await send({ type: "fixes", fixes });
  await stage("fixes", "done");

  await send({ type: "done" });
  return { site: { hostname: crawl.hostname, origin: crawl.origin }, report, fixes };
}

/* ── router ─────────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // Cached report — free, unlimited, and what a shared permalink hits.
    if (request.method === "GET" && url.pathname.startsWith("/aeo/")) {
      const domain = decodeURIComponent(url.pathname.slice("/aeo/".length)).toLowerCase();
      if (!domain) return json({ error: "No domain given." }, 400, cors);
      if (!env.CACHE) return json({ error: "Not found." }, 404, cors);
      const hit = await env.CACHE.get(`report:${domain}`, "json");
      return hit ? json(hit, 200, cors) : json({ error: "Not found." }, 404, cors);
    }

    if (request.method === "POST" && url.pathname === "/aeo") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Expected a JSON body." }, 400, cors);
      }

      let normalized;
      try {
        normalized = normalizeInput(body?.input);
      } catch (err) {
        return json({ error: String(err.message) }, 400, cors);
      }
      const domain = normalized.hostname.toLowerCase();
      const refresh = body?.refresh === true;

      // Serve from cache before spending quota or money.
      if (!refresh && env.CACHE) {
        const hit = await env.CACHE.get(`report:${domain}`, "json");
        if (hit) {
          return sseStream(async (send) => {
            await send({ type: "cached", cachedAt: hit.cachedAt });
            for (const step of STEPS) await send({ type: "stage", step, state: "done" });
            if (hit.site) await send({ type: "site", site: hit.site });
            for (const p of hit.pillarDetail || []) await send({ type: "audit", pillar: p });
            await send({ type: "score", ...hit.report });
            await send({ type: "fixes", fixes: hit.fixes || [] });
            await send({ type: "done" });
          }, request, env);
        }
      }

      const quota = await checkQuota(request, env);
      if (!quota.allowed) {
        return json(
          { error: "Daily limit reached.", remaining: 0 },
          429,
          cors
        );
      }
      await consumeQuota(env, quota);

      return sseStream(async (send) => {
        const result = await runPipeline(send, body.input, env, quota);
        if (env.CACHE && result) {
          await env.CACHE.put(
            `report:${domain}`,
            JSON.stringify({ ...result, cachedAt: new Date().toISOString() }),
            { expirationTtl: CACHE_TTL_SECONDS }
          );
        }
      }, request, env);
    }

    if (request.method === "POST" && url.pathname === "/feedback") {
      const hook = env.FEEDBACK_WEBHOOK;
      if (!hook) return json({ ok: true }, 200, cors); // no-op when unconfigured
      const body = await request.json().catch(() => ({}));
      await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `*AEO* ${body.verdict || ""} — ${body.domain || "?"}\n${body.note || ""}` }),
      }).catch(() => {});
      return json({ ok: true }, 200, cors);
    }

    return json({ error: "Not found." }, 404, cors);
  },
};
