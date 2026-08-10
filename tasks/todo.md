# AEO Readiness Check — build log

Spec: `../anandiyer.github.io/tasks/aeo-lab-prd.md`
Design: `../anandiyer.github.io/labs/aeo/index.html` (static, demo data)

## Milestone 0 — scaffold ✅

- [x] Repo laid out as `site/` + `worker/` + `tasks/`, matching canonical-lookalike
- [x] `wrangler.toml` with ALLOWED_ORIGIN, DAILY_LIMIT=3, MODEL_CHEAP/STRONG
- [x] `.dev.vars.example`, `.gitignore`
- [x] CORS, SSE transport, per-IP quota, domain cache scaffolding in `worker.js`
- [ ] `[[routes]]` + KV ids — blocked on the hostname decision

## Milestone 1 — crawler + deterministic audit ✅

- [x] `robots.js` — full group parser, longest-match path semantics, wildcards,
      `$` anchors, case-insensitive agents, empty-Disallow-means-allow
- [x] Answer-crawler vs training-crawler classification (the differentiator)
- [x] `html.js` — JSON-LD (incl. `@graph`), meta/OG, headings, images, links,
      JS-shell detection, wall detection
- [x] `crawl.js` — ≤10 pages, priority paths, robots, sitemap, well-known
- [x] `audit.js` — Pillars A (20), B (20), D (10)
- [x] `score.js` — weights, bands, fix ranking
- [x] 33 unit tests, all green
- [x] `scan.mjs` CLI harness

### Verified against live sites

| Site | Deterministic | Notes |
|---|---|---|
| canonical.cc | 30/50 (C) | no sitemap (confirmed 404, no jekyll-sitemap plugin); robots.txt is Content Signals boilerplate **comments only**, no actual directive |
| vercel.com | 38/50 (B) | llms.txt correctly detected |
| stripe.com | 39/50 (B) | llms.txt + Organization schema detected |
| cursor.com | 41/50 (B) | best of the set |
| anthropic.com | 27/50 (C) | llms.txt correctly **rejected** — the path returns an HTML 404 |

Crawler classification validated against live publisher robots.txt: Reuters,
The Atlantic and Wired each block Claude/Perplexity/Google while explicitly
allowing `OAI-SearchBot` (OpenAI licensing deals). Parser resolves correctly.

### Bugs found and fixed during validation

- `severityFor` used a hardcoded id list, so the agent-native `markdown` check
  fell through to "medium" instead of "ahead". Now keyed on pillar id.
- `crawlSite` derived `origin` from the *input* URL, not the post-redirect URL.
  On apex→www sites (canonical.cc included) every absolute internal link was
  classified cross-origin and dropped, and every subsequent fetch re-followed
  the redirect. Now re-derived from `home.finalUrl`.

## Milestone 2 — frontend wired to the Worker ✅

- [x] Demo data replaced with a real SSE client (`app.js`)
- [x] Handles `stage` / `status` / `site` / `audit` / `score` / `fixes` / `quota` / `cached` / `error` / `done`
- [x] Score ring, pillar bars, fix cards with copy-able artifacts, diff rendering
- [x] Cached-report permalink `?d=example.com`; `?api=` override for dev
- [x] Error + 429 states; JS-shell interrupt banner
- [x] `devserver.mjs` — runs the Worker on plain node, so the frontend is
      testable without a Cloudflare session
- [x] Verified in a real browser end-to-end against canonical.cc

### Bugs found and fixed during milestone 2

- The cache stored only `{hostname, origin}` while the live path emitted the
  full site object, so a **cached report displayed "undefined pages crawled ·
  no robots.txt"** for a site that has one. Cache now stores what it replays.
- A cached replay marked **every** step `done`, including the two that never
  ran. Step states are now recorded during the live run and replayed verbatim.
- Both are covered by `test/worker.test.js`, which runs the pipeline twice
  against a stubbed site and asserts the replay matches the live run.

### Honest-reporting decisions

- Unbuilt stages render as dashed `–` steps, never as complete
- Unmeasured pillars are excluded from the denominator and named in the card,
  never scored as zero
- Fixes needing the model stage say what they'll produce instead of showing
  an empty card

## Milestone 3 — queries + engines ✅ (backend; frontend pending)

- [x] Query generation from crawl (CHEAP model), 12 fixed shapes
- [x] **FOUR** engine adapters, not five — Gemini cannot ground (see below)
- [x] Failed engine → reported unavailable, never silently downgraded
- [x] Pillar E: mention rate, citation rate, share of voice, sentiment
- [x] `also_cited` event
- [x] Deployed to aeo-api.canonical.cc and verified live
- [x] Frontend: engine grid (4 columns), query chips with per-question win/loss,
      also-cited card, disclosure note, unavailable-engine cards, budget warnings

