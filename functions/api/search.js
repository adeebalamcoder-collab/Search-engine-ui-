// ─── MAIN ──────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  }

  const q    = (body.q    || "").trim();
  const type = (body.type || "search").trim();
  const page = Math.max(1, parseInt(body.page, 10) || 1);

  if (!q) {
    return new Response(JSON.stringify({ error: "Empty query." }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  }

  const errors = [];

  // 1️⃣ Tavily (Primary)
  if (env.TAVILY_API_KEY) {
    try {
      const data = await fetchTavily(env.TAVILY_API_KEY, q, type, page);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
          "X-Search-Engine": "tavily", ...CORS_HEADERS },
      });
    } catch (e) { errors.push(`Tavily: ${e.message}`); }
  }

  // 2️⃣ Google CSE (Fallback1 — 100/day free)
  if (env.GOOGLE_API_KEY && env.GOOGLE_CX) {
    try {
      const data = await fetchGoogle(env.GOOGLE_API_KEY, env.GOOGLE_CX, q, page);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
          "X-Search-Engine": "google", ...CORS_HEADERS },
      });
    } catch (e) { errors.push(`Google: ${e.message}`); }
  }

  // 3️⃣ SearXNG (Fallback2)
  if (env.SEARXNG_URL) {
    try {
      const data = await fetchSearXNG(env.SEARXNG_URL, q, page);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
          "X-Search-Engine": "searxng", ...CORS_HEADERS },
      });
    } catch (e) { errors.push(`SearXNG: ${e.message}`); }
  }

  // 4️⃣ LangSearch (Fallback3)
  if (env.LANGSEARCH_API_KEY) {
    try {
      const data = await fetchLangSearch(env.LANGSEARCH_API_KEY, q, type, page);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
          "X-Search-Engine": "langsearch", ...CORS_HEADERS },
      });
    } catch (e) { errors.push(`LangSearch: ${e.message}`); }
  }

  // 5️⃣ Serper (Last resort — credits bachao)
  if (env.SERPER_API_KEY) {
    try {
      const data = await fetchSerper(env.SERPER_API_KEY, q, type, page);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
          "X-Search-Engine": "serper", ...CORS_HEADERS },
      });
    } catch (e) { errors.push(`Serper: ${e.message}`); }
  }

  return new Response(
    JSON.stringify({ error: "All search engines failed.", detail: errors.join(" | ") }),
    { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
