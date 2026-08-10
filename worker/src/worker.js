/* Canonical Labs — AEO Readiness Check (Cloudflare Worker).
 *
 * Endpoints
 *   POST /aeo                  → SSE stream of the pipeline
 *   GET  /aeo/:domain          → cached report JSON (free, no quota)
 *   GET  /aeo/:domain/plan.md  → the report as a downloadable Markdown fix plan
 *   POST /feedback             → thumbs / free-text, relayed to Slack
 *
 * Transport and conventions mirror canonical-lookalike so the two labs behave
 * identically from the browser's point of view.
 */

import { crawlSite, normalizeInput } from "./crawl.js";
import { runDeterministicAudit } from "./audit.js";
import { auditContent } from "./content.js";
import { scoreReport, rankFixes } from "./score.js";
import { attachArtifacts } from "./fixes.js";
import { generateQueries } from "./queries.js";
import { runEngines, alsoCited, ENGINES, activeEngines } from "./engines.js";
import { scoreVisibility } from "./visibility.js";
import { renderPlan, planFilename } from "./plan.js";

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (PRD §9)

/* Bump whenever the cached payload shape changes.
 *
 * Cached reports outlive the code that wrote them. A v1 entry replayed by v2
 * code rendered "the 12 questions we asked" above engine columns that had
 * answered 6 — the entry predated adaptive query sizing and per-question
 * results. Versioning the key makes stale entries simply miss and expire,
 * instead of half-rendering. */
const CACHE_VERSION = "v2";
const cacheKey = (domain) => `report:${CACHE_VERSION}:${domain}`;

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

/**
 * Per-DOMAIN daily cap — the limit users actually feel.
 *
 * Three fresh scans of the same site per UTC day. Cached reads don't count, so
 * revisiting or sharing a report is always free.
 */
async function checkDomainQuota(domain, env) {
  const limit = Number(env.DOMAIN_DAILY_LIMIT || 3);
  if (!env.RL) return { allowed: true, remaining: limit };
  const key = `aeo:domain:${domain}:${todayKey()}`;
  const used = Number((await env.RL.get(key)) || 0);
  if (used >= limit) return { allowed: false, remaining: 0, key, used, limit, scope: "domain" };
  return { allowed: true, remaining: limit - used, key, used, limit, scope: "domain" };
}

/**
 * Per-IP daily cap — a backstop, not the headline limit.
 *
 * A purely per-domain limit would let one caller scan unlimited *different*
 * domains, which is unbounded spend. This is set loose enough not to interfere
 * with normal use while still capping a single abuser; the global
 * MAX_PAID_RUNS_PER_DAY is the real ceiling on cost.
 */
async function checkQuota(request, env) {
  const limit = Number(env.DAILY_LIMIT || 15);
  if (!env.RL) return { allowed: true, remaining: limit }; // no KV in local dev
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  const key = `aeo:${ip}:${todayKey()}`;
  const used = Number((await env.RL.get(key)) || 0);
  if (used >= limit) return { allowed: false, remaining: 0, key, used, limit, scope: "ip" };
  return { allowed: true, remaining: limit - used, key, used, limit, scope: "ip" };
}

/**
 * Global spend guard.
 *
 * Per-IP limits cap one abuser, not a distributed one, and the engine stage
 * costs real money (~$1.50 a run). This caps paid runs per UTC day across
 * everyone. When it trips the scan still runs — it just falls back to the
 * deterministic half, which is free. Degrading beats failing: the user still
 * gets 50 points of real findings and the artifacts to fix them.
 */
async function paidRunsAllowed(env) {
  const cap = Number(env.MAX_PAID_RUNS_PER_DAY || 50);
  if (!env.RL) return { allowed: true, used: 0, cap };
  const key = `aeo:paid:${todayKey()}`;
  const used = Number((await env.RL.get(key)) || 0);
  return { allowed: used < cap, used, cap, key };
}

