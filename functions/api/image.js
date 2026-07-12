// Cloudflare PAGES FUNCTION for image search.
// Path: functions/api/images.js
// Primary:  Unsplash (env.UNSPLASH_ACCESS_KEY)
// Fallback1: Pexels (env.PEXELS_API_KEY)
// Fallback2: Tavily (env.TAVILY_API_KEY)
// Fallback3: Serper (env.SERPER_API_KEY)
// Fallback4: LangSearch (env.LANGSEARCH_API_KEY)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ─── UNSPLASH ──────────────────────────────────────────────────────────────
async function fetchUnsplashImages(accessKey, q, page) {
  const params = new URLSearchParams({
    query: q,
    page: String(page),
    per_page: "30",
    orientation: "landscape",
  });
  const res = await fetch(`https://api.unsplash.com/search/photos?${params}`, {
    headers: { "Authorization": `Client-ID ${accessKey}` },
  });
  if (!res.ok) throw new Error(`Unsplash HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.results || [];
  if (results.length === 0) throw new Error("Unsplash empty");
  return results.map((item, idx) => ({
    title:        item.alt_description || item.description || q,
    imageUrl:     item.urls?.regular   || item.urls?.full || "",
    thumbnailUrl: item.urls?.small     || item.urls?.thumb || "",
    link:         item.links?.html     || "",
    source:       "unsplash.com",
    imageWidth:   item.width           || 0,
    imageHeight:  item.height          || 0,
    position:     idx + 1,
  }));
}

// ─── PEXELS ────────────────────────────────────────────────────────────────
async function fetchPexelsImages(apiKey, q, page) {
  const params = new URLSearchParams({
    query: q,
    page: String(page),
    per_page: "30",
    orientation: "landscape",
  });
  const res = await fetch(`https://api.pexels.com/v1/search?${params}`, {
    headers: { "Authorization": apiKey },
  });
  if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
  const data = await res.json();
  const photos = data?.photos || [];
  if (photos.length === 0) throw new Error("Pexels empty");
  return photos.map((item, idx) => ({
    title:        item.alt           || q,
    imageUrl:     item.src?.large    || item.src?.original || "",
    thumbnailUrl: item.src?.medium   || item.src?.small || "",
    link:         item.url           || "",
    source:       "pexels.com",
    imageWidth:   item.width         || 0,
    imageHeight:  item.height        || 0,
    position:     idx + 1,
  }));
}

// ─── TAVILY ────────────────────────────────────────────────────────────────
async function fetchTavilyImages(apiKey, q) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: q,
      search_depth: "basic",
      max_results: 10,
      include_images: true,
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  const imgs = data?.images || [];
  if (imgs.length === 0) throw new Error("Tavily empty images");
  return imgs.map((url, idx) => ({
    title:        q,
    imageUrl:     typeof url === "string" ? url : url.url || "",
    thumbnailUrl: typeof url === "string" ? url : url.url || "",
    link:         typeof url === "string" ? url : url.url || "",
    source:       (() => { try { return new URL(typeof url === "string" ? url : url.url).hostname; } catch { return ""; } })(),
    imageWidth:   0,
    imageHeight:  0,
    position:     idx + 1,
  }));
}

// ─── SERPER ────────────────────────────────────────────────────────────────
async function fetchSerperImages(apiKey, q, page) {
  const res = await fetch("https://google.serper.dev/images", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q, page, num: 100, gl: "in", hl: "en" }),
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const data = await res.json();
  const raw = data?.images || [];
  if (raw.length === 0) throw new Error("Serper empty");
  return raw.map((item, idx) => ({
    title:        item.title        || "",
    imageUrl:     item.imageUrl     || "",
    thumbnailUrl: item.thumbnailUrl || item.imageUrl || "",
    link:         item.link         || "",
    source:       item.source       || "",
    imageWidth:   item.imageWidth   || 0,
    imageHeight:  item.imageHeight  || 0,
    position:     idx + 1,
  }));
}

// ─── LANGSEARCH ────────────────────────────────────────────────────────────
async function fetchLangSearchImages(apiKey, q) {
  const res = await fetch("https://api.langsearch.com/v1/web-search", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, freshness: "noLimit", summary: false, count: 10, market: "en-US" }),
  });
  if (!res.ok) throw new Error(`LangSearch HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 200) throw new Error(`LangSearch error: ${data.msg}`);
  const values = data?.data?.webPages?.value || [];
  if (values.length === 0) throw new Error("LangSearch empty");
  return values.map((item, idx) => ({
    title:        item.name  || "",
    imageUrl:     item.url   || "",
    thumbnailUrl: item.url   || "",
    link:         item.url   || "",
    source:       (() => { try { return new URL(item.url).hostname; } catch { return ""; } })(),
    imageWidth:   0,
    imageHeight:  0,
    position:     idx + 1,
  }));
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

  const q    = (body.q || "").trim();
  const page = Math.max(1, parseInt(body.page, 10) || 1);

  if (!q) {
    return new Response(JSON.stringify({ error: "Empty query." }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  }

  const errors = [];

  // 1️⃣ Unsplash (Primary)
  if (env.UNSPLASH_ACCESS_KEY) {
    try {
      const images = await fetchUnsplashImages(env.UNSPLASH_ACCESS_KEY, q, page);
      return new Response(JSON.stringify({ images, searchParameters: { q, page } }),
        { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
          "X-Search-Engine": "unsplash", ...CORS_HEADERS } });
    } catch (e) { errors.push(`Unsplash: ${e.message}`); }
  }

  // 2️⃣ Pexels
  if (env.PEXELS_API_KEY) {
    try {
      const images = await fetchPexelsImages(env.PEXELS_API_KEY, q, page);
      return new Response(JSON.stringify({ images, searchParameters: { q, page } }),
        { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
          "X-Search-Engine": "pexels", ...CORS_HEADERS } });
    } catch (e) { errors.push(`Pexels: ${e.message}`); }
  }

  // 3️⃣ Tavily
  if (env.TAVILY_API_KEY) {
    try {
      const images = await fetchTavilyImages(env.TAVILY_API_KEY, q);
      return new Response(JSON.stringify({ images, searchParameters: { q, page } }),
        { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
          "X-Search-Engine": "tavily", ...CORS_HEADERS } });
    } catch (e) { errors.push(`Tavily: ${e.message}`); }
  }

  // 4️⃣ Serper (Last resort — credits bachao)
  if (env.SERPER_API_KEY) {
    try {
      const images = await fetchSerperImages(env.SERPER_API_KEY, q, page);
      return new Response(JSON.stringify({ images, searchParameters: { q, page } }),
        { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
          "X-Search-Engine": "serper", ...CORS_HEADERS } });
    } catch (e) { errors.push(`Serper: ${e.message}`); }
  }

  // 5️⃣ LangSearch
  if (env.LANGSEARCH_API_KEY) {
    try {
      const images = await fetchLangSearchImages(env.LANGSEARCH_API_KEY, q);
      return new Response(JSON.stringify({ images, searchParameters: { q, page } }),
        { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
          "X-Search-Engine": "langsearch", ...CORS_HEADERS } });
    } catch (e) { errors.push(`LangSearch: ${e.message}`); }
  }

  return new Response(
    JSON.stringify({ error: "All image engines failed.", detail: errors.join(" | ") }),
    { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}

// ─── PREFLIGHT ─────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
