/* Fix artifact generation — the differentiator (PRD §7).
 *
 * Every generator in this file is DETERMINISTIC and built strictly from what
 * the crawler actually read. Nothing here invents a fact.
 *
 * THE GROUNDING RULE: if a value cannot be sourced from the crawl, it is
 * emitted as an obvious `{{PLACEHOLDER}}` and listed in `placeholders`, never
 * guessed. A fabricated price or stat inside a JSON-LD block that a founder
 * pastes onto their live site is the worst failure this tool could produce.
 *
 * Prose-level artifacts (rewriting an opening paragraph, drafting FAQ answers)
 * genuinely need a model and land in milestone 5; they are not faked here.
 */

import { ANSWER_CRAWLERS } from "./robots.js";
import { extractMeta, extractSocialLinks, extractHeadings, visibleText } from "./html.js";

const artifact = (o) => ({ placeholders: [], ...o });

/* ── robots.txt ─────────────────────────────────────────────────────────── */

/**
 * A real diff: the exact lines to remove and add. Training-crawler blocks are
 * preserved verbatim — that's a deliberate IP choice and not ours to undo.
 */
export function robotsFix(crawl, evidence) {
  const blocked = evidence?.blockedAnswer || [];
  if (!blocked.length) return null;

  const blockedTraining = evidence.blockedTraining || [];
  const remove = blocked.map((b) => `User-agent: ${b.ua}\nDisallow: /`);

  const lines = [];
  if (blockedTraining.length) {
    lines.push("# Training crawlers — still blocked, your call.");
    for (const ua of blockedTraining) lines.push(`User-agent: ${ua}`, "Disallow: /", "");
  }
  lines.push("# Answer crawlers — these produce citations. Allow.");
  for (const b of blocked) lines.push(`User-agent: ${b.ua}`, "Allow: /", "");

  return artifact({
    kind: "diff",
    filename: "robots.txt",
    title: crawl.robotsTxt
      ? `robots.txt — replace the ${blocked.length === 1 ? "block" : "blocks"} below`
      : "robots.txt — new file at your web root",
    removed: crawl.robotsTxt ? remove.join("\n\n") : "",
    added: lines.join("\n").trim(),
    whereToPut: `${crawl.origin}/robots.txt`,
    note: blockedTraining.length
      ? "Your training-crawler blocks are kept exactly as they are — that's a deliberate choice about your content, and it costs you nothing in answer engines."
      : null,
  });
}

/* ── llms.txt ───────────────────────────────────────────────────────────── */

const SECTION_FOR = (path) => {
  if (/\/(docs|documentation|guides|api|reference|help|support)(\/|$)/i.test(path)) return "Docs";
  if (/\/(product|products|features|platform|solutions|tools|labs)(\/|$)/i.test(path)) return "Product";
  if (/\/(pricing|plans)(\/|$)/i.test(path)) return "Pricing";
  if (/\/(blog|news|changelog|research|writing|posts)(\/|$)/i.test(path)) return "Writing";
  if (/\/(about|team|company|careers|jobs|customers|contact|portfolio|investments)(\/|$)/i.test(path)) return "Company";
  return "Pages";
};

const titleCase = (slug) =>
  slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** Built from the pages we actually crawled, grouped by section. */
export function llmsTxtFix(crawl) {
  const meta = extractMeta(crawl.home?.html || "");
  const name =
    meta.og.site_name ||
    (meta.title || "").split(/[|·—–-]/)[0].trim() ||
    crawl.hostname;
  const summary = meta.description || meta.og.description || null;

  const sections = new Map();
  for (const page of crawl.pages) {
    let path;
    try { path = new URL(page.finalUrl || page.url).pathname; } catch { continue; }
    if (path === "/") continue;
    const pm = extractMeta(page.html || "");
    const label = (pm.title || "").split(/[|·—–-]/)[0].trim() || titleCase(path.split("/").filter(Boolean).pop() || "");
    const desc = pm.description ? pm.description.slice(0, 110) : null;
    const section = SECTION_FOR(path);
    if (!sections.has(section)) sections.set(section, []);
    if (sections.get(section).length < 8) {
      sections.get(section).push(
        `- [${label}](${crawl.origin}${path})${desc ? `: ${desc}` : ""}`
      );
    }
  }

  const placeholders = [];
  const out = [`# ${name}`, ""];
  if (summary) {
    out.push(`> ${summary}`, "");
  } else {
    out.push("> {{ONE_LINE_SUMMARY}}", "");
    placeholders.push({
      token: "{{ONE_LINE_SUMMARY}}",
      why: "Your homepage has no meta description, so there's no sourced sentence to use here.",
    });
  }
  // Stable order so re-runs produce an identical file.
  for (const key of ["Product", "Docs", "Pricing", "Company", "Writing", "Pages"]) {
    const items = sections.get(key);
    if (!items?.length) continue;
    out.push(`## ${key}`, ...items, "");
  }

  return artifact({
    kind: "file",
    filename: "llms.txt",
    title: "llms.txt — new file at your web root",
    content: out.join("\n").trim(),
    language: "markdown",
    whereToPut: `${crawl.origin}/llms.txt`,
    note: `Generated from the ${crawl.pages.length} pages we crawled. Extend it with anything important we didn't reach.`,
    placeholders,
  });
}

