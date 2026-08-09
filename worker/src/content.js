/* Pillar C — Answer-shaped content (25 pts).
 *
 * The other pillars ask whether engines can reach you, parse you, and whether
 * they cite you. This one asks *why*: is the prose written the way an answer
 * engine likes to quote?
 *
 * 16 of the 25 points are deterministic and 9 need a model, so most of the
 * pillar stays stable across re-runs. The model half runs at temperature 0 and
 * is omitted entirely (excluded from the max, never scored zero) when no key is
 * configured or the call fails — the same rule the visibility pillar follows.
 */

import { completeJson } from "./openrouter.js";
import { visibleText, extractHeadings, extractMeta } from "./html.js";

const WEIGHTS = {
  opener: 6,      // model
  questions: 3,
  scannable: 2,
  comparison: 5,
  pricing: 4,
  quotable: 3,    // model
  freshness: 2,
};

const check = (id, label, state, points, max, evidence, fix = null) => ({
  id, label, state, points, max, evidence, fix,
});

const pathOf = (p) => {
  try { return new URL(p.finalUrl || p.url).pathname; } catch { return ""; }
};

/* ── deterministic checks ───────────────────────────────────────────────── */

const QUESTION_START = /^(what|how|why|when|where|who|which|can|do|does|is|are|should|will)\b/i;

/** Headings phrased the way people actually ask things. */
function questionHeadings(crawl) {
  let total = 0, questions = 0;
  const examples = [];
  for (const page of crawl.pages) {
    const h = extractHeadings(page.html || "");
    for (const text of [...h.h2, ...h.h3]) {
      total++;
      if (text.endsWith("?") || QUESTION_START.test(text)) {
        questions++;
        if (examples.length < 4) examples.push(text);
      }
    }
  }
  const ratio = total ? questions / total : 0;
  const points = ratio >= 0.25 ? WEIGHTS.questions : ratio > 0.05 ? 2 : ratio > 0 ? 1 : 0;
  return check(
    "c-questions", "Headings are phrased as questions",
    points === WEIGHTS.questions ? "pass" : points ? "partial" : "fail",
    points, WEIGHTS.questions,
    { questionHeadings: questions, totalHeadings: total, ratio: Math.round(ratio * 100), examples },
    points < WEIGHTS.questions ? "questionHeadings" : null
  );
}

/** Tables and real lists — the structures engines lift wholesale. */
function scannable(crawl) {
  let tables = 0, lists = 0;
  for (const page of crawl.pages) {
    const html = page.html || "";
    tables += (html.match(/<table\b/gi) || []).length;
    for (const m of html.match(/<(ul|ol)\b[\s\S]{0,4000}?<\/\1>/gi) || []) {
      if ((m.match(/<li\b/gi) || []).length >= 3) lists++;
    }
  }
  const points = tables > 0 && lists > 0 ? 2 : tables > 0 || lists > 0 ? 1 : 0;
  return check(
    "c-scannable", "Content uses tables and lists",
    points === 2 ? "pass" : points ? "partial" : "fail",
    points, WEIGHTS.scannable, { tables, lists }, null
  );
}

/** First-party comparison pages — forkoff's top recommendation, and rare. */
function comparisonPages(crawl) {
  const RX = /(\bvs\b|\bversus\b|alternatives?|compare|comparison|competitors)/i;
  const hits = [];
  for (const page of crawl.pages) {
    const path = pathOf(page);
    const title = extractMeta(page.html || "").title || "";
    if (RX.test(path) || RX.test(title)) hits.push({ path, title: title.slice(0, 80) });
  }
  const points = hits.length >= 2 ? WEIGHTS.comparison : hits.length === 1 ? 3 : 0;
  return check(
    "c-comparison", "First-party comparison and alternatives pages",
    points === WEIGHTS.comparison ? "pass" : points ? "partial" : "fail",
    points, WEIGHTS.comparison, { found: hits.length, pages: hits.slice(0, 5) },
    points < WEIGHTS.comparison ? "comparisonPage" : null
  );
}

