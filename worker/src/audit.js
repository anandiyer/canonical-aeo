/* Deterministic AEO audit — Pillars A, B and D (50 of the 100 points).
 *
 * No model is involved anywhere in this file. That is the point: a site that
 * hasn't changed must score identically on a re-run, or the whole tool loses
 * credibility on the user's second visit (PRD §12).
 *
 * Every check returns the same shape so the UI can render them uniformly:
 *   { id, label, state: "pass"|"partial"|"fail", points, max, evidence, fix }
 * `fix` names the artifact generator that can repair it (null = nothing to emit).
 */

import { classifyCrawlers, hasContentSignals } from "./robots.js";
import {
  extractJsonLd, hasType, findType, extractMeta, extractHeadings,
  extractImages, detectJsShell, detectWall,
} from "./html.js";

const check = (id, label, state, points, max, evidence, fix = null) => ({
  id, label, state, points, max, evidence, fix,
});

/* ── Pillar A — Retrievability & agent access (20) ──────────────────────── */

export function auditRetrievability(crawl) {
  const checks = [];
  const { robotsTxt, home, pages, sitemap } = crawl;

  // ── AI crawler allowlist (8) — the headline check.
  const crawlers = classifyCrawlers(robotsTxt);
  const blockedAnswer = crawlers.answer.filter((c) => !c.allowed);
  const blockedTraining = crawlers.training.filter((c) => !c.allowed);
  {
    const max = 8;
    // Scale by how many answer crawlers are blocked, not all-or-nothing —
    // blocking one engine is genuinely less bad than blocking all of them.
    const ratio = blockedAnswer.length / crawlers.answer.length;
    const points = Math.round(max * (1 - ratio));
    checks.push(
      check(
        "bots",
        "AI answer crawlers can reach the site",
        blockedAnswer.length === 0 ? "pass" : points > 0 ? "partial" : "fail",
        points,
        max,
        {
          blockedAnswer: blockedAnswer.map((c) => ({ ua: c.ua, engine: c.engine })),
          blockedTraining: blockedTraining.map((c) => c.ua),
          // Surfaced so the report can say "you blocked training too, which is
          // fine and deliberate" rather than lumping them together.
          trainingBlockedIsFine: blockedTraining.length > 0,
          hasRobotsTxt: robotsTxt != null,
        },
        blockedAnswer.length ? "robots" : null
      )
    );
  }

  // ── Renders without JavaScript (6)
  {
    const max = 6;
    const shell = detectJsShell(home?.html || "");
    const state = shell.isShell ? "fail" : shell.isThin ? "partial" : "pass";
    checks.push(
      check("render", "Content is present without JavaScript", state,
        state === "pass" ? max : state === "partial" ? 3 : 0, max, shell, null)
    );
  }

  // ── Sitemap (2)
  {
    const max = 2;
    const ok = !!sitemap?.found;
    checks.push(
      check("sitemap", "XML sitemap is published", ok ? "pass" : "fail",
        ok ? max : 0, max, sitemap || { found: false }, ok ? null : "sitemap")
    );
  }

  // ── Clean HTTP (2)
  {
    const max = 2;
    const bad = pages.filter((p) => p.status >= 400).length;
    const canonical = !!extractMeta(home?.html || "").canonical;
    let points = max;
    if (bad > 0) points -= 1;
    if (!canonical) points -= 1;
    points = Math.max(0, points);
    checks.push(
      check("http", "Clean status codes and a canonical URL",
        points === max ? "pass" : points > 0 ? "partial" : "fail", points, max,
        { erroringPages: bad, hasCanonical: canonical }, null)
    );
  }

  // ── No walls over the primary content (2)
  {
    const max = 2;
    const wall = detectWall(home?.html || "");
    checks.push(
      check("walls", "No paywall or cookie wall over the main content",
        wall.hit ? "fail" : "pass", wall.hit ? 0 : max, max, wall, null)
    );
  }

  return { id: "retrievability", label: "Retrievability & agent access", max: 20, checks };
}

/* ── Pillar B — Structured meaning (20) ─────────────────────────────────── */

