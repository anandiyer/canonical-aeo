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

## Milestone 3 — queries + engines

- [ ] Query generation from crawl (CHEAP model), 12 fixed shapes
- [ ] 5 engine adapters via OpenRouter — **`"engine": "native"` is mandatory**
      (the default hybrid silently falls back to Exa, which would make all five
      engines read identical context and turn the comparison into theatre)
- [ ] Failed engine → dropped with a visible note, never silently downgraded
- [ ] Pillar E scoring: mention rate, citation rate, share of voice, sentiment
- [ ] `also_cited` event

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