/**
 * Prices as readable text.
 *
 * Skipped entirely for sites that don't sell anything directly — a venture
 * firm has no pricing page and shouldn't be marked down for it. When it
 * doesn't apply the check is dropped from the pillar max rather than scored
 * zero, the same rule used elsewhere for things we didn't measure.
 */
function pricingInText(crawl) {
  const pricingPage = crawl.pages.find((p) => /\/(pricing|plans|price)/i.test(pathOf(p)));
  const allText = crawl.pages.map((p) => visibleText(p.html || "")).join(" ");
  // Deliberately narrow. An earlier, looser version matched "sign up" and a
  // stray "/mo" on canonical.cc — a venture firm with nothing to sell — and
  // marked it down 4 points for having no prices. Only unambiguous
  // published-pricing language counts; anything softer produces exactly that
  // kind of confident, wrong deduction.
  const commerceSignals =
    /(per (month|user|seat)|billed (annually|monthly)|free trial|starts at\s*[$£€]|pricing starts)/i.test(allText) ||
    /"@type"\s*:\s*"(Offer|AggregateOffer)"/i.test(crawl.pages.map((p) => p.html || "").join(" "));

  if (!pricingPage && !commerceSignals) {
    return check("c-pricing", "Prices are readable as text", "n/a", 0, 0,
      { applicable: false, why: "No pricing page and no commerce signals — this site doesn't appear to sell directly." }, null);
  }

  // Look on the pricing page if there is one, otherwise anywhere on the site.
  // Requiring a /pricing path was too strict: plenty of companies state figures
  // on the homepage or in an FAQ, and that is just as quotable to an engine.
  const AMOUNT = /(?:[$£€]\s?\d[\d,.]*\s?[KMB]?|\b\d[\d,.]*\s?(?:USD|EUR|GBP)\b)/gi;
  const searched = pricingPage ? visibleText(pricingPage.html || "") : allText;
  const amounts = searched.match(AMOUNT) || [];
  const contactOnly = /(contact (us|sales)|request a quote|talk to sales|get a quote)/i.test(searched);

  let points = 0;
  if (amounts.length >= 2) points = WEIGHTS.pricing;
  else if (amounts.length === 1) points = 2;

  return check(
    "c-pricing", "Prices are readable as text",
    points === WEIGHTS.pricing ? "pass" : points ? "partial" : "fail",
    points, WEIGHTS.pricing,
    {
      applicable: true,
      hasPricingPage: !!pricingPage,
      pricingPath: pricingPage ? pathOf(pricingPage) : null,
      searchedWholeSite: !pricingPage,
      amountsFound: amounts.length,
      examples: [...new Set(amounts)].slice(0, 4),
      contactOnly,
    },
    points < WEIGHTS.pricing ? "pricingText" : null
  );
}

/** Visible recency — dates and bylines an engine can trust. */
function freshness(crawl) {
  const year = new Date().getUTCFullYear();
  let dated = 0, authored = 0;
  for (const page of crawl.pages) {
    const html = page.html || "";
    const text = visibleText(html);
    if (
      /<time\b/i.test(html) ||
      new RegExp(`\\b(${year}|${year - 1})\\b`).test(text) ||
      /(last updated|published|updated on)/i.test(text)
    ) dated++;
    if (/\b(by|author|written by)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test(text)) authored++;
  }
  const points = (dated > 0 ? 1 : 0) + (authored > 0 ? 1 : 0);
  return check(
    "c-freshness", "Dates and authorship are visible",
    points === 2 ? "pass" : points ? "partial" : "fail",
    points, WEIGHTS.freshness, { pagesWithDates: dated, pagesWithAuthors: authored }, null
  );
}

/* ── model-scored checks ────────────────────────────────────────────────── */

