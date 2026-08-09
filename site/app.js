/* AEO Readiness Check — frontend.
   Streams the Worker's pipeline over a fetch/ReadableStream SSE channel and
   renders the stepper, score card and fix cards as events arrive. */

// Resolution order mirrors labs/lookalike:
//   1. ?api=… query param (explicit override)
//   2. localhost → the local dev Worker (so no param needed in dev)
//   3. the deployed production Worker
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const ENDPOINT =
  new URLSearchParams(location.search).get("api") ||
  (LOCAL_HOSTS.includes(location.hostname)
    ? "http://localhost:8787"
    : "https://aeo-api.canonical.cc");

const STEPS = [
  ["fetch", "Fetching site"],
  ["audit", "Auditing structure"],
  ["queries", "Generating queries"],
  ["engines", "Asking 4 engines"],
  ["score", "Scoring"],
  ["fixes", "Writing fixes"],
];

const SEVERITY_LABEL = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  ahead: "Ahead of the curve",
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let running = false;
let inflight = null;
let lastInput = "";
let lastQueries = null;

/* ── stepper ──────────────────────────────────────────────────────────── */

function buildStepper() {
  const wrap = $("stepper");
  wrap.innerHTML = "";
  STEPS.forEach(([id, label], i) => {
    const step = el("div", "step", `<span class="dot">${i + 1}</span><span>${esc(label)}</span>`);
    step.dataset.step = id;
    wrap.appendChild(step);
  });
}

function setStep(id, state) {
  const node = $("stepper").querySelector(`[data-step="${id}"]`);
  if (!node) return;
  node.classList.remove("active", "done", "skipped");
  if (state === "done") {
    node.classList.add("done");
    node.querySelector(".dot").textContent = "✓";
  } else if (state === "skipped") {
    // Not built yet. Marked visibly rather than left looking stuck or, worse,
    // shown as complete when nothing ran.
    node.classList.add("skipped");
    node.querySelector(".dot").textContent = "–";
  } else {
    node.classList.add("active");
  }
}

/* ── score card ───────────────────────────────────────────────────────── */

const RING_CIRCUMFERENCE = 2 * Math.PI * 33;

function renderScore(ev) {
  $("score-card").classList.remove("is-hidden");

  const gradeClass = `grade-${ev.band.toLowerCase()}`;
  const ring = $("ring-fg");
  ring.setAttribute("stroke-dasharray", RING_CIRCUMFERENCE.toFixed(2));
  ring.classList.add(gradeClass);
  $("score-num").textContent = ev.score;
  const badge = $("grade-band");
  badge.textContent = `GRADE ${ev.band}`;
  badge.className = `grade-band ${gradeClass}-bg`;

  // Animate the ring on the next frame so the transition actually runs.
  requestAnimationFrame(() => {
    ring.setAttribute(
      "stroke-dashoffset",
      (RING_CIRCUMFERENCE * (1 - ev.score / 100)).toFixed(2)
    );
  });

  const wrap = $("pillars");
  wrap.innerHTML = "";
  for (const p of ev.pillars) {
    const pct = p.max ? (p.score / p.max) * 100 : 0;
    const row = el("div", "pillar");
    row.appendChild(
      el("div", "axis-top", `<span>${esc(p.label)}</span><span class="tabular">${p.score}<span class="of">/${p.max}</span></span>`)
    );
    const bar = el("div", "axis-bar");
    const fill = el("div", "axis-fill" + (pct < 25 ? " low" : ""));
    bar.appendChild(fill);
    row.appendChild(bar);
    wrap.appendChild(row);
    requestAnimationFrame(() => (fill.style.width = pct + "%"));
  }

  // Be explicit about what was NOT measured. Scoring an unmeasured pillar as
  // zero would understate a site for something we never checked.
  if (ev.omitted && ev.omitted.length) {
    const names = { content: "answer-shaped content", visibility: "live AI visibility" };
    $("not-measured").innerHTML =
      `Scored out of <b>${ev.max}</b> and normalized to 100. Not measured yet: ` +
      ev.omitted.map((o) => esc(names[o] || o)).join(" and ") +
      ` — those checks are still being built, so they're excluded from the total rather than counted as zero.`;
    $("not-measured").classList.remove("is-hidden");
  }
}

