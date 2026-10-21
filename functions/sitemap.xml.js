// functions/sitemap.xml.js — /sitemap.xml for Google (home, sections, every published article).
// Enabled by _routes.json ("/sitemap.xml" is listed there).

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function onRequestGet(context) {
  var env = context.env;
  var origin = new URL(context.request.url).origin;
  var urls = [{ loc: origin + '/', freq: 'hourly', pri: '1.0' }];
  ['about', 'archive', 'privacy', 'terms'].forEach(function (p) {
    urls.push({ loc: origin + '/' + p + '.html', freq: 'monthly', pri: '0.3' });
  });

  if (env.SIGNAL_DB) {
    try {
      var cats = await env.SIGNAL_DB.prepare('SELECT slug FROM categories ORDER BY name').all();
      (cats.results || []).forEach(function (c) {
        urls.push({ loc: origin + '/section/' + c.slug, freq: 'hourly', pri: '0.7' });
      });
      var arts = await env.SIGNAL_DB.prepare(
        'SELECT slug, published_at, updated_at FROM articles WHERE is_published = 1 ORDER BY published_at DESC LIMIT 5000'
      ).all();
      (arts.results || []).forEach(function (a) {
        var d = a.updated_at || a.published_at;
        urls.push({ loc: origin + '/article/' + a.slug, mod: d ? new Date(d).toISOString() : null, freq: 'weekly', pri: '0.8' });
      });
    } catch (e) {}
  }

  var xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    + urls.map(function (u) {
      return '<url><loc>' + esc(u.loc) + '</loc>' + (u.mod ? '<lastmod>' + u.mod + '</lastmod>' : '')
        + '<changefreq>' + u.freq + '</changefreq><priority>' + u.pri + '</priority></url>';
    }).join('') + '</urlset>';

  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=900' } });
}
