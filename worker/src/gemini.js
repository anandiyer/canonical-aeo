/* Gemini with Grounding by Google Search — direct Google API.
 *
 * WHY THIS BYPASSES OPENROUTER
 * Every other engine goes through OpenRouter. Gemini cannot: OpenRouter silently
 * drops Google's grounding tool. Verified against gemini-3.5-flash with the web
 * plugin, `tools:[{google_search:{}}]`, `tools:[{type:'google_search'}]`,
 * `google_search_retrieval`, and a provider passthrough — all five returned 200
 * with zero citations and no groundingMetadata. The model answered from memory
 * every time.
 *
 * BILLING IS REQUIRED
 * Grounding with Google Search is not available on the Gemini free tier at all.
 * A free-tier key returns 200 for an ordinary call and 429 for the identical
 * call with the grounding tool attached — which is exactly how this presents.
 * Enabling billing on the AI Studio project fixes it; Gemini 3.x then includes
 * 5,000 grounded search requests per month before $14/1,000.
 *
 * Note Google bills per *search query*, and one prompt may trigger several.
 */

const API = "https://generativelanguage.googleapis.com/v1beta/models";

/** Ask Gemini one question with Google Search grounding attached. */
/* Grounding needs generous headroom. Gemini attaches groundingMetadata only
   when it finishes cleanly — at maxOutputTokens 900 the same prompt came back
   finishReason:MAX_TOKENS with NO grounding at all, which the caller would
   have read as "answered from memory" and discarded. 4000 finishes with STOP
   and 18 chunks. Do not lower this. */
export async function askGemini(key, model, prompt, { maxTokens = 4000, timeoutMs = 60000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
      }),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const message = String(json?.error?.message || `HTTP ${res.status}`);
      // Translate Google's generic quota message into the actual cause, so the
      // report doesn't tell a user "rate limited" when the real answer is
      // "this feature needs billing switched on".
      if (res.status === 429) {
        throw new Error(
          "Google Search grounding is unavailable on this key — it requires billing enabled on the Gemini API project (grounding is not offered on the free tier)."
        );
      }
      throw new Error(message);
    }

    const candidate = json?.candidates?.[0];
    const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("");
    const grounding = candidate?.groundingMetadata;

    // No groundingMetadata means the model answered from parametric memory. We
    // must not count that as a search result — it's the exact failure that made
    // the OpenRouter route unusable. (Note a truncated response also arrives
    // without grounding, hence the large token budget above.)
    if (!grounding) {
      const why = candidate?.finishReason === "MAX_TOKENS"
        ? "Gemini truncated before attaching grounding metadata"
        : "Gemini returned an ungrounded answer (no groundingMetadata)";
      throw new Error(`${why} — not counted.`);
    }

    // groundingChunks[].web.uri is ALWAYS a vertexaisearch.cloud.google.com
    // redirect, never the real source. Resolving each one would cost a
    // subrequest per citation — 18 on a single answer here — and blow the
    // Worker's per-invocation budget. Fortunately `web.title` carries the bare
    // domain ("netstock.com", "slimstock.com"), which is exactly the
    // attribution we need. Chunks whose title isn't domain-shaped are dropped
    // rather than guessed at: an unattributable citation must not be counted
    // for or against anyone.
    const DOMAINISH = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
    const annotations = (grounding.groundingChunks || [])
      .map((c) => String(c?.web?.title || "").trim().toLowerCase())
      .filter((t) => DOMAINISH.test(t))
      .map((host) => `https://${host}`);

    return {
      text,
      annotations,
      searchQueries: grounding.webSearchQueries || [],
      // Google doesn't return a per-call cost; billing is per search query.
      cost: 0,
      searchCount: (grounding.webSearchQueries || []).length,
    };
  } finally {
    clearTimeout(timer);
  }
}