/* ── engines ──────────────────────────────────────────────────────────── */

function renderEngines(ev) {
  const wrap = $("engines");
  wrap.innerHTML = "";
  $("engines-label").classList.remove("is-hidden");

  for (const e of ev.engines) {
    const card = el("div", "engine");
    card.appendChild(el("div", "engine-name", esc(e.label)));
    card.appendChild(el("span", `engine-band band-${e.band.toLowerCase()}`, e.band));
    card.appendChild(
      el("div", "engine-stat", `<span>Mentioned</span><b class="tabular">${e.mentioned}/${e.answered}</b>`)
    );
    card.appendChild(
      el("div", "engine-stat", `<span>Cited w/ link</span><b class="tabular">${e.cited}/${e.answered}</b>`)
    );
    wrap.appendChild(card);
  }

  // An engine we couldn't reach is shown as unreachable, never as a zero — a
  // blank column would read as "this engine never mentions you", which is a
  // claim we haven't earned.
  for (const u of ev.unavailable || []) {
    const card = el("div", "engine engine-out");
    card.appendChild(el("div", "engine-name", esc(u.label)));
    card.appendChild(el("span", "engine-band band-out", "—"));
    card.appendChild(el("div", "engine-stat out", "<span>Not measured</span>"));
    card.title = u.error || "";
    wrap.appendChild(card);
  }

  const notes = [
    "Measured through each engine's own API using its native search. Not identical to what a signed-in human sees — no personalization, no chat memory. Directionally right, not a guarantee.",
  ];
  if (ev.sentimentMeasured === false) {
    notes.push("Sentiment couldn't be classified this run, so those 3 points are excluded from the total rather than counted against you.");
  }
  if ((ev.unavailable || []).length) {
    notes.push(
      `${ev.unavailable.map((u) => esc(u.label)).join(" and ")} didn't respond and ${ev.unavailable.length === 1 ? "is" : "are"} excluded from the score entirely.`
    );
  }
  $("disclosure").innerHTML = notes.join(" ");
  $("disclosure").classList.remove("is-hidden");
}

/* ── query chips ──────────────────────────────────────────────────────── */

function renderQueries(ev, perQuery) {
  const wrap = $("query-chips");
  wrap.innerHTML = "";
  const rows = perQuery && perQuery.length
    ? perQuery
    : ev.queries.map((q) => ({ q: q.q, shape: q.shape }));

  for (const row of rows) {
    // Before the engines report back, chips are neutral. Afterwards they carry
    // the win/loss that makes them worth reading.
    let cls = "chip", tag = "";
    if (row.answeredBy != null) {
      // Three states, not two: being named by 1 engine of 4 is a real signal
      // but it is not a win, and colouring it the same green as 4/4 would
      // flatter the result.
      const ratio = row.answeredBy ? row.mentionedBy / row.answeredBy : 0;
      const state = ratio >= 0.5 ? "win" : ratio > 0 ? "partial" : "lose";
      const mark = state === "win" ? "✓" : state === "partial" ? "~" : "✕";
      cls += " " + state;
      tag = `<i>${mark} ${row.mentionedBy}/${row.answeredBy}</i>`;
    }
    wrap.appendChild(el("span", cls, esc(row.q) + tag));
  }

  $("queries-label").textContent =
    `The ${rows.length} buyer question${rows.length === 1 ? "" : "s"} we asked`;
  $("queries-label").classList.remove("is-hidden");
  $("queries-card").classList.remove("is-hidden");

  $("queries-note").innerHTML = perQuery && perQuery.length
    ? "Counts are how many engines named you. Only the <em>alternatives</em> and <em>reviews</em> questions mention your brand — the rest test whether you surface when nobody asked for you."
    : "Generated from your site. Only the <em>alternatives</em> and <em>reviews</em> questions name your brand on purpose.";
}

/* ── also cited ───────────────────────────────────────────────────────── */

