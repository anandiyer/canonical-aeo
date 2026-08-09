import { test } from "node:test";
import assert from "node:assert/strict";
import { robotsFix, llmsTxtFix, orgSchemaFix, sitemapFix, attachArtifacts } from "../src/fixes.js";
import { runDeterministicAudit } from "../src/audit.js";
import { rankFixes } from "../src/score.js";
import { extractSocialLinks } from "../src/html.js";

function crawlFixture({ robots = null, ogImage = true, desc = true, social = true } = {}) {
  const html = `<html><head>
    <title>Northwind Analytics | Demand Forecasting</title>
    ${desc ? '<meta name="description" content="Demand forecasting for retail supply chains.">' : ""}
    <meta property="og:site_name" content="Northwind Analytics">
    ${ogImage ? '<meta property="og:image" content="https://northwind.io/logo.png">' : ""}
    </head><body>
    ${social ? `<a href="https://www.linkedin.com/company/northwind-analytics">in</a>
      <a href="https://x.com/northwindio">x</a>
      <a href="https://twitter.com/intent/tweet?url=x">share</a>` : ""}
    </body></html>`;
  return {
    origin: "https://northwind.io",
    hostname: "northwind.io",
    home: { url: "https://northwind.io/", finalUrl: "https://northwind.io/", status: 200, html },
    pages: [
      { finalUrl: "https://northwind.io/", html },
      { finalUrl: "https://northwind.io/pricing", html: '<title>Pricing | Northwind</title><meta name="description" content="Plans and pricing.">' },
      { finalUrl: "https://northwind.io/docs/api", html: "<title>Forecast API | Northwind</title>" },
    ],
    robotsTxt: robots,
    sitemap: { found: false },
    wellKnown: {},
  };
}

test("robotsFix preserves training blocks while unblocking answer crawlers", () => {
  const a = robotsFix(crawlFixture({ robots: "User-agent: *\nDisallow: /" }), {
    blockedAnswer: [{ ua: "OAI-SearchBot", engine: "ChatGPT" }, { ua: "PerplexityBot", engine: "Perplexity" }],
    blockedTraining: ["GPTBot"],
  });
  assert.ok(a.added.includes("User-agent: OAI-SearchBot\nAllow: /"));
  assert.ok(a.added.includes("User-agent: PerplexityBot\nAllow: /"));
  assert.ok(a.added.includes("User-agent: GPTBot\nDisallow: /"), "training block must survive");
  assert.match(a.note, /deliberate choice/i);
});

test("robotsFix returns null when nothing is blocked", () => {
  assert.equal(robotsFix(crawlFixture(), { blockedAnswer: [], blockedTraining: [] }), null);
});

test("llmsTxt is grouped, sourced from crawled pages, and stable across runs", () => {
  const crawl = crawlFixture();
  const a = llmsTxtFix(crawl);
  assert.ok(a.content.startsWith("# Northwind Analytics"));
  assert.ok(a.content.includes("> Demand forecasting for retail supply chains."));
  assert.ok(a.content.includes("## Pricing"), "pricing page routed to its section");
  assert.ok(a.content.includes("## Docs"), "docs page routed to its section");
  assert.ok(a.content.includes("https://northwind.io/docs/api"));
  assert.equal(a.placeholders.length, 0);
  assert.equal(llmsTxtFix(crawl).content, a.content, "identical input must give identical output");
});

test("llmsTxt emits a placeholder rather than inventing a summary", () => {
  const a = llmsTxtFix(crawlFixture({ desc: false }));
  assert.ok(a.content.includes("{{ONE_LINE_SUMMARY}}"));
  assert.equal(a.placeholders[0].token, "{{ONE_LINE_SUMMARY}}");
  assert.ok(a.placeholders[0].why.length > 10, "a placeholder must explain itself");
});

test("orgSchema uses only real sameAs links and skips share URLs", () => {
  const a = orgSchemaFix(crawlFixture());
  const node = JSON.parse(a.content.replace(/<\/?script[^>]*>/g, ""));
  assert.equal(node["@type"], "Organization");
  assert.equal(node.name, "Northwind Analytics");
  assert.deepEqual(node.sameAs, [
    "https://www.linkedin.com/company/northwind-analytics",
    "https://x.com/northwindio",
  ]);
  assert.equal(a.placeholders.length, 0);
});

test("orgSchema placeholders the logo instead of guessing one", () => {
  const a = orgSchemaFix(crawlFixture({ ogImage: false }));
  const node = JSON.parse(a.content.replace(/<\/?script[^>]*>/g, ""));
  assert.equal(node.logo, "{{LOGO_URL}}");
  assert.ok(a.placeholders.some((p) => p.token === "{{LOGO_URL}}"));
});

test("orgSchema omits sameAs entirely when no socials exist", () => {
  const a = orgSchemaFix(crawlFixture({ social: false }));
  const node = JSON.parse(a.content.replace(/<\/?script[^>]*>/g, ""));
  assert.equal("sameAs" in node, false, "absent, not an empty array or a guess");
  assert.match(a.note, /omitted rather than guessed/i);
});

test("extractSocialLinks ignores share/intent URLs", () => {
  const links = extractSocialLinks(
    `<a href="https://twitter.com/intent/tweet?url=x">s</a><a href="https://x.com/realco">r</a>`
  );
  assert.deepEqual(links, ["https://x.com/realco"]);
});

test("generated sitemap only contains pages we actually crawled", () => {
  const a = sitemapFix(crawlFixture());
  assert.ok(a.content.includes("<loc>https://northwind.io/pricing</loc>"));
  assert.ok(a.content.includes("<loc>https://northwind.io/docs/api</loc>"));
  assert.equal((a.content.match(/<loc>/g) || []).length, 3);
});

test("attachArtifacts builds real artifacts and marks model-dependent ones pending", () => {
  const crawl = crawlFixture({ robots: "User-agent: *\nDisallow: /" });
  const withArtifacts = attachArtifacts(rankFixes(runDeterministicAudit(crawl)), crawl);

  const byId = Object.fromEntries(withArtifacts.map((f) => [f.id, f]));
  assert.ok(byId["bots"].artifact, "robots diff should be generated");
  assert.ok(byId["llms-txt"].artifact, "llms.txt should be generated");
  assert.ok(byId["schema-org"].artifact, "Organization JSON-LD should be generated");

  // These need a model and must say so rather than rendering an empty card.
  assert.equal(byId["schema-product"].artifact, null);
  assert.equal(byId["schema-product"].pending, true);
  assert.ok(byId["schema-product"].willProduce.length > 0);
});

test("a throwing generator degrades that one fix, not the whole report", () => {
  const crawl = crawlFixture({ robots: "User-agent: *\nDisallow: /" });
  crawl.origin = null; // force a URL construction failure inside a generator
  const out = attachArtifacts(rankFixes(runDeterministicAudit(crawl)), crawl);
  assert.equal(out.length > 0, true, "report still produced");
  assert.ok(out.every((f) => "artifact" in f));
});
