// Cloudflare PAGES FUNCTION
// Path: functions/api/search.js
// Endpoint: https://search-engine-ui-86b.pages.dev/api/search
//
// Supports: web search, images, news, videos
// Body: { q: "query", type: "search"|"images"|"news"|"videos", page: 1 }

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const q    = body.q    || "";
    const type = body.type || "search";
    const page = body.page || 1;

    if (!q.trim()) {
      return new Response(JSON.stringify({ error: "Empty query" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Pick correct Serper endpoint based on type
    let serperEndpoint;
    switch (type) {
      case "images": serperEndpoint = "https://google.serper.dev/images";  break;
      case "news":   serperEndpoint = "https://google.serper.dev/news";    break;
      case "videos": serperEndpoint = "https://google.serper.dev/videos";  break;
      default:       serperEndpoint = "https://google.serper.dev/search";  break;
    }

    const serperRes = await fetch(serperEndpoint, {
      method: "POST",
      headers: {
        "X-API-KEY":     env.SERPER_API_KEY,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ q, page }),
    });

    const data = await serperRes.json();

    return new Response(JSON.stringify(data), {
      status:  serperRes.status,
      headers: {
        "Content-Type":                "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Proxy failed", detail: String(err) }), {
      status:  500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// Handle preflight CORS requests
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