function renderAlsoCited(brands) {
  if (!brands || !brands.length) return;
  const wrap = $("also-chips");
  wrap.innerHTML = "";
  for (const b of brands) {
    wrap.appendChild(
      el("span", "chip", `${esc(b.host)}<i>${b.queryCount} ${b.queryCount === 1 ? "query" : "queries"}</i>`)
    );
  }
  $("also-body").textContent =
    "On the questions where you weren't cited, these domains were. Not a competitive ranking — just who currently owns the answers you're missing.";
  $("also-cited").classList.remove("is-hidden");
}

/* ── fixes ────────────────────────────────────────────────────────────── */

function renderArtifact(a) {
  const box = el("div", "artifact");
  const bar = el("div", "artifact-bar");
  bar.appendChild(el("span", "artifact-name", esc(a.title)));

  const btn = el("button", "copy-btn", "Copy");
  btn.type = "button";
  bar.appendChild(btn);
  box.appendChild(bar);

  const pre = el("pre");
  const code = el("code");
  let copyText;

  if (a.kind === "diff") {
    // Rendered as a real diff; only the added lines are copyable, since the
    // removed ones are what the user is deleting.
    const removed = a.removed ? a.removed.split("\n").map((l) => `- ${l}`).join("\n") : "";
    const added = a.added.split("\n").map((l) => `+ ${l}`).join("\n");
    code.innerHTML =
      (removed ? `<span class="del">${esc(removed)}</span>\n` : "") +
      `<span class="add">${esc(added)}</span>`;
    copyText = a.added;
  } else {
    code.textContent = a.content;
    copyText = a.content;
  }
  pre.appendChild(code);
  box.appendChild(pre);

  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(copyText).then(() => {
      btn.textContent = "Copied ✓";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("copied");
      }, 1600);
    });
  });

  return box;
}

function renderFixes(fixes) {
  const wrap = $("fixes");
  wrap.innerHTML = "";

  if (!fixes.length) {
    $("fixes-title").textContent = "Nothing to fix on the checks we ran";
    $("fixes-title").classList.remove("is-hidden");
    wrap.appendChild(
      el("div", "card fix sev-ahead",
        `<h3 class="fix-title">Clean sweep</h3>
         <p class="fix-why">Every deterministic check passed. That's rare.</p>`)
    );
    return;
  }

  $("fixes-title").textContent =
    `${fixes.length} thing${fixes.length === 1 ? "" : "s"} to fix, most damaging first`;
  $("fixes-title").classList.remove("is-hidden");

  for (const f of fixes) {
    const card = el("div", `card fix sev-${f.severity}`);

    const head = el("div", "fix-head");
    head.appendChild(
      el("span", "fix-badge", `${SEVERITY_LABEL[f.severity] || f.severity} · +${f.recoverable} pt${f.recoverable === 1 ? "" : "s"}`)
    );
    if (f.artifact?.filename) head.appendChild(el("span", "fix-where", esc(f.artifact.filename)));
    card.appendChild(head);

    card.appendChild(el("h3", "fix-title", esc(f.label)));

    const why = explain(f);
    if (why) card.appendChild(el("p", "fix-why", why));

    if (f.artifact) {
      card.appendChild(renderArtifact(f.artifact));
      const foot = [];
      if (f.artifact.whereToPut) foot.push(`Put it at <code>${esc(f.artifact.whereToPut)}</code>`);
      if (f.artifact.note) foot.push(esc(f.artifact.note));
      for (const ph of f.artifact.placeholders || []) {
        foot.push(`<b>⚠ <code>${esc(ph.token)}</code> is a placeholder</b> — ${esc(ph.why)}`);
      }
      if (foot.length) card.appendChild(el("p", "fix-where-to", foot.join("<br>")));
    } else if (f.pending) {
      card.appendChild(
        el("p", "fix-pending", `Generating <b>${esc(f.willProduce)}</b> needs the writing stage, which isn't live yet.`)
      );
    }

    wrap.appendChild(card);
  }
}

