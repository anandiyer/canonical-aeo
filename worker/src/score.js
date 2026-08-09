/* Scoring + grade bands (PRD §4).
 *
 * Pillar weights are fixed and sum to 100:
 *   A Retrievability 20 · B Structured 20 · C Answer-shaped 25
 *   D Agent-native 10 · E Live visibility 25
 */

export const PILLAR_MAX = {
  retrievability: 20,
  structured: 20,
  content: 25,
  agentnative: 10,
  visibility: 25,
};

export const TOTAL_MAX = Object.values(PILLAR_MAX).reduce((a, b) => a + b, 0);

/** A 85+ · B 70–84 · C 50–69 · D below 50. */
export function band(score, max = 100) {
  const pct = max === 0 ? 0 : (score / max) * 100;
  if (pct >= 85) return "A";
  if (pct >= 70) return "B";
  if (pct >= 50) return "C";
  return "D";
}

/** Sum a pillar's checks, clamped into [0, pillar.max]. */
export function scorePillar(pillar) {
  const raw = pillar.checks.reduce((sum, c) => sum + (Number(c.points) || 0), 0);
  const score = Math.max(0, Math.min(pillar.max, raw));
  return { id: pillar.id, label: pillar.label, score, max: pillar.max, band: band(score, pillar.max) };
}

/**
 * Combine pillars into the final report score.
 *
 * Pillars that didn't run (e.g. visibility when every engine failed) are
 * excluded from BOTH numerator and denominator, and named in `omitted`. The
 * alternative — scoring a missing pillar as zero — would report a site as
 * failing something we never actually measured.
 */
export function scoreReport(pillars) {
  const scored = pillars.filter(Boolean).map(scorePillar);
  const present = new Set(scored.map((p) => p.id));
  const omitted = Object.keys(PILLAR_MAX).filter((id) => !present.has(id));

  const score = scored.reduce((s, p) => s + p.score, 0);
  const max = scored.reduce((s, p) => s + p.max, 0);
  // Always present the headline as if out of 100 so two runs are comparable
  // even when a pillar dropped out.
  const normalized = max === 0 ? 0 : Math.round((score / max) * 100);

  return {
    score: normalized,
    raw: score,
    max,
    band: band(normalized),
    pillars: scored,
    omitted,
  };
}

/** Fix cards, most damaging first: points recoverable, then severity. */
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, ahead: 3 };

export function severityFor(check, pillarId) {
  // Everything in the agent-native pillar is framed as an opportunity, never a
  // failure — almost no site has these yet, and calling them failures would be
  // both discouraging and misleading (PRD §4, Pillar D).
  if (pillarId === "agentnative") return "ahead";

  if (check.id === "bots" && check.state !== "pass") return "critical";
  if (check.id === "render" && check.state === "fail") return "critical";

  const lost = check.max - check.points;
  return lost >= 4 ? "high" : "medium";
}

export function rankFixes(pillars) {
  const out = [];
  for (const p of pillars.filter(Boolean)) {
    for (const c of p.checks) {
      if (c.state === "pass" || !c.fix) continue;
      out.push({
        id: c.id,
        pillar: p.id,
        label: c.label,
        severity: severityFor(c, p.id),
        recoverable: c.max - c.points,
        evidence: c.evidence,
        fix: c.fix,
      });
    }
  }
  return out.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.recoverable - a.recoverable
  );
}
