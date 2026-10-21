// functions/section/[slug].js
// Pretty section URLs:  /section/<category-slug>   (e.g. /section/europe-uk)
// Serves index.html with a proper <title>, description and canonical for that section.
// Enabled by _routes.json ("/section/*" is listed there).

const SITE = 'The Pacific Signal';

function attr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadShell(env, origin, file) {
  var res = await env.ASSETS.fetch(new URL('/' + file, origin));
  for (var i = 0; i < 3 && res.status >= 300 && res.status < 400; i++) {
    var loc = res.headers.get('Location');
    if (!loc) break;
    res = await env.ASSETS.fetch(new URL(loc, origin));
  }
  return res;
}

export async function onRequestGet(context) {
  var env = context.env;
  var url = new URL(context.request.url);
  var origin = url.origin;
  var slug = String(context.params.slug || '').toLowerCase();

  var shell = await loadShell(env, origin, 'index.html');

  var cat = null;
  if (env.SIGNAL_DB && /^[a-z0-9-]+$/.test(slug)) {
    try { cat = await env.SIGNAL_DB.prepare('SELECT name, slug FROM categories WHERE slug = ?').bind(slug).first(); } catch (e) {}
  }

  if (!cat) {
    return new HTMLRewriter()
      .on('head', { element: function (el) { el.append('<meta name="robots" content="noindex">', { html: true }); } })
      .transform(new Response(shell.body, { status: 404, headers: shell.headers }));
  }

  var canonical = origin + '/section/' + cat.slug;
  var title = cat.name + ' \u2014 ' + SITE;
  var desc = 'Latest news, analysis and explained journalism on ' + cat.name + ' from ' + SITE + '.';

  var meta = ''
    + '<meta name="description" content="' + attr(desc) + '">'
    + '<link rel="canonical" href="' + attr(canonical) + '">'
    + '<meta property="og:type" content="website">'
    + '<meta property="og:site_name" content="' + attr(SITE) + '">'
    + '<meta property="og:title" content="' + attr(title) + '">'
    + '<meta property="og:description" content="' + attr(desc) + '">'
    + '<meta property="og:url" content="' + attr(canonical) + '">'
    + '<meta property="og:image" content="' + attr(origin + '/images/tps.png') + '">'
    + '<meta name="twitter:card" content="summary">'
    + '<script>window.__TPS_SECTION__=' + JSON.stringify({ slug: cat.slug, name: cat.name }).replace(/</g, '\\u003c') + ';</script>';

  var headers = new Headers(shell.headers);
  headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');

  return new HTMLRewriter()
    .on('title', { element: function (el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', { element: function (el) { el.remove(); } })
    .on('head', { element: function (el) { el.append(meta, { html: true }); } })
    .transform(new Response(shell.body, { status: 200, headers: headers }));
}
