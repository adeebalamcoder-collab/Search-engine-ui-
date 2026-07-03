// Cloudflare PAGES FUNCTION (not a separate Worker).
// Save this file at: functions/api/search.js  in your GitHub repo root.
// Cloudflare Pages auto-detects the /functions folder and deploys this
// as a serverless endpoint at:  https://search-engine-ui-86b.pages.dev/api/search
//
// SETUP:
// 1. In your repo, create the folder path "functions/api/" and add this file as "search.js"
// 2. Push to GitHub -> Cloudflare Pages auto-redeploys (few seconds, since it's already connected)
// 3. In the Cloudflare Pages dashboard -> your project -> Settings -> Environment variables:
//      Add variable: SERPER_API_KEY = <your NEW rotated Serper key>
//      (Do this for both "Production" and "Preview" environments, then redeploy)
// 4. In search.html, change the fetch URL to a RELATIVE path: '/api/search'
//    (see notes at bottom of this file)

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json(); // expects { q: "...", page: 1 }

    const serperRes = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": env.SERPER_API_KEY, // stays server-side, never reaches the browser
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

/*
CHANGE IN search.html:

Find (old, direct call to Serper):

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, page })
  });

Replace with (relative path — same domain, no CORS issue at all):

  const res = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, page })
  });

Also DELETE the SERPER_API_KEY constant from search.html completely.
*/
