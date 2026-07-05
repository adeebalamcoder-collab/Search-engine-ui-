// Cloudflare PAGES FUNCTION for image search.
// Path: functions/api/images.js
// Endpoint: POST /api/images
//
// Replaces Serper.dev with SearXNG.
// Requires env variable: SEARXNG_URL (already set for /api/search)
// Body: { q: "...", page: 1, gl: "us", hl: "en", num: 100 }

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const TIMEOUT_MS = 9000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

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

  const q    = (body.q || "").trim();
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
    categories: "images",
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

  // Normalise SearXNG image results into Serper-compatible shape
  const rawResults = Array.isArray(searxData.results) ? searxData.results : [];
  const images = rawResults.map((item, idx) => ({
    title:           item.title          || "",
    imageUrl:        item.img_src        || item.url || "",
    thumbnailUrl:    item.thumbnail_src  || item.img_src || "",
    link:            item.url            || "",
    source:          item.engine         || "",
    imageWidth:      item.resolution_x   || 0,
    imageHeight:     item.resolution_y   || 0,
    thumbnailWidth:  0,
    thumbnailHeight: 0,
    position:        idx + 1,
  }));

  return new Response(
    JSON.stringify({ images, searchParameters: { q, page } }),
    {
      status: 200,
      headers: {
        "Content-Type":  "application/json",
        "Cache-Control": "no-store",
        ...CORS_HEADERS,
      },
    }
  );
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
        }

