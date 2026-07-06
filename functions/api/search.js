// Cloudflare PAGES FUNCTION
// Path: functions/api/search.js
// Endpoint: POST /api/search
//
// Replaces Serper.dev with SearXNG.
// Requires env variable: SEARXNG_URL (e.g. https://search.inetol.net)
//
// API contract is identical to the previous Serper-backed version.
// Body: { q: "query", type: "search"|"images"|"news"|"videos", page: 1 }

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const TIMEOUT_MS = 9000; // Stay well under Cloudflare's 10 s CPU limit

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
//
// SearXNG JSON result fields (actual, from source):
//   url, title, content, engine, score, category, pretty_url,
//   publishedDate (news/videos), img_src (images), thumbnail_src (images),
//   iframe_src (videos), duration (videos), author (videos/news)
//
// Serper shapes the frontend currently consumes:
//   Web    → { title, link, snippet, displayLink, position }
//   Images → { title, imageUrl, imageWidth, imageHeight, thumbnailUrl,
//               thumbnailWidth, thumbnailHeight, source, link, position }
//   News   → { title, link, snippet, date, source, imageUrl, position }
//   Videos → { title, link, snippet, date, imageUrl, duration, position }
// ---------------------------------------------------------------------------
function normaliseResult(item, type, position) {
  const base = {
    title:    item.title    || "",
    link:     item.url      || "",
    position: position,
  };

  switch (type) {
    case "images":
      return {
        ...base,
        imageUrl:       item.img_src       || item.url || "",
        thumbnailUrl:   item.thumbnail_src || item.img_src || "",
        source:         item.engine        || "",
        // SearXNG does not always provide dimensions; default to 0
        imageWidth:     item.resolution_x  || 0,
        imageHeight:    item.resolution_y  || 0,
        thumbnailWidth:  0,
        thumbnailHeight: 0,
      };

    case "news":
      return {
        ...base,
        snippet:   item.content       || "",
        date:      item.publishedDate || "",
        source:    item.engine        || "",
        imageUrl:  item.img_src       || item.thumbnail_src || "",
      };

    case "videos":
      return {
        ...base,
        snippet:  item.content       || "",
        date:     item.publishedDate || "",
        imageUrl: item.thumbnail_src || item.img_src || "",
        duration: item.duration      || "",
      };

    default: // "search" / general web
      return {
        ...base,
        snippet:     item.content     || "",
        displayLink: item.pretty_url  || (() => {
          try { return new URL(item.url).hostname; } catch { return item.url || ""; }
        })(),
      };
  }
}

// ---------------------------------------------------------------------------
// Build the top-level response envelope that mirrors Serper's shape.
//
// Serper top-level keys used by the frontend (by type):
//   Web    → { searchParameters, organic, answerBox?, knowledgeGraph?, ... }
//   Images → { searchParameters, images }
//   News   → { searchParameters, news }
//   Videos → { searchParameters, videos }
//
// SearXNG top-level keys:
//   query, number_of_results, results[], answers[], corrections[],
//   suggestions[], infoboxes[]
// ---------------------------------------------------------------------------
function buildEnvelope(type, q, page, searxData) {
  const rawResults  = Array.isArray(searxData.results) ? searxData.results : [];
  const suggestions = Array.isArray(searxData.suggestions) ? searxData.suggestions : [];
  const answers     = Array.isArray(searxData.answers)     ? searxData.answers     : [];

  const searchParameters = {
    q,
    type,
    page,
    engine: "searxng",
    num: rawResults.length,
  };

  // Normalise every result with a 1-based position index
  const normalised = rawResults.map((item, idx) => normaliseResult(item, type, idx + 1));

  // Related searches — built from SearXNG suggestions
  const relatedSearches = suggestions.slice(0, 8).map(s => ({ query: s }));

  switch (type) {
    case "images":
      return { searchParameters, images: normalised, relatedSearches };

    case "news":
      return { searchParameters, news: normalised, relatedSearches };

    case "videos":
      return { searchParameters, videos: normalised, relatedSearches };

    default: {
      // Try to surface an answerBox from SearXNG's answers array
      let answerBox;
      if (answers.length > 0) {
        answerBox = { answer: answers[0] };
      }
      const envelope = {
        searchParameters,
        organic: normalised,
        relatedSearches,
      };
      if (answerBox) envelope.answerBox = answerBox;
      return envelope;
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch with an AbortController-based timeout
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export async function onRequestPost(context) {
  const { request, env } = context;

  // Validate SEARXNG_URL is configured
  const searxngBase = (env.SEARXNG_URL || "").replace(/\/+$/, "");
  if (!searxngBase) {
    return new Response(
      JSON.stringify({ error: "SEARXNG_URL environment variable is not set." }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

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

  // Build SearXNG request URL
  const params = new URLSearchParams({
    q,
    format:     "json",
    categories: mapTypeToCategory(type),
    pageno:     String(page),
    safesearch: "1",
  });

  const searxngUrl = `${searxngBase}/search?${params.toString()}`;

  let searxRes;
  try {
    searxRes = await fetchWithTimeout(
      searxngUrl,
      {
        method: "GET",
        headers: {
          "Accept":     "application/json",
          "User-Agent": "AtkyniSearchProxy/1.0",
        },
      },
      TIMEOUT_MS
    );
  } catch (err) {
    const isTimeout = err && err.name === "AbortError";
    return new Response(
      JSON.stringify({
        error:  isTimeout ? "SearXNG request timed out." : "Failed to reach SearXNG.",
        detail: String(err),
      }),
      { status: 504, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  // Handle non-200 from SearXNG
  if (!searxRes.ok) {
    let detail = "";
    try { detail = await searxRes.text(); } catch { /* ignore */ }
    return new Response(
      JSON.stringify({
        error:  `SearXNG returned HTTP ${searxRes.status}.`,
        detail: detail.slice(0, 500),
      }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  let searxData;
  try {
    searxData = await searxRes.json();
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "SearXNG returned non-JSON response.", detail: String(err) }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  // Build Serper-compatible envelope and return
  const envelope = buildEnvelope(type, q, page, searxData);

  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: {
      "Content-Type":                "application/json",
      "Cache-Control":               "no-store",
      ...CORS_HEADERS,
    },
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
