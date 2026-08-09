import { test } from "node:test";
import assert from "node:assert/strict";
import {
  visibleText, extractJsonLd, hasType, extractMeta, extractHeadings,
  extractImages, extractLinks, detectJsShell, detectWall,
} from "../src/html.js";

test("visibleText drops script and style bodies", () => {
  const html = "<p>Hello</p><script>var x = 'INVISIBLE';</script><style>.a{color:red}</style><p>World</p>";
  const t = visibleText(html);
  assert.equal(t.includes("INVISIBLE"), false);
  assert.equal(t.includes("color:red"), false);
  assert.equal(t, "Hello World");
});

test("extractJsonLd flattens @graph and tolerates malformed blocks", () => {
  const html = `
    <script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"A"},{"@type":"WebSite"}]}</script>
    <script type="application/ld+json">{ this is not json }</script>
    <script type="application/ld+json">{"@type":"FAQPage"}</script>`;
  const nodes = extractJsonLd(html);
  assert.equal(nodes.length, 3, "malformed block skipped, others kept");
  assert.equal(hasType(nodes, "Organization"), true);
  assert.equal(hasType(nodes, "FAQPage"), true);
});

test("hasType matches array-valued @type case-insensitively", () => {
  const nodes = [{ "@type": ["WebPage", "product"] }];
  assert.equal(hasType(nodes, "Product"), true);
  assert.equal(hasType(nodes, "Organization"), false);
});

test("extractMeta reads title, description, og and canonical", () => {
  const html = `<head><title>  Acme  Analytics </title>
    <meta name="description" content="We forecast demand.">
    <meta property="og:title" content="Acme">
    <link rel="canonical" href="https://acme.io/">
    <link rel="alternate" type="text/markdown" href="/index.md"></head>`;
  const m = extractMeta(html);
  assert.equal(m.title, "Acme Analytics");
  assert.equal(m.description, "We forecast demand.");
  assert.equal(m.og.title, "Acme");
  assert.equal(m.canonical, "https://acme.io/");
  assert.equal(m.markdownAlternate, "/index.md");
});

test("extractHeadings collects visible heading text", () => {
  const h = extractHeadings("<h1>Main <span>Title</span></h1><h2>One</h2><h2>Two</h2>");
  assert.deepEqual(h.h1, ["Main Title"]);
  assert.equal(h.h2.length, 2);
});

test("extractImages separates decorative alt='' from genuinely missing alt", () => {
  const i = extractImages(`<img src="a.png" alt="A chart"><img src="b.png" alt=""><img src="c.png">`);
  assert.equal(i.total, 3);
  assert.equal(i.withAlt, 1);
  assert.equal(i.decorative, 1);
  assert.equal(i.missing, 1);
});

test("extractLinks keeps same-origin links only and strips fragments", () => {
  const html = `<a href="/pricing">P</a><a href="https://other.com/x">O</a>
                <a href="#top">T</a><a href="mailto:a@b.c">M</a><a href="/pricing#faq">P2</a>`;
  const links = extractLinks(html, "https://acme.io/");
  assert.deepEqual(links, ["https://acme.io/pricing"]);
});

test("detectJsShell flags an empty mount with a bundle", () => {
  const shell = `<html><body><div id="root"></div><script src="/assets/index-4f2a1b.js"></script></body></html>`;
  const r = detectJsShell(shell);
  assert.equal(r.isShell, true);
  assert.equal(r.emptyMount, true);
});

test("detectJsShell does NOT flag a content-rich page that also ships JS", () => {
  const body = "<p>" + "Northwind forecasts demand for retail supply chains. ".repeat(60) + "</p>";
  const r = detectJsShell(`<html><body>${body}<script src="/app.js"></script></body></html>`);
  assert.equal(r.isShell, false, "false positives here are worse than misses");
  assert.equal(r.isThin, false);
});

test("detectWall spots a subscriber paywall but ignores a normal cookie banner", () => {
  const paywalled = "<p>Subscribe to continue reading this article.</p>";
  assert.equal(detectWall(paywalled).paywall, true);

  const normal = "<p>We use cookies. " + "Real content about forecasting. ".repeat(60) + "</p>";
  assert.equal(detectWall(normal).hit, false, "a banner over real content is not a wall");
});
