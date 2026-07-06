// Cloudflare PAGES FUNCTION
// Path: functions/api/search.js
// Endpoint: POST /api/search
//
// Ordered fallback chain — tries each instance in order, next on failure.
// Last fallback: env.SEARXNG_URL (your own Cloudflare Worker / Railway instance).
//
// Body: { q: "query", type: "search"|"images"|"news"|"videos", page: 1 }

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Map Atkyn type → SearXNG categories param
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
// Normalise a single SearXNG result into the shape the frontend expects.
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
        snippet:     item.content    || "",
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
  const normalised      = rawResults.map((item, idx) => normaliseResult(item, type, idx + 1));
  const relatedSearches = suggestions.slice(0, 8).map(s => ({ query: s }));

  switch (type) {
    case "images": return { searchParameters, images: normalised, relatedSearches };
    case "news":   return { searchParameters, news:   normalised, relatedSearches };
    case "videos": return { searchParameters, videos: normalised, relatedSearches };
    default: {
      const envelope = { searchParameters, organic: normalised, relatedSearches };
      if (answers.length > 0) envelope.answerBox = { answer: answers[0] };
      return envelope;
    }
  }
}

// ---------------------------------------------------------------------------
// Try one SearXNG instance — resolves with parsed data or throws
// ---------------------------------------------------------------------------
async function tryInstance(baseUrl, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = `${baseUrl}/search?${params.toString()}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": "AtkyniSearchProxy/1.0" },
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) throw new Error(`Non-JSON content-type: ${ct}`);

    const data = await res.json();
    if (!Array.isArray(data.results)) throw new Error("No results[] array");

    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export async function onRequestPost(context) {
  const { request, env } = context;

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

  const params = new URLSearchParams({
    q,
    format:     "json",
    categories: mapTypeToCategory(type),
    pageno:     String(page),
    safesearch: "1",
  });

  // ---------------------------------------------------------------------------
  // Ordered fallback chain
  // 1. Railway (your own instance)        ← env.SEARXNG_URL
  // 2. https://search.pereira.is
  // 3. https://search.inetol.net
  // 4. https://searx.tiekoetter.com
  // 5. https://paulgo.io
  // 6. https://xka.cz
  // 7. https://searx.be
  // 8. Cloudflare Worker                  ← env.SEARXNG_URL (same var, last resort)
  //    (if Railway is down, this is the final safety net)
  // ---------------------------------------------------------------------------
  const railwayBase = (env.SEARXNG_URL || "").replace(/\/+$/, "");

  const chain = [
    ...(railwayBase ? [railwayBase] : []),   // 1. your Railway instance
    "https://search.pereira.is",             // 2.
    "https://search.inetol.net",             // 3.
    "https://searx.tiekoetter.com",          // 4.
    "https://paulgo.io",                     // 5.
    "https://xka.cz",                        // 6.
    "https://searx.be",                      // 7.
  ];

  let searxData = null;
  for (const base of chain) {
    try {
      searxData = await tryInstance(base, params);
      break; // got a valid response, stop
    } catch {
      // this instance failed, try next
    }
  }

  // 8. Last resort — Cloudflare Worker (same SEARXNG_URL but via its own /api/search)
  if (!searxData && railwayBase) {
    try {
      const workerRes = await fetch(`${railwayBase}/api/search`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ q, type, page }),
        signal:  AbortSignal.timeout(TIMEOUT_MS),
      });
      if (workerRes.ok) {
        const envelope = await workerRes.json();
        return new Response(JSON.stringify(envelope), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
        });
      }
    } catch { /* final fallback also failed */ }
  }

  if (!searxData) {
    return new Response(
      JSON.stringify({ error: "All search instances failed or timed out." }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  return new Response(JSON.stringify(buildEnvelope(type, q, page, searxData)), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
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
