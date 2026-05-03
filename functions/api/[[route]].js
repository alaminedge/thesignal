// functions/api/[[route]].js
// The Pacific Signal — Complete API Handler
// Professional News Analysis Platform

export async function onRequest(context) {

  const { request, env } = context;

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.SIGNAL_DB;

  var body = {};
  if (request.method === 'POST' || request.method === 'PUT') {
    try {
      body = await request.json();
    } catch (e) {}
  }

  function json(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: corsHeaders
    });
  }

  function err(msg, status) {
    return json({ error: msg }, status || 400);
  }

  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 80);
  }

  async function uniqueSlug(baseSlug, table, excludeId) {
    var slug = baseSlug;
    var counter = 1;
    while (true) {
      var existing = await db.prepare(
        'SELECT id FROM ' + table + ' WHERE slug = ? AND id != ?'
      ).bind(slug, excludeId || 0).first();
      if (!existing) break;
      slug = baseSlug + '-' + counter;
      counter = counter + 1;
    }
    return slug;
  }

  // ═══════════════ DATABASE SETUP ═══════════════
  if (db && !globalThis.__pacific_signal_ready) {

    var tables = [
      "CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE IF NOT EXISTS articles (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, excerpt TEXT, content TEXT NOT NULL, image_url TEXT, category_id INTEGER, author TEXT DEFAULT 'The Pacific Signal', display_block TEXT DEFAULT NULL, spotlight_label TEXT, is_pinned INTEGER DEFAULT 0, pin_order INTEGER DEFAULT 0, is_published INTEGER DEFAULT 0, view_count INTEGER DEFAULT 0, published_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, display_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, site_title TEXT DEFAULT 'The Pacific Signal', site_tagline TEXT DEFAULT 'Beyond the Headlines', logo_url TEXT, about_text TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE IF NOT EXISTS subscribers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
    ];

    for (var i = 0; i < tables.length; i++) {
      try { await db.prepare(tables[i]).run(); } catch (e) {}
    }

    var migrations = [
      "ALTER TABLE articles ADD COLUMN display_block TEXT DEFAULT NULL",
      "ALTER TABLE articles ADD COLUMN spotlight_label TEXT",
      "ALTER TABLE articles ADD COLUMN excerpt TEXT",
      "ALTER TABLE articles ADD COLUMN image_url TEXT",
      "ALTER TABLE articles ADD COLUMN is_pinned INTEGER DEFAULT 0",
      "ALTER TABLE articles ADD COLUMN pin_order INTEGER DEFAULT 0",
      "ALTER TABLE articles ADD COLUMN view_count INTEGER DEFAULT 0"
    ];

    for (var j = 0; j < migrations.length; j++) {
      try { await db.prepare(migrations[j]).run(); } catch (e) {}
    }

    try {
      await db.prepare("INSERT OR IGNORE INTO admins (username, password, display_name) VALUES ('admin', 'admin123', 'Editor')").run();
    } catch (e) {}

    try {
      await db.prepare("INSERT OR IGNORE INTO settings (id, site_title, site_tagline) VALUES (1, 'The Pacific Signal', 'Beyond the Headlines')").run();
    } catch (e) {}

    var catCountResult = await db.prepare('SELECT COUNT(*) as count FROM categories').first();
    if (catCountResult && catCountResult.count === 0) {

      var defaultCategories = [
        'United States & Canada',
        'China & East Asia',
        'Europe & UK',
        'Russia & Post-Soviet',
        'Middle East & North Africa',
        'South Asia',
        'Southeast Asia & Oceania',
        'Africa',
        'Latin America & Caribbean',
        'Arctic & Global Commons',
        'Global Markets & Trade',
        'Energy & Commodities',
        'Technology & Business',
        'Science & Health',
        'Cybersecurity & Digital',
        'Climate & Environment',
        'Democracy & Rights',
        'Religion, Culture & Identity',
        'Arts, Media & Sports',
        'Geopolitics & Strategy'
      ];

      for (var k = 0; k < defaultCategories.length; k++) {
        var catSlug = slugify(defaultCategories[k]);
        try {
          await db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').bind(defaultCategories[k], catSlug).run();
        } catch (e) {}
      }
    }

    globalThis.__pacific_signal_ready = true;
  }

  // ═══════════════ PUBLIC ROUTES ═══════════════

  // GET /api/homepage
  if (path === '/api/homepage' && request.method === 'GET') {
    if (!db) return json({ hero: null, feed: [], visual: null, spotlights: [], latest: [] });

    var hero = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'hero' AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 1"
    ).first();

    if (!hero) {
      hero = await db.prepare(
        "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.is_pinned = 1 AND a.is_published = 1 ORDER BY a.pin_order ASC LIMIT 1"
      ).first();
    }

    var feedResult = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'feed' AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 8"
    ).all();

    var visual = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'visual' AND a.is_published = 1 AND a.image_url IS NOT NULL ORDER BY a.published_at DESC LIMIT 1"
    ).first();

    var spotlightsResult = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'spotlight' AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 4"
    ).all();

    var latestResult = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block IS NULL AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 9"
    ).all();

    return json({
      hero: hero || null,
      feed: feedResult.results || [],
      visual: visual || null,
      spotlights: spotlightsResult.results || [],
      latest: latestResult.results || []
    });
  }

  // GET /api/article/:slug
  if (request.method === 'GET' && path.match(/^\/api\/article\/[a-z0-9-]+$/)) {
    if (!db) return err('Article not found', 404);
    var articleSlug = path.split('/')[3];

    var article = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.slug = ? AND a.is_published = 1"
    ).bind(articleSlug).first();

    if (!article) return err('Article not found', 404);

    try {
      await db.prepare('UPDATE articles SET view_count = view_count + 1 WHERE id = ?').bind(article.id).run();
    } catch (e) {}

    var relatedResult = await db.prepare(
      "SELECT id, title, slug, excerpt, image_url, author, published_at FROM articles WHERE category_id = ? AND id != ? AND is_published = 1 ORDER BY published_at DESC LIMIT 3"
    ).bind(article.category_id, article.id).all();

    return json({ article: article, related: relatedResult.results || [] });
  }

  // GET /api/categories
  if (path === '/api/categories' && request.method === 'GET') {
    if (!db) return json([]);
    var catsResult = await db.prepare('SELECT *