async function consumePaidRun(env, guard) {
  if (!env.RL || !guard.key) return;
  await env.RL.put(guard.key, String(guard.used + 1), { expirationTtl: 60 * 60 * 36 });
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

/* ── Slack ──────────────────────────────────────────────────────────────── */

/**
 * Post every scan to #hack-central.
 *
 * Fire-and-forget and never awaited on the critical path: a Slack outage must
 * not slow down or fail a user's scan. SEARCH_WEBHOOK falls back to
 * FEEDBACK_WEBHOOK, matching the canonical-lookalike convention where both
 * point at the same channel.
 */
async function notifySlack(env, payload) {
  const hook = env.SEARCH_WEBHOOK || env.FEEDBACK_WEBHOOK;
  if (!hook) return;

  const { site, report, queryPlan, engineDetail, fixes, cached, ip } = payload;
  const grade = report ? `${report.score}/100 · ${report.band}` : "—";

  const lines = [
    `*<https://canonical.cc/labs/aeo/?d=${encodeURIComponent(site.hostname)}|${site.hostname}>* — ${grade}${cached ? " _(cached)_" : ""}`,
  ];

  if (report?.pillars?.length) {
    lines.push(report.pillars.map((p) => `${p.label.replace(/ .*/, "")} ${p.score}/${p.max}`).join(" · "));
  }
  if (engineDetail?.engines?.length) {
    lines.push(
      "> " + engineDetail.engines
        .map((e) => `${e.label} ${e.mentioned}/${e.answered}${e.cited ? ` (${e.cited} cited)` : ""}`)
        .join("  ·  ")
    );
  }
  if (queryPlan?.queries?.length) {
    lines.push("> _Asked:_ " + queryPlan.queries.map((q) => q.q).join(" · "));
  }
  const top = (fixes || []).filter((f) => f.severity === "critical" || f.severity === "high").slice(0, 3);
  if (top.length) lines.push("> _Top fixes:_ " + top.map((f) => f.label).join(" · "));

  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `:mag: *AEO scan*\n${lines.join("\n")}` }),
    });
    // Slack answers a bad or revoked webhook with a 4xx and a one-word body.
    // Swallowing that made a misconfigured URL indistinguishable from a working
    // one — the failure has to be visible in `wrangler tail` to be fixable.
    if (res.ok) {
      console.log(`slack: posted ${site.hostname}`);
    } else {
      console.error(`slack webhook rejected: ${res.status} ${(await res.text()).slice(0, 120)}`);
    }
  } catch (err) {
    // Still never fatal: a Slack outage must not affect a user's scan.
    console.error("slack webhook failed:", String(err?.message || err));
  }
}

/**
 * Post a fix-plan download to #hack-central.
 *
 * A scan is curiosity; a download is intent — somebody is about to hand this
 * report to an agent and change their site. Worth knowing about separately.
 *
 * Deduped per domain+IP for 10 minutes through the existing RL namespace: a
 * browser prefetch, a retry or a link scanner would otherwise post twice for
 * one human action, and a channel that cries wolf stops being read.
 */
async function notifyDownload(env, request, domain, entry) {
  const hook = env.SEARCH_WEBHOOK || env.FEEDBACK_WEBHOOK;
  if (!hook) return;

  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  if (env.RL) {
    const key = `aeo:dl:${domain}:${ip}`;
    if (await env.RL.get(key)) return;
    await env.RL.put(key, "1", { expirationTtl: 600 });
  }

  const grade = entry.report ? `${entry.report.score}/100 · ${entry.report.band}` : "—";
  const bits = [
    `*<https://canonical.cc/labs/aeo/?d=${encodeURIComponent(domain)}|${domain}>* — ${grade}`,
    `${(entry.fixes || []).length} tasks`,
  ];
  const country = request.headers.get("CF-IPCountry");
  if (country && country !== "XX") bits.push(country);
  const referer = request.headers.get("Referer");
  if (referer) bits.push(`via ${referer.slice(0, 120)}`);

  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `:inbox_tray: *AEO fix plan downloaded*\n${bits.join(" · ")}` }),
    });
    if (res.ok) {
      console.log(`slack: download ${domain}`);
    } else {
      console.error(`slack webhook rejected: ${res.status} ${(await res.text()).slice(0, 120)}`);
    }
  } catch (err) {
    // Never fatal — the user gets their file whether or not Slack is up.
    console.error("slack download webhook failed:", String(err?.message || err));
  }
}

/* ── the pipeline ───────────────────────────────────────────────────────── */