/** Turn a check's evidence into a plain-English explanation. */
function explain(f) {
  const e = f.evidence || {};
  switch (f.id) {
    case "bots": {
      const list = (e.blockedAnswer || []).map((b) => `<code>${esc(b.ua)}</code> (${esc(b.engine)})`);
      if (!list.length) return null;
      let s = `Your <code>robots.txt</code> blocks ${list.join(", ")}. `;
      s += `These are the crawlers that fetch pages in order to <em>cite</em> them in an answer — blocking them removes you from those engines' results.`;
      if (e.trainingBlockedIsFine) {
        s += ` You also block ${esc((e.blockedTraining || []).join(", "))}, which is a different thing entirely: those collect training data, and blocking them is a legitimate choice that costs you no visibility.`;
      }
      return s;
    }
    case "render":
      return `We fetched your page the way a crawler does and got <b>${e.textLength} characters</b> of text${
        e.emptyMount ? ", with an empty mount element and a script bundle" : ""
      }. Most answer-engine crawlers don't execute JavaScript, so they see roughly what we saw. This caps everything else.`;
    case "sitemap":
      return `No XML sitemap found at the usual locations or declared in <code>robots.txt</code>.`;
    case "schema-org":
      return `No <code>Organization</code> JSON-LD anywhere we looked. This is the block that tells an engine you're one entity across your site and your social profiles.`;
    case "schema-product":
      return `No <code>Product</code>, <code>Service</code> or <code>SoftwareApplication</code> schema, so there's nothing machine-readable describing what you sell.`;
    case "schema-faq":
      return `No <code>FAQPage</code> schema. This is the single most direct way to hand an engine a question-and-answer pair it can quote.`;
    case "meta": {
      const bits = [];
      if (!e.titleOk) bits.push("the title is missing or an awkward length");
      if (!e.descOk) bits.push("the meta description is missing or outside 50–200 characters");
      if (!e.ogOk) bits.push("Open Graph tags are incomplete");
      return bits.length ? `On your homepage, ${bits.join(", ")}.` : null;
    }
    case "llms-txt":
      return `No <code>llms.txt</code>. A growing set of agents look for it to understand a site without crawling it — almost nobody in any category has one yet.`;
    case "content-signals":
      return `No Content Signals in <code>robots.txt</code>. These state whether your content may be indexed, used to ground an answer, or used for training.`;
    case "markdown":
      return `No machine-readable Markdown copy of your pages, via either <code>rel="alternate"</code> or content negotiation.`;
    case "mcp":
      return `No MCP endpoint discoverable at <code>/.well-known/mcp.json</code>.`;
    default:
      return null;
  }
}

/* ── warnings + notices ───────────────────────────────────────────────── */

/** Non-fatal notes from the pipeline (budget caps, partial stages). */
function addWarning(msg) {
  if (!msg) return;
  const box = $("audit-warning");
  const list = $("audit-warning-msg");
  $("audit-warning-title").textContent = "Heads up.";
  // Appended, not replaced: a run can hit more than one of these and the second
  // one silently overwriting the first is how a caveat goes missing.
  const line = el("span", "warn-line", esc(msg));
  list.appendChild(line);
  box.classList.remove("is-hidden");
}

function showWarning(title, msg) {
  $("audit-warning-title").textContent = title;
  $("audit-warning-msg").textContent = msg;
  $("audit-warning").classList.remove("is-hidden");
}

function showNotice(html, isError) {
  const n = $("notice");
  n.innerHTML = html;
  n.className = "notice" + (isError ? " error" : "");
}

/* ── event handling ───────────────────────────────────────────────────── */

