// functions/api/[[route]].js
// The Pacific Signal — Complete API Handler
// Professional News Analysis Platform
// Beyond the Headlines
//
// SECURITY NOTE: Auth uses hand-rolled JWT (HMAC-SHA256 via crypto.subtle)
// and SHA-256 password hashing. Two-layer auth with master phrase.
// Set an env var JWT_SECRET in Cloudflare Pages settings for production use.

const FALLBACK_SECRET = 'pacific-signal-dev-secret-change-me-in-cloudflare-env';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MASTER_PHRASE_TTL_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
const ARCHIVE_AFTER_DAYS = 90; // articles older than this are considered "archived"

export async function onRequest(context) {

  const { request, env } = context;

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Master-Token'
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

  function json(data, status, extraHeaders) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: extraHeaders ? Object.assign({}, corsHeaders, extraHeaders) : corsHeaders
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

  function extractMasterToken(request) {
    return request.headers.get('X-Master-Token') || null;
  }

  async function getAdminUser(request) {
    var token = extractBearer(request);
    if (!token) return null;
    var payload = await verifyToken(token);
    if (!payload || payload.role !== 'admin') return null;
    return payload;
  }

  // Check if master phrase is set and verified
  async function checkMasterPhraseSetup() {
    if (!db) return { is_set: false, is_verified: false };
    var record = await db.prepare("SELECT * FROM master_phrase WHERE id = 1").first();
    return { is_set: !!record, is_verified: false };
  }

  // Verify the master phrase JWT token
  async function verifyMasterAccess(request) {
    var masterToken = extractMasterToken(request);
    if (!masterToken) return false;
    var payload = await verifyToken(masterToken);
    if (!payload || payload.purpose !== 'master-phrase') return false;
    return true;
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

  if (db && !globalThis.__pacific_signal_db_v3) {

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
        "CREATE TABLE IF NOT EXISTS master_phrase (id INTEGER PRIMARY KEY, phrase_hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    } catch (e) {}

    try {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, site_title TEXT DEFAULT 'The Pacific Signal', site_tagline TEXT DEFAULT 'Beyond the Headlines', logo_url TEXT, about_text TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    } catch (e) {}

    // NOTE: no "subscribers" table — the newsletter form is display-only for now.

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

    // Seed default admin — password stored as SHA-256 hash
    try {
      var defaultHash = await sha256Hex('admin123');
      await db.prepare(
        "INSERT OR IGNORE INTO admins (username, password, display_name) VALUES ('admin', ?, 'Editor')"
      ).bind(defaultHash).run();
    } catch (e) {}

    // Upgrade legacy plaintext password if needed
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

    globalThis.__pacific_signal_db_v3 = true;
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

    var explainersResult = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'explainer' AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 3"
    ).all();

    var latestResult = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block IS NULL AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 9"
    ).all();

    return json({
      hero: heroArticle || null,
      feed: feedArticlesResult.results || [],
      visual: visualArticle || null,
      spotlights: spotlightsResult.results || [],
      explainers: explainersResult.results || [],
      latest: latestResult.results || []
    }, 200, { 'Cache-Control': 'public, max-age=60' });
  }

  // GET /api/search-index — one lightweight, cacheable payload for client-side fuzzy search.
  // Replaces a live D1 query on every keystroke: the browser fetches this once (cached),
  // then matches locally (typo-tolerant) with no further D1 reads per search.
  if (path === '/api/search-index' && request.method === 'GET') {
    if (!db) return json([]);
    var indexResult = await db.prepare(
      "SELECT a.id, a.title, a.slug, a.excerpt, c.name as category_name FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.is_published = 1 ORDER BY a.published_at DESC LIMIT 800"
    ).all();
    return json(indexResult.results || [], 200, { 'Cache-Control': 'public, max-age=300' });
  }

  // GET /api/archive?category=&q=&page= — articles older than the archive cutoff, browsable and searchable
  if (path === '/api/archive' && request.method === 'GET') {
    if (!db) return json({ articles: [], page: 1, hasMore: false });

    var archivePage = parseInt(url.searchParams.get('page') || '1');
    var archiveLimit = 12;
    var archiveOffset = (archivePage - 1) * archiveLimit;
    var archiveCategorySlug = (url.searchParams.get('category') || '').trim();
    var archiveQuery = (url.searchParams.get('q') || '').trim();
    var cutoffIso = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();

    var whereParts = ["a.is_published = 1", "a.published_at < ?"];
    var bindArgs = [cutoffIso];

    if (archiveCategorySlug) {
      whereParts.push("c.slug = ?");
      bindArgs.push(archiveCategorySlug);
    }
    if (archiveQuery) {
      whereParts.push("(a.title LIKE ? OR a.excerpt LIKE ?)");
      var archiveLike = '%' + archiveQuery.replace(/[%_]/g, '') + '%';
      bindArgs.push(archiveLike, archiveLike);
    }

    var archiveSql = "SELECT a.id, a.title, a.slug, a.excerpt, a.image_url, a.author, a.published_at, c.name as category_name, c.slug as category_slug "
      + "FROM articles a LEFT JOIN categories c ON a.category_id = c.id "
      + "WHERE " + whereParts.join(' AND ')
      + " ORDER BY a.published_at DESC LIMIT ? OFFSET ?";
    bindArgs.push(archiveLimit, archiveOffset);

    var archiveResult = await db.prepare(archiveSql).bind(...bindArgs).all();
    var archiveArticles = archiveResult.results || [];

    return json({
      articles: archiveArticles,
      page: archivePage,
      hasMore: archiveArticles.length === archiveLimit
    }, 200, { 'Cache-Control': 'public, max-age=120' });
  }

  // GET /api/rss.xml
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

    var relatedArticlesResult = await db.prepare(
      "SELECT id, title, slug, excerpt, image_url, author, published_at FROM articles WHERE category_id = ? AND id != ? AND is_published = 1 ORDER BY published_at DESC LIMIT 3"
    ).bind(article.category_id, article.id).all();

    return json({ article: article, related: relatedArticlesResult.results || [] });
  }

  if (path === '/api/categories' && request.method === 'GET') {
    if (!db) return json([]);
    var allCategoriesResult = await db.prepare('SELECT * FROM categories ORDER BY name ASC').all();
    return json(allCategoriesResult.results || [], 200, { 'Cache-Control': 'public, max-age=600' });
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

  // Newsletter is display-only for now ("feature coming soon") — no backend, no storage,
  // intentionally kept out of scope. The footer form does not call this API.

  // ══════════════════════════════════════════════════════════════
  // ADMIN AUTH ROUTES
  // ══════════════════════════════════════════════════════════════

  // POST /api/admin/login — login with username/password
  if (path === '/api/admin/login' && request.method === 'POST') {
    var adminUsername = body.username;
    var adminPassword = body.password;

    if (!adminUsername || !adminPassword) return err('Username and password are required');
    if (!db) return err('Database not configured', 500);

    var adminRecord = await db.prepare('SELECT * FROM admins WHERE username = ?').bind(adminUsername).first();
    if (!adminRecord) return err('Invalid credentials', 401);

    var attemptHash = await sha256Hex(adminPassword);
    if (attemptHash !== adminRecord.password) return err('Invalid credentials', 401);

    // Check if master phrase is already set
    var masterRecord = await db.prepare("SELECT * FROM master_phrase WHERE id = 1").first();
    var masterPhraseSet = !!masterRecord;

    // Sign the main admin token
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
      },
      master_phrase_set: masterPhraseSet
    });
  }

  // POST /api/admin/set-master-phrase — set the master phrase (first time only)
  if (path === '/api/admin/set-master-phrase' && request.method === 'POST') {
    var currentAdmin = await getAdminUser(request);
    if (!currentAdmin) return err('Unauthorized — Please sign in', 401);
    if (!db) return err('Database not configured', 500);

    // Check if master phrase is already set
    var existingMaster = await db.prepare("SELECT * FROM master_phrase WHERE id = 1").first();
    if (existingMaster) return err('Master phrase is already set. Use verify-master-phrase instead.', 400);

    var phrase = body.master_phrase;
    if (!phrase || phrase.length < 8) return err('Master phrase must be at least 8 characters');

    var phraseHash = await sha256Hex(phrase);

    try {
      await db.prepare("INSERT INTO master_phrase (id, phrase_hash) VALUES (1, ?)").bind(phraseHash).run();
    } catch (e) {
      return err('Error setting master phrase: ' + e.message, 500);
    }

    // Sign a master phrase token valid for 5 days
    var masterToken = await signToken({
      admin_id: currentAdmin.id,
      purpose: 'master-phrase',
      exp: Date.now() + MASTER_PHRASE_TTL_MS
    });

    return json({
      message: 'Master phrase set successfully',
      master_token: masterToken,
      expires_in_ms: MASTER_PHRASE_TTL_MS
    });
  }

  // POST /api/admin/verify-master-phrase — verify the master phrase
  if (path === '/api/admin/verify-master-phrase' && request.method === 'POST') {
    var currentAdmin = await getAdminUser(request);
    if (!currentAdmin) return err('Unauthorized — Please sign in', 401);
    if (!db) return err('Database not configured', 500);

    var masterRecord = await db.prepare("SELECT * FROM master_phrase WHERE id = 1").first();
    if (!masterRecord) return err('Master phrase has not been set yet. Use set-master-phrase first.', 400);

    var phrase = body.master_phrase;
    if (!phrase) return err('Master phrase is required');

    var phraseHash = await sha256Hex(phrase);
    if (phraseHash !== masterRecord.phrase_hash) return err('Incorrect master phrase', 401);

    // Sign a master phrase token valid for 5 days
    var masterToken = await signToken({
      admin_id: currentAdmin.id,
      purpose: 'master-phrase',
      exp: Date.now() + MASTER_PHRASE_TTL_MS
    });

    return json({
      message: 'Master phrase verified',
      master_token: masterToken,
      expires_in_ms: MASTER_PHRASE_TTL_MS
    });
  }

  // POST /api/admin/validate-master-token — check if existing master token is still valid
  if (path === '/api/admin/validate-master-token' && request.method === 'POST') {
    var currentAdmin = await getAdminUser(request);
    if (!currentAdmin) return err('Unauthorized — Please sign in', 401);

    var masterToken = extractMasterToken(request);
    if (!masterToken) return err('No master token provided', 401);

    var payload = await verifyToken(masterToken);
    if (!payload || payload.purpose !== 'master-phrase') return err('Invalid or expired master token', 401);

    return json({
      message: 'Master token is valid',
      admin_id: payload.admin_id,
      expires_at: payload.exp
    });
  }

  // ══════════════════════════════════════════════════════════════
  // ADMIN ROUTES — Authentication + Master Phrase required
  // ══════════════════════════════════════════════════════════════

  if (path.startsWith('/api/admin/')) {

    var currentAdmin = await getAdminUser(request);
    if (!currentAdmin) return err('Unauthorized — Please sign in', 401);

    // All admin routes (except auth routes above) require master phrase verification
    var masterAccess = await verifyMasterAccess(request);
    if (!masterAccess) return err('Master phrase verification required. Use X-Master-Token header.', 401);

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
          var oldestPinToEvict = await db.prepare('SELECT id FROM articles WHERE is_pinned = 1 ORDER BY pin_order ASC LIMIT 1').first();
          if (oldestPinToEvict) await db.prepare('UPDATE articles SET is_pinned = 0, pin_order = 0 WHERE id = ?').bind(oldestPinToEvict.id).run();
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
              var oldestPinToEvict2 = await db.prepare('SELECT id FROM articles WHERE is_pinned = 1 AND id != ? ORDER BY pin_order ASC LIMIT 1').bind(updateArticleId).first();
              if (oldestPinToEvict2) await db.prepare('UPDATE articles SET is_pinned = 0, pin_order = 0 WHERE id = ?').bind(oldestPinToEvict2.id).run();
            }
            var currentMaxPin = await db.prepare('SELECT MAX(pin_order) as max_order FROM articles WHERE is_pinned = 1 AND id != ?').bind(updateArticleId).first();
            updatedPinOrder = (currentMaxPin && currentMaxPin.max_order !== null) ? currentMaxPin.max_order + 1 : 0;
          } else {
            updatedPinOrder = existingArticle.pin_order || 0; // already pinned — keep its existing order instead of resetting it to 0
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

    // DELETE /admin/articles/bulk — body: { ids: [1,2,3] }. Used by the Archive tab for
    // "delete selected" / "delete all archived" so N deletes cost one D1 write, not N.
    if (adminRoutePath === '/articles/bulk' && request.method === 'DELETE') {
      var bulkIds = Array.isArray(body.ids) ? body.ids.map(function (n) { return parseInt(n); }).filter(function (n) { return !isNaN(n); }) : [];
      if (!bulkIds.length) return err('No article ids provided');
      if (!db) return json({ message: 'Deleted (test mode)', count: bulkIds.length });

      var placeholders = bulkIds.map(function () { return '?'; }).join(',');
      await db.prepare('DELETE FROM articles WHERE id IN (' + placeholders + ')').bind(...bulkIds).run();
      return json({ message: 'Deleted ' + bulkIds.length + ' article(s)', count: bulkIds.length });
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
      if (!db) return json({ total_articles: 0, published_articles: 0, categories: 0, pinned_articles: 0, archived_articles: 0 });

      var archiveCutoffIso = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // Single round-trip instead of 5 separate COUNT(*) queries.
      var combinedStats = await db.prepare(
        "SELECT "
        + "(SELECT COUNT(*) FROM articles) as total_articles, "
        + "(SELECT COUNT(*) FROM articles WHERE is_published = 1) as published_articles, "
        + "(SELECT COUNT(*) FROM categories) as categories, "
        + "(SELECT COUNT(*) FROM articles WHERE is_pinned = 1) as pinned_articles, "
        + "(SELECT COUNT(*) FROM articles WHERE is_published = 1 AND published_at < ?) as archived_articles"
      ).bind(archiveCutoffIso).first();

      return json(combinedStats || { total_articles: 0, published_articles: 0, categories: 0, pinned_articles: 0, archived_articles: 0 });
    }

    return err('Admin route not found: ' + adminRoutePath, 404);
  }

  return err('API route not found: ' + path, 404);
}
