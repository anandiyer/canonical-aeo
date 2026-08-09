/* Pillar E — Live AI visibility (25 pts).
 *
 *   mention rate    10   named at all
 *   citation rate    8   named WITH a link to your domain
 *   share of voice   4   your mentions vs every brand cited
 *   sentiment        3   how you're described when named
 *
 * Only engines that actually answered are counted. An engine that errored is
 * excluded from both numerator and denominator and reported as unavailable —
 * scoring it zero would mark a site down for something we never measured.
 */

import { completeJson } from "./openrouter.js";
import { band } from "./score.js";

const WEIGHTS = { mention: 10, citation: 8, share: 4, sentiment: 3 };

/** One cheap batched call classifies every answer that named the brand. */
async function scoreSentiment(engineResults, queryPlan, env) {
  const key = env.OPENROUTER_API_KEY;
  const snippets = [];
  for (const engine of engineResults) {
    for (const a of engine.answers || []) {
      if (!a.mentioned) continue;
      snippets.push({ engine: engine.id, query: a.query, text: a.text.slice(0, 700) });
      if (snippets.length >= 12) break;
    }
    if (snippets.length >= 12) break;
  }
  if (!key || !snippets.length) return { score: null, label: null, counts: null, cost: 0 };

  const prompt = `A brand called "${queryPlan.brand}" was mentioned in these AI assistant answers.
Classify how the brand is characterised in each one.

${snippets.map((s, i) => `[${i + 1}] ${s.text}`).join("\n\n")}

Return JSON: {"verdicts":[{"i":1,"sentiment":"positive|neutral|negative"}]}
Use "neutral" for a bare listing with no evaluative language. Judge only how the
brand is described — not the overall tone of the answer.`;

  try {
    const { data, cost } = await completeJson(key, {
      model: env.MODEL_CHEAP || "google/gemini-3.5-flash",
      prompt,
      // Generous on purpose. Reasoning tokens count against max_tokens and
      // scale with input size, so a budget that fits a toy prompt silently
      // yields an empty completion on the real 12-snippet one — the same trap
      // that suppresses search on the engine calls. Measured cost is ~$0.005.
      maxTokens: 3000,
      temperature: 0,
    });
    const verdicts = Array.isArray(data?.verdicts) ? data.verdicts : [];
    if (!verdicts.length) return { score: null, label: null, counts: null, cost };

    const counts = { positive: 0, neutral: 0, negative: 0 };
    for (const v of verdicts) {
      const s = String(v?.sentiment || "").toLowerCase();
      if (s in counts) counts[s]++;
    }
    const n = counts.positive + counts.neutral + counts.negative;
    if (!n) return { score: null, label: null, counts: null, cost };

    // Neutral is the honest default, so it scores mid rather than zero: being
    // listed without praise is a normal, fine outcome.
    const score = (counts.positive * 1 + counts.neutral * 0.6) / n;
    const label = counts.negative > counts.positive ? "negative"
      : counts.positive > counts.neutral ? "positive" : "neutral";
    return { score, label, counts, cost };
  } catch {
    return { score: null, label: null, counts: null, cost: 0 };
  }
}

export async function scoreVisibility(engineRun, queryPlan, env) {
  const engines = engineRun.engines.filter((e) => e.available);
  if (!engines.length) return null; // nothing measured → pillar omitted entirely

  const answered = engines.reduce((s, e) => s + e.answered, 0);
  const mentioned = engines.reduce((s, e) => s + e.mentioned, 0);
  const cited = engines.reduce((s, e) => s + e.cited, 0);

  const mentionRate = answered ? mentioned / answered : 0;
  const citationRate = answered ? cited / answered : 0;

  // Share of voice: your citations vs every distinct brand citation seen.
  let ownCitations = 0;
  const otherCitations = new Map();
  for (const e of engines) {
    for (const a of e.answers || []) {
      if (a.cited) ownCitations++;
      for (const host of a.otherBrands || []) {
        otherCitations.set(host, (otherCitations.get(host) || 0) + 1);
      }
    }
  }
  const totalBrandCitations = ownCitations + [...otherCitations.values()].reduce((s, n) => s + n, 0);
  const shareOfVoice = totalBrandCitations ? ownCitations / totalBrandCitations : 0;

  const sentiment = await scoreSentiment(engines, queryPlan, env);

  const checks = [
    {
      id: "mention-rate",
      label: "Named when buyers ask",
      state: mentionRate >= 0.6 ? "pass" : mentionRate > 0 ? "partial" : "fail",
      points: Math.round(WEIGHTS.mention * mentionRate),
      max: WEIGHTS.mention,
      evidence: { mentioned, answered, rate: Math.round(mentionRate * 100) },
    },
    {
      id: "citation-rate",
      label: "Cited with a link to your site",
      state: citationRate >= 0.5 ? "pass" : citationRate > 0 ? "partial" : "fail",
      points: Math.round(WEIGHTS.citation * citationRate),
      max: WEIGHTS.citation,
      evidence: { cited, answered, rate: Math.round(citationRate * 100) },
    },
    {
      id: "share-of-voice",
      label: "Share of voice against everyone else cited",
      state: shareOfVoice >= 0.25 ? "pass" : shareOfVoice > 0 ? "partial" : "fail",
      points: Math.round(WEIGHTS.share * Math.min(1, shareOfVoice / 0.25)),
      max: WEIGHTS.share,
      evidence: {
        ownCitations,
        otherBrands: otherCitations.size,
        share: Math.round(shareOfVoice * 100),
      },
    },
  ];

  // Sentiment only scores when we could measure it. Unmeasured → excluded from
  // the pillar max, same principle as an unavailable engine. `sentimentMeasured`
  // is surfaced so the UI can say why the pillar is out of 22 and not 25,
  // rather than leaving the user to wonder where three points went.
  if (sentiment.score != null) {
    checks.push({
      id: "sentiment",
      label: "Described positively when named",
      state: sentiment.score >= 0.75 ? "pass" : sentiment.score >= 0.5 ? "partial" : "fail",
      points: Math.round(WEIGHTS.sentiment * sentiment.score),
      max: WEIGHTS.sentiment,
      evidence: { label: sentiment.label, ...sentiment.counts },
    });
  }

  const max = checks.reduce((s, c) => s + c.max, 0);

  return {
    pillar: { id: "visibility", label: "Live AI visibility", max, checks },
    detail: {
      engines: engines.map((e) => ({
        id: e.id,
        label: e.label,
        model: e.model,
        answered: e.answered,
        total: e.total,
        mentioned: e.mentioned,
        cited: e.cited,
        mentionRate: e.mentionRate,
        citationRate: e.citationRate,
        band: band(Math.round((e.mentionRate * 0.6 + e.citationRate * 0.4) * 100)),
      })),
      unavailable: engineRun.engines
        .filter((e) => !e.available)
        .map((e) => ({ id: e.id, label: e.label, error: e.error })),
      mentionRate,
      citationRate,
      shareOfVoice,
      sentiment: sentiment.label,
      sentimentMeasured: sentiment.score != null,
    },
    cost: (engineRun.cost || 0) + (sentiment.cost || 0),
  };
}
