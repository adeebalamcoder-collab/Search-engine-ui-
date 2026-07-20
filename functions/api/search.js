// Cloudflare PAGES FUNCTION
// Path: functions/api/search.js
// Primary:   Google CSE (env.GOOGLE_API_KEY + env.GOOGLE_CX) — 100/day free
// Fallback1: SearXNG    (env.SEARXNG_URL)
// Fallback2: LangSearch (env.LANGSEARCH_API_KEY)
// Fallback3: Tavily     (env.TAVILY_API_KEY)
// Last:      Serper     (env.SERPER_API_KEY)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ─── GOOGLE CSE ────────────────────────────────────────────────────────────
async function fetchGoogle(apiKey, cx, q, page) {
  const start = (page - 1) * 10 + 1;
  const params = new URLSearchParams({
    key: apiKey,
    cx,
    q,
    start: String(start),
    num: "10",
  });
  const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
  if (!res.ok) throw new Error(`Google CSE HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Google CSE error: ${data.error.message}`);
  const items = data?.items || [];
  if (items.length === 0) throw new Error("Google CSE empty results");

  const organic = items.map((item, idx) => ({
    title:       item.title          || "",
    link:        item.link           || "",
    snippet:     item.snippet        || "",
    displayLink: item.displayLink    || "",
    position:    start + idx,
  }));

  return {
    searchParameters: { q, page, engine: "google", num: organic.length },
    organic,
    relatedSearches: [],
  };
}

// ─── SEARXNG ───────────────────────────────────────────────────────────────
async function fetchSearXNG(baseUrl, q, page) {
  const params = new URLSearchParams({
    q,
    format: "json",
    pageno: String(page),
  });
  const res = await fetch(`${baseUrl}/search?${params}`, {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.results || [];
  if (results.length === 0) throw new Error("SearXNG empty results");

  const organic = results.map((item, idx) => ({
    title:       item.title   || "",
    link:        item.url     || "",
    snippet:     item.content || "",
    displayLink: (() => {
      try { return new URL(item.url).hostname; } catch { return item.url || ""; }
    })(),
    position: idx + 1,
  }));

  return {
    searchParameters: { q, page, engine: "searxng", num: organic.length },
    organic,
    relatedSearches: [],
  };
}

// ─── LANGSEARCH ────────────────────────────────────────────────────────────
async function fetchLangSearch(apiKey, q, type, page) {
  const res = await fetch("https://api.langsearch.com/v1/web-search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: q,
      freshness: "noLimit",
      summary: false,
      count: 10,
      market: "en-US",
      setLang: "en",
      lang: "en",
    }),
  });
  if (!res.ok) throw new Error(`LangSearch HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 200) throw new Error(`LangSearch error: ${data.msg}`);

  const values = data?.data?.webPages?.value || [];
  if (values.length === 0) throw new Error("LangSearch empty results");

  const organic = values.map((item, idx) => ({
    title:       item.name    || "",
    link:        item.url     || "",
    snippet:     item.snippet || "",
    displayLink: item.displayUrl || (() => {
      try { return new URL(item.url).hostname; } catch { return item.url || ""; }
    })(),
    position: idx + 1,
  }));

  return {
    searchParameters: { q, type, page, engine: "langsearch", num: organic.length },
    organic,
    relatedSearches: [],
  };
}

// ─── TAVILY ────────────────────────────────────────────────────────────────
async function fetchTavily(apiKey, q, type, page) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: q,
      search_depth: "basic",
      max_results: 10,
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.results || [];
  if (results.length === 0) throw new Error("Tavily empty results");

  const organic = results.map((item, idx) => ({
    title:       item.title   || "",
    link:        item.url     || "",
    snippet:     item.content || "",
    displayLink: (() => {
      try { return new URL(item.url).hostname; } catch { return item.url || ""; }
    })(),
    position: idx + 1,
  }));

  return {
    searchParameters: { q, type, page, engine: "tavily", num: organic.length },
    organic,
    relatedSearches: [],
  };
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
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q, page, num: 10, gl: "in", hl: "en" }),
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const data = await res.json();
  const hasResults =
    (data.organic?.length > 0) ||
    (data.images?.length  > 0) ||
    (data.news?.length    > 0) ||
    (data.videos?.length  > 0);
  if (!hasResults) throw new Error("Serper empty results");
  data.searchParameters = { q, type, page, engine: "serper", num: 10 };
  return data;
}

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

  // 1️⃣ Google CSE (Primary — 100/day free)
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

  // 2️⃣ SearXNG (Fallback1)
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

  // 3️⃣ LangSearch (Fallback2)
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

  // 4️⃣ Tavily (Fallback3)
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

// ─── PREFLIGHT ─────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
