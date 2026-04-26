// Cloudflare Worker: CORS proxy for warframe.market.
// Deploy this to a Cloudflare Worker and put its URL in warframe_toolkit.html (API_BASE).
// Free tier handles 100k requests/day — far more than this app needs.
//
// Endpoint pattern:  https://<your-worker>.workers.dev/api/<warframe.market path>
// Whitelisted paths: /v2/items, /v1/items/<slug>/statistics
// Everything else is rejected so the worker can't be abused as a generic proxy.

const ORIGIN = 'https://api.warframe.market';
const ITEMS_PATH = '/v2/items';
const STATS_RE = /^\/v1\/items\/[a-z0-9_-]+\/statistics$/;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404, headers: corsHeaders });
    }

    const apiPath = url.pathname.slice(4); // strip "/api"
    if (apiPath !== ITEMS_PATH && !STATS_RE.test(apiPath)) {
      return new Response('Forbidden path', { status: 403, headers: corsHeaders });
    }

    const target = `${ORIGIN}${apiPath}${url.search}`;
    try {
      const upstream = await fetch(target, {
        cf: { cacheTtl: 300, cacheEverything: true },
        headers: {
          'User-Agent': 'wf-toolkit-proxy',
          'Accept': 'application/json',
          'Language': 'en',
          'Platform': 'pc',
        },
      });

      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};
