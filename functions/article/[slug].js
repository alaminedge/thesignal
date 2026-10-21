// functions/article/[slug].js
// Pretty article URLs:  /article/<slug>
//
// Serves the static article.html shell, but with the article's real <title>, description,
// canonical, Open Graph / Twitter tags and NewsArticle JSON-LD injected on the server, so that
// Google, WhatsApp, Facebook, X, LinkedIn etc. see the correct headline and image.
// The article data is also embedded in the page, so it paints immediately with no extra request.
//
// Enabled by _routes.json ("/article/*" is listed there).

const SITE = 'The Pacific Signal';

function attr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function abs(origin, u) {
  if (!u) return origin + '/images/tps.png';
  if (/^https?:\/\//i.test(u)) return u;
  return origin + (u.charAt(0) === '/' ? '' : '/') + u;
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '\u2026' : s;
}

async function loadShell(env, origin, file) {
  var res = await env.ASSETS.fetch(new URL('/' + file, origin));
  // Cloudflare Pages "pretty URLs" may answer /x.html with a redirect to /x — follow it.
  for (var i = 0; i < 3 && res.status >= 300 && res.status < 400; i++) {
    var loc = res.headers.get('Location');
    if (!loc) break;
    res = await env.ASSETS.fetch(new URL(loc, origin));
  }
  return res;
}

export async function onRequestGet(context) {
  var request = context.request, env = context.env;
  var url = new URL(request.url);
  var origin = url.origin;
  var slug = String(context.params.slug || '').toLowerCase();

  var shell = await loadShell(env, origin, 'article.html');

  var article = null, related = [];
  if (env.SIGNAL_DB && /^[a-z0-9-]+$/.test(slug)) {
    try {
      article = await env.SIGNAL_DB.prepare(
        "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.slug = ? AND a.is_published = 1"
      ).bind(slug).first();

      if (article) {
        var rel = await env.SIGNAL_DB.prepare(
          "SELECT a.id, a.title, a.slug, a.excerpt, a.image_url, a.author, a.published_at, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.category_id = ? AND a.id != ? AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 4"
        ).bind(article.category_id, article.id).all();
        related = rel.results || [];
        if (related.length < 4) {
          var ids = [article.id].concat(related.map(function (r) { return r.id; }));
          var fill = await env.SIGNAL_DB.prepare(
            "SELECT a.id, a.title, a.slug, a.excerpt, a.image_url, a.author, a.published_at, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.is_published = 1 AND a.id NOT IN (" + ids.map(function () { return '?'; }).join(',') + ") ORDER BY a.published_at DESC LIMIT ?"
          ).bind(...ids, 4 - related.length).all();
          related = related.concat(fill.results || []);
        }
        // Count the view without delaying the response
        context.waitUntil(
          env.SIGNAL_DB.prepare("UPDATE articles SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?").bind(article.id).run().catch(function () {})
        );
      }
    } catch (e) { article = null; }
  }

  // Unknown slug: keep the shell (it shows a friendly message) but return a real 404 + noindex.
  if (!article) {
    var h404 = new Headers(shell.headers);
    h404.set('Cache-Control', 'no-store');
    return new HTMLRewriter()
      .on('head', { element: function (el) { el.append('<meta name="robots" content="noindex">', { html: true }); } })
      .transform(new Response(shell.body, { status: 404, headers: h404 }));
  }

  var canonical = origin + '/article/' + article.slug;
  var title = article.title + ' \u2014 ' + SITE;
  var desc = clip(article.excerpt || article.content.replace(/<[^>]*>/g, ' '), 200);
  var img = abs(origin, article.image_url);
  var published = article.published_at || article.created_at;
  var modified = article.updated_at || published;

  var ld = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    headline: clip(article.title, 110),
    description: desc,
    image: [img],
    datePublished: published ? new Date(published).toISOString() : undefined,
    dateModified: modified ? new Date(modified).toISOString() : undefined,
    articleSection: article.category_name || undefined,
    author: { '@type': 'Person', name: article.author || SITE },
    publisher: { '@type': 'NewsMediaOrganization', name: SITE, logo: { '@type': 'ImageObject', url: origin + '/images/tps.png' } }
  };

  var meta = ''
    + '<meta name="description" content="' + attr(desc) + '">'
    + '<link rel="canonical" href="' + attr(canonical) + '">'
    + '<meta property="og:type" content="article">'
    + '<meta property="og:site_name" content="' + attr(SITE) + '">'
    + '<meta property="og:title" content="' + attr(article.title) + '">'
    + '<meta property="og:description" content="' + attr(desc) + '">'
    + '<meta property="og:url" content="' + attr(canonical) + '">'
    + '<meta property="og:image" content="' + attr(img) + '">'
    + (published ? '<meta property="article:published_time" content="' + attr(new Date(published).toISOString()) + '">' : '')
    + (article.category_name ? '<meta property="article:section" content="' + attr(article.category_name) + '">' : '')
    + '<meta name="twitter:card" content="summary_large_image">'
    + '<meta name="twitter:title" content="' + attr(article.title) + '">'
    + '<meta name="twitter:description" content="' + attr(desc) + '">'
    + '<meta name="twitter:image" content="' + attr(img) + '">'
    + '<script type="application/ld+json">' + safeJson(ld) + '</script>'
    + '<script>window.__TPS_PRELOAD__=' + safeJson({ article: article, related: related }) + ';</script>';

  var headers = new Headers(shell.headers);
  headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');

  return new HTMLRewriter()
    .on('title', { element: function (el) { el.setInnerContent(title); } })
    .on('head', { element: function (el) { el.append(meta, { html: true }); } })
    .transform(new Response(shell.body, { status: 200, headers: headers }));
}
