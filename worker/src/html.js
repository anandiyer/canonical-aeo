/* Lightweight HTML extraction.
 *
 * Deliberately regex/string based rather than DOM based: Workers have no
 * DOMParser, and HTMLRewriter is streaming-only and unavailable in plain node
 * — so a string implementation is the only one we can unit-test off-platform.
 * Everything here is tolerant of malformed markup and never throws.
 */

const stripComments = (html) => String(html || "").replace(/<!--[\s\S]*?-->/g, "");

/** Remove script/style/noscript/svg bodies, then all tags. */
export function visibleText(html) {
  return stripComments(html)
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** All JSON-LD blocks, parsed. `@graph` containers are flattened. */
export function extractJsonLd(html) {
  const out = [];
  const rx = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(stripComments(html)))) {
    let parsed;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue; // malformed JSON-LD is common; treat as absent rather than fatal
    }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      if (node && typeof node === "object" && Array.isArray(node["@graph"])) out.push(...node["@graph"]);
      else if (node) out.push(node);
    }
  }
  return out;
}

/** Case-insensitive @type test; @type may be a string or an array. */
export function hasType(nodes, type) {
  const want = String(type).toLowerCase();
  return nodes.some((n) => {
    const t = n && n["@type"];
    if (!t) return false;
    return (Array.isArray(t) ? t : [t]).some((x) => String(x).toLowerCase() === want);
  });
}

export function findType(nodes, type) {
  const want = String(type).toLowerCase();
  return nodes.find((n) => {
    const t = n && n["@type"];
    if (!t) return false;
    return (Array.isArray(t) ? t : [t]).some((x) => String(x).toLowerCase() === want);
  });
}

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : null;
}

/** title, meta description, canonical, and the og:/twitter: families. */
export function extractMeta(html) {
  const src = stripComments(html);
  const titleM = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const meta = { title: titleM ? titleM[1].replace(/\s+/g, " ").trim() : null, og: {}, twitter: {} };

  for (const tag of src.match(/<meta\b[^>]*>/gi) || []) {
    const name = (attr(tag, "name") || attr(tag, "property") || "").toLowerCase();
    const content = attr(tag, "content");
    if (!name || content == null) continue;
    if (name === "description") meta.description = content;
    else if (name.startsWith("og:")) meta.og[name.slice(3)] = content;
    else if (name.startsWith("twitter:")) meta.twitter[name.slice(8)] = content;
  }

  for (const tag of src.match(/<link\b[^>]*>/gi) || []) {
    const rel = (attr(tag, "rel") || "").toLowerCase();
    if (rel === "canonical") meta.canonical = attr(tag, "href");
    // A machine-readable Markdown twin, e.g.
    //   <link rel="alternate" type="text/markdown" href="/index.md">
    if (rel === "alternate" && /markdown/i.test(attr(tag, "type") || "")) {
      meta.markdownAlternate = attr(tag, "href");
    }
  }
  return meta;
}

/** { h1: [...], h2: [...], h3: [...] } of visible heading text. */
export function extractHeadings(html) {
  const out = { h1: [], h2: [], h3: [] };
  const rx = /<(h[123])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = rx.exec(stripComments(html)))) {
    const text = visibleText(m[2]);
    if (text) out[m[1].toLowerCase()].push(text);
  }
  return out;
}

/** Content images and how many carry a non-empty alt.
 *  `alt=""` is intentional (decorative) and counted separately, not as a miss. */
export function extractImages(html) {
  const tags = stripComments(html).match(/<img\b[^>]*>/gi) || [];
  let withAlt = 0, decorative = 0;
  for (const t of tags) {
    const a = attr(t, "alt");
    if (a === null) continue;
    if (a === "") decorative++;
    else withAlt++;
  }
  return { total: tags.length, withAlt, decorative, missing: tags.length - withAlt - decorative };
}

/** Same-origin links, absolutised and de-duplicated — the crawl frontier. */
export function extractLinks(html, baseUrl) {
  const out = new Set();
  const rx = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = rx.exec(stripComments(html)))) {
    const href = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    try {
      const u = new URL(href, baseUrl);
      if (u.origin !== new URL(baseUrl).origin) continue;
      u.hash = "";
      out.add(u.toString());
    } catch { /* unparseable href */ }
  }
  return [...out];
}

/**
 * Heuristic: does this page have real content without running JavaScript?
 *
 * We can't execute JS in a Worker, so we can't diff raw vs. rendered. Instead
 * we look for the signature of a client-rendered shell: almost no visible
 * text, an empty mount node, and a script bundle. All three together is a
 * strong signal; we report the evidence so the UI can show its work rather
 * than asserting a verdict the user can't check.
 */
export function detectJsShell(html) {
  const text = visibleText(html);
  const src = stripComments(html);
  const emptyMount = /<div\b[^>]*\bid\s*=\s*["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(src);
  const scripts = (src.match(/<script\b[^>]*\bsrc\s*=/gi) || []).length;
  const bundle = /<script\b[^>]*src\s*=\s*["'][^"']*\.(js|mjs)["']/i.test(src);

  // Thresholds are deliberately conservative — a false "your site is invisible"
  // is far more damaging than a missed detection.
  const veryThin = text.length < 500;
  const thin = text.length < 1200;

  return {
    textLength: text.length,
    emptyMount,
    scriptCount: scripts,
    // Only the strongest combination is called a shell.
    isShell: (veryThin && emptyMount) || (veryThin && bundle && scripts > 0),
    isThin: thin && !veryThin,
  };
}

/** Cookie walls / paywalls / hard interstitials over the primary content. */
export function detectWall(html) {
  const text = visibleText(html).toLowerCase();
  const short = text.length < 900;
  const paywall = /(subscribe to (continue|read)|this (article|content) is for subscribers|create a free account to continue)/i.test(text);
  const cookieWall = short && /(accept all cookies|we use cookies|cookie preferences)/i.test(text);
  return { paywall, cookieWall, hit: paywall || cookieWall };
}

/**
 * Does the opening prose actually define what this is?
 * Deterministic proxy for the LLM-scored "answer-shaped content" pillar: we
 * only check for a definitional sentence pattern in the first ~60 words.
 */
export function definitionalOpener(html, brandHint) {
  const words = visibleText(html).split(/\s+/).slice(0, 60).join(" ");
  const brand = brandHint ? brandHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "[A-Z][\\w.'-]+";
  const rx = new RegExp(`\\b${brand}\\b[^.]{0,40}?\\b(is|are|provides|helps|builds|makes)\\b`, "i");
  return { opener: words, definitional: rx.test(words) };
}
