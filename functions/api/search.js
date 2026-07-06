// Cloudflare PAGES FUNCTION
// Path: functions/api/search.js
// Endpoint: POST /api/search
//
// Primary: env.SEARXNG_URL (your Railway instance)
// Fallback: 4 public SearXNG instances (called server-side, JSON works fine)
// Body: { q: "query", type: "search"|"images"|"news"|"videos", page: 1 }

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const TIMEOUT_MS = 6000; // per-instance timeout

// ---------------------------------------------------------------------------
// Fallback SearXNG instances — server-side calls, JSON works fine
// ---------------------------------------------------------------------------
const FALLBACK_INSTANCES = [
  "https://searx.be",
  "https://search.mdosch.de",
  "https://searx.tiekoetter.com",
  "https://searxng.site",
  "https://search.rhscz.eu",
  "https://search.pereira.is",
  "https://search.inetol.net",
  "https://xka.cz",
];

// ---------------------------------------------------------------------------
// Map Atkyn type → SearXNG categories
// ---------------------------------------------------------------------------
function mapTypeToCategory(type) {
  switch (type) {
    case "images": return "images";
    case "news":   return "news";
    case "videos": return "videos";
    default:       return "general";
  }
}

// ---------------------------------------------------------------------------
// Normalise SearXNG result → Serper-compatible shape
// ---------------------------------------------------------------------------
function normaliseResult(item, type, position) {
  const base = {
    title:    item.title || "",
    link:     item.url   || "",
    position: position,
  };

  switch (type) {
    case "images":
      return {
        ...base,
        imageUrl:        item.img_src       || item.url || "",
        thumbnailUrl:    item.thumbnail_src || item.img_src || "",
        source:          item.engine        || "",
        imageWidth:      item.resolution_x  || 0,
        imageHeight:     item.resolution_y  || 0,
        thumbnailWidth:  0,
        thumbnailHeight: 0,
      };
    case "news":
      return {
        ...base,
        snippet:  item.content       || "",
        date:     item.publishedDate || "",
        source:   item.engine        || "",
        imageUrl: item.img_src       || item.thumbnail_src || "",
      };
    case "videos":
      return {
        ...base,
        snippet:  item.content       || "",
        date:     item.publishedDate || "",
        imageUrl: item.thumbnail_src || item.img_src || "",
        duration: item.duration      || "",
      };
    default:
      return {
        ...base,
        snippet:     (item.content || "").slice(0, 150),
        displayLink: item.pretty_url || (() => {
          try { return new URL(item.url).hostname; } catch { return item.url || ""; }
        })(),
      };
  }
}

// ---------------------------------------------------------------------------
// Build Serper-compatible envelope
// ---------------------------------------------------------------------------
function buildEnvelope(type, q, page, searxData) {
  const rawResults  = Array.isArray(searxData.results)     ? searxData.results     : [];
  const suggestions = Array.isArray(searxData.suggestions) ? searxData.suggestions : [];
  const answers     = Array.isArray(searxData.answers)     ? searxData.answers     : [];

  const searchParameters = { q, type, page, engine: "searxng", num: rawResults.length };
  const normalised = rawResults.map((item, idx) => normaliseResult(item, type, idx + 1));
  const relatedSearches = suggestions.slice(0, 8).map(s => ({ query: s }));

  switch (type) {
    case "images":
      return { searchParameters, images: normalised, relatedSearches };
    case "news":
      return { searchParameters, news: normalised, relatedSearches };
    case "videos":
      return { searchParameters, videos: normalised, relatedSearches };
    default: {
      const envelope = { searchParameters, organic: normalised, relatedSearches };
      if (answers.length > 0) envelope.answerBox = { answer: answers[0] };
      return envelope;
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch one SearXNG instance with timeout
// Returns parsed JSON or throws
// ---------------------------------------------------------------------------
async function fetchInstance(baseUrl, q, type, page) {
  const params = new URLSearchParams({
    q,
    format:     "json",
    categories: mapTypeToCategory(type),
    pageno:     String(page),
    safesearch: "0", // safesearch off so adult queries also return results
  });

  const url = `${baseUrl.replace(/\/+$/, "")}/search?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Accept":     "application/json",
        "User-Agent": "AtkyniSearchProxy/1.0",
      },
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    // Must parse as JSON object with results array
    if (!data || typeof data !== "object") throw new Error("Invalid JSON response");
    if (!Array.isArray(data.results)) throw new Error("No results array in response");

    // Empty results is valid — return it, don't try next instance
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Try all instances in order — primary first, then fallbacks
// ---------------------------------------------------------------------------
async function fetchWithFallback(primaryUrl, q, type, page) {
  const instances = [primaryUrl, ...FALLBACK_INSTANCES].filter(Boolean);
  const errors = [];

  for (const instance of instances) {
    try {
      const data = await fetchInstance(instance, q, type, page);
      return { data, usedInstance: instance };
    } catch (err) {
      errors.push(`${instance}: ${err.message}`);
      // continue to next instance
    }
  }

  throw new Error(`All instances failed:\n${errors.join("\n")}`);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export async function onRequestPost(context) {
  const { request, env } = context;

  const primaryUrl = (env.SEARXNG_URL || "").replace(/\/+$/, "");

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body." }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const q    = (body.q    || "").trim();
  const type = (body.type || "search").trim();
  const page = Math.max(1, parseInt(body.page, 10) || 1);

  if (!q) {
    return new Response(
      JSON.stringify({ error: "Empty query." }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  try {
    const { data, usedInstance } = await fetchWithFallback(primaryUrl, q, type, page);
    const envelope = buildEnvelope(type, q, page, data);

    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: {
        "Content-Type":                "application/json",
        "Cache-Control":               "no-store",
        "X-SearXNG-Instance":          usedInstance,
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "All search instances failed.", detail: String(err) }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
}

// ---------------------------------------------------------------------------
// Preflight CORS
// ---------------------------------------------------------------------------
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
