/* OpenRouter client.
 *
 * One key covers every model and every answer engine. See wrangler.toml for
 * the empirically-verified engine notes — in particular that Perplexity must
 * NOT receive the web plugin, and that max_tokens below ~900 silently
 * suppresses search on the models that do use it.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const HEADERS = (key) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  // OpenRouter attribution — shows up in the dashboard per-app.
  "HTTP-Referer": "https://canonical.cc/labs/aeo/",
  "X-Title": "Canonical AEO Readiness Check",
});

/** Cheap retry for transient network/5xx/429. Never retries a 4xx we caused. */
async function callWithRetry(key, body, { tries = 3, timeoutMs = 60000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: HEADERS(key),
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;

      // 4xx other than 429 is our fault — surface it rather than hammering.
      if (res.status !== 429 && res.status < 500) {
        throw new Error(json?.error?.message || `HTTP ${res.status}`);
      }
      lastErr = new Error(json?.error?.message || `HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (err?.message && !/abort|network|fetch failed|HTTP 5|HTTP 429/i.test(err.message) && attempt === 0) {
        // A definite client error — stop early.
        if (!/HTTP 429/.test(err.message)) throw err;
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw lastErr || new Error("OpenRouter call failed");
}

/** Plain completion. Returns { text, cost, annotations }. */
export async function complete(key, { model, prompt, system, maxTokens = 1200, web = false, temperature = 0 }) {
  const body = {
    model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
    max_tokens: maxTokens,
    temperature,
  };
  // `web === "native"` for engines that need the plugin; `false` for Perplexity,
  // whose search is intrinsic and which 404s if the plugin is supplied.
  if (web === "native") body.plugins = [{ id: "web", engine: "native" }];

  const json = await callWithRetry(key, body);
  const message = json?.choices?.[0]?.message || {};
  const annotations = (message.annotations || [])
    .filter((a) => a?.type === "url_citation" && a.url_citation?.url)
    .map((a) => a.url_citation.url);

  return {
    text: message.content || "",
    annotations,
    cost: Number(json?.usage?.cost || 0),
    model: json?.model || model,
  };
}

/**
 * Completion that must return JSON.
 * Models wrap JSON in prose or fences often enough that a tolerant extractor
 * is worth more than `response_format`, which not every model honours.
 */
export async function completeJson(key, opts) {
  const res = await complete(key, {
    ...opts,
    system: (opts.system ? opts.system + "\n\n" : "") + "Reply with JSON only. No prose, no code fences.",
  });
  return { ...res, data: extractJson(res.text) };
}

export function extractJson(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const candidates = [];

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(s);

  // Fall back to the outermost brace/bracket pair.
  const first = s.search(/[[{]/);
  const lastObj = s.lastIndexOf("}");
  const lastArr = s.lastIndexOf("]");
  const last = Math.max(lastObj, lastArr);
  if (first !== -1 && last > first) candidates.push(s.slice(first, last + 1));

  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch { /* try the next shape */ }
  }
  return null;
}