// Reordered: the business classification now comes before the audit, because
// Pillar C needs to know what kind of company this is before it can judge
// whether checks like published pricing even apply.
const STEPS = ["fetch", "queries", "audit", "engines", "score", "fixes"];

/**
 * fetch → audit → queries → engines → score → fixes.
 *
 * The query and engine stages need OPENROUTER_API_KEY. Without it they report
 * `skipped` and the visibility pillar is omitted from the score entirely
 * (excluded from the denominator, not counted as zero), so the tool still
 * produces a valid deterministic report.
 */
async function runPipeline(send, input, env, quota) {
  const stage = (step, state) => send({ type: "stage", step, state });
  const status = (text) => send({ type: "status", text });

  await send({ type: "quota", remaining: quota.remaining, domainRemaining: quota.domainRemaining });

  // Recorded so a cached replay reproduces exactly what the live run reported.
  // Storing less than we emit is how a cached report ends up claiming steps ran
  // that never did.
  const stepStates = {};
  const recordStage = async (step, state) => {
    if (state === "done" || state === "skipped") stepStates[step] = state;
    await stage(step, state);
  };

  // 1 — fetch
  await stage("fetch", "active");
  const crawl = await crawlSite(input, status);
  const site = {
    hostname: crawl.hostname,
    origin: crawl.origin,
    pagesCrawled: crawl.pages.length,
    hasRobots: crawl.robotsTxt != null,
    sitemap: crawl.sitemap,
    redirectedTo: crawl.redirectedTo || null,
  };
  await send({ type: "site", site });
  await recordStage("fetch", "done");

  // 2 — understand the business (drives both the questions and Pillar C)
  let queryPlan = null;
  let visibility = null;
  let engineDetail = null;
  let alsoCitedBrands = [];
  const spend = await paidRunsAllowed(env);
  if (!spend.allowed) {
    await send({
      type: "warn",
      where: "budget",
      message: `Daily engine budget reached (${spend.cap} paid scans). The technical audit below is complete; the live-engine half will be back tomorrow.`,
    });
  }
  if (env.OPENROUTER_API_KEY && spend.allowed) {
    await consumePaidRun(env, spend);
    await stage("queries", "active");
    await status("Working out what your buyers would ask…");
    try {
      // Size the query set to what the platform will actually allow, rather
      // than generating 12 and throwing half away. Cloudflare caps subrequests
      // per invocation (50 free / 1000 paid); the crawl has already spent some.
      const cap = Number(env.SUBREQUEST_BUDGET || 45);
      const spare = Math.max(4, cap - (crawl.subrequests || 0) - 2);
      const engineCount = activeEngines(env).length || 1;
      const count = Math.max(engineCount, Math.floor(spare / engineCount));
      queryPlan = await generateQueries(crawl, env, { count });
    } catch (err) {
      const message = String(err?.message || err);
      console.error("query generation failed:", message);
      await send({ type: "warn", where: "queries", message });
    }
    if (queryPlan) {
      await send({
        type: "queries",
        brand: queryPlan.brand,
        category: queryPlan.category,
        queries: queryPlan.queries,
      });
      await recordStage("queries", "done");
    } else {
      await recordStage("queries", "skipped");
    }
  } else {
    await recordStage("queries", "skipped");
  }

  // 3 — audit: structure, schema, agent-readiness, and how the copy reads
  await stage("audit", "active");
  await status("Checking crawler access, schema and agent readiness…");
  const pillars = runDeterministicAudit(crawl);

  // Pillar C sits in the audit stage rather than getting its own step: 16 of
  // its 25 points are deterministic and the model half is a single call, so
  // splitting it out would show the user a step that's over before it renders.
  await status("Reading how the copy is written…");
  try {
    const content = await auditContent(crawl, env, queryPlan);
    if (content?.pillar?.max > 0) pillars.push(content.pillar);
  } catch (err) {
    const message = String(err?.message || err);
    console.error("content audit failed:", message);
    await send({ type: "warn", where: "content", message });
  }

  const pillarDetail = pillars.map((p) => ({
    id: p.id,
    label: p.label,
    max: p.max,
    score: p.checks.reduce((s, c) => s + c.points, 0),
    checks: p.checks.map(({ id, label, state, points, max, evidence }) => ({
      id, label, state, points, max, evidence,
    })),
  }));
  for (const pillar of pillarDetail) await send({ type: "audit", pillar });
  await recordStage("audit", "done");

  // 4 — ask the answer engines
  if (queryPlan) {
    await stage("engines", "active");
    await status(`Asking ${activeEngines(env).length} answer engines ${queryPlan.queries.length} questions…`);
    try {
      // Cloudflare caps subrequests per invocation (50 free / 1000 paid). The
      // crawl has already spent some; reserve 2 for sentiment + headroom and
      // divide the rest across engines. Before this, exceeding the cap killed
      // whole engines mid-run and they reported as "never mentions you".
      const remaining = Math.max(4, Number(env.SUBREQUEST_BUDGET || 45) - (crawl.subrequests || 0) - 2);
      const engineRun = await runEngines(
        queryPlan, crawl, env,
        (engine) => status(`${engine.label}: ${engine.mentioned}/${engine.answered} mentions`),
        { subrequestBudget: remaining }
      );
      if (engineRun?.queriesTrimmed > 0) {
        await send({
          type: "warn",
          where: "budget",
          message: `Asked ${engineRun.queriesAsked} of ${queryPlan.queries.length} questions — the rest didn't fit this platform's per-run request limit. Rates below are out of ${engineRun.queriesAsked}.`,
        });
      }
      if (engineRun) {
        visibility = await scoreVisibility(engineRun, queryPlan, env);
        if (visibility) {
          pillars.push(visibility.pillar);
          engineDetail = visibility.detail;
          alsoCitedBrands = alsoCited(engineRun.engines, queryPlan);
          await send({ type: "engines", ...engineDetail });
          await send({ type: "also_cited", brands: alsoCitedBrands });
        }
      }
      await recordStage("engines", visibility ? "done" : "skipped");
    } catch (err) {
      const message = String(err?.message || err);
      console.error("engine stage failed:", message);
      await send({ type: "warn", where: "engines", message });
      await recordStage("engines", "skipped");
    }
  } else {
    await recordStage("engines", "skipped");
  }

  // 5 — score
  await stage("score", "active");
  const report = scoreReport(pillars);
  await send({ type: "score", ...report });
  await recordStage("score", "done");

  // 6 — fixes
  await stage("fixes", "active");
  const fixes = attachArtifacts(rankFixes(pillars), crawl);
  await send({ type: "fixes", fixes });
  await recordStage("fixes", "done");

  // NOTE: `done` is deliberately NOT sent here. The router emits it only after
  // the report is in the cache, because `done` is what reveals the "download
  // the fix plan" button and that button reads straight out of the cache. Sent
  // from here, a fast click raced the KV write and got a 404.
  //
  // Rebuilt here rather than reused: the visibility pillar is appended after
  // the audit block, and a cached replay must include it.
  const fullDetail = pillars.map((p) => ({
    id: p.id, label: p.label, max: p.max,
    score: p.checks.reduce((s, c) => s + c.points, 0),
    checks: p.checks.map(({ id, label, state, points, max, evidence }) => ({ id, label, state, points, max, evidence })),
  }));
  return {
    site, report, fixes, pillarDetail: fullDetail, stepStates,
    // Only the displayable slice of the plan — the raw engine answers can run
    // to hundreds of KB and KV has a value size limit.
    queryPlan: queryPlan
      ? { brand: queryPlan.brand, category: queryPlan.category, queries: queryPlan.queries }
      : null,
    engineDetail,
    alsoCitedBrands,
  };
}

