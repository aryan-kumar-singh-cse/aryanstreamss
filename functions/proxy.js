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

  // Build upstream headers — inject correct Referer/Origin based on target CDN
  const upstreamHeaders = {
    "User-Agent": request.headers.get("User-Agent") ||
      "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // FanCode CDN (Akamai hdntl-authenticated streams)
  if (
    targetUrl.includes("fancode.com") ||
    targetUrl.includes("aiv-cdn.net") ||
    targetUrl.includes("aiv-cdn.com") ||
    targetUrl.includes("in-mc-flive") ||
    targetUrl.includes("akamaized.net") ||
    targetUrl.includes("akamaihd.net")
  ) {
    upstreamHeaders["Referer"] = "https://fancode.com/";
    upstreamHeaders["Origin"] = "https://fancode.com";
  }

  // Forward Range header for segment byte-range requests
  const range = request.headers.get("Range");
  if (range) upstreamHeaders["Range"] = range;

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") || "";
    const isM3U8 =
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegurl") ||
      targetUrl.includes(".m3u8");

    let body;
    if (isM3U8) {
      // Rewrite manifest so all segment/key URLs go through this proxy
      let text = await response.text();
      const finalUrl = response.url || targetUrl;
      // Use URL object so we only look at the path — the query string may contain
      // slashes (e.g. in ?acl=/path/to/dir/*) that would corrupt lastIndexOf("/")
      let baseUrl;
      try {
        const u = new URL(finalUrl);
        const pathDir = u.pathname.substring(0, u.pathname.lastIndexOf("/") + 1);
        baseUrl = u.origin + pathDir;
      } catch (_) {
        baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf("/") + 1);
      }
      const proxyBase = url.origin + url.pathname;

      text = text.replace(/^(?!#)(\S+)$/gm, (match) => {
        const trimmed = match.trim();
        if (!trimmed) return match;
        const absolute = trimmed.startsWith("http://") || trimmed.startsWith("https://")
          ? trimmed
          : baseUrl + trimmed;
        return proxyBase + "?url=" + encodeURIComponent(absolute);
      });

      // Also rewrite URI= attributes (e.g. EXT-X-KEY)
      text = text.replace(/URI="([^"]+)"/g, (_m, uri) => {
        const absolute = uri.startsWith("http://") || uri.startsWith("https://")
          ? uri
          : baseUrl + uri;
        return `URI="${proxyBase}?url=${encodeURIComponent(absolute)}"`;
      });

      body = text;
    } else {
      body = response.body;
    }

    const responseHeaders = new Headers();
    for (const [k, v] of response.headers.entries()) {
      const kl = k.toLowerCase();
      if (kl !== "access-control-allow-origin" && kl !== "x-frame-options" && kl !== "content-security-policy") {
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