### Engine findings — all verified against the live API, none documented

| Engine | Model | $/query | Verdict |
|---|---|---|---|
| Perplexity | `sonar` | $0.0052 | best citations, cheapest |
| ChatGPT | `gpt-5.6-luna` | $0.0122 | works |
| Grok | `grok-4.3` | $0.0259 | works; 4.5 costs 8× for the same result |
| Claude | `claude-sonnet-5` | $0.0690 | works; 61% of total spend |
| ~~Gemini~~ | — | — | **excluded: zero citations in every config** |

1. **Gemini cannot ground through OpenRouter.** Zero citations with the native
   plugin, without it, on 3.5-flash and 3.6-flash. Answers from parametric
   memory. A column that cannot cite is a fake column.
2. **Perplexity must NOT get the web plugin** — Sonar 404s on
   `engine:"native"` because search is intrinsic. Every other engine requires it.
3. **Low `max_tokens` silently suppresses search.** At 500 tokens gpt-5.6-luna
   returned 0 citations and answered from memory; at 900 it returned 3
   citations. A cheap config yields a tool that looks fine and reports fiction.

### Bugs found and fixed during milestone 3

- **Reasoning tokens count against `max_tokens` and scale with prompt size.**
  Bit us three separate times: engine search suppression (500→900), sentiment
  returning empty (1200→3000), and query generation failing *in production but
  not locally* (2000→6000). Any Gemini call needs generous headroom.
- **`generateQueries` returned `null` on failure**, indistinguishable from "no
  API key" — so a broken stage rendered as a deliberately skipped one. It now
  throws with the model, the response length and a preview, and the worker
  logs it and surfaces a `warn` to the UI.
- **Cloudflare subrequest limit killed whole engines.** The crawl spends ~20 of
  the free plan's 50; 12 queries × 4 engines needed 48 more. Perplexity got 3
  of 12 through and Grok got 0 — and a dead engine reads as "never mentions
  you", which is a lie. The pipeline now counts subrequests during the crawl,
  divides the remainder across engines, and tells the user when it asked fewer
  questions than planned.

### Live production verification (netstock.com)

```
WARN [budget]: Asked 6 of 12 questions — the rest didn't fit the per-run limit.
  ChatGPT     6/6 | band C | mention 83% | cite 17%
  Claude      6/6 | band D | mention 50% | cite  0%
  Perplexity  6/6 | band D | mention 67% | cite 17%
  Grok        6/6 | band C | mention 83% | cite 33%
  sentiment: positive | also cited: stockiqtech.com, deposco.com, leafio.ai
SCORE 55/100 grade C (raw 41/75) omitted=['content']
```

### Deployment

- Worker live at **aeo-api.canonical.cc** (+ canonical-aeo.ai-29d.workers.dev)
- KV: `AEO_RL` + `AEO_CACHE` — deliberately NOT the existing plain-`RL`
  namespace, which belongs to canonical-lookalike
- `OPENROUTER_API_KEY` set as a Worker secret
- Global spend cap `MAX_PAID_RUNS_PER_DAY = 50` (~$75/day worst case). Past it,
  scans still run and return the full free deterministic audit.

### Plan decision — settled: staying on the FREE Workers plan

`SUBREQUEST_BUDGET = 45`. The query set is now **sized to the budget before
generation** rather than generating 12 and discarding half, so a free-plan run
asks exactly 6 balanced questions and shows no confusing "asked 6 of 12"
warning. ~$0.75/scan.

To upgrade later: Workers Paid ($5/mo) → set `SUBREQUEST_BUDGET = 950`. The
apportionment scales automatically; no other change needed.

### Frontend wiring notes

- Query chips are three-state, not two. Named by 1 engine of 4 renders amber,
  not green — colouring a 1/4 the same as a 4/4 would flatter a weak result.
- An engine we couldn't reach renders as a visible "not measured" card with a
  dashed band, never as a blank or zero column. A missing column would read as
  "this engine never mentions you", which is a claim we haven't earned.
- Pipeline warnings append rather than replace; a run can hit more than one and
  the second silently overwriting the first is how a caveat goes missing.
- `devserver.mjs` now loads `.dev.vars` + wrangler `[vars]`. Before this it ran
  with no API key and the paid stages reported "skipped" — indistinguishable
  from a deliberate config choice.

## Milestone 7 — ship ✅ LIVE

