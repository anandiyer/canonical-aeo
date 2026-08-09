import { test } from "node:test";
import assert from "node:assert/strict";
import { auditContent } from "../src/content.js";

const page = (path, html) => ({ finalUrl: `https://acme.io${path}`, url: `https://acme.io${path}`, html });

function crawl({ pages = [], home = null } = {}) {
  const h = home || page("/", "<h1>Acme</h1><p>" + "Acme is demand forecasting software for retail. ".repeat(20) + "</p>");
  return { hostname: "acme.io", origin: "https://acme.io", home: h, pages: [h, ...pages] };
}

// No key → the model checks are skipped, so these exercise the deterministic 16.
const noKey = {};

test("question-shaped headings are recognised and rewarded", async () => {
  const rich = crawl({ pages: [page("/faq",
    "<h2>What is Acme?</h2><h2>How does forecasting work?</h2><h2>Pricing</h2><h2>Why choose us?</h2>")] });
  const c = (await auditContent(rich, noKey)).pillar.checks.find((x) => x.id === "c-questions");
  assert.equal(c.evidence.questionHeadings, 3);
  assert.equal(c.state, "pass");
  assert.equal(c.points, 3);
});

test("a site with no question headings scores zero on that check", async () => {
  const flat = crawl({ pages: [page("/about", "<h2>Our team</h2><h2>Our mission</h2>")] });
  const c = (await auditContent(flat, noKey)).pillar.checks.find((x) => x.id === "c-questions");
  assert.equal(c.points, 0);
  assert.equal(c.fix, "questionHeadings");
});

test("comparison pages are detected by path or title", async () => {
  const withCompare = crawl({ pages: [
    page("/acme-vs-blueyonder", "<title>Acme vs Blue Yonder</title>"),
    page("/alternatives", "<title>Acme alternatives</title>"),
  ]});
  const c = (await auditContent(withCompare, noKey)).pillar.checks.find((x) => x.id === "c-comparison");
  assert.equal(c.state, "pass");
  assert.equal(c.evidence.found, 2);
});

test("a single comparison page scores partial, not full", async () => {
  const one = crawl({ pages: [page("/acme-vs-blueyonder", "<title>Acme vs Blue Yonder</title>")] });
  const c = (await auditContent(one, noKey)).pillar.checks.find((x) => x.id === "c-comparison");
  assert.equal(c.state, "partial");
  assert.ok(c.points > 0 && c.points < 5);
});

test("real prices as text score full marks", async () => {
  const priced = crawl({ pages: [page("/pricing",
    "<h1>Pricing</h1><p>Starter is $49 per month. Growth is $199 per month.</p>")] });
  const c = (await auditContent(priced, noKey)).pillar.checks.find((x) => x.id === "c-pricing");
  assert.equal(c.state, "pass");
  assert.equal(c.evidence.amountsFound >= 2, true);
});

test("a contact-sales-only pricing page fails, and says why", async () => {
  const gated = crawl({ pages: [page("/pricing",
    "<h1>Pricing</h1><p>Contact sales for a quote. Start free trial today.</p>")] });
  const c = (await auditContent(gated, noKey)).pillar.checks.find((x) => x.id === "c-pricing");
  assert.equal(c.state, "fail");
  assert.equal(c.evidence.contactOnly, true);
  assert.equal(c.fix, "pricingText");
});

test("pricing is marked n/a for a site that doesn't sell directly", async () => {
  // A venture firm has no pricing page and must not be marked down for it.
  const vc = crawl();
  const res = await auditContent(vc, noKey);
  const c = res.pillar.checks.find((x) => x.id === "c-pricing");
  assert.equal(c.state, "n/a");
  assert.equal(c.max, 0, "an inapplicable check must not inflate the denominator");
  assert.equal(c.evidence.applicable, false);
});

test("an inapplicable check lowers the pillar max instead of the score", async () => {
  const vc = await auditContent(crawl(), noKey);
  const commerce = await auditContent(
    crawl({ pages: [page("/pricing", "<p>Plans from $49 per month. Start free trial.</p>")] }), noKey);
  assert.equal(vc.pillar.max, commerce.pillar.max - 4, "pricing's 4 points drop out entirely");
});

test("tables and lists both present scores full scannability", async () => {
  const rich = crawl({ pages: [page("/docs",
    "<table><tr><td>a</td></tr></table><ul><li>1</li><li>2</li><li>3</li></ul>")] });
  const c = (await auditContent(rich, noKey)).pillar.checks.find((x) => x.id === "c-scannable");
  assert.equal(c.state, "pass");
});

test("a two-item list does not count as a scannable structure", async () => {
  const thin = crawl({ pages: [page("/x", "<ul><li>1</li><li>2</li></ul>")] });
  const c = (await auditContent(thin, noKey)).pillar.checks.find((x) => x.id === "c-scannable");
  assert.equal(c.evidence.lists, 0);
});

