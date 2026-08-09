#!/usr/bin/env node
/* Local CLI harness — runs the deterministic pipeline against a real site
 * without wrangler or KV. This is how we validate the audit against reality.
 *
 *   node scan.mjs canonical.cc
 *   node scan.mjs canonical.cc --json
 */

import { crawlSite } from "./src/crawl.js";
import { runDeterministicAudit } from "./src/audit.js";
import { auditContent } from "./src/content.js";
import { scoreReport, rankFixes } from "./src/score.js";
import { attachArtifacts } from "./src/fixes.js";

const target = process.argv[2];
const asJson = process.argv.includes("--json");
if (!target) {
  console.error("usage: node scan.mjs <domain> [--json]");
  process.exit(1);
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const MARK = { pass: C.green("✔"), partial: C.yellow("◐"), fail: C.red("✖") };

const crawl = await crawlSite(target, (m) => !asJson && console.error(C.dim("  " + m)));
const pillars = runDeterministicAudit(crawl);
const envForContent = Object.fromEntries(
  (await import("node:fs")).readFileSync(new URL("./.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const contentPillar = await auditContent(crawl, process.argv.includes("--no-model") ? {} : envForContent);
if (contentPillar?.pillar?.max > 0) pillars.push(contentPillar.pillar);
const report = scoreReport(pillars);
const fixes = attachArtifacts(rankFixes(pillars), crawl);

if (asJson) {
  console.log(JSON.stringify({ site: crawl.hostname, report, fixes, pillars }, null, 2));
  process.exit(0);
}

console.log(`\n${C.bold(crawl.hostname)}  ${C.dim(`· ${crawl.pages.length} pages crawled`)}`);
console.log(
  `${C.bold(`${report.raw}/${report.max}`)} on the deterministic half ` +
    `${C.dim(`(normalized ${report.score}/100 · grade ${report.band})`)}`
);
console.log(C.dim(`not yet measured: ${report.omitted.join(", ")}\n`));

for (const p of pillars) {
  const got = p.checks.reduce((s, c) => s + c.points, 0);
  console.log(`${C.cyan(p.label)} ${C.dim(`${got}/${p.max}`)}`);
  for (const c of p.checks) {
    console.log(`  ${MARK[c.state]} ${c.label} ${C.dim(`${c.points}/${c.max}`)}`);
  }
  console.log("");
}

if (fixes.length) {
  console.log(C.bold(`${fixes.length} fixes, most damaging first:`));
  for (const f of fixes) {
    const tag =
      f.severity === "critical" ? C.red("CRITICAL") :
      f.severity === "high" ? C.yellow("HIGH    ") :
      f.severity === "ahead" ? C.cyan("AHEAD   ") : C.dim("MEDIUM  ");
    console.log(`  ${tag} +${f.recoverable}  ${f.label}`);
  }
} else {
  console.log(C.green("No fixes needed on the deterministic checks."));
}

// The headline finding deserves to be spelled out rather than buried in a list.
const bots = pillars[0].checks.find((c) => c.id === "bots");
if (bots.evidence.blockedAnswer.length) {
  console.log(
    "\n" + C.red("⚠ Blocked answer crawlers: ") +
      bots.evidence.blockedAnswer.map((b) => `${b.ua} (${b.engine})`).join(", ")
  );
}
if (bots.evidence.blockedTraining.length) {
  console.log(C.dim(`  Training crawlers blocked (fine, deliberate): ${bots.evidence.blockedTraining.join(", ")}`));
}

// Print the generated artifacts — the whole point of the tool.
if (process.argv.includes("--fixes")) {
  for (const f of fixes) {
    if (!f.artifact) {
      if (f.pending) console.log(`\n${C.dim("· pending (needs model): " + f.willProduce)}`);
      continue;
    }
    const a = f.artifact;
    console.log(`\n${C.bold("── " + a.title)}`);
    if (a.kind === "diff") {
      if (a.removed) console.log(a.removed.split("\n").map((l) => C.red("- " + l)).join("\n"));
      console.log(a.added.split("\n").map((l) => C.green("+ " + l)).join("\n"));
    } else {
      console.log(a.content);
    }
    if (a.note) console.log(C.dim("  " + a.note));
    for (const ph of a.placeholders || []) console.log(C.yellow(`  ⚠ ${ph.token} — ${ph.why}`));
  }
}
