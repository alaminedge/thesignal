// functions/api/[[route]].js
// The Pacific Signal — Complete API Handler
// Professional News Analysis Platform
// Beyond the Headlines
//
// SECURITY NOTE: Auth now uses hand-rolled JWT (HMAC-SHA256 via crypto.subtle)
// and SHA-256 password hashing instead of plaintext + substring checks.
// Set an env var JWT_SECRET in Cloudflare Pages settings for production use.
// A fallback secret is used only so local/dev deploys don't crash — change it.

const FALLBACK_SECRET = 'pacific-signal-dev-secret-change-me-in-cloudflare-env';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
  const secret = env.JWT_SECRET || FALLBACK_SECRET;

  var body = {};
  if (request.method === 'POST' || request.method === 'PUT') {
    try {
      body = await request.json();
    } catch (e) {
      // No JSON body or invalid JSON
    }
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

  function xmlResponse(xml, status) {
    return new Response(xml, {
      status: status || 200,
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  // ══════════════════════════════════════════════════════════════
  // CRYPTO HELPERS — hand-rolled, crypto.subtle only, no libraries
  // ══════════════════════════════════════════════════════════════

  function toBase64Url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    var bin = atob(str);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function utf8Bytes(str) {
    return new TextEncoder().encode(str);
  }

  async function sha256Hex(str) {
    var digest = await crypto.subtle.digest('SHA-256', utf8Bytes(str));
    var bytes = new Uint8Array(digest);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }

  async function hmacKey() {
    return crypto.subtle.importKey(
      'raw',
      utf8Bytes(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );
  }

  // signToken(payload) -> header.payload.signature (JWT-shaped, HMAC-SHA256)
  async function signToken(payload) {
    var header = { alg: 'HS256', typ: 'JWT' };
    var headerPart = toBase64Url(utf8Bytes(JSON.stringify(header)));
    var payloadPart = toBase64Url(utf8Bytes(JSON.stringify(payload)));
    var signingInput = headerPart + '.' + payloadPart;
    var key = await hmacKey();
    var sig = await crypto.subtle.sign('HMAC', key, utf8Bytes(signingInput));
    var sigPart = toBase64Url(new Uint8Array(sig));
    return signingInput + '.' + sigPart;
  }

  // verifyToken(token) -> payload object if valid & unexpired, else null
  async function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    var parts = token.split('.');
    if (parts.length !== 3) return null;

    var signingInput = parts[0] + '.' + parts[1];
    var key = await hmacKey();

    var validSig;
    try {
      validSig = await crypto.subtle.verify('HMAC', key, fromBase64Url(parts[2]), utf8Bytes(signingInput));
    } catch (e) {
      return null;
    }
    if (!validSig) return null;

    var payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1])));
    } catch (e) {
      return null;
    }

    if (!payload.exp || Date.now() > payload.exp) return null;

    return payload;
  }

  function extractBearer(request) {
    var authHeader = request.headers.get('Authorization') || '';
    var match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
  }

  async function getAdminUser(request) {
    var token = extractBearer(request);
    if (!token) return null;
    var payload = await verifyToken(token);
    if (!payload || payload.role !== 'admin') return null;
    return payload;
  }

  // Helper function to create URL-friendly slug
  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 80);
  }

  // Helper function to ensure unique slug in database
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

  function escapeXml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // ══════════════════════════════════════════════════════════════
  // DATABASE SETUP — Create all tables if they don't exist
  // ══════════════════════════════════════════════════════════════

  if (db && !globalThis.__pacific_signal_db_v2) {

    try {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    } catch (e) {}

    try {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS articles (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, excerpt TEXT, content TEXT NOT NULL, image_url TEXT, category_id INTEGER, author TEXT DEFAULT 'The Pacific Signal', display_block TEXT DEFAULT NULL, spotlight_label TEXT, is_pinned INTEGER DEFAULT 0, pin_order INTEGER DEFAULT 0, is_published INTEGER DEFAULT 0, view_count INTEGER DEFAULT 0, published_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    } catch (e) {}

    try {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, display_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    } catch (e) {}

    try {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, site_title TEXT DEFAULT 'The Pacific Signal', site_tagline TEXT DEFAULT 'Beyond the Headlines', logo_url TEXT, about_text TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    } catch (e) {}

    try {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS subscribers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    } catch (e) {}

    // Safe migrations for existing databases
    var migrationList = [
      "ALTER TABLE articles ADD COLUMN display_block TEXT DEFAULT NULL",
      "ALTER TABLE articles ADD COLUMN spotlight_label TEXT",
      "ALTER TABLE articles ADD COLUMN excerpt TEXT",
      "ALTER TABLE articles ADD COLUMN image_url TEXT",
      "ALTER TABLE articles ADD COLUMN is_pinned INTEGER DEFAULT 0",
      "ALTER TABLE articles ADD COLUMN pin_order INTEGER DEFAULT 0",
      "ALTER TABLE articles ADD COLUMN view_count INTEGER DEFAULT 0",
      "ALTER TABLE articles ADD COLUMN author TEXT DEFAULT 'The Pacific Signal'"
    ];

    for (var i = 0; i < migrationList.length; i++) {
      try { await db.prepare(migrationList[i]).run(); } catch (e) {}
    }

    // Lean indexes — only on columns actually filtered/sorted by in hot paths
    try { await db.prepare("CREATE INDEX IF NOT EXISTS idx_articles_pub ON articles(is_published, published_at)").run(); } catch (e) {}
    try { await db.prepare("CREATE INDEX IF NOT EXISTS idx_articles_block ON articles(display_block, is_published)").run(); } catch (e) {}
    try { await db.prepare("CREATE INDEX IF NOT EXISTS idx_articles_views ON articles(view_count)").run(); } catch (e) {}

    // Seed default admin — password stored as SHA-256 hash, not plaintext
    try {
      var defaultHash = await sha256Hex('admin123');
      await db.prepare(
        "INSERT OR IGNORE INTO admins (username, password, display_name) VALUES ('admin', ?, 'Editor')"
      ).bind(defaultHash).run();
    } catch (e) {}

    // If an old plaintext password ('admin123' stored raw) exists from a prior
    // deploy of this file, upgrade it to a hash automatically.
    try {
      var legacyAdmin = await db.prepare("SELECT id, password FROM admins WHERE username = 'admin'").first();
      if (legacyAdmin && legacyAdmin.password === 'admin123') {
        var upgradedHash = await sha256Hex('admin123');
        await db.prepare("UPDATE admins SET password = ? WHERE id = ?").bind(upgradedHash, legacyAdmin.id).run();
      }
    } catch (e) {}

    try {
      await db.prepare(
        "INSERT OR IGNORE INTO settings (id, site_title, site_tagline) VALUES (1, 'The Pacific Signal', 'Beyond the Headlines')"
      ).run();
    } catch (e) {}

    var categoryCountResult = await db.prepare('SELECT COUNT(*) as count FROM categories').first();

    if (categoryCountResult && categoryCountResult.count === 0) {
      var defaultCategoryNames = [
        'United States & Canada', 'China & East Asia', 'Europe & UK', 'Russia & Post-Soviet',
        'Middle East & North Africa', 'South Asia', 'Southeast Asia & Oceania', 'Africa',
        'Latin America & Caribbean', 'Arctic & Global Commons', 'Global Markets & Trade',
        'Energy & Commodities', 'Technology & Business', 'Science & Health', 'Cybersecurity & Digital',
        'Climate & Environment', 'Democracy & Rights', 'Religion, Culture & Identity',
        'Arts, Media & Sports', 'Geopolitics & Strategy'
      ];

      for (var j = 0; j < defaultCategoryNames.length; j++) {
        var categoryName = defaultCategoryNames[j];
        var categorySlug = slugify(categoryName);
        try {
          await db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').bind(categoryName, categorySlug).run();
        } catch (e) {}
      }
    }

    globalThis.__pacific_signal_db_v2 = true;
  }

  // ══════════════════════════════════════════════════════════════
  // PUBLIC API ROUTES — No authentication required
  // ══════════════════════════════════════════════════════════════

  if (path === '/api/homepage' && request.method === 'GET') {
    if (!db) return json({ hero: null, feed: [], visual: null, spotlights: [], latest: [] });

    var heroArticle = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'hero' AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 1"
    ).first();

    if (!heroArticle) {
      heroArticle = await db.prepare(
        "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.is_pinned = 1 AND a.is_published = 1 ORDER BY a.pin_order ASC LIMIT 1"
      ).first();
    }

    var feedArticlesResult = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'feed' AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 8"
    ).all();

    var visualArticle = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'visual' AND a.is_published = 1 AND a.image_url IS NOT NULL ORDER BY a.published_at DESC LIMIT 1"
    ).first();

    var spotlightsResult = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'spotlight' AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 4"
    ).all();

    var latestResult = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block IS NULL AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 9"
    ).all();

    var mostReadResult = await db.prepare(
      "SELECT a.id, a.title, a.slug, a.view_count, c.name as category_name FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.is_published = 1 ORDER BY a.view_count DESC, a.published_at DESC LIMIT 5"
    ).all();

    return json({
      hero: heroArticle || null,
      feed: feedArticlesResult.results || [],
      visual: visualArticle || null,
      spotlights: spotlightsResult.results || [],
      latest: latestResult.results || [],
      most_read: mostReadResult.results || []
    });
  }

  // GET /api/most-read — standalone, usable on any page (e.g. category pages)
  if (path === '/api/most-read' && request.method === 'GET') {
    if (!db) return json([]);
    var mr = await db.prepare(
      "SELECT a.id, a.title, a.slug, a.view_count, c.name as category_name FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.is_published = 1 ORDER BY a.view_count DESC, a.published_at DESC LIMIT 5"
    ).all();
    return json(mr.results || []);
  }

  // GET /api/search?q=... — lightweight LIKE search, no extra tables/indexes
  if (path === '/api/search' && request.method === 'GET') {
    if (!db) return json({ query: '', results: [] });
    var q = (url.searchParams.get('q') || '').trim();
    if (!q || q.length < 2) return json({ query: q, results: [] });

    var likeTerm = '%' + q.replace(/[%_]/g, '') + '%';
    var searchResult = await db.prepare(
      "SELECT a.id, a.title, a.slug, a.excerpt, a.image_url, a.author, a.published_at, c.name as category_name FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.is_published = 1 AND (a.title LIKE ? OR a.excerpt LIKE ?) ORDER BY a.published_at DESC LIMIT 20"
    ).bind(likeTerm, likeTerm).all();

    return json({ query: q, results: searchResult.results || [] });
  }

  // GET /api/rss.xml — RSS 2.0 feed, generated on the fly from existing data
  if (path === '/api/rss.xml' && request.method === 'GET') {
    if (!db) return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel></channel></rss>');

    var siteInfo = await db.prepare('SELECT * FROM settings WHERE id = 1').first();
    var feedArticles = await db.prepare(
      "SELECT title, slug, excerpt, author, published_at FROM articles WHERE is_published = 1 ORDER BY published_at DESC LIMIT 30"
    ).all();

    var siteOrigin = url.origin;
    var siteTitle = (siteInfo && siteInfo.site_title) || 'The Pacific Signal';
    var siteTagline = (siteInfo && siteInfo.site_tagline) || 'Beyond the Headlines';

    var items = (feedArticles.results || []).map(function (a) {
      var link = siteOrigin + '/article.html?slug=' + encodeURIComponent(a.slug);
      var pubDate = a.published_at ? new Date(a.published_at).toUTCString() : new Date().toUTCString();
      return '<item>'
        + '<title>' + escapeXml(a.title) + '</title>'
        + '<link>' + escapeXml(link) + '</link>'
        + '<guid>' + escapeXml(link) + '</guid>'
        + '<description>' + escapeXml(a.excerpt || '') + '</description>'
        + '<author>' + escapeXml(a.author || siteTitle) + '</author>'
        + '<pubDate>' + pubDate + '</pubDate>'
        + '</item>';
    }).join('');

    var rss = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<rss version="2.0"><channel>'
      + '<title>' + escapeXml(siteTitle) + '</title>'
      + '<link>' + escapeXml(siteOrigin) + '</link>'
      + '<description>' + escapeXml(siteTagline) + '</description>'
      + '<language>en-us</language>'
      + items
      + '</channel></rss>';

    return xmlResponse(rss);
  }

  if (request.method === 'GET' && path.match(/^\/api\/article\/[a-z0-9-]+$/)) {
    if (!db) return err('Article not found', 404);

    var requestedSlug = path.split('/')[3];

    var article = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.slug = ? AND a.is_published = 1"
    ).bind(requestedSlug).first();

    if (!article) return err('Article not found', 404);

    try {
      await db.prepare('UPDATE articles SET view_count = view_count + 1 WHERE id = ?').bind(article.id).run();
    } catch (e) {}

    var relatedArticlesResult = await db.prepare(
      "SELECT id, title, slug, excerpt, image_url, author, published_at FROM articles WHERE category_id = ? AND id != ? AND is_published = 1 ORDER BY published_at DESC LIMIT 3"
    ).bind(article.category_id, article.id).all();

    return json({ article: article, related: relatedArticlesResult.results || [] });
  }

  if (path === '/api/categories' && request.method === 'GET') {
    if (!db) return json([]);
    var allCategoriesResult = await db.prepare('SELECT * FROM categories ORDER BY name ASC').all();
    return json(allCategoriesResult.results || []);
  }

  if (request.method === 'GET' && path.match(/^\/api\/category\/[a-z0-9-]+$/)) {
    if (!db) return json({ category: null, articles: [] });

    var categorySlugParam = path.split('/')[3];
    var pageNumber = parseInt(url.searchParams.get('page') || '1');
    var pageLimit = 12;
    var pageOffset = (pageNumber - 1) * pageLimit;

    var categoryInfo = await db.prepare('SELECT * FROM categories WHERE slug = ?').bind(categorySlugParam).first();
    if (!categoryInfo) return err('Category not found', 404);

    var categoryArticlesResult = await db.prepare(
      "SELECT a.*, c.name as category_name FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.category_id = ? AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT ? OFFSET ?"
    ).bind(categoryInfo.id, pageLimit, pageOffset).all();

    var articlesList = categoryArticlesResult.results || [];

    return json({
      category: categoryInfo,
      articles: articlesList,
      page: pageNumber,
      hasMore: articlesList.length === pageLimit
    });
  }

  if (path === '/api/subscribe' && request.method === 'POST') {
    var subscriberEmail = body.email;
    if (!subscriberEmail) return err('Email is required');
    if (!db) return json({ message: 'Subscribed successfully!' }, 201);

    try {
      await db.prepare('INSERT INTO subscribers (email) VALUES (?)').bind(subscriberEmail.toLowerCase().trim()).run();
      return json({ message: 'Subscribed successfully!' }, 201);
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) return err('This email is already subscribed');
      return err('Error subscribing. Please try again.');
    }
  }

  // ══════════════════════════════════════════════════════════════
  // ADMIN AUTH ROUTES
  // ══════════════════════════════════════════════════════════════

  if (path === '/api/admin/login' && request.method === 'POST') {
    var adminUsername = body.username;
    var adminPassword = body.password;

    if (!adminUsername || !adminPassword) return err('Username and password are required');
    if (!db) return err('Database not configured', 500);

    var adminRecord = await db.prepare('SELECT * FROM admins WHERE username = ?').bind(adminUsername).first();
    if (!adminRecord) return err('Invalid credentials', 401);

    var attemptHash = await sha256Hex(adminPassword);
    if (attemptHash !== adminRecord.password) return err('Invalid credentials', 401);

    var token = await signToken({
      id: adminRecord.id,
      username: adminRecord.username,
      role: 'admin',
      exp: Date.now() + TOKEN_TTL_MS
    });

    return json({
      token: token,
      admin: {
        id: adminRecord.id,
        username: adminRecord.username,
        display_name: adminRecord.display_name
      }
    });
  }

  // ══════════════════════════════════════════════════════════════
  // ADMIN ROUTES — Authentication required (real JWT verification)
  // ══════════════════════════════════════════════════════════════

  if (path.startsWith('/api/admin/')) {

    var currentAdmin = await getAdminUser(request);
    if (!currentAdmin) return err('Unauthorized — Please sign in', 401);

    var adminRoutePath = path.replace('/api/admin', '');

    // ────────────────────────────────────────────────────────
    // PUT /api/admin/password — change the signed-in admin's password
    // ────────────────────────────────────────────────────────
    if (adminRoutePath === '/password' && request.method === 'PUT') {
      var currentPassword = body.current_password;
      var newPassword = body.new_password;

      if (!currentPassword || !newPassword) return err('Current and new password are required');
      if (newPassword.length < 8) return err('New password must be at least 8 characters');
      if (!db) return json({ message: 'Password updated (test mode)' });

      var adminRow = await db.prepare('SELECT * FROM admins WHERE id = ?').bind(currentAdmin.id).first();
      if (!adminRow) return err('Admin not found', 404);

      var currentHash = await sha256Hex(currentPassword);
      if (currentHash !== adminRow.password) return err('Current password is incorrect', 401);

      var newHash = await sha256Hex(newPassword);
      await db.prepare('UPDATE admins SET password = ? WHERE id = ?').bind(newHash, currentAdmin.id).run();

      return json({ message: 'Password updated successfully' });
    }

    // ══════════════════════════════════════════════════════════
    // ARTICLES MANAGEMENT
    // ══════════════════════════════════════════════════════════

    if (adminRoutePath === '/articles' && request.method === 'GET') {
      if (!db) return json([]);
      var articlesListResult = await db.prepare(
        "SELECT a.*, c.name as category_name FROM articles a LEFT JOIN categories c ON a.category_id = c.id ORDER BY a.created_at DESC"
      ).all();
      return json(articlesListResult.results || []);
    }

    if (adminRoutePath === '/articles' && request.method === 'POST') {
      var newTitle = body.title;
      var newCustomSlug = body.slug || null;
      var newExcerpt = body.excerpt || '';
      var newContent = body.content || '';
      var newImageUrl = body.image_url || null;
      var newCategoryId = body.category_id || null;
      var newAuthor = body.author || 'The Pacific Signal';
      var newDisplayBlock = body.display_block || null;
      var newSpotlightLabel = body.spotlight_label || null;
      var newIsPinned = body.is_pinned || 0;
      var newIsPublished = body.is_published || 0;

      if (!newTitle) return err('Title is required');
      if (!newContent) return err('Content is required');

      var finalArticleSlug = newCustomSlug ? slugify(newCustomSlug) : slugify(newTitle);
      if (!finalArticleSlug) finalArticleSlug = 'article-' + Date.now();
      finalArticleSlug = await uniqueSlug(finalArticleSlug, 'articles', 0);

      if (!db) return json({ id: Date.now(), slug: finalArticleSlug, message: 'Article created (test mode)' }, 201);

      var assignedPinOrder = 0;

      if (newIsPinned) {
        var currentPinnedCountResult = await db.prepare('SELECT COUNT(*) as count FROM articles WHERE is_pinned = 1').first();
        if (currentPinnedCountResult && currentPinnedCountResult.count >= 2) {
          await db.prepare('UPDATE articles SET is_pinned = 0, pin_order = 0 WHERE is_pinned = 1 ORDER BY pin_order DESC LIMIT 1').run();
        }
        var maxPinOrderResult = await db.prepare('SELECT MAX(pin_order) as max_order FROM articles WHERE is_pinned = 1').first();
        assignedPinOrder = (maxPinOrderResult && maxPinOrderResult.max_order !== null) ? maxPinOrderResult.max_order + 1 : 0;
      }

      var publishDate = newIsPublished ? new Date().toISOString() : null;

      try {
        var insertResult = await db.prepare(
          "INSERT INTO articles (title, slug, excerpt, content, image_url, category_id, author, display_block, spotlight_label, is_pinned, pin_order, is_published, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          newTitle, finalArticleSlug, newExcerpt, newContent, newImageUrl, newCategoryId, newAuthor,
          newDisplayBlock, newSpotlightLabel, newIsPinned ? 1 : 0, assignedPinOrder, newIsPublished ? 1 : 0, publishDate
        ).run();

        return json({ id: insertResult.meta.last_row_id, slug: finalArticleSlug, message: 'Article created successfully' }, 201);
      } catch (e) {
        return err('Database error: ' + e.message, 500);
      }
    }

    if (request.method === 'PUT' && adminRoutePath.match(/^\/articles\/\d+$/)) {
      var updateArticleId = parseInt(adminRoutePath.split('/')[2]);
      if (!db) return json({ message: 'Article updated (test mode)' });

      var updateFields = [];
      var updateValues = [];

      if (body.title !== undefined) { updateFields.push('title = ?'); updateValues.push(body.title); }

      if (body.slug !== undefined) {
        var updatedSlug = body.slug ? slugify(body.slug) : (body.title ? slugify(body.title) : null);
        if (updatedSlug) {
          updatedSlug = await uniqueSlug(updatedSlug, 'articles', updateArticleId);
          updateFields.push('slug = ?'); updateValues.push(updatedSlug);
        }
      }

      if (body.excerpt !== undefined) { updateFields.push('excerpt = ?'); updateValues.push(body.excerpt); }
      if (body.content !== undefined) { updateFields.push('content = ?'); updateValues.push(body.content); }
      if (body.image_url !== undefined) { updateFields.push('image_url = ?'); updateValues.push(body.image_url); }
      if (body.category_id !== undefined) { updateFields.push('category_id = ?'); updateValues.push(body.category_id); }
      if (body.author !== undefined) { updateFields.push('author = ?'); updateValues.push(body.author); }
      if (body.display_block !== undefined) { updateFields.push('display_block = ?'); updateValues.push(body.display_block); }
      if (body.spotlight_label !== undefined) { updateFields.push('spotlight_label = ?'); updateValues.push(body.spotlight_label); }

      if (body.is_pinned !== undefined) {
        var updatedPinOrder = 0;
        if (body.is_pinned) {
          var existingArticle = await db.prepare('SELECT is_pinned, pin_order FROM articles WHERE id = ?').bind(updateArticleId).first();
          if (!existingArticle || !existingArticle.is_pinned) {
            var currentPinCount = await db.prepare('SELECT COUNT(*) as count FROM articles WHERE is_pinned = 1 AND id != ?').bind(updateArticleId).first();
            if (currentPinCount && currentPinCount.count >= 2) {
              await db.prepare('UPDATE articles SET is_pinned = 0, pin_order = 0 WHERE is_pinned = 1 ORDER BY pin_order DESC LIMIT 1').run();
            }
            var currentMaxPin = await db.prepare('SELECT MAX(pin_order) as max_order FROM articles WHERE is_pinned = 1 AND id != ?').bind(updateArticleId).first();
            updatedPinOrder = (currentMaxPin && currentMaxPin.max_order !== null) ? currentMaxPin.max_order + 1 : 0;
          }
        }
        updateFields.push('is_pinned = ?'); updateValues.push(body.is_pinned ? 1 : 0);
        updateFields.push('pin_order = ?'); updateValues.push(updatedPinOrder);
      }

      if (body.is_published !== undefined) {
        updateFields.push('is_published = ?'); updateValues.push(body.is_published ? 1 : 0);
        if (body.is_published) updateFields.push("published_at = COALESCE(published_at, CURRENT_TIMESTAMP)");
      }

      if (updateFields.length > 0) {
        updateFields.push('updated_at = CURRENT_TIMESTAMP');
        updateValues.push(updateArticleId);
        await db.prepare('UPDATE articles SET ' + updateFields.join(', ') + ' WHERE id = ?').bind(...updateValues).run();
      }

      return json({ message: 'Article updated successfully' });
    }

    if (request.method === 'DELETE' && adminRoutePath.match(/^\/articles\/\d+$/)) {
      var deleteArticleId = parseInt(adminRoutePath.split('/')[2]);
      if (db) await db.prepare('DELETE FROM articles WHERE id = ?').bind(deleteArticleId).run();
      return json({ message: 'Article deleted successfully' });
    }

    // ══════════════════════════════════════════════════════════
    // CATEGORIES MANAGEMENT
    // ══════════════════════════════════════════════════════════

    if (adminRoutePath === '/categories' && request.method === 'GET') {
      if (!db) return json([]);
      var categoriesListResult = await db.prepare('SELECT * FROM categories ORDER BY name ASC').all();
      return json(categoriesListResult.results || []);
    }

    if (adminRoutePath === '/categories' && request.method === 'POST') {
      var newCategoryName = body.name;
      if (!newCategoryName) return err('Category name is required');

      var newCategorySlug = slugify(newCategoryName);
      newCategorySlug = await uniqueSlug(newCategorySlug, 'categories', 0);

      if (!db) return json({ id: Date.now(), slug: newCategorySlug, message: 'Category created (test mode)' }, 201);

      var categoryInsertResult = await db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').bind(newCategoryName, newCategorySlug).run();

      return json({ id: categoryInsertResult.meta.last_row_id, slug: newCategorySlug, message: 'Category created successfully' }, 201);
    }

    if (request.method === 'PUT' && adminRoutePath.match(/^\/categories\/\d+$/)) {
      var updateCategoryId = parseInt(adminRoutePath.split('/')[2]);
      if (!db) return json({ message: 'Category updated (test mode)' });

      var categoryUpdateFields = [];
      var categoryUpdateValues = [];

      if (body.name !== undefined) {
        var updatedCategorySlug = slugify(body.name);
        updatedCategorySlug = await uniqueSlug(updatedCategorySlug, 'categories', updateCategoryId);
        categoryUpdateFields.push('name = ?'); categoryUpdateValues.push(body.name);
        categoryUpdateFields.push('slug = ?'); categoryUpdateValues.push(updatedCategorySlug);
      }

      if (categoryUpdateFields.length > 0) {
        categoryUpdateValues.push(updateCategoryId);
        await db.prepare('UPDATE categories SET ' + categoryUpdateFields.join(', ') + ' WHERE id = ?').bind(...categoryUpdateValues).run();
      }

      return json({ message: 'Category updated successfully' });
    }

    if (request.method === 'DELETE' && adminRoutePath.match(/^\/categories\/\d+$/)) {
      var deleteCategoryId = parseInt(adminRoutePath.split('/')[2]);
      if (db) {
        await db.prepare('UPDATE articles SET category_id = NULL WHERE category_id = ?').bind(deleteCategoryId).run();
        await db.prepare('DELETE FROM categories WHERE id = ?').bind(deleteCategoryId).run();
      }
      return json({ message: 'Category deleted successfully' });
    }

    // ══════════════════════════════════════════════════════════
    // SETTINGS MANAGEMENT
    // ══════════════════════════════════════════════════════════

    if (adminRoutePath === '/settings' && request.method === 'GET') {
      if (!db) return json({ site_title: 'The Pacific Signal', site_tagline: 'Beyond the Headlines' });
      var settingsRecord = await db.prepare('SELECT * FROM settings WHERE id = 1').first();
      return json(settingsRecord || { site_title: 'The Pacific Signal', site_tagline: 'Beyond the Headlines' });
    }

    if (adminRoutePath === '/settings' && request.method === 'PUT') {
      if (!db) return json({ message: 'Settings saved (test mode)' });
      await db.prepare(
        "UPDATE settings SET site_title = ?, site_tagline = ?, logo_url = ?, about_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1"
      ).bind(body.site_title || 'The Pacific Signal', body.site_tagline || 'Beyond the Headlines', body.logo_url || null, body.about_text || '').run();
      return json({ message: 'Settings saved successfully' });
    }

    // ══════════════════════════════════════════════════════════
    // DASHBOARD STATISTICS
    // ══════════════════════════════════════════════════════════

    if (adminRoutePath === '/stats' && request.method === 'GET') {
      if (!db) return json({ total_articles: 0, published_articles: 0, categories: 0, pinned_articles: 0, total_subscribers: 0 });

      var totalArticlesCount = await db.prepare('SELECT COUNT(*) as count FROM articles').first();
      var publishedArticlesCount = await db.prepare('SELECT COUNT(*) as count FROM articles WHERE is_published = 1').first();
      var totalCategoriesCount = await db.prepare('SELECT COUNT(*) as count FROM categories').first();
      var pinnedArticlesCount = await db.prepare('SELECT COUNT(*) as count FROM articles WHERE is_pinned = 1').first();
      var totalSubscribersCount = await db.prepare('SELECT COUNT(*) as count FROM subscribers').first();

      return json({
        total_articles: totalArticlesCount ? totalArticlesCount.count : 0,
        published_articles: publishedArticlesCount ? publishedArticlesCount.count : 0,
        categories: totalCategoriesCount ? totalCategoriesCount.count : 0,
        pinned_articles: pinnedArticlesCount ? pinnedArticlesCount.count : 0,
        total_subscribers: totalSubscribersCount ? totalSubscribersCount.count : 0
      });
    }

    if (adminRoutePath === '/subscribers' && request.method === 'GET') {
      if (!db) return json([]);
      var subscribersListResult = await db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC').all();
      return json(subscribersListResult.results || []);
    }

    return err('Admin route not found: ' + adminRoutePath, 404);
  }

  return err('API route not found: ' + path, 404);
}