/* ── router ─────────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // The fix plan, as a Markdown file. MUST be matched before the cached-report
    // route below, which would otherwise read the domain as "example.com/plan.md".
    if (request.method === "GET" && url.pathname.startsWith("/aeo/") && url.pathname.endsWith("/plan.md")) {
      const domain = decodeURIComponent(
        url.pathname.slice("/aeo/".length, -"/plan.md".length)
      ).toLowerCase();
      if (!domain) return json({ error: "No domain given." }, 400, cors);

      const entry = env.CACHE ? await env.CACHE.get(cacheKey(domain), "json") : null;
      if (!entry) {
        return json({ error: `No report for ${domain} — run a scan first.` }, 404, cors);
      }

      // Awaited, not fired and forgotten: Cloudflare cancels pending promises
      // when the invocation ends. Rendering first means a Slack outage can
      // never cost the user their download.
      const body = renderPlan(entry);
      await notifyDownload(env, request, domain, entry);

      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${planFilename(domain)}"`,
          // The client downloads via fetch+blob (so a 404 doesn't navigate the
          // tab away from the report), and needs to read the filename back out
          // rather than re-deriving it and drifting from this one.
          "access-control-expose-headers": "Content-Disposition",
          // The plan is only as current as the last scan; never let an
          // intermediary serve a stale one after a re-run.
          "cache-control": "no-store",
          ...cors,
        },
      });
    }

    // Cached report — free, unlimited, and what a shared permalink hits.
    if (request.method === "GET" && url.pathname.startsWith("/aeo/")) {
      const domain = decodeURIComponent(url.pathname.slice("/aeo/".length)).toLowerCase();
      if (!domain) return json({ error: "No domain given." }, 400, cors);
      if (!env.CACHE) return json({ error: "Not found." }, 404, cors);
      const hit = await env.CACHE.get(cacheKey(domain), "json");
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
        const hit = await env.CACHE.get(cacheKey(domain), "json");
        if (hit) {
          return sseStream(async (send) => {
            await send({ type: "cached", cachedAt: hit.cachedAt });
            // Replay the recorded step states, not a blanket "done" — a step
            // that was skipped on the live run must still read as skipped here.
            for (const step of STEPS) {
              await send({ type: "stage", step, state: hit.stepStates?.[step] || "done" });
            }
            if (hit.site) await send({ type: "site", site: hit.site });
            for (const p of hit.pillarDetail || []) await send({ type: "audit", pillar: p });
            if (hit.queryPlan) {
              await send({
                type: "queries",
                brand: hit.queryPlan.brand,
                category: hit.queryPlan.category,
                queries: hit.queryPlan.queries,
              });
            }
            if (hit.engineDetail) await send({ type: "engines", ...hit.engineDetail });
            if (hit.alsoCitedBrands?.length) await send({ type: "also_cited", brands: hit.alsoCitedBrands });
            await send({ type: "score", ...hit.report });
            await send({ type: "fixes", fixes: hit.fixes || [] });
            await send({ type: "done" });
            await notifySlack(env, { ...hit, cached: true });
          }, request, env);
        }
      }

      // Domain limit first — it's the one the user asked for and the one whose
      // message is actionable ("this site, today"), so it should win the race
      // to explain a 429.
      const domainQuota = await checkDomainQuota(domain, env);
      if (!domainQuota.allowed) {
        return json(
          {
            error: `${domain} has been scanned ${domainQuota.limit} times today. Fresh scans reset at midnight UTC — the existing report stays free to view.`,
            scope: "domain",
            remaining: 0,
          },
          429, cors
        );
      }

      const quota = await checkQuota(request, env);
      if (!quota.allowed) {
        return json(
          { error: "You've hit today's overall scan limit. It resets at midnight UTC.", scope: "ip", remaining: 0 },
          429, cors
        );
      }
      await consumeQuota(env, quota);
      await consumeQuota(env, domainQuota);

      return sseStream(async (send) => {
        const result = await runPipeline(send, body.input, env, { ...quota, domainRemaining: domainQuota.remaining - 1 });
        // Cache first, THEN `done`: the client reveals the fix-plan download on
        // `done`, and that download is served out of this cache entry.
        if (env.CACHE && result) {
          await env.CACHE.put(
            cacheKey(domain),
            JSON.stringify({ ...result, cachedAt: new Date().toISOString() }),
            { expirationTtl: CACHE_TTL_SECONDS }
          );
        }
        await send({ type: "done" });
        if (result) {
          // MUST be awaited. Cloudflare cancels pending promises when the
          // invocation ends, so a fire-and-forget fetch here never actually
          // sent — it failed silently and looked fine in the logs. The stream
          // has already emitted `done`, so this costs the user nothing.
          await notifySlack(env, { ...result, cached: false });
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
