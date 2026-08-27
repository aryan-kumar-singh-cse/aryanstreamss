export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!targetUrl) {
    return new Response("Missing url parameter", { status: 400, headers: corsHeaders });
  }

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
        "Accept": "*/*",
      },
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") || "";
    const isM3U8 = contentType.includes("mpegurl") || targetUrl.includes(".m3u8");

    let body;
    if (isM3U8) {
      // Rewrite relative URLs in manifests to go through the proxy
      let text = await response.text();
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      const proxyBase = url.origin + url.pathname;

      text = text.replace(/^(?!#)(\S+)$/gm, (match) => {
        // Trim any carriage return (\r) and whitespace from the matched line
        const trimmed = match.trim();
        if (!trimmed) return match;

        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
          // Absolute URL — wrap in proxy
          return proxyBase + "?url=" + encodeURIComponent(trimmed);
        } else {
          // Relative URL — resolve against base, then wrap in proxy
          return proxyBase + "?url=" + encodeURIComponent(baseUrl + trimmed);
        }
      });
      body = text;
    } else {
      body = response.body;
    }

    const responseHeaders = new Headers();
    // Copy safe headers
    for (const [k, v] of response.headers.entries()) {
      const kl = k.toLowerCase();
      if (kl !== "access-control-allow-origin" && kl !== "x-frame-options") {
        responseHeaders.set(k, v);
      }
    }
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "*");

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response("Proxy error: " + err.message, {
      status: 502,
      headers: corsHeaders,
    });
  }
}
