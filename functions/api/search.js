// Cloudflare PAGES FUNCTION
// Path: functions/api/search.js
// KV Namespace: SEARCH_CACHE (bind karo Cloudflare dashboard mein)
// Primary:   Serper     (env.SERPER_API_KEY)
// Fallback1: LangSearch (env.LANGSEARCH_API_KEY)
// Fallback2: Tavily     (env.TAVILY_API_KEY)
// Fallback3: Google CSE (env.GOOGLE_API_KEY + env.GOOGLE_CX)
// Last:      SearXNG    (env.SEARXNG_URL)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CACHE_TTL_SECONDS = 15 * 24 * 60 * 60; // 15 din

// ─── TIMEOUT WRAPPER ───────────────────────────────────────────────────────
function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// ─── KV CACHE ──────────────────────────────────────────────────────────────
function cacheKey(q, type, page) {
  return `s:${type}:${page}:${q.toLowerCase().trim()}`;
}

async function cacheGet(kv, key) {
  if (!kv) return null;
  try {
    const val = await kv.get(key, "json");
    return val || null;
  } catch { return null; }
}

async function cacheSet(kv, key, data) {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(data), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {}
}

// ─── GOOGLE CSE ────────────────────────────────────────────────────────────
async function fetchGoogle(apiKey, cx, q, page) {
  const start = (page - 1) * 15 + 1;
  const params = new URLSearchParams({ key: apiKey, cx, q, start: String(start), num: "15" });
  const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
  if (!res.ok) throw new Error(`Google CSE HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Google CSE error: ${data.error.message}`);
  const items = data?.items || [];
  if (items.length === 0) throw new Error("Google CSE empty results");
  const organic = items.map((item, idx) => ({
    title: item.title || "", link: item.link || "",
    snippet: item.snippet || "", displayLink: item.displayLink || "",
    position: start + idx,
  }));
  return { searchParameters: { q, page, engine: "google", num: organic.length }, organic, relatedSearches: [] };
}

// ─── SEARXNG ───────────────────────────────────────────────────────────────
async function fetchSearXNG(baseUrl, q, page) {
  const params = new URLSearchParams({ q, format: "json", pageno: String(page) });
  const res = await fetch(`${baseUrl}/search?${params}`, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.results || [];
  if (results.length === 0) throw new Error("SearXNG empty results");
  const organic = results.map((item, idx) => ({
    title: item.title || "", link: item.url || "", snippet: item.content || "",
    displayLink: (() => { try { return new URL(item.url).hostname; } catch { return item.url || ""; } })(),
    position: idx + 1,
  }));
  return { searchParameters: { q, page, engine: "searxng", num: organic.length }, organic, relatedSearches: [] };
}

// ─── LANGSEARCH ────────────────────────────────────────────────────────────
async function fetchLangSearch(apiKey, q, type, page) {
  const res = await fetch("https://api.langsearch.com/v1/web-search", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, freshness: "noLimit", summary: false, count: 15, market: "en-US", setLang: "en", lang: "en" }),
  });
  if (!res.ok) throw new Error(`LangSearch HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 200) throw new Error(`LangSearch error: ${data.msg}`);
  const values = data?.data?.webPages?.value || [];
  if (values.length === 0) throw new Error("LangSearch empty results");
  const organic = values.map((item, idx) => ({
    title: item.name || "", link: item.url || "", snippet: item.snippet || "",
    displayLink: item.displayUrl || (() => { try { return new URL(item.url).hostname; } catch { return item.url || ""; } })(),
    position: idx + 1,
  }));
  return { searchParameters: { q, type, page, engine: "langsearch", num: organic.length }, organic, relatedSearches: [] };
}

// ─── TAVILY ────────────────────────────────────────────────────────────────
async function fetchTavily(apiKey, q, type, page) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, search_depth: "basic", max_results: 15, include_answer: false }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.results || [];
  if (results.length === 0) throw new Error("Tavily empty results");
  const organic = results.map((item, idx) => ({
    title: item.title || "", link: item.url || "", snippet: item.content || "",
    displayLink: (() => { try { return new URL(item.url).hostname; } catch { return item.url || ""; } })(),
    position: idx + 1,
  }));
  return { searchParameters: { q, type, page, engine: "tavily", num: organic.length }, organic, relatedSearches: [] };
}

// ─── SERPER ────────────────────────────────────────────────────────────────
function mapTypeToSerperEndpoint(type) {
  switch (type) {
    case "images": return "https://google.serper.dev/images";
    case "news":   return "https://google.serper.dev/news";
    case "videos": return "https://google.serper.dev/videos";
    default:       return "https://google.serper.dev/search";
  }
}

async function fetchSerper(apiKey, q, type, page) {
  const res = await fetch(mapTypeToSerperEndpoint(type), {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q, page, num: 15, gl: "in", hl: "en" }),
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const data = await res.json();
  const hasResults = (data.organic?.length > 0) || (data.images?.length > 0) || (data.news?.length > 0) || (data.videos?.length > 0);
  if (!hasResults) throw new Error("Serper empty results");
  data.searchParameters = { q, type, page, engine: "serper", num: 15 };
  return data;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env.SEARCH_CACHE || null;

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

  // ── KV Cache check ─────────────────────────────────────────────────────
  const key = cacheKey(q, type, page);
  const cached = await cacheGet(kv, key);
  if (cached) {
    return new Response(JSON.stringify(cached), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
        "X-Search-Engine": "kv-cache", ...CORS_HEADERS },
    });
  }

  const errors = [];
  let result = null;

  // 1️⃣ Serper (Primary) — 3s timeout
  if (env.SERPER_API_KEY) {
    try {
      result = await withTimeout(fetchSerper(env.SERPER_API_KEY, q, type, page), 3000);
    } catch (e) { errors.push(`Serper: ${e.message}`); }
  }

  // 2️⃣ LangSearch (Fallback1) — 3s timeout
  if (!result && env.LANGSEARCH_API_KEY) {
    try {
      result = await withTimeout(fetchLangSearch(env.LANGSEARCH_API_KEY, q, type, page), 3000);
    } catch (e) { errors.push(`LangSearch: ${e.message}`); }
  }

  // 3️⃣ Tavily (Fallback2)
  if (!result && env.TAVILY_API_KEY) {
    try {
      result = await fetchTavily(env.TAVILY_API_KEY, q, type, page);
    } catch (e) { errors.push(`Tavily: ${e.message}`); }
  }

  // 4️⃣ Google CSE (Fallback3)
  if (!result && env.GOOGLE_API_KEY && env.GOOGLE_CX) {
    try {
      result = await fetchGoogle(env.GOOGLE_API_KEY, env.GOOGLE_CX, q, page);
    } catch (e) { errors.push(`Google: ${e.message}`); }
  }

  // 5️⃣ SearXNG (Last resort)
  if (!result && env.SEARXNG_URL) {
    try {
      result = await fetchSearXNG(env.SEARXNG_URL, q, page);
    } catch (e) { errors.push(`SearXNG: ${e.message}`); }
  }

  if (!result) {
    return new Response(
      JSON.stringify({ error: "All search engines failed.", detail: errors.join(" | ") }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  // ── KV mein save karo — fire and forget ────────────────────────────────
  cacheSet(kv, key, result);

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
      "X-Search-Engine": result.searchParameters?.engine || "unknown", ...CORS_HEADERS },
  });
}

// ─── PREFLIGHT ─────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
