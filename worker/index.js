const UPSTREAM = 'https://waterlevel.ie';
const ALLOWED_ORIGIN = 'https://graza.github.io';
const CACHE_TTL = 900; // 15 minutes, matching OPW's update interval

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// Only proxy valid OPW station CSV paths
const VALID_PATH = /^\/data\/(day|week|month)\/\d+_OD\.csv$/;

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const { pathname } = new URL(request.url);

    if (!VALID_PATH.test(pathname)) {
      return new Response('Not found', { status: 404 });
    }

    const upstreamUrl = `${UPSTREAM}${pathname}`;
    const cache = caches.default;
    const cacheKey = new Request(upstreamUrl);

    let response = await cache.match(cacheKey);

    if (!response) {
      const upstream = await fetch(upstreamUrl, {
        headers: { Referer: UPSTREAM },
      });

      if (!upstream.ok) {
        return new Response('Upstream error', { status: upstream.status });
      }

      response = new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
        },
      });

      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/csv',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
      },
    });
  },
};