- [x] **https://canonical.cc/labs/aeo/** — deployed and verified end to end
- [x] Added to the Labs grid and the shared header dropdown
- [x] Site adopted the repo's newer conventions on rebase: root-relative
      internal URLs and the `lab-share` strip (this lab is plain HTML, not
      Jekyll-processed, so the share markup is inlined as lookalike does it)
- [ ] Fix canonical.cc's own findings (sitemap, llms.txt) — the tool's own
      report for canonical.cc lists both with artifacts ready to paste

### Bug found by looking at the live page

The chips read "the 12 buyer questions we asked" above engine columns that had
answered 6. The cached entry predated adaptive query sizing and per-question
results — **a v1 payload replayed by v2 code**. Cached reports outlive the code
that writes them, so the cache key is now versioned (`report:v2:<domain>`);
stale entries miss and expire rather than half-rendering. Bump `CACHE_VERSION`
whenever the payload shape changes.

## Remaining

- Pillar C (answer-shaped content, 25 pts). Scores currently report out of 75
  with the omission named on the card.
- Optional: Workers Paid ($5/mo) → `SUBREQUEST_BUDGET = 950` for 12 questions
  instead of 6.

## Milestone 4 — Pillar C

- [ ] Direct-answer-in-first-60-words, definitional opener, question H2s,
      comparison pages, pricing-in-text, quotable claims
- [ ] `temperature: 0` so re-runs are stable

## Milestone 5 — fix artifacts

- [ ] Generators: orgSchema, productSchema, faqSchema, llmsTxt, robots diff,
      meta, sitemap, contentSignals, markdown, opener rewrite
- [ ] **Grounding rule**: built only from crawled content; anything unsourced
      emits `{{PLACEHOLDER}}`. A fabricated stat inside JSON-LD a founder pastes
      live is the worst failure mode this tool has.

## Milestone 6 — cache, permalinks

- [ ] Verify 7-day domain cache end-to-end under wrangler dev
- [ ] `?refresh=1` costs quota, cached reads don't

## Milestone 7 — ship

- [ ] Self-scan canonical.cc, fix what it finds (sitemap + llms.txt at minimum)
- [ ] Add to `labs/index.html` grid + LABS dropdown in **every** lab page
- [ ] Sync `site/` → `anandiyer.github.io/labs/aeo/`

## Open decisions

1. **Hostname**: `aeo-api.canonical.cc` (recommended) vs `/aeo` routes on the
   existing `lookalike` Worker. Blocks deploy.
2. **Name**: "AEO Readiness Check" is the working title.
3. **12 queries/run** — the main cost dial (~$0.75–1.65 per fresh run).

## Milestone 8 — the downloadable fix plan ✅

Shipped 2026-08-10. The report is now available as one Markdown file the user
hands to an LLM, and each download posts to `#hack-central`.

- [x] `src/plan.js` — pure, synchronous renderer over the cached report entry.
      Reformats what the pipeline measured; derives no new claim.
- [x] `GET /aeo/:domain/plan.md` — matched *before* `GET /aeo/:domain`, which
      would otherwise read the domain as `example.com/plan.md`. Returns
      `text/markdown` + `Content-Disposition: attachment`, 404 when uncached.
- [x] Written instructions for the nine fixes with no generated artifact
      (`productSchema`, `faqSchema`, `meta`, `markdown`, `mcp`,
      `questionHeadings`, `comparisonPage`, `pricingText`, `openerRewrite`).
      These render as near-empty cards on the page; in the file they're the
      most useful part, because the reading model *can* write the prose.
- [x] The `render` failure is promoted to a "read this first" blocker — it has
      no `fix` key so it never reaches `rankFixes`, and it caps everything else.
- [x] Verification checklist derived from the tasks actually issued, not fixed.
- [x] `notifyDownload` → Slack, awaited (Cloudflare cancels pending promises),
      deduped per domain+IP for 10 min through `RL`.
- [x] Cache write moved *before* the `done` event. The client reveals the
      download button on `done`, so the old ordering let a fast click race the
      KV write and 404.
- [x] Frontend: `#plan-card` between the score and the engine grid. Real `href`
      for right-click, but the click is fetch+blob so a miss is a notice rather
      than a cross-origin JSON error page replacing the report.
- [x] 91 tests green (was 84 before this milestone, 78 before its endpoint tests)
- [x] Synced `site/` → `anandiyer.github.io/labs/aeo/`, cache-buster `20260810a`

### Known stale, not touched here

Milestones 2–7 above are marked incomplete but actually shipped, and the README
still says "Not yet deployed". The build log has drifted from the deployed
reality; worth a pass, out of scope for this change.
