import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, isAllowed, classifyCrawlers, hasContentSignals } from "../src/robots.js";

test("empty or missing robots.txt allows everything", () => {
  assert.equal(isAllowed("", "OAI-SearchBot"), true);
  assert.equal(isAllowed(null, "GPTBot"), true);
});

test("wildcard disallow blocks an unnamed agent", () => {
  const r = "User-agent: *\nDisallow: /";
  assert.equal(isAllowed(r, "OAI-SearchBot"), false);
});

test("a named group overrides the wildcard group", () => {
  const r = ["User-agent: *", "Disallow: /", "", "User-agent: OAI-SearchBot", "Allow: /"].join("\n");
  assert.equal(isAllowed(r, "OAI-SearchBot"), true, "named allow should win");
  assert.equal(isAllowed(r, "PerplexityBot"), false, "unnamed still falls to wildcard");
});

test("agent matching is case-insensitive", () => {
  const r = "User-agent: gptbot\nDisallow: /";
  assert.equal(isAllowed(r, "GPTBot"), false);
});

test("stacked user-agent lines share one rule block", () => {
  const r = "User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /";
  assert.equal(isAllowed(r, "GPTBot"), false);
  assert.equal(isAllowed(r, "CCBot"), false);
});

test("a rule line ends the agent list, so a later UA starts a new group", () => {
  const r = ["User-agent: GPTBot", "Disallow: /", "User-agent: OAI-SearchBot", "Allow: /"].join("\n");
  assert.equal(isAllowed(r, "GPTBot"), false);
  assert.equal(isAllowed(r, "OAI-SearchBot"), true);
});

test("empty Disallow means allow everything", () => {
  const r = "User-agent: *\nDisallow:";
  assert.equal(isAllowed(r, "PerplexityBot"), true);
});

test("longest matching path wins, Allow breaking ties", () => {
  const r = "User-agent: *\nDisallow: /\nAllow: /blog/";
  assert.equal(isAllowed(r, "X", "/blog/post"), true);
  assert.equal(isAllowed(r, "X", "/pricing"), false);
});

test("comments are stripped", () => {
  const r = "# blocking training\nUser-agent: GPTBot # openai\nDisallow: / # everything";
  assert.equal(isAllowed(r, "GPTBot"), false);
});

test("the headline case: training blocked, answer crawlers accidentally blocked too", () => {
  const r = "User-agent: *\nDisallow: /";
  const c = classifyCrawlers(r);
  assert.equal(c.answer.every((x) => !x.allowed), true, "all answer crawlers blocked");
  assert.equal(c.training.every((x) => !x.allowed), true, "all training crawlers blocked");
});

test("the good case: training blocked deliberately, answer crawlers allowed", () => {
  const r = [
    "User-agent: GPTBot", "Disallow: /",
    "", "User-agent: ClaudeBot", "Disallow: /",
    "", "User-agent: *", "Allow: /",
  ].join("\n");
  const c = classifyCrawlers(r);
  assert.equal(c.answer.every((x) => x.allowed), true, "answer crawlers must stay allowed");
  assert.equal(c.training.find((x) => x.ua === "GPTBot").allowed, false);
  assert.equal(c.training.find((x) => x.ua === "ClaudeBot").allowed, false);
});

test("Content Signals are detected", () => {
  assert.equal(hasContentSignals("Content-Signal: ai-train=no, search=yes"), true);
  assert.equal(hasContentSignals("User-agent: *\nDisallow:"), false);
});

test("parseRobots ignores non-group directives without corrupting groups", () => {
  const r = "Sitemap: https://x.com/sitemap.xml\nUser-agent: *\nDisallow: /admin";
  const g = parseRobots(r);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].agents, ["*"]);
  assert.equal(g[0].rules.length, 1);
});