function handleEvent(ev) {
  switch (ev.type) {
    case "stage":
      setStep(ev.step, ev.state || "active");
      break;
    case "status":
      $("status").textContent = ev.text || "";
      break;
    case "quota":
      if (ev.remaining != null) {
        $("quota").textContent = `${ev.remaining} check${ev.remaining === 1 ? "" : "s"} left today`;
      }
      break;
    case "cached":
      $("hint").textContent = "Showing a cached report — re-runs are free for 7 days.";
      break;
    case "site":
      $("site-name").textContent = ev.site.hostname;
      $("site-sub").textContent =
        `${ev.site.pagesCrawled} page${ev.site.pagesCrawled === 1 ? "" : "s"} crawled · ` +
        `${ev.site.hasRobots ? "robots.txt found" : "no robots.txt"} · ` +
        `${ev.site.sitemap?.found ? "sitemap found" : "no sitemap"}`;
      break;
    case "audit":
      // Per-pillar detail arrives before the total; the render check is the one
      // worth interrupting for, since it invalidates everything downstream.
      for (const c of ev.pillar.checks || []) {
        if (c.id === "render" && c.state === "fail") {
          showWarning(
            "Your pages look empty without JavaScript.",
            `We got ${c.evidence.textLength} characters of text fetching this the way a crawler does. Everything below is measured against what a crawler can actually see.`
          );
        }
      }
      break;
    case "queries":
      lastQueries = ev;
      renderQueries(ev, null);
      break;
    case "engines":
      renderEngines(ev);
      // The per-query breakdown only exists once the engines have answered, so
      // the chips are re-rendered here with their win/loss markers.
      if (lastQueries) renderQueries(lastQueries, ev.perQuery);
      break;
    case "also_cited":
      renderAlsoCited(ev.brands);
      break;
    case "warn":
      addWarning(ev.message);
      break;
    case "score":
      renderScore(ev);
      $("rescan").classList.remove("is-hidden");
      break;
    case "fixes":
      renderFixes(ev.fixes || []);
      break;
    case "done":
      $("spinner").style.display = "none";
      $("status").textContent = "";
      break;
    case "error":
      $("spinner").style.display = "none";
      $("status").textContent = "";
      showNotice(`<b>Couldn't finish:</b> ${esc(ev.message)}`, true);
      break;
  }
}

/* ── run ──────────────────────────────────────────────────────────────── */

async function run(input, opts = {}) {
  if (running || !input.trim()) return;
  if (inflight) inflight.abort();
  running = true;
  lastInput = input.trim();
  inflight = new AbortController();

  const go = $("go");
  go.disabled = true;
  go.classList.add("loading");
  $("go-label").textContent = "Checking…";
  $("notice").className = "notice is-hidden";
  $("audit-warning").classList.add("is-hidden");
  $("score-card").classList.add("is-hidden");
  $("fixes-title").classList.add("is-hidden");
  $("fixes").innerHTML = "";
  $("not-measured").classList.add("is-hidden");
  $("audit-warning-msg").innerHTML = "";
  lastQueries = null;
  for (const id of ["engines-label", "disclosure", "queries-label", "queries-card", "also-cited"]) {
    $(id).classList.add("is-hidden");
  }
  $("engines").innerHTML = "";
  $("stage").classList.remove("is-hidden");
  $("spinner").style.display = "";
  buildStepper();
  $("status").textContent = "Starting — fetching the site the way a crawler would…";
  $("stage").scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const res = await fetch(ENDPOINT + "/aeo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: lastInput, ...(opts.refresh ? { refresh: true } : {}) }),
      signal: inflight.signal,
    });

    if (res.status === 429) {
      $("stage").classList.add("is-hidden");
      showNotice(
        `<b>Daily limit reached.</b> You've used your checks for today — they reset at midnight UTC. Reports already generated stay free to revisit.`,
        false
      );
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      $("stage").classList.add("is-hidden");
      showNotice(`<b>Couldn't start:</b> ${esc(body.error || `HTTP ${res.status}`)}`, true);
      return;
    }

    // Parse the SSE frames off the raw stream — EventSource can't POST.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line.slice(5).trim()));
        } catch {
          /* ignore a malformed frame rather than killing the stream */
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      $("spinner").style.display = "none";
      showNotice(`<b>Couldn't reach the checker:</b> ${esc(err.message)}`, true);
    }
  } finally {
    running = false;
    inflight = null;
    go.disabled = false;
    go.classList.remove("loading");
    $("go-label").textContent = "Check my AEO →";
  }
}

/* ── wiring ───────────────────────────────────────────────────────────── */

$("go").addEventListener("click", () => run($("input").value));
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") run($("input").value);
});
$("rescan").addEventListener("click", () => run(lastInput, { refresh: true }));

// Shareable permalink: /labs/aeo/?d=example.com runs (or replays) that domain.
const preset = new URLSearchParams(location.search).get("d");
if (preset) {
  $("input").value = preset;
  run(preset);
}
