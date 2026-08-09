/* Answer-engine adapters — Pillar E (PRD §6).
 *
 * FOUR engines, not five. Every configuration detail here was verified against
 * the live API and contradicts the published docs in at least one respect; see
 * wrangler.toml for the measurements. The two that matter most:
 *
 *   - Perplexity 404s if given the web plugin (search is intrinsic to Sonar).
 *   - Everyone else REQUIRES engine:"native", or OpenRouter falls back to Exa
 *     and every engine reads identical retrieved context — which would make
 *     the whole comparison theatre while still producing a plausible chart.
 */

import { complete } from "./openrouter.js";
import { askGemini } from "./gemini.js";

export const ENGINES = [
  { id: "chatgpt", label: "ChatGPT", envKey: "ENGINE_CHATGPT", fallback: "openai/gpt-5.6-luna", web: "native" },
  { id: "claude", label: "Claude", envKey: "ENGINE_CLAUDE", fallback: "anthropic/claude-sonnet-5", web: "native" },
  { id: "perplexity", label: "Perplexity", envKey: "ENGINE_PERPLEXITY", fallback: "perplexity/sonar", web: false },
  { id: "grok", label: "Grok", envKey: "ENGINE_GROK", fallback: "x-ai/grok-4.3", web: "native" },
  // Direct Google API, not OpenRouter — see src/gemini.js for why. Included
  // only when GEMINI_API_KEY is set AND that key can actually ground.
  { id: "gemini", label: "Gemini", envKey: "ENGINE_GEMINI", fallback: "gemini-3.5-flash", provider: "google" },
];

/** Engines usable with the keys currently configured. */
export function activeEngines(env) {
  return ENGINES.filter((e) => (e.provider === "google" ? !!env.GEMINI_API_KEY : !!env.OPENROUTER_API_KEY));
}

/* Hosts that are never a "competitor" — aggregators, forums, encyclopedias.
   Without this, every share-of-voice reading is dominated by Reddit and G2. */
const NON_BRAND_HOSTS = [
  "wikipedia.org", "reddit.com", "youtube.com", "medium.com", "quora.com",
  "g2.com", "capterra.com", "trustradius.com", "gartner.com", "forbes.com",
  "linkedin.com", "x.com", "twitter.com", "facebook.com", "github.com",
  "producthunt.com", "crunchbase.com", "techcrunch.com", "substack.com",
  "softwareadvice.com", "getapp.com", "slashdot.org", "stackoverflow.com",
];

const rootDomain = (host) => {
  const parts = String(host || "").replace(/^www\./, "").split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : parts.join(".");
};

const isAggregator = (host) => {
  const root = rootDomain(host);
  return NON_BRAND_HOSTS.some((h) => root === h || root.endsWith("." + h));
};

