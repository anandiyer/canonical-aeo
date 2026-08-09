# Canonical Labs — AEO Readiness Check

Paste a URL → get an **AEO readiness score (0–100, graded A–D)** plus
**copy-pasteable fixes**: the actual JSON-LD, the actual `llms.txt`, the actual
`robots.txt` diff.

Lives at **`canonical.cc/labs/aeo`**. Same aesthetic as the other labs (navy
gradient, Aeonik, white cards, warm-yellow in-progress accent).

Full spec: `../anandiyer.github.io/tasks/aeo-lab-prd.md`.

## How it works

```
 Browser (static, GitHub Pages)              Cloudflare Worker (holds keys)
 ┌────────────────────────────┐   POST       ┌────────────────────────────────┐
 │ paste URL → Check my AEO    │ ──/aeo─────→ │ cache hit? → replay, free      │
 │ live stepper + fix cards    │ ←─ SSE ───── │ else rate-limit 3/IP/day (KV)  │
 └────────────────────────────┘              │ 1 crawl     plain HTTP, no JS  │
                                              │ 2 audit     pure JS, no model  │
                                              │ 3 queries   CHEAP model   [ ]  │
                                              │ 4 engines   5 × native搜索 [ ] │
                                              │ 5 score     pure JS            │
                                              │ 6 fixes     STRONG model  [ ]  │
                                              └────────────────────────────────┘
```

`[ ]` = not built yet. See **Status** below.

### The scoring model (100 pts)

| Pillar | Pts | Model involved? |
|---|---|---|
| A · Retrievability & agent access | 20 | No |
| B · Structured meaning | 20 | No |
| C · Answer-shaped content | 25 | Yes |
| D · Agent-native readiness | 10 | No |
| E · Live AI visibility | 25 | Yes |

**50 of the 100 points are fully deterministic.** That is deliberate: a site
that hasn't changed must score identically on a re-run, or the tool loses
credibility on the user's second visit.

### Two things no competing grader does

1. **It writes the fix.** Framer, Webflow, HubSpot and forkoff all stop at
   naming the gap. We emit the artifact — grounded strictly in crawled content,
   with `{{PLACEHOLDER}}` for anything we can't source.
2. **It separates training crawlers from answer crawlers.** Blocking `GPTBot`
   is a legitimate IP decision. Blocking `OAI-SearchBot` silently removes you
   from ChatGPT's citations. Most sites that block one block both by accident.
   Validated against live publisher robots.txt — Reuters, The Atlantic and
   Wired all block Claude/Perplexity/Google while explicitly allowing
   `OAI-SearchBot`, and the parser resolves that correctly.

## Status

| Milestone | State |
|---|---|
| 0 · Scaffold, wrangler config, CORS/SSE/quota plumbing | ✅ done |
| 1 · Crawler + deterministic audit (A, B, D) | ✅ done, 33 tests green |
| 2 · Frontend wired to the Worker | ⬜ design built, still static demo data |
| 3 · Query generation + 5 engine adapters + Pillar E | ⬜ |
| 4 · Pillar C content analysis | ⬜ |
| 5 · Fix artifact generation | ⬜ |
| 6 · Cache, permalinks, `also_cited` | ⬜ partial (cache wired, untested) |
| 7 · Self-scan, nav wiring, ship | ⬜ |

## Develop

```bash
cd worker
npm test                     # 33 unit tests, no network
node scan.mjs canonical.cc   # run the real pipeline against a live site
node scan.mjs stripe.com --json
```

`scan.mjs` is the fastest way to sanity-check the audit — it exercises the
crawler and every deterministic check without wrangler, KV or an API key.

## Deploy

**Not yet deployed.** Two decisions are outstanding:

1. **Hostname.** `labs-api.canonical.cc` is a `custom_domain` on the Worker
   named `lookalike`; a hostname belongs to exactly one Worker, so this lab
   needs either its own subdomain (`aeo-api.canonical.cc`, recommended) or to
   be merged into the lookalike Worker as extra routes. The `[[routes]]` block
   in `wrangler.toml` is commented out pending that call.
2. **KV namespaces.** `RL` (rate limit) and `CACHE` (reports) both need
   creating and their ids pasting into `wrangler.toml`.

```bash
cd worker
wrangler kv namespace create RL
wrangler kv namespace create CACHE
wrangler secret put OPENROUTER_API_KEY   # needed from milestone 3 onward
wrangler deploy
```

Only `OPENROUTER_API_KEY` is required — it covers all five answer engines via
native search. Exa is **not** used (it was only needed for the deferred
competitor cohort).

## Layout

```
site/     → static page, deploys to /labs/aeo/
worker/   → Cloudflare Worker
  src/robots.js   robots.txt parser + answer-vs-training crawler classification
  src/html.js     regex-based extraction (no DOM in Workers)
  src/crawl.js    fetches pages the way a crawler does — no JS execution
  src/audit.js    Pillars A, B, D — deterministic
  src/score.js    weights, grade bands, fix ranking
  src/worker.js   router, CORS, SSE, quota, cache
  scan.mjs        local CLI harness
```