export function auditStructured(crawl) {
  const checks = [];
  const home = crawl.home?.html || "";
  const allNodes = crawl.pages.flatMap((p) => extractJsonLd(p.html || ""));
  const homeNodes = extractJsonLd(home);

  const schemaCheck = (id, label, type, max, fix) => {
    const present = hasType(allNodes, type);
    checks.push(
      check(id, label, present ? "pass" : "fail", present ? max : 0, max,
        { type, present, node: present ? findType(allNodes, type) : null }, present ? null : fix)
    );
  };

  schemaCheck("schema-org", "Organization schema identifies the company", "Organization", 5, "orgSchema");
  // Any one of these three counts — they're alternatives, not a checklist.
  {
    const max = 3;
    const t = ["Product", "Service", "SoftwareApplication"].find((x) => hasType(allNodes, x));
    checks.push(
      check("schema-product", "Product or Service schema describes what you sell",
        t ? "pass" : "fail", t ? max : 0, max, { matched: t || null }, t ? null : "productSchema")
    );
  }
  schemaCheck("schema-faq", "FAQ schema exposes your answers", "FAQPage", 3, "faqSchema");

  // ── Article dates / authorship (2)
  {
    const max = 2;
    const art = findType(allNodes, "Article") || findType(allNodes, "BlogPosting");
    const dated = !!(art && (art.datePublished || art.dateModified));
    const authored = !!(art && art.author);
    const points = (dated ? 1 : 0) + (authored ? 1 : 0);
    checks.push(
      check("schema-article", "Articles carry author and dates",
        points === max ? "pass" : points ? "partial" : "fail", points, max,
        { hasArticle: !!art, dated, authored }, null)
    );
  }

  // ── Title + meta description (3)
  {
    const max = 3;
    const meta = extractMeta(home);
    let points = 0;
    const titleOk = meta.title && meta.title.length >= 15 && meta.title.length <= 70;
    const descOk = meta.description && meta.description.length >= 50 && meta.description.length <= 200;
    const ogOk = !!(meta.og.title && meta.og.description && meta.og.image);
    if (titleOk) points++;
    if (descOk) points++;
    if (ogOk) points++;
    checks.push(
      check("meta", "Title, description and Open Graph are complete",
        points === max ? "pass" : points ? "partial" : "fail", points, max,
        { title: meta.title, titleOk, description: meta.description, descOk, ogOk }, points < max ? "meta" : null)
    );
  }

  // ── Heading hierarchy (2)
  {
    const max = 2;
    const h = extractHeadings(home);
    const oneH1 = h.h1.length === 1;
    const hasH2 = h.h2.length > 0;
    const points = (oneH1 ? 1 : 0) + (hasH2 ? 1 : 0);
    checks.push(
      check("headings", "Sane heading hierarchy",
        points === max ? "pass" : points ? "partial" : "fail", points, max,
        { h1Count: h.h1.length, h2Count: h.h2.length, h1: h.h1 }, null)
    );
  }

  // ── Alt text (2)
  {
    const max = 2;
    const img = extractImages(home);
    const denom = img.withAlt + img.missing;
    const cov = denom === 0 ? 1 : img.withAlt / denom;
    const points = cov >= 0.9 ? 2 : cov >= 0.5 ? 1 : 0;
    checks.push(
      check("alt", "Images carry alt text",
        points === max ? "pass" : points ? "partial" : "fail", points, max,
        { ...img, coverage: Math.round(cov * 100) }, null)
    );
  }

  return { id: "structured", label: "Structured meaning", max: 20, checks, _homeNodes: homeNodes };
}

/* ── Pillar D — Agent-native readiness (10) ─────────────────────────────── */

export function auditAgentNative(crawl) {
  const checks = [];
  const wk = crawl.wellKnown || {};

  const flag = (id, label, ok, max, evidence, fix) =>
    checks.push(check(id, label, ok ? "pass" : "fail", ok ? max : 0, max, evidence, ok ? null : fix));

  flag("llms-txt", "llms.txt describes the site to agents", !!wk.llmsTxt, 4,
    { found: !!wk.llmsTxt, full: !!wk.llmsFullTxt }, "llmsTxt");
  flag("markdown", "A machine-readable Markdown copy is available", !!wk.markdownTwin, 2,
    { found: !!wk.markdownTwin, via: wk.markdownVia || null }, "markdown");
  flag("content-signals", "Content Signals state usage permissions",
    hasContentSignals(crawl.robotsTxt), 2, { found: hasContentSignals(crawl.robotsTxt) }, "contentSignals");
  flag("mcp", "An MCP endpoint is discoverable", !!wk.mcp, 1, { found: !!wk.mcp }, "mcp");
  flag("agent-card", "An A2A agent card is published", !!wk.agentCard, 1, { found: !!wk.agentCard }, null);

  return { id: "agentnative", label: "Agent-native readiness", max: 10, checks };
}

/** Run every deterministic pillar. */
export function runDeterministicAudit(crawl) {
  return [auditRetrievability(crawl), auditStructured(crawl), auditAgentNative(crawl)];
}
