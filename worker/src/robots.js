/* robots.txt parsing + AI-crawler classification.
 *
 * The differentiator for this lab (PRD §2, gap 3): almost every site that
 * blocks AI crawlers blocks *training* and *answer* crawlers together, without
 * realising they're different things. Blocking GPTBot is a legitimate IP
 * decision. Blocking OAI-SearchBot silently removes you from ChatGPT's
 * citations. We grade those two cases very differently.
 */

/** Crawlers that fetch pages in order to CITE them in an answer.
 *  Blocking these costs you visibility. */
export const ANSWER_CRAWLERS = [
  { ua: "OAI-SearchBot", engine: "ChatGPT", vendor: "OpenAI" },
  { ua: "Claude-SearchBot", engine: "Claude", vendor: "Anthropic" },
  { ua: "Claude-User", engine: "Claude", vendor: "Anthropic" },
  { ua: "PerplexityBot", engine: "Perplexity", vendor: "Perplexity" },
  { ua: "Google-Extended", engine: "Gemini / AI Overviews", vendor: "Google" },
  { ua: "Applebot-Extended", engine: "Apple Intelligence", vendor: "Apple" },
  { ua: "meta-externalagent", engine: "Meta AI", vendor: "Meta" },
];

/** Crawlers that collect data for MODEL TRAINING.
 *  Blocking these is a defensible choice and is NOT penalised. */
export const TRAINING_CRAWLERS = [
  { ua: "GPTBot", vendor: "OpenAI" },
  { ua: "ClaudeBot", vendor: "Anthropic" },
  { ua: "CCBot", vendor: "Common Crawl" },
  { ua: "Google-CloudVertexBot", vendor: "Google" },
  { ua: "Bytespider", vendor: "ByteDance" },
];

/**
 * Parse robots.txt into user-agent groups.
 * A group is one or more consecutive `User-agent:` lines followed by rules;
 * a rule line ends the "agent list" phase for that group.
 */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let expectingAgents = false;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      // A new user-agent line after rules starts a fresh group.
      if (!current || !expectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        expectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "allow" || field === "disallow") {
      if (!current) continue; // rule before any user-agent — ignore
      expectingAgents = false;
      current.rules.push({ type: field, path: value });
    } else {
      // sitemap:, crawl-delay:, content-signal: etc. — not group rules
      expectingAgents = false;
    }
  }
  return groups;
}

/** Find the group that applies to `ua`: exact (case-insensitive) match wins,
 *  otherwise the wildcard group, otherwise none. */
function groupFor(groups, ua) {
  const needle = ua.toLowerCase();
  let wildcard = null;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a === needle) return g;
      if (a === "*" && !wildcard) wildcard = g;
    }
  }
  return wildcard;
}

/**
 * Standard robots.txt semantics: the longest matching path rule wins; on a
 * tie, Allow beats Disallow. An empty Disallow value means "allow everything".
 */
export function isAllowed(robotsText, ua, path = "/") {
  const groups = parseRobots(robotsText);
  const group = groupFor(groups, ua);
  if (!group) return true; // no applicable group → allowed

  let best = null;
  for (const rule of group.rules) {
    // `Disallow:` with an empty value is an explicit full allow.
    if (rule.type === "disallow" && rule.path === "") {
      if (!best || best.len < 0) best = { type: "allow", len: 0 };
      continue;
    }
    if (!rule.path) continue;
    if (!matchesPath(rule.path, path)) continue;
    const len = rule.path.replace(/\*/g, "").length;
    if (!best || len > best.len || (len === best.len && rule.type === "allow")) {
      best = { type: rule.type, len };
    }
  }
  if (!best) return true;
  return best.type === "allow";
}

/** Supports the `*` wildcard and the `$` end-anchor. */
function matchesPath(pattern, path) {
  if (!pattern.includes("*") && !pattern.endsWith("$")) {
    return path.startsWith(pattern);
  }
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const rx = new RegExp(
    "^" +
      body
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      (anchored ? "$" : "")
  );
  return rx.test(path);
}

/** True if robots.txt carries Cloudflare-style Content Signals. */
export function hasContentSignals(robotsText) {
  return /^\s*content-signal\s*:/im.test(String(robotsText || ""));
}

/**
 * Classify every AI crawler we care about.
 * Returns { answer: [...], training: [...] } with an `allowed` flag each.
 */
export function classifyCrawlers(robotsText) {
  const check = (list) =>
    list.map((c) => ({ ...c, allowed: isAllowed(robotsText, c.ua, "/") }));
  return {
    answer: check(ANSWER_CRAWLERS),
    training: check(TRAINING_CRAWLERS),
  };
}
