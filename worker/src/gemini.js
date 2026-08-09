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
export async function askGemini(key, model, prompt, { maxTokens = 900, timeoutMs = 45000 } = {}) {
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
    // the OpenRouter route unusable.
    if (!grounding) {
      throw new Error("Gemini returned an ungrounded answer (no groundingMetadata) — not counted.");
    }

    const annotations = (grounding.groundingChunks || [])
      .map((c) => c?.web?.uri)
      .filter(Boolean);

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