/* ── Organization JSON-LD ───────────────────────────────────────────────── */

export function orgSchemaFix(crawl) {
  const html = crawl.home?.html || "";
  const meta = extractMeta(html);
  const placeholders = [];

  const name =
    meta.og.site_name ||
    (meta.title || "").split(/[|·—–-]/)[0].trim() ||
    crawl.hostname;

  const node = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name,
    url: crawl.origin + "/",
  };

  // Only include a logo we actually saw.
  const logo = meta.og.image || null;
  if (logo) {
    node.logo = new URL(logo, crawl.origin).toString();
  } else {
    node.logo = "{{LOGO_URL}}";
    placeholders.push({ token: "{{LOGO_URL}}", why: "No og:image on your homepage, so we have no logo URL to cite." });
  }

  const desc = meta.description || meta.og.description;
  if (desc) {
    node.description = desc;
  } else {
    node.description = "{{ONE_LINE_DESCRIPTION}}";
    placeholders.push({ token: "{{ONE_LINE_DESCRIPTION}}", why: "No meta description found to source this from." });
  }

  const sameAs = extractSocialLinks(html, crawl.origin);
  if (sameAs.length) node.sameAs = sameAs;

  return artifact({
    kind: "code",
    filename: "organization.jsonld",
    title: "Organization JSON-LD — paste into <head>",
    content: `<script type="application/ld+json">\n${JSON.stringify(node, null, 2)}\n</script>`,
    language: "html",
    whereToPut: `<head> on ${crawl.origin}/`,
    note: sameAs.length
      ? `The ${sameAs.length} sameAs ${sameAs.length === 1 ? "link was" : "links were"} read off your live site — nothing invented.`
      : "No social profile links found on your homepage, so sameAs is omitted rather than guessed.",
    placeholders,
  });
}

/* ── Content Signals ────────────────────────────────────────────────────── */

export function contentSignalsFix(crawl) {
  return artifact({
    kind: "file",
    filename: "robots.txt",
    title: "Content Signals — add to robots.txt",
    content: [
      "# Content Signals: state how your content may be used.",
      "#   search   = appearing in a search index",
      "#   ai-input = used as grounding for a generated answer (RAG)",
      "#   ai-train = used to train or fine-tune a model",
      "User-agent: *",
      "Content-Signal: search=yes, ai-input=yes, ai-train=no",
      "Allow: /",
    ].join("\n"),
    language: "text",
    whereToPut: `${crawl.origin}/robots.txt`,
    note: "Shown with the common stance: be findable and quotable, but don't be training data. Change any value to match what you actually want.",
  });
}

/* ── sitemap ────────────────────────────────────────────────────────────── */

export function sitemapFix(crawl) {
  const urls = crawl.pages
    .map((p) => { try { return new URL(p.finalUrl || p.url).pathname; } catch { return null; } })
    .filter(Boolean);
  const body = [...new Set(urls)]
    .map((p) => `  <url><loc>${crawl.origin}${p}</loc></url>`)
    .join("\n");

  return artifact({
    kind: "file",
    filename: "sitemap.xml",
    title: "sitemap.xml — starter, from the pages we found",
    content: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`,
    language: "xml",
    whereToPut: `${crawl.origin}/sitemap.xml`,
    note: "Only covers the pages we crawled. If you're on Jekyll, adding the `jekyll-sitemap` plugin generates a complete one automatically.",
  });
}

/* ── the ones that genuinely need a model ───────────────────────────────── */

const PENDING = {
  productSchema: "Product / Service JSON-LD",
  faqSchema: "FAQPage JSON-LD drawn from your real on-site questions",
  meta: "A rewritten title and meta description",
  markdown: "A Markdown twin of your homepage",
  mcp: "An MCP endpoint descriptor",
};

/* ── dispatch ───────────────────────────────────────────────────────────── */

const GENERATORS = {
  robots: robotsFix,
  llmsTxt: llmsTxtFix,
  orgSchema: orgSchemaFix,
  contentSignals: contentSignalsFix,
  sitemap: sitemapFix,
};

/**
 * Attach an artifact to each ranked fix where we can build one deterministically.
 * Fixes awaiting the model stage get `{ pending: true, willProduce }` so the UI
 * can be honest about what's coming rather than rendering an empty card.
 */
export function attachArtifacts(fixes, crawl) {
  return fixes.map((f) => {
    const gen = GENERATORS[f.fix];
    if (gen) {
      try {
        const built = gen(crawl, f.evidence);
        if (built) return { ...f, artifact: built };
      } catch (err) {
        // A generator throwing must never take down the whole report.
        return { ...f, artifact: null, artifactError: String(err?.message || err) };
      }
    }
    return { ...f, artifact: null, pending: !!PENDING[f.fix], willProduce: PENDING[f.fix] || null };
  });
}
