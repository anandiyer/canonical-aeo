/* Site crawling — fetches everything the deterministic audit needs.
 *
 * Deliberately fetches the way an answer-engine crawler does: plain HTTP, no
 * JavaScript execution. That is the whole point of the render check — if we
 * rendered the page we would see content the real crawlers never see.
 */

import { extractLinks, extractMeta } from "./html.js";

const UA =
  "CanonicalAEOBot/1.0 (+https://canonical.cc/labs/aeo; AEO readiness checker)";

const MAX_PAGES = 10;
const PAGE_TIMEOUT_MS = 8000;
const MAX_BYTES = 1_500_000; // don't pull a whole video into memory

/** Pages worth having even if they aren't linked from the nav. */
const PRIORITY_PATHS = [
  "/pricing", "/about", "/product", "/products", "/docs", "/faq", "/faqs",
];

/* Pages that carry disproportionate AEO weight — the ones that answer buyer
   questions and tend to hold FAQ/Product schema. Document order is a poor
   frontier: a nav with ten links buries the FAQ that sits in the footer. */
const HIGH_VALUE = [
  /\/faqs?(\.html)?\/?$/i, /\/pricing/i, /\/about/i, /\/products?(\/|$)/i,
  /\/services?(\/|$)/i, /\/solutions?(\/|$)/i, /\/docs?(\/|$)/i,
  /\/how-it-works/i, /\/customers/i, /\/case-stud/i, /\/compare|\/vs-/i,
];

/** Lower sorts first: high-value pages, then shallow paths, then doc order. */
function linkRank(url, index) {
  let path;
  try { path = new URL(url).pathname; } catch { return [9, 9, index]; }
  const valuable = HIGH_VALUE.some((rx) => rx.test(path)) ? 0 : 1;
  const depth = path.split("/").filter(Boolean).length;
  return [valuable, depth, index];
}

/* Every network call goes through fetchText, so counting here gives an exact
   subrequest tally. Cloudflare caps subrequests per Worker invocation (50 on
   the free plan, 1000 on paid) and exceeding it kills later calls outright —
   which silently cost us a whole answer engine before this existed. */
let subrequests = 0;
export const subrequestCount = () => subrequests;
export const resetSubrequests = () => { subrequests = 0; };

