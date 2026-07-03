// Cloudflare PAGES FUNCTION for image search.
// Save this file at: functions/api/images.js  in your GitHub repo root.
// Deploys automatically at: https://search-engine-ui-86b.pages.dev/api/images
//
// Uses the SAME SERPER_API_KEY environment variable you already set up
// for /api/search — no new variable needed.

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json(); // expects { q: "...", page: 1 }

    const serperRes = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: {
        "X-API-KEY": env.SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await serperRes.json();

    return new Response(JSON.stringify(data), {
      status: serperRes.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Proxy failed", detail: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