const PROMPT = (host, opener, headings) => `You are judging whether a company's web copy is written so an AI assistant can quote it.

Site: ${host}

The first 120 words of the homepage:
"""
${opener}
"""

Some section headings from the site:
${headings.map((h) => `- ${h}`).join("\n") || "- (none found)"}

Return JSON only:
{
  "directAnswer": 0.0,
  "directAnswerWhy": "one sentence",
  "quotableClaims": 0.0,
  "quotableWhy": "one sentence",
  "bestSentence": "the single most quotable sentence already present, verbatim, or null"
}

Scoring, both 0.0–1.0:
- "directAnswer": does the opening say plainly WHAT this is and WHO it is for,
  in a sentence an assistant could lift as a definition? 1.0 = a clean
  definitional sentence ("X is a Y that does Z for W"). 0.0 = pure positioning
  or slogan with no statement of what the thing is.
- "quotableClaims": are there specific, attributable claims — named numbers,
  dated facts, concrete specifics? 1.0 = several. 0.0 = only vague superlatives.

Judge only what is written above. Do not reward or penalise the product itself.`;

async function modelChecks(crawl, env) {
  const key = env.OPENROUTER_API_KEY;
  const home = crawl.home?.html || "";
  const opener = visibleText(home).split(/\s+/).slice(0, 120).join(" ");
  const h = extractHeadings(home);
  const headings = [...h.h2, ...h.h3].slice(0, 12);

  if (!key || opener.length < 40) return { checks: [], cost: 0, measured: false };

  try {
    const { data, cost } = await completeJson(key, {
      model: env.MODEL_STRONG || "anthropic/claude-sonnet-5",
      prompt: PROMPT(crawl.hostname, opener, headings),
      // Generous: reasoning tokens count against this and a tight budget
      // returns an empty completion rather than an error.
      maxTokens: 2000,
      temperature: 0, // an unchanged site must score the same twice
    });
    if (!data || typeof data.directAnswer !== "number") return { checks: [], cost, measured: false };

    const clamp = (n) => Math.max(0, Math.min(1, Number(n) || 0));

    /* Quantise to three bands before scoring.
     *
     * temperature:0 is NOT reproducible on current models — the same unchanged
     * homepage scored 0.67, 0.5 and 0.33 on three consecutive runs, which would
     * have shown a user their score moving with nothing changed. Bands mean a
     * judgement has to genuinely shift category, not wobble, to move the
     * number. This is the cost of scoring prose at all, and it's why only 9 of
     * 25 points here are model-scored. */
    const band = (n) => (n >= 0.75 ? 1 : n >= 0.4 ? 0.5 : 0);
    const direct = band(clamp(data.directAnswer));
    const quotable = band(clamp(data.quotableClaims));

    return {
      cost,
      measured: true,
      checks: [
        check(
          "c-opener", "Opening says plainly what this is and who it's for",
          direct >= 0.75 ? "pass" : direct >= 0.4 ? "partial" : "fail",
          Math.round(WEIGHTS.opener * direct), WEIGHTS.opener,
          { score: direct, raw: clamp(data.directAnswer), why: String(data.directAnswerWhy || "").slice(0, 300), opener: opener.slice(0, 300) },
          direct >= 0.75 ? null : "openerRewrite"
        ),
        check(
          "c-quotable", "Specific, quotable claims rather than superlatives",
          quotable >= 0.75 ? "pass" : quotable >= 0.4 ? "partial" : "fail",
          Math.round(WEIGHTS.quotable * quotable), WEIGHTS.quotable,
          { score: quotable, raw: clamp(data.quotableClaims), why: String(data.quotableWhy || "").slice(0, 300), bestSentence: data.bestSentence || null },
          null
        ),
      ],
    };
  } catch {
    return { checks: [], cost: 0, measured: false };
  }
}

/** Exported for tests: the banding that keeps model drift from moving scores. */
export const __bandForTest = (n) => (n >= 0.75 ? 1 : n >= 0.4 ? 0.5 : 0);

/* ── pillar ─────────────────────────────────────────────────────────────── */

export async function auditContent(crawl, env) {
  const deterministic = [
    questionHeadings(crawl),
    scannable(crawl),
    comparisonPages(crawl),
    pricingInText(crawl),
    freshness(crawl),
  ];
  const model = await modelChecks(crawl, env);

  // n/a checks carry max 0, so they neither earn nor cost points.
  const checks = [...deterministic, ...model.checks];
  const max = checks.reduce((s, c) => s + c.max, 0);

  return {
    pillar: { id: "content", label: "Answer-shaped content", max, checks },
    cost: model.cost || 0,
    modelMeasured: model.measured,
  };
}