async function fetchText(url, { timeout = PAGE_TIMEOUT_MS, accept } = {}) {
  subrequests++;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: { "user-agent": UA, accept: accept || "text/html,*/*" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    const type = res.headers.get("content-type") || "";
    let body = "";
    if (res.ok || res.status < 500) {
      body = (await res.text()).slice(0, MAX_BYTES);
    }
    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      contentType: type,
      html: body,
      redirected: (res.url || url) !== url,
    };
  } catch (err) {
    return { url, status: 0, error: String(err?.message || err), html: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize whatever the user typed into an https origin. */
export function normalizeInput(raw) {
  let s = String(raw || "").trim();
  if (!s) throw new Error("Enter a website URL.");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https URLs are supported.");
  if (!u.hostname.includes(".")) throw new Error("That doesn't look like a real domain.");
  return { origin: u.origin, hostname: u.hostname, href: u.origin + "/" };
}

async function fetchSitemap(origin, robotsTxt) {
  // A Sitemap: directive in robots.txt wins over the conventional location.
  const declared = String(robotsTxt || "").match(/^\s*sitemap\s*:\s*(\S+)/im)?.[1];
  const candidates = [declared, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`].filter(Boolean);

  for (const url of candidates) {
    const r = await fetchText(url, { timeout: 5000, accept: "application/xml,text/xml,*/*" });
    if (r.status === 200 && /<(urlset|sitemapindex)\b/i.test(r.html)) {
      const urlCount = (r.html.match(/<loc>/gi) || []).length;
      const lastmods = [...r.html.matchAll(/<lastmod>([^<]+)<\/lastmod>/gi)].map((m) => m[1]);
      return { found: true, url, urlCount, lastmodCount: lastmods.length, newestLastmod: lastmods.sort().pop() || null };
    }
  }
  return { found: false };
}

/** llms.txt, Markdown twins, MCP discovery, A2A agent card. */
async function fetchWellKnown(origin, homeHtml) {
  const [llms, llmsFull, mcp, agentCard] = await Promise.all([
    fetchText(`${origin}/llms.txt`, { timeout: 4000, accept: "text/plain,*/*" }),
    fetchText(`${origin}/llms-full.txt`, { timeout: 4000, accept: "text/plain,*/*" }),
    fetchText(`${origin}/.well-known/mcp.json`, { timeout: 4000, accept: "application/json,*/*" }),
    fetchText(`${origin}/.well-known/agent.json`, { timeout: 4000, accept: "application/json,*/*" }),
  ]);

  const okText = (r) => r.status === 200 && r.html.trim().length > 0 && !/^\s*<!doctype html/i.test(r.html);
  const okJson = (r) => {
    if (r.status !== 200) return false;
    try { JSON.parse(r.html); return true; } catch { return false; }
  };

  // A Markdown twin can be advertised via <link rel="alternate"> or served by
  // content negotiation. Check the declared link first, then try `/index.md`.
  let markdownTwin = false, markdownVia = null;
  const declared = extractMeta(homeHtml).markdownAlternate;
  if (declared) {
    const r = await fetchText(new URL(declared, origin).toString(), { timeout: 4000, accept: "text/markdown" });
    if (r.status === 200 && !/^\s*<!doctype html/i.test(r.html)) { markdownTwin = true; markdownVia = "link-alternate"; }
  }
  if (!markdownTwin) {
    const r = await fetchText(`${origin}/index.md`, { timeout: 4000, accept: "text/markdown,*/*" });
    if (r.status === 200 && !/^\s*<!doctype html/i.test(r.html)) { markdownTwin = true; markdownVia = "index.md"; }
  }

  return {
    llmsTxt: okText(llms) ? llms.html.slice(0, 20000) : null,
    llmsFullTxt: okText(llmsFull) ? true : null,
    mcp: okJson(mcp),
    agentCard: okJson(agentCard),
    markdownTwin,
    markdownVia,
  };
}

/**
 * Crawl a site. `onProgress(msg)` is called with human-readable status so the
 * SSE stream can narrate the slow part.
 */
export async function crawlSite(input, onProgress = () => {}) {
  resetSubrequests();
  const requested = normalizeInput(input);

  onProgress(`Fetching ${requested.hostname}…`);
  const home = await fetchText(requested.href);
  if (home.status === 0) {
    throw new Error(`Couldn't reach ${requested.hostname}. ${home.error || "The request failed."}`);
  }
  if (home.status >= 400) {
    throw new Error(`${requested.hostname} returned HTTP ${home.status}. Check the URL and try again.`);
  }

  // Re-derive the origin from where we actually landed. Apex→www (and
  // http→https) redirects are near-universal, and using the requested origin
  // would (a) re-follow the redirect on every subsequent fetch and (b) make
  // same-origin link filtering reject every absolute internal link, because
  // the page links to www while we'd be comparing against the apex.
  let origin = requested.origin;
  let hostname = requested.hostname;
  try {
    const landed = new URL(home.finalUrl);
    origin = landed.origin;
    hostname = landed.hostname;
  } catch { /* keep the requested origin */ }
  const href = origin + "/";
  const redirectedTo = origin !== requested.origin ? origin : null;

  onProgress("Reading robots.txt and sitemap…");
  const robotsRes = await fetchText(`${origin}/robots.txt`, { timeout: 5000, accept: "text/plain,*/*" });
  // A site with no robots.txt is unrestricted — distinct from one serving an
  // HTML 404 page, which we must not parse as robots directives.
  const robotsTxt =
    robotsRes.status === 200 && !/^\s*<!doctype html/i.test(robotsRes.html) ? robotsRes.html : null;

  const [sitemap, wellKnown] = await Promise.all([
    fetchSitemap(origin, robotsTxt),
    fetchWellKnown(origin, home.html),
  ]);

  onProgress("Crawling key pages…");
  const seen = new Set([home.finalUrl, href]);

  // Real links the homepage actually points at come FIRST. PRIORITY_PATHS are
  // speculative guesses, and on a site that doesn't use those names they are
  // all 404s — putting them first meant six wasted slots crowded out genuine
  // pages. (canonical.cc lost its linked /faqs page, and with it the FAQPage
  // schema that page already carried, entirely to this ordering.)
  // A high-value path that exists is nearly always linked, so it shows up here
  // anyway; the speculative probes only ever add unlinked pages.
  const discovered = extractLinks(home.html, href)
    .map((url, i) => ({ url, rank: linkRank(url, i) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2])
    .map((x) => x.url);

  const queue = [];
  for (const link of discovered) {
    if (queue.length >= MAX_PAGES * 2) break;
    if (!seen.has(link)) { queue.push(link); seen.add(link); }
  }
  for (const p of PRIORITY_PATHS) {
    const u = origin + p;
    if (!seen.has(u)) { queue.push(u); seen.add(u); }
  }

  const fetched = await Promise.all(queue.slice(0, MAX_PAGES - 1).map((u) => fetchText(u)));
  // Priority paths that don't exist are simply absent — not an error.
  const pages = [home, ...fetched.filter((p) => p.status === 200 && /html/i.test(p.contentType || ""))];

  return { origin, hostname, home, pages, robotsTxt, sitemap, wellKnown, requestedOrigin: requested.origin, redirectedTo, subrequests: subrequestCount() };
}
