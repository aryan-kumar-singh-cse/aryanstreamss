export async function onRequest(context) {
  const { request, env } = context;
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

  const isM3U8 = targetUrl.includes(".m3u8") || targetUrl.includes("m3u8");

  // Check Cloudflare Edge Cache for TS / media segments
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  if (!isM3U8 && request.method === "GET") {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        const newHeaders = new Headers(cachedResponse.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("X-Proxy-Cache", "HIT");
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
          statusText: cachedResponse.statusText,
          headers: newHeaders,
        });
      }
    } catch (_) {}
  }

  const upstreamHeaders = {
    "User-Agent": request.headers.get("User-Agent") ||
      "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };

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

  const range = request.headers.get("Range");
  if (range) upstreamHeaders["Range"] = range;

  try {
    const fetchOptions = {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow",
    };

    if (!isM3U8) {
      fetchOptions.cf = {
        cacheEverything: true,
        cacheTtl: 180,
      };
    }

    const response = await fetch(targetUrl, fetchOptions);

    const contentType = response.headers.get("content-type") || "";
    const isActuallyM3U8 = isM3U8 ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegurl");

    let body;
    if (isActuallyM3U8) {
      let text = await response.text();
      const finalUrl = response.url || targetUrl;
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
      if (
        kl !== "access-control-allow-origin" &&
        kl !== "x-frame-options" &&
        kl !== "content-security-policy" &&
        kl !== "set-cookie" &&
        kl !== "cache-control"
      ) {
        responseHeaders.set(k, v);
      }
    }
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "*");

    if (isActuallyM3U8) {
      responseHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
    } else {
      responseHeaders.set("Cache-Control", "public, max-age=180, s-maxage=180");
      responseHeaders.set("X-Proxy-Cache", "MISS");
    }

    const clientResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

    if (!isActuallyM3U8 && response.status === 200 && request.method === "GET") {
      try {
        if (context && typeof context.waitUntil === "function") {
          context.waitUntil(cache.put(cacheKey, clientResponse.clone()));
        } else {
          cache.put(cacheKey, clientResponse.clone()).catch(() => {});
        }
      } catch (_) {}
    }

    return clientResponse;
  } catch (err) {
    return new Response("Proxy error: " + err.message, {
      status: 502,
      headers: corsHeaders,
    });
  }
}