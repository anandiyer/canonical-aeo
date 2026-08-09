/* Buyer-intent query generation (PRD §5).
 *
 * forkoff makes the user type 10–50 queries. For a free tool that's a
 * conversion killer, so we derive them from the crawl and show the user what
 * we picked. Fixed shapes keep coverage comparable between runs and between
 * sites — without them the model drifts toward whatever the site emphasises,
 * which is exactly the bias we're trying to measure.
 */

import { completeJson } from "./openrouter.js";
import { extractMeta, visibleText } from "./html.js";

export const QUERY_SHAPES = [
  { id: "best-for", n: 3, hint: "best {category} for {ICP} — no brand name" },
  { id: "alternatives", n: 2, hint: "{brand} alternatives, or {brand} vs {named competitor}" },
  { id: "pricing", n: 2, hint: "how much {category} costs — no brand name" },
  { id: "reputation", n: 2, hint: "is {brand} any good / {brand} reviews" },
  { id: "jtbd", n: 3, hint: "how do I {job the buyer is trying to do} — no brand name" },
];

export const QUERY_COUNT = QUERY_SHAPES.reduce((n, s) => n + s.n, 0); // 12

/**
 * Scale the shape mix down to `total` while keeping the balance.
 *
 * We ask for exactly what the platform budget allows rather than generating 12
 * and discarding half: a discarded query is wasted spend, and "we asked 6 of
 * 12" is a confusing thing to show a user on every single run.
 * Largest-remainder apportionment, so the totals always add up exactly.
 */
export function shapePlan(total = QUERY_COUNT) {
  const want = Math.max(QUERY_SHAPES.length, Math.min(QUERY_COUNT, total));
  const exact = QUERY_SHAPES.map((s) => ({ ...s, raw: (s.n / QUERY_COUNT) * want }));
  const plan = exact.map((s) => ({ ...s, n: Math.max(1, Math.floor(s.raw)) }));

  let diff = want - plan.reduce((a, s) => a + s.n, 0);
  // Hand out (or claw back) the remainder by largest fractional part.
  const order = [...plan.keys()].sort(
    (a, b) => (exact[b].raw % 1) - (exact[a].raw % 1)
  );
  let i = 0;
  while (diff !== 0 && i < order.length * 3) {
    const k = order[i % order.length];
    if (diff > 0) { plan[k].n++; diff--; }
    else if (plan[k].n > 1) { plan[k].n--; diff++; }
    i++;
  }
  return plan;
}

/** Compact, token-bounded digest of the crawl for the model to read. */
function siteDigest(crawl) {
  const meta = extractMeta(crawl.home?.html || "");
  const pages = crawl.pages
    .map((p) => {
      try { return new URL(p.finalUrl || p.url).pathname; } catch { return null; }
    })
    .filter(Boolean)
    .slice(0, 10);

  return [
    `Domain: ${crawl.hostname}`,
    meta.og.site_name ? `Site name: ${meta.og.site_name}` : null,
    meta.title ? `Title: ${meta.title}` : null,
    meta.description ? `Description: ${meta.description}` : null,
    `Pages: ${pages.join(", ")}`,
    `Homepage text: ${visibleText(crawl.home?.html || "").slice(0, 1800)}`,
  ].filter(Boolean).join("\n");
}

const PROMPT = (digest, plan, total) => `You are analysing a company's website to work out what its buyers would ask an AI assistant.

${digest}

Return JSON exactly like:
{
  "brand": "the company's name as a buyer would say it",
  "aliases": ["other names or spellings a model might use"],
  "category": "the product category in buyer language, e.g. 'demand forecasting software'",
  "icp": "who buys it, e.g. 'mid-market retail and CPG supply chain teams'",
  "competitors": ["up to 5 named competitors you can infer"],
  "queries": [
    {"shape": "best-for", "q": "..."},
    {"shape": "alternatives", "q": "..."},
    {"shape": "pricing", "q": "..."},
    {"shape": "reputation", "q": "..."},
    {"shape": "jtbd", "q": "..."}
  ]
}

Produce exactly ${total} queries, distributed as:
${plan.map((s) => `- ${s.n} × "${s.id}": ${s.hint}`).join("\n")}

Rules:
- Write queries the way a real buyer types them into ChatGPT. No marketing language.
- Only the "alternatives" and "reputation" shapes may contain the brand name. The
  other shapes MUST NOT mention it — the whole point is to find out whether the
  brand surfaces when nobody asked for it.
- Base "category", "icp" and "competitors" on the site content. If you genuinely
  cannot tell, use an empty array rather than inventing names.`;

/**
 * Generate the query set.
 *
 * Throws with a specific reason on failure rather than returning null. A silent
 * null is indistinguishable from "no key configured", which is exactly how a
 * broken stage ends up looking like a deliberately skipped one.
 */
export async function generateQueries(crawl, env, opts = {}) {
  const key = env.OPENROUTER_API_KEY;
  if (!key) throw new Error("No OPENROUTER_API_KEY configured");

  const total = Math.max(QUERY_SHAPES.length, Math.min(QUERY_COUNT, opts.count || QUERY_COUNT));
  const plan = shapePlan(total);

  const model = env.MODEL_CHEAP || "google/gemini-3.5-flash";
  const { data, text, cost } = await completeJson(key, {
    model,
    prompt: PROMPT(siteDigest(crawl), plan, total),
    // Reasoning tokens count against this and scale with prompt size. 2000 was
    // enough locally and not in production, where the digest runs longer.
    maxTokens: 6000,
    temperature: 0, // stable query sets across re-runs
  });

  if (!data || !Array.isArray(data.queries)) {
    const preview = String(text || "").slice(0, 300).replace(/\s+/g, " ");
    throw new Error(
      `${model} returned no usable query JSON (${(text || "").length} chars)` +
      (preview ? `: ${preview}` : " — empty completion, likely truncated by max_tokens")
    );
  }

  const queries = data.queries
    .map((q) => (typeof q === "string" ? { shape: "unknown", q } : q))
    .filter((q) => q && typeof q.q === "string" && q.q.trim().length > 5)
    .map((q) => ({ shape: String(q.shape || "unknown"), q: q.q.trim() }))
    .slice(0, total);

  if (!queries.length) return null;

  // The brand name is what every downstream mention check keys on, so fall
  // back to the hostname rather than letting it come back empty.
  const brand = String(data.brand || "").trim() || crawl.hostname.replace(/^www\./, "").split(".")[0];

  return {
    brand,
    aliases: (Array.isArray(data.aliases) ? data.aliases : []).map(String).filter(Boolean),
    category: String(data.category || "").trim() || null,
    icp: String(data.icp || "").trim() || null,
    competitors: (Array.isArray(data.competitors) ? data.competitors : []).map(String).filter(Boolean),
    queries,
    cost,
  };
}
