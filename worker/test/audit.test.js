import { test } from "node:test";
import assert from "node:assert/strict";
import { runDeterministicAudit, auditRetrievability, auditAgentNative } from "../src/audit.js";
import { scoreReport, rankFixes, band } from "../src/score.js";

/** A site that does everything right. */
function goodCrawl() {
  const html = `<html><head>
    <title>Northwind Analytics — Demand Forecasting</title>
    <meta name="description" content="Northwind Analytics is demand forecasting software for mid-market retail and CPG supply chains.">
    <meta property="og:title" content="Northwind"><meta property="og:description" content="Forecasting">
    <meta property="og:image" content="https://northwind.io/og.png">
    <link rel="canonical" href="https://northwind.io/">
    <script type="application/ld+json">{"@type":"Organization","name":"Northwind"}</script>
    <script type="application/ld+json">{"@type":"Product","name":"Northwind"}</script>
    <script type="application/ld+json">{"@type":"FAQPage"}</script>
    <script type="application/ld+json">{"@type":"Article","author":"A","datePublished":"2026-01-01"}</script>
    </head><body><h1>Demand forecasting</h1><h2>How it works</h2>
    <img src="a.png" alt="Chart">
    <p>${"Northwind Analytics is demand forecasting software for retail. ".repeat(40)}</p>
    </body></html>`;
  return {
    origin: "https://northwind.io",
    home: { url: "https://northwind.io/", status: 200, html },
    pages: [{ url: "https://northwind.io/", status: 200, html }],
    robotsTxt: "User-agent: *\nAllow: /\nContent-Signal: search=yes",
    sitemap: { found: true, urlCount: 40 },
    wellKnown: { llmsTxt: "# Northwind", llmsFullTxt: null, markdownTwin: true, mcp: true, agentCard: true },
  };
}

/** The failure case the tool exists to catch. */
function badCrawl() {
  const html = `<html><head><title>App</title></head>
    <body><div id="root"></div><script src="/assets/index-4f2a1b.js"></script></body></html>`;
  return {
    origin: "https://bad.io",
    home: { url: "https://bad.io/", status: 200, html },
    pages: [{ url: "https://bad.io/", status: 200, html }],
    robotsTxt: "User-agent: *\nDisallow: /",
    sitemap: { found: false },
    wellKnown: {},
  };
}

test("a well-configured site scores full marks on every deterministic pillar", () => {
  const pillars = runDeterministicAudit(goodCrawl());
  for (const p of pillars) {
    const got = p.checks.reduce((s, c) => s + c.points, 0);
    assert.equal(got, p.max, `${p.id} should be ${p.max}, got ${got}`);
  }
});

test("a JS shell behind a blanket Disallow fails every check it can fail", () => {
  const pillars = runDeterministicAudit(badCrawl());
  const byId = Object.fromEntries(pillars.flatMap((p) => p.checks.map((c) => [c.id, c])));

  // The checks that describe a genuine defect must all be zero.
  for (const id of ["bots", "render", "sitemap", "schema-org", "schema-product",
                    "schema-faq", "meta", "headings", "llms-txt", "content-signals"]) {
    assert.equal(byId[id].points, 0, `${id} should score 0 on a broken site`);
  }

  // …but checks with nothing to fix still pass, and that is correct: this page
  // has no images and no paywall, so it cannot be marked down for either.
  // The residual score is small and explainable rather than arbitrarily zero.
  assert.equal(byId.alt.state, "pass", "no images means no missing alt text");
  assert.equal(byId.walls.state, "pass", "no wall present");

  const total = pillars.reduce((s, p) => s + p.checks.reduce((a, c) => a + c.points, 0), 0);
  assert.ok(total <= 6, `expected a near-zero score, got ${total}`);
});

test("blocking training crawlers alone costs nothing", () => {
  const crawl = goodCrawl();
  crawl.robotsTxt = ["User-agent: GPTBot", "Disallow: /", "", "User-agent: CCBot", "Disallow: /",
                     "", "User-agent: *", "Allow: /"].join("\n");
  const bots = auditRetrievability(crawl).checks.find((c) => c.id === "bots");
  assert.equal(bots.state, "pass");
  assert.equal(bots.points, bots.max, "a deliberate training block must not be penalised");
  assert.equal(bots.evidence.trainingBlockedIsFine, true);
});

test("blocking one answer crawler is partial, not total, failure", () => {
  const crawl = goodCrawl();
  crawl.robotsTxt = "User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /";
  const bots = auditRetrievability(crawl).checks.find((c) => c.id === "bots");
  assert.equal(bots.state, "partial");
  assert.ok(bots.points > 0 && bots.points < bots.max, `graded partial, got ${bots.points}/${bots.max}`);
  assert.deepEqual(bots.evidence.blockedAnswer.map((b) => b.ua), ["PerplexityBot"]);
});

test("agent-native failures are flagged 'ahead of the curve', never critical", () => {
  const pillars = [auditAgentNative({ robotsTxt: "", wellKnown: {} })];
  const fixes = rankFixes(pillars);
  assert.ok(fixes.length > 0);
  assert.ok(fixes.every((f) => f.severity === "ahead"), "these must not read as failures");
});

test("fixes are ranked with critical first, then by points recoverable", () => {
  const fixes = rankFixes(runDeterministicAudit(badCrawl()));
  assert.equal(fixes[0].id, "bots", "the blocked-crawler fix is the most damaging");
  assert.equal(fixes[0].severity, "critical");
  const ranks = { critical: 0, high: 1, medium: 2, ahead: 3 };
  for (let i = 1; i < fixes.length; i++) {
    assert.ok(ranks[fixes[i - 1].severity] <= ranks[fixes[i].severity], "severity must not regress");
  }
});

test("passing checks never produce a fix card", () => {
  const fixes = rankFixes(runDeterministicAudit(goodCrawl()));
  assert.equal(fixes.length, 0);
});

test("scoreReport normalizes to 100 and omits pillars that did not run", () => {
  const r = scoreReport(runDeterministicAudit(goodCrawl()));
  assert.equal(r.score, 100, "all deterministic pillars perfect → 100");
  assert.equal(r.max, 50, "only A+B+D ran");
  assert.deepEqual(r.omitted.sort(), ["content", "visibility"]);
  assert.equal(r.band, "A");
});

test("a missing pillar is excluded from the denominator, not scored as zero", () => {
  const pillars = runDeterministicAudit(goodCrawl());
  const withVisibility = [...pillars, { id: "visibility", label: "Live AI visibility", max: 25,
    checks: [{ id: "v", label: "v", state: "partial", points: 12, max: 25, evidence: {} }] }];
  const r = scoreReport(withVisibility);
  assert.equal(r.raw, 62);
  assert.equal(r.max, 75);
  assert.equal(r.score, 83, "62/75 normalized to 100");
  assert.deepEqual(r.omitted, ["content"]);
});

test("grade bands land on the documented boundaries", () => {
  assert.equal(band(85), "A");
  assert.equal(band(84), "B");
  assert.equal(band(70), "B");
  assert.equal(band(69), "C");
  assert.equal(band(50), "C");
  assert.equal(band(49), "D");
});