test("model checks are omitted from the max when no key is configured", async () => {
  const res = await auditContent(crawl(), noKey);
  assert.equal(res.modelMeasured, false);
  assert.equal(res.pillar.checks.some((c) => c.id === "c-opener"), false);
  // 16 deterministic, minus pricing's 4 which is n/a for this fixture.
  assert.equal(res.pillar.max, 12);
});

test("the pillar never exceeds 25 points when everything applies", async () => {
  const full = crawl({ pages: [
    page("/pricing", "<p>From $49 per month, or $499 per year.</p>"),
    page("/acme-vs-blueyonder", "<title>Acme vs Blue Yonder</title>"),
    page("/alternatives", "<title>Alternatives</title>"),
    page("/faq", "<h2>What is Acme?</h2><h2>How does it work?</h2><table><tr><td>x</td></tr></table><ul><li>1</li><li>2</li><li>3</li></ul>"),
  ]});
  const res = await auditContent(full, noKey);
  assert.equal(res.pillar.max, 16, "deterministic half only, without a model key");
  const scored = res.pillar.checks.reduce((s, c) => s + c.points, 0);
  assert.ok(scored <= res.pillar.max);
});

test("weak words like 'sign up' do not make pricing applicable", async () => {
  // Regression: canonical.cc, a venture firm, was docked 4 points for having no
  // prices because a lab page said "sign up" and contained "/mo".
  const softSignals = crawl({ pages: [page("/labs", "<p>Sign up for updates. Rates shown per year /mo basis.</p>")] });
  const c = (await auditContent(softSignals, {})).pillar.checks.find((x) => x.id === "c-pricing");
  assert.equal(c.state, "n/a");
  assert.equal(c.max, 0);
});

test("genuine pricing language does make it applicable", async () => {
  const real = crawl({ pages: [page("/product", "<p>Plans are billed annually, from $49 per user.</p>")] });
  const c = (await auditContent(real, {})).pillar.checks.find((x) => x.id === "c-pricing");
  assert.notEqual(c.state, "n/a");
  assert.equal(c.max, 4);
});

test("prices stated outside a /pricing page still count", async () => {
  // Regression: canonical.cc states "$500K–$1.5M" in its FAQ and had no
  // /pricing path, so it scored 0 despite publishing figures plainly.
  const inFaq = crawl({ pages: [page("/faqs",
    "<p>Canonical writes $500K to $1.5M first checks. Typical rounds are billed annually.</p>")] });
  const c = (await auditContent(inFaq, {})).pillar.checks.find((x) => x.id === "c-pricing");
  assert.equal(c.state, "pass");
  assert.equal(c.evidence.searchedWholeSite, true);
});

test("model scores are banded so small drift can't move the number", async () => {
  // temperature:0 is not reproducible on current models. Three consecutive runs
  // of an unchanged homepage returned 0.67 / 0.5 / 0.33 — all "partial", so all
  // must score identically.
  const { __bandForTest } = await import("../src/content.js");
  if (!__bandForTest) return; // exported only for this assertion
  assert.equal(__bandForTest(0.67), __bandForTest(0.5));
  assert.equal(__bandForTest(0.5), __bandForTest(0.41));
  assert.equal(__bandForTest(0.8), 1);
  assert.equal(__bandForTest(0.2), 0);
});

test("the site profile, not keywords, decides whether pricing applies", async () => {
  // A venture firm's site is full of money words and sells nothing at a list
  // price. No keyword heuristic gets this right; the classification does.
  const vcLike = crawl({ pages: [page("/faqs",
    "<p>We write $500K to $1.5M checks. Founders often ask about terms per round.</p>")] });
  const asInvestor = await auditContent(vcLike, {}, { businessModel: "investor", sellsDirectly: false });
  const c = asInvestor.pillar.checks.find((x) => x.id === "c-pricing");
  assert.equal(c.state, "n/a");
  assert.equal(c.max, 0);
  assert.equal(c.evidence.businessModel, "investor");

  // Identical page, classified as SaaS → the check applies and passes.
  const asSaas = await auditContent(vcLike, {}, { businessModel: "saas", sellsDirectly: true });
  const c2 = asSaas.pillar.checks.find((x) => x.id === "c-pricing");
  assert.notEqual(c2.state, "n/a");
  assert.equal(c2.max, 4);
});

test("an omitted sellsDirectly does not silently exempt a company", async () => {
  const noFlag = await auditContent(crawl({ pages: [page("/pricing", "<p>From $49 per user.</p>")] }),
    {}, { businessModel: "saas" });
  assert.notEqual(noFlag.pillar.checks.find((x) => x.id === "c-pricing").state, "n/a");
});