/** Word-boundary, case-insensitive brand match. Avoids matching inside URLs. */
export function mentionsBrand(text, names) {
  const body = String(text || "");
  return names.some((raw) => {
    const name = String(raw || "").trim();
    if (name.length < 3) return false; // too short to match safely
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w.@/-])${esc}([^\\w.-]|$)`, "i").test(body);
  });
}

/** Ask one engine one query. Never throws — a dead engine degrades visibly. */
async function askOne(env, engine, model, query, brandNames, ownDomain, maxTokens) {
  try {
    const res =
      engine.provider === "google"
        // Gemini needs its OWN budget. The two providers have opposite
        // failure modes at low limits: below ~900 the OpenRouter engines stop
        // searching and answer from memory, while Gemini below ~4000 truncates
        // and drops groundingMetadata entirely. One shared number cannot serve
        // both, and using the OpenRouter figure made Gemini report unavailable
        // on every single question.
        ? await askGemini(env.GEMINI_API_KEY, model, query, {
            maxTokens: Number(env.GEMINI_MAX_TOKENS || 4000),
          })
        : await complete(env.OPENROUTER_API_KEY, {
            model,
            prompt: query,
            maxTokens,
            web: engine.web,
            temperature: 0,
          });

    const hosts = res.annotations
      .map((u) => { try { return new URL(u).hostname; } catch { return null; } })
      .filter(Boolean);

    const own = rootDomain(ownDomain);
    const cited = hosts.some((h) => rootDomain(h) === own);
    const others = [...new Set(hosts.map(rootDomain))].filter((h) => h !== own && !isAggregator(h));

    return {
      ok: true,
      query,
      mentioned: mentionsBrand(res.text, brandNames),
      cited,
      citedHosts: [...new Set(hosts)],
      otherBrands: others,
      text: res.text.slice(0, 4000),
      cost: res.cost,
    };
  } catch (err) {
    return { ok: false, query, error: String(err?.message || err), cost: 0 };
  }
}

/**
 * Run the full query set against every engine.
 *
 * `onProgress(engineId, done, total)` fires as each engine finishes so the UI
 * can fill in columns incrementally rather than sitting on a spinner.
 */
export async function runEngines(queryPlan, crawl, env, onProgress = () => {}, opts = {}) {
  const engines = activeEngines(env);
  if (!engines.length) return null;

  const maxTokens = Number(env.ENGINE_MAX_TOKENS || 900);
  const brandNames = [queryPlan.brand, ...queryPlan.aliases].filter(Boolean);
  const results = [];
  let totalCost = 0;

  // Fit within the remaining subrequest budget. Asking every engine fewer
  // questions is far better than asking some engines nothing: a missing engine
  // reads as "this engine never mentions you", which is a lie.
  const perEngine = Math.max(1, Math.floor((opts.subrequestBudget ?? Infinity) / engines.length));
  const queries = queryPlan.queries.slice(0, perEngine);
  const trimmed = queryPlan.queries.length - queries.length;

  // Engines run in parallel; the queries within an engine also run in parallel.
  await Promise.all(
    engines.map(async (engine) => {
      const model = env[engine.envKey] || engine.fallback;
      const answers = await Promise.all(
        queries.map((q) =>
          askOne(env, engine, model, q.q, brandNames, crawl.hostname, maxTokens)
        )
      );

      const ok = answers.filter((a) => a.ok);
      const failed = answers.length - ok.length;
      totalCost += answers.reduce((s, a) => s + (a.cost || 0), 0);

      // An engine that answered nothing is reported as unavailable rather than
      // as a zero score — we didn't measure it, so we mustn't grade it.
      const available = ok.length > 0;
      const mentioned = ok.filter((a) => a.mentioned).length;
      const cited = ok.filter((a) => a.cited).length;

      results.push({
        id: engine.id,
        label: engine.label,
        model,
        available,
        answered: ok.length,
        failed,
        total: answers.length,
        mentioned,
        cited,
        mentionRate: ok.length ? mentioned / ok.length : 0,
        citationRate: ok.length ? cited / ok.length : 0,
        error: available ? null : answers.find((a) => !a.ok)?.error || "No answer",
        answers: ok,
      });

      onProgress(results[results.length - 1]);
    })
  );

  // Stable display order regardless of which engine finished first.
  results.sort((a, b) => ENGINES.findIndex((e) => e.id === a.id) - ENGINES.findIndex((e) => e.id === b.id));

  // Per-query view: how many engines named you on each question. This is what
  // makes the query chips actionable — "you lose every pricing question" is a
  // far more useful finding than an aggregate percentage.
  const perQuery = queries.map((q) => {
    let mentionedBy = 0, citedBy = 0, answeredBy = 0;
    for (const engine of results) {
      const a = (engine.answers || []).find((x) => x.query === q.q);
      if (!a) continue;
      answeredBy++;
      if (a.mentioned) mentionedBy++;
      if (a.cited) citedBy++;
    }
    return { q: q.q, shape: q.shape, mentionedBy, citedBy, answeredBy };
  });

  return { engines: results, cost: totalCost, queriesAsked: queries.length, queriesTrimmed: trimmed, perQuery };
}

/** Brands cited on queries where the user's own site wasn't. */
export function alsoCited(engineResults, queryPlan) {
  const perBrand = new Map();
  for (const engine of engineResults) {
    for (const a of engine.answers || []) {
      if (a.cited) continue; // only count queries the user LOST
      for (const host of a.otherBrands || []) {
        if (!perBrand.has(host)) perBrand.set(host, new Set());
        perBrand.get(host).add(a.query);
      }
    }
  }
  return [...perBrand.entries()]
    .map(([host, queries]) => ({ host, queryCount: queries.size }))
    .sort((a, b) => b.queryCount - a.queryCount)
    .slice(0, 8);
}
