// Cloudflare PAGES FUNCTION
// Path: functions/api/search.js
// Primary:  Serper.dev (env.SERPER_API_KEY)
// Fallback: LangSearch (env.LANGSEARCH_API_KEY)
// Last:     SearXNG Railway (env.SEARXNG_URL)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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
  const url = mapTypeToSerperEndpoint(type);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q, page, num: 10 }),
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const data = await res.json();
  // Serper already returns Serper-compatible shape
  const hasResults =
    (data.organic?.length > 0) ||
    (data.images?.length  > 0) ||
    (data.news?.length    > 0) ||
    (data.videos?.length  > 0);
  if (!hasResults) throw new Error("Serper empty results");
  data.searchParameters = { q, type, page, engine: "serper", num: 10 };
  return data;
}

// ─── LANGSEARCH ────────────────────────────────────────────────────────────
async function fetchLangSearch(apiKey, q, type, page) {
  const res = await fetch("https://api.langsearch.com/v1/web-search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: q, freshness: "noLimit", summary: false, count: 10 }),
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

// ─── SEARXNG FALLBACK ──────────────────────────────────────────────────────
function mapTypeToSearxCategory(type) {
  switch (type) {
    case "images": return "images";
    case "news":   return "news";
    case "videos": return "videos";
    default:       return "general";
  }
}

function normaliseSearxResult(item, type, position) {
  const base = { title: item.title || "", link: item.url || "", position };
  switch (type) {
    case "images":
      return { ...base, imageUrl: item.img_src || "", thumbnailUrl: item.thumbnail_src || item.img_src || "" };
    case "news":
      return { ...base, snippet: item.content || "", date: item.publishedDate || "", imageUrl: item.img_src || "" };
    case "videos":
      return { ...base, snippet: item.content || "", date: item.publishedDate || "", imageUrl: item.thumbnail_src || "" };
    default:
      return {
        ...base,
        snippet: (item.content || "").slice(0, 150),
        displayLink: item.pretty_url || (() => {
          try { return new URL(item.url).hostname; } catch { return item.url || ""; }
        })(),
      };
  }
}

async function fetchSearXNG(baseUrl, q, type, page) {
  const params = new URLSearchParams({
    q, format: "json",
    categories: mapTypeToSearxCategory(type),
    pageno: String(page),
    safesearch: "0",
  });
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/search?${params}`, {
    headers: { "Accept": "application/json", "User-Agent": "AtkyniSearchProxy/1.0" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.results) || data.results.length === 0) throw new Error("SearXNG empty results");

  const key = type === "images" ? "images" : type === "news" ? "news" : type === "videos" ? "videos" : "organic";
  return {
    searchParameters: { q, type, page, engine: "searxng", num: data.results.length },
    [key]: data.results.map((item, idx) => normaliseSearxResult(item, type, idx + 1)),
    relatedSearches: (data.suggestions || []).slice(0, 8).map(s => ({ query: s })),
  };
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

  // 1️⃣ Serper
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

  // 2️⃣ LangSearch
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

  // 3️⃣ SearXNG Railway
  if (env.SEARXNG_URL) {
    try {
      const data = await fetchSearXNG(env.SEARXNG_URL, q, type, page);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
          "X-Search-Engine": "searxng", ...CORS_HEADERS },
      });
    } catch (e) { errors.push(`SearXNG: ${e.message}`); }
  }

  return new Response(
    JSON.stringify({ error: "All search engines failed.", detail: errors.join(" | ") }),
    { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
