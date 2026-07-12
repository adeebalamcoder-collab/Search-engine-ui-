// Cloudflare PAGES FUNCTION
// Path: functions/api/search.js
// Primary:  LangSearch (env.LANGSEARCH_API_KEY)
// Fallback: Serper.dev (env.SERPER_API_KEY)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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
      market: "en-IN",
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

  // 1️⃣ LangSearch (Primary)
  if (env.LANGSEARCH_API_KEY) {
    try {
      const data = await fetchLangSearch(env.LANGSEARCH_API_KEY, q, type, page);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Search-Engine": "langsearch",
          ...CORS_HEADERS,
        },
      });
    } catch (e) { errors.push(`LangSearch: ${e.message}`); }
  }

  // 2️⃣ Serper (Fallback)
  if (env.SERPER_API_KEY) {
    try {
      const data = await fetchSerper(env.SERPER_API_KEY, q, type, page);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Search-Engine": "serper",
          ...CORS_HEADERS,
        },
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
