// functions/index.js
// Homepage ("/"): serves index.html with the homepage data and a lead-image preload
// already inside the HTML, so the browser can start downloading the lead image
// immediately instead of waiting for JS -> /api/homepage -> render.
// Enabled by adding "/" to _routes.json. If anything fails, the plain static page is served unchanged.

var IMG_PROXY = 'https://wsrv.nl/'; // keep in sync with TPS_IMG_PROXY in assets/site.js
var HERO_WIDTHS = [420, 640, 960, 1280];

function attr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function proxied(u, w) {
  return IMG_PROXY + '?url=' + encodeURIComponent(u) + '&w=' + w + '&q=72&output=webp';
}

export async function onRequestGet(context) {
  var env = context.env;
  var url = new URL(context.request.url);

  // Legacy ?category= links are handled client-side: serve the plain static page
  if (url.searchParams.get('category')) return env.ASSETS.fetch(context.request);

  // Edge cache (60s), same approach as the API: most visitors get the finished HTML instantly
  var edge = null, cacheKey = null;
  try {
    edge = caches.default;
    cacheKey = new Request(url.origin + '/', { method: 'GET' });
    var hit = await edge.match(cacheKey);
    if (hit) return hit;
  } catch (e) { edge = null; }

  // Static shell (index.html) — fetched as "/" so Pages doesn't redirect
  var shell = await env.ASSETS.fetch(context.request);
  if (shell.status !== 200) return shell;

  var data = null;
  try {
    var apiRes = await fetch(new URL('/api/homepage?page=1', url.origin).toString(), {
      headers: { 'Accept': 'application/json' }
    });
    if (apiRes.ok) data = await apiRes.json();
  } catch (e) { data = null; }
  if (!data) return shell;

  var hero = data.hero || (data.latest && data.latest[0]) || null;
  var html = '';

  if (hero && hero.image_url && /^https?:\/\//i.test(hero.image_url)) {
    var srcset = HERO_WIDTHS.map(function (w) { return proxied(hero.image_url, w) + ' ' + w + 'w'; }).join(', ');
    html += '<link rel="preload" as="image" fetchpriority="high" href="' + attr(proxied(hero.image_url, 640)) + '"'
      + ' imagesrcset="' + attr(srcset) + '" imagesizes="(min-width:1000px) 640px, 100vw">';
  }
  html += '<script>window.__homeData=' + JSON.stringify(data)
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ';</script>';

  var headers = new Headers(shell.headers);
  headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');

  // Insert after the viewport meta so <meta charset> stays within the first 1024 bytes
  var out = new HTMLRewriter()
    .on('meta[name="viewport"]', { element: function (el) { el.after(html, { html: true }); } })
    .transform(new Response(shell.body, { status: 200, headers: headers }));

  if (edge && cacheKey) {
    try { context.waitUntil(edge.put(cacheKey, out.clone())); } catch (e) {}
  }
  return out;
}
