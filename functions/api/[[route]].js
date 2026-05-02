// The Signal - Complete API Handler
// Rhythm of the Scroll + ImgBB Integration

export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.SIGNAL_DB;

  let body = {};
  if (request.method === 'POST' || request.method === 'PUT') {
    try {
      body = await request.json();
    } catch (e) {
      // No JSON body
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
      
      if (!existing) {
        break;
      }
      
      slug = baseSlug + '-' + counter;
      counter++;
    }
    
    return slug;
  }

  // ═══════════════════════════════════════════
  // DATABASE SETUP
  // ═══════════════════════════════════════════
  if (db && !globalThis.__signal_db_v3) {
    
    var tableSQLs = [
      `CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS subcategories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        excerpt TEXT,
        content TEXT NOT NULL,
        image_url TEXT,
        category_id INTEGER,
        subcategory_id INTEGER,
        author TEXT DEFAULT 'The Signal',
        display_block TEXT DEFAULT NULL,
        spotlight_label TEXT,
        spotlight_category_id INTEGER,
        spotlight_subcategory_id INTEGER,
        is_pinned INTEGER DEFAULT 0,
        pin_order INTEGER DEFAULT 0,
        is_published INTEGER DEFAULT 0,
        published_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        display_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_title TEXT DEFAULT 'The Signal',
        site_tagline TEXT DEFAULT 'Smart Analysis & Insights',
        logo_url TEXT,
        about_text TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    for (var i = 0; i < tableSQLs.length; i++) {
      try {
        await db.prepare(tableSQLs[i]).run();
      } catch (e) {
        // Table already exists
      }
    }

    var migrationSQLs = [
      "ALTER TABLE articles ADD COLUMN display_block TEXT DEFAULT NULL",
      "ALTER TABLE articles ADD COLUMN spotlight_label TEXT",
      "ALTER TABLE articles ADD COLUMN spotlight_category_id INTEGER",
      "ALTER TABLE articles ADD COLUMN spotlight_subcategory_id INTEGER",
      "ALTER TABLE articles ADD COLUMN excerpt TEXT",
      "ALTER TABLE articles ADD COLUMN image_url TEXT",
      "ALTER TABLE articles ADD COLUMN is_pinned INTEGER DEFAULT 0",
      "ALTER TABLE articles ADD COLUMN pin_order INTEGER DEFAULT 0"
    ];

    for (var j = 0; j < migrationSQLs.length; j++) {
      try {
        await db.prepare(migrationSQLs[j]).run();
      } catch (e) {
        // Column already exists
      }
    }

    try {
      await db.prepare(
        "INSERT OR IGNORE INTO admins (username, password, display_name) VALUES ('admin', 'admin123', 'Admin')"
      ).run();
    } catch (e) {
      // Admin already exists
    }

    try {
      await db.prepare(
        "INSERT OR IGNORE INTO settings (id, site_title, site_tagline) VALUES (1, 'The Signal', 'Smart Analysis & Insights')"
      ).run();
    } catch (e) {
      // Settings already exist
    }

    globalThis.__signal_db_v3 = true;
  }

  // ═══════════════════════════════════════════
  // PUBLIC ROUTES
  // ═══════════════════════════════════════════

  // GET /api/homepage — Rhythm of the Scroll Layout
  if (path === '/api/homepage' && request.method === 'GET') {
    
    if (!db) {
      return json({
        hero: null,
        feed: [],
        visual: null,
        spotlights: [],
        latest: []
      });
    }

    // Block A: Hero — one article marked as display_block='hero' or first pinned
    var hero = await db.prepare(
      `SELECT a.*, c.name as category_name, c.slug as category_slug,
              s.name as subcategory_name, s.slug as subcategory_slug
       FROM articles a
       LEFT JOIN categories c ON a.category_id = c.id
       LEFT JOIN subcategories s ON a.subcategory_id = s.id
       WHERE a.display_block = 'hero' AND a.is_published = 1
       ORDER BY a.published_at DESC LIMIT 1`
    ).first();

    if (!hero) {
      hero = await db.prepare(
        `SELECT a.*, c.name as category_name, c.slug as category_slug,
                s.name as subcategory_name, s.slug as subcategory_slug
         FROM articles a
         LEFT JOIN categories c ON a.category_id = c.id
         LEFT JOIN subcategories s ON a.subcategory_id = s.id
         WHERE a.is_pinned = 1 AND a.is_published = 1
         ORDER BY a.pin_order ASC LIMIT 1`
      ).first();
    }

    // Block B: Intelligence Feed — up to 8 articles marked as display_block='feed'
    var feedResult = await db.prepare(
      `SELECT a.*, c.name as category_name, c.slug as category_slug,
              s.name as subcategory_name, s.slug as subcategory_slug
       FROM articles a
       LEFT JOIN categories c ON a.category_id = c.id
       LEFT JOIN subcategories s ON a.subcategory_id = s.id
       WHERE a.display_block = 'feed' AND a.is_published = 1
       ORDER BY a.published_at DESC LIMIT 8`
    ).all();

    // Block C: Visual Break — one article marked as display_block='visual' with image
    var visual = await db.prepare(
      `SELECT a.*, c.name as category_name, c.slug as category_slug,
              s.name as subcategory_name, s.slug as subcategory_slug
       FROM articles a
       LEFT JOIN categories c ON a.category_id = c.id
       LEFT JOIN subcategories s ON a.subcategory_id = s.id
       WHERE a.display_block = 'visual' AND a.is_published = 1 AND a.image_url IS NOT NULL
       ORDER BY a.published_at DESC LIMIT 1`
    ).first();

    // Block D: Category Spotlights — up to 4 articles marked as display_block='spotlight'
    var spotlightsResult = await db.prepare(
      `SELECT a.*, c.name as category_name, c.slug as category_slug,
              s.name as subcategory_name, s.slug as subcategory_slug
       FROM articles a
       LEFT JOIN categories c ON a.category_id = c.id
       LEFT JOIN subcategories s ON a.subcategory_id = s.id
       WHERE a.display_block = 'spotlight' AND a.is_published = 1
       ORDER BY a.published_at DESC LIMIT 4`
    ).all();

    // Latest articles — not assigned to any block
    var latestResult = await db.prepare(
      `SELECT a.*, c.name as category_name, c.slug as category_slug,
              s.name as subcategory_name, s.slug as subcategory_slug
       FROM articles a
       LEFT JOIN categories c ON a.category_id = c.id
       LEFT JOIN subcategories s ON a.subcategory_id = s.id
       WHERE a.display_block IS NULL AND a.is_published = 1
       ORDER BY a.published_at DESC LIMIT 6`
    ).all();

    return json({
      hero: hero || null,
      feed: feedResult.results || [],
      visual: visual || null,
      spotlights: spotlightsResult.results || [],
      latest: latestResult.results || []
    });
  }

  // GET /api/article/:slug — Single article page
  if (request.method === 'GET' && path.match(/^\/api\/article\/[a-z0-9-]+$/)) {
    var slug = path.split('/')[3];
    
    if (!db) {
      return err('Article not found', 404);
    }

    var article = await db.prepare(
      `SELECT a.*, c.name as category_name, c.slug as category_slug,
              s.name as subcategory_name, s.slug as subcategory_slug
       FROM articles a
       LEFT JOIN categories c ON a.category_id = c.id
       LEFT JOIN subcategories s ON a.subcategory_id = s.id
       WHERE a.slug = ? AND a.is_published = 1`
    ).bind(slug).first();

    if (!article) {
      return err('Article not found', 404);
    }

    var relatedResult = await db.prepare(
      `SELECT id, title, slug, excerpt, image_url, author, published_at
       FROM articles
       WHERE category_id = ? AND id != ? AND is_published = 1
       ORDER BY published_at DESC LIMIT 3`
    ).bind(article.category_id, article.id).all();

    return json({
      article: article,
      related: relatedResult.results || []
    });
  }

  // GET /api/categories — All categories with subcategories
  if (path === '/api/categories' && request.method === 'GET') {
    if (!db) {
      return json([]);
    }

    var categoriesResult = await db.prepare(
      'SELECT * FROM categories ORDER BY name ASC'
    ).all();

    var categories = categoriesResult.results || [];

    for (var i = 0; i < categories.length; i++) {
      var subsResult = await db.prepare(
        'SELECT * FROM subcategories WHERE category_id = ? ORDER BY name ASC'
      ).bind(categories[i].id).all();
      
      categories[i].subcategories = subsResult.results || [];
    }

    return json(categories);
  }

  // ═══════════════════════════════════════════
  // AUTH ROUTES
  // ═══════════════════════════════════════════

  // POST /api/admin/login
  if (path === '/api/admin/login' && request.method === 'POST') {
    var username = body.username;
    var password = body.password;

    if (!username || !password) {
      return err('Username and password required');
    }

    if (!db) {
      if (username === 'admin' && password === 'admin123') {
        return json({
          token: 'signal_admin_token',
          admin: { id: 1, username: 'admin', display_name: 'Admin' }
        });
      }
      return err('Invalid credentials', 401);
    }

    var admin = await db.prepare(
      'SELECT * FROM admins WHERE username = ? AND password = ?'
    ).bind(username, password).first();

    if (!admin) {
      return err('Invalid credentials', 401);
    }

    return json({
      token: 'signal_token_' + admin.id,
      admin: {
        id: admin.id,
        username: admin.username,
        display_name: admin.display_name
      }
    });
  }

  // ═══════════════════════════════════════════
  // ADMIN ROUTES
  // ═══════════════════════════════════════════

  if (path.startsWith('/api/admin/')) {
    
    var authHeader = request.headers.get('Authorization') || '';
    
    if (!authHeader.includes('signal_')) {
      return err('Unauthorized — Please sign in', 401);
    }

    var adminPath = path.replace('/api/admin', '');

    // ────────────────────────────────────────
    // ARTICLES
    // ────────────────────────────────────────

    // GET /api/admin/articles — List all articles
    if (adminPath === '/articles' && request.method === 'GET') {
      if (!db) {
        return json([]);
      }

      var articlesResult = await db.prepare(
        `SELECT a.*, c.name as category_name, s.name as subcategory_name
         FROM articles a
         LEFT JOIN categories c ON a.category_id = c.id
         LEFT JOIN subcategories s ON a.subcategory_id = s.id
         ORDER BY a.created_at DESC`
      ).all();

      return json(articlesResult.results || []);
    }

    // POST /api/admin/articles — Create article
    if (adminPath === '/articles' && request.method === 'POST') {
      var title = body.title;
      var slug = body.slug || null;
      var excerpt = body.excerpt || '';
      var content = body.content || '';
      var image_url = body.image_url || null;
      var category_id = body.category_id || null;
      var subcategory_id = body.subcategory_id || null;
      var author = body.author || 'The Signal';
      var display_block = body.display_block || null;
      var spotlight_label = body.spotlight_label || null;
      var spotlight_category_id = body.spotlight_category_id || null;
      var spotlight_subcategory_id = body.spotlight_subcategory_id || null;
      var is_pinned = body.is_pinned || 0;
      var is_published = body.is_published || 0;

      if (!title) {
        return err('Title is required');
      }

      if (!content) {
        return err('Content is required');
      }

      var finalSlug = slug ? slugify(slug) : slugify(title);
      
      if (!finalSlug) {
        finalSlug = 'article-' + Date.now();
      }
      
      finalSlug = await uniqueSlug(finalSlug, 'articles', 0);

      if (!db) {
        return json({
          id: Date.now(),
          slug: finalSlug,
          message: 'Article created (test mode)'
        }, 201);
      }

      var pinOrder = 0;
      
      if (is_pinned) {
        var pinnedCount = await db.prepare(
          'SELECT COUNT(*) as count FROM articles WHERE is_pinned = 1'
        ).first();
        
        if (pinnedCount && pinnedCount.count >= 2) {
          await db.prepare(
            'UPDATE articles SET is_pinned = 0, pin_order = 0 WHERE is_pinned = 1 ORDER BY pin_order DESC LIMIT 1'
          ).run();
        }
        
        var maxPin = await db.prepare(
          'SELECT MAX(pin_order) as max_order FROM articles WHERE is_pinned = 1'
        ).first();
        
        pinOrder = (maxPin && maxPin.max_order !== null) ? maxPin.max_order + 1 : 0;
      }

      var publishedAt = is_published ? new Date().toISOString() : null;

      try {
        var insertResult = await db.prepare(
          `INSERT INTO articles (title, slug, excerpt, content, image_url, category_id, subcategory_id, author, display_block, spotlight_label, spotlight_category_id, spotlight_subcategory_id, is_pinned, pin_order, is_published, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          title, finalSlug, excerpt, content, image_url,
          category_id, subcategory_id, author,
          display_block, spotlight_label, spotlight_category_id, spotlight_subcategory_id,
          is_pinned ? 1 : 0, pinOrder, is_published ? 1 : 0, publishedAt
        ).run();

        return json({
          id: insertResult.meta.last_row_id,
          slug: finalSlug,
          message: 'Article created'
        }, 201);
        
      } catch (e) {
        return err('Database error: ' + e.message, 500);
      }
    }

    // PUT /api/admin/articles/:id — Update article
    if (request.method === 'PUT' && adminPath.match(/^\/articles\/\d+$/)) {
      var articleId = parseInt(adminPath.split('/')[2]);

      if (!db) {
        return json({ message: 'Updated (test mode)' });
      }

      var updates = [];
      var values = [];

      if (body.title !== undefined) {
        updates.push('title = ?');
        values.push(body.title);
      }

      if (body.slug !== undefined) {
        var newSlug = body.slug ? slugify(body.slug) : (body.title ? slugify(body.title) : null);
        if (newSlug) {
          newSlug = await uniqueSlug(newSlug, 'articles', articleId);
          updates.push('slug = ?');
          values.push(newSlug);
        }
      }

      if (body.excerpt !== undefined) {
        updates.push('excerpt = ?');
        values.push(body.excerpt);
      }

      if (body.content !== undefined) {
        updates.push('content = ?');
        values.push(body.content);
      }

      if (body.image_url !== undefined) {
        updates.push('image_url = ?');
        values.push(body.image_url);
      }

      if (body.category_id !== undefined) {
        updates.push('category_id = ?');
        values.push(body.category_id);
      }

      if (body.subcategory_id !== undefined) {
        updates.push('subcategory_id = ?');
        values.push(body.subcategory_id);
      }

      if (body.author !== undefined) {
        updates.push('author = ?');
        values.push(body.author);
      }

      if (body.display_block !== undefined) {
        updates.push('display_block = ?');
        values.push(body.display_block);
      }

      if (body.spotlight_label !== undefined) {
        updates.push('spotlight_label = ?');
        values.push(body.spotlight_label);
      }

      if (body.spotlight_category_id !== undefined) {
        updates.push('spotlight_category_id = ?');
        values.push(body.spotlight_category_id);
      }

      if (body.spotlight_subcategory_id !== undefined) {
        updates.push('spotlight_subcategory_id = ?');
        values.push(body.spotlight_subcategory_id);
      }

      if (body.is_pinned !== undefined) {
        var pinOrderVal = 0;
        
        if (body.is_pinned) {
          var currentArticle = await db.prepare(
            'SELECT is_pinned, pin_order FROM articles WHERE id = ?'
          ).bind(articleId).first();

          if (!currentArticle || !currentArticle.is_pinned) {
            var pinnedCountResult = await db.prepare(
              'SELECT COUNT(*) as count FROM articles WHERE is_pinned = 1 AND id != ?'
            ).bind(articleId).first();
            
            if (pinnedCountResult && pinnedCountResult.count >= 2) {
              await db.prepare(
                'UPDATE articles SET is_pinned = 0, pin_order = 0 WHERE is_pinned = 1 ORDER BY pin_order DESC LIMIT 1'
              ).run();
            }
            
            var maxPinResult = await db.prepare(
              'SELECT MAX(pin_order) as max_order FROM articles WHERE is_pinned = 1 AND id != ?'
            ).bind(articleId).first();
            
            pinOrderVal = (maxPinResult && maxPinResult.max_order !== null) ? maxPinResult.max_order + 1 : 0;
          }
        }

        updates.push('is_pinned = ?');
        values.push(body.is_pinned ? 1 : 0);
        updates.push('pin_order = ?');
        values.push(pinOrderVal);
      }

      if (body.is_published !== undefined) {
        updates.push('is_published = ?');
        values.push(body.is_published ? 1 : 0);
        
        if (body.is_published) {
          updates.push("published_at = COALESCE(published_at, CURRENT_TIMESTAMP)");
        }
      }

      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(articleId);
        
        await db.prepare(
          'UPDATE articles SET ' + updates.join(', ') + ' WHERE id = ?'
        ).bind(...values).run();
      }

      return json({ message: 'Article updated' });
    }

    // DELETE /api/admin/articles/:id
    if (request.method === 'DELETE' && adminPath.match(/^\/articles\/\d+$/)) {
      var deleteId = parseInt(adminPath.split('/')[2]);
      
      if (db) {
        await db.prepare('DELETE FROM articles WHERE id = ?').bind(deleteId).run();
      }
      
      return json({ message: 'Article deleted' });
    }

    // ────────────────────────────────────────
    // CATEGORIES
    // ────────────────────────────────────────

    // GET /api/admin/categories
    if (adminPath === '/categories' && request.method === 'GET') {
      if (!db) return json([]);
      
      var catsResult = await db.prepare('SELECT * FROM categories ORDER BY name ASC').all();
      return json(catsResult.results || []);
    }

    // POST /api/admin/categories
    if (adminPath === '/categories' && request.method === 'POST') {
      if (!body.name) return err('Category name required');

      var catSlug = slugify(body.name);
      catSlug = await uniqueSlug(catSlug, 'categories', 0);

      if (!db) return json({ id: Date.now(), slug: catSlug, message: 'Created (test mode)' }, 201);

      var catResult = await db.prepare(
        'INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)'
      ).bind(body.name, catSlug, body.description || '').run();

      return json({ id: catResult.meta.last_row_id, slug: catSlug, message: 'Category created' }, 201);
    }

    // PUT /api/admin/categories/:id
    if (request.method === 'PUT' && adminPath.match(/^\/categories\/\d+$/)) {
      var catId = parseInt(adminPath.split('/')[2]);
      
      if (!db) return json({ message: 'Updated (test mode)' });

      var catUpdates = [];
      var catValues = [];

      if (body.name !== undefined) {
        var newCatSlug = slugify(body.name);
        newCatSlug = await uniqueSlug(newCatSlug, 'categories', catId);
        catUpdates.push('name = ?');
        catValues.push(body.name);
        catUpdates.push('slug = ?');
        catValues.push(newCatSlug);
      }

      if (body.description !== undefined) {
        catUpdates.push('description = ?');
        catValues.push(body.description);
      }

      if (catUpdates.length > 0) {
        catValues.push(catId);
        await db.prepare(
          'UPDATE categories SET ' + catUpdates.join(', ') + ' WHERE id = ?'
        ).bind(...catValues).run();
      }

      return json({ message: 'Category updated' });
    }

    // DELETE /api/admin/categories/:id
    if (request.method === 'DELETE' && adminPath.match(/^\/categories\/\d+$/)) {
      var delCatId = parseInt(adminPath.split('/')[2]);
      
      if (db) {
        await db.prepare('DELETE FROM subcategories WHERE category_id = ?').bind(delCatId).run();
        await db.prepare('UPDATE articles SET category_id = NULL WHERE category_id = ?').bind(delCatId).run();
        await db.prepare('DELETE FROM categories WHERE id = ?').bind(delCatId).run();
      }
      
      return json({ message: 'Category deleted' });
    }

    // ────────────────────────────────────────
    // SUBCATEGORIES
    // ────────────────────────────────────────

    // GET /api/admin/subcategories
    if (adminPath === '/subcategories' && request.method === 'GET') {
      if (!db) return json([]);
      
      var subsResult = await db.prepare(
        `SELECT s.*, c.name as category_name
         FROM subcategories s
         LEFT JOIN categories c ON s.category_id = c.id
         ORDER BY c.name ASC, s.name ASC`
      ).all();
      
      return json(subsResult.results || []);
    }

    // POST /api/admin/subcategories
    if (adminPath === '/subcategories' && request.method === 'POST') {
      if (!body.category_id || !body.name) return err('Category and name required');

      var subSlug = slugify(body.name);
      subSlug = await uniqueSlug(subSlug, 'subcategories', 0);

      if (!db) return json({ id: Date.now(), slug: subSlug, message: 'Created (test mode)' }, 201);

      var subResult = await db.prepare(
        'INSERT INTO subcategories (category_id, name, slug) VALUES (?, ?, ?)'
      ).bind(body.category_id, body.name, subSlug).run();

      return json({ id: subResult.meta.last_row_id, slug: subSlug, message: 'Subcategory created' }, 201);
    }

    // DELETE /api/admin/subcategories/:id
    if (request.method === 'DELETE' && adminPath.match(/^\/subcategories\/\d+$/)) {
      var delSubId = parseInt(adminPath.split('/')[2]);
      
      if (db) {
        await db.prepare('UPDATE articles SET subcategory_id = NULL WHERE subcategory_id = ?').bind(delSubId).run();
        await db.prepare('DELETE FROM subcategories WHERE id = ?').bind(delSubId).run();
      }
      
      return json({ message: 'Subcategory deleted' });
    }

    // ────────────────────────────────────────
    // SETTINGS
    // ────────────────────────────────────────

    // GET /api/admin/settings
    if (adminPath === '/settings' && request.method === 'GET') {
      if (!db) return json({ site_title: 'The Signal', site_tagline: 'Smart Analysis & Insights' });
      
      var settings = await db.prepare('SELECT * FROM settings WHERE id = 1').first();
      return json(settings || { site_title: 'The Signal', site_tagline: 'Smart Analysis & Insights' });
    }

    // PUT /api/admin/settings
    if (adminPath === '/settings' && request.method === 'PUT') {
      if (!db) return json({ message: 'Settings saved (test mode)' });

      await db.prepare(
        `UPDATE settings SET site_title = ?, site_tagline = ?, logo_url = ?, about_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
      ).bind(
        body.site_title || 'The Signal',
        body.site_tagline || 'Smart Analysis & Insights',
        body.logo_url || null,
        body.about_text || ''
      ).run();

      return json({ message: 'Settings saved' });
    }

    // ────────────────────────────────────────
    // DASHBOARD STATS
    // ────────────────────────────────────────

    // GET /api/admin/stats
    if (adminPath === '/stats' && request.method === 'GET') {
      if (!db) return json({ total_articles: 0, published_articles: 0, categories: 0, pinned_articles: 0 });

      var totalArticles = await db.prepare('SELECT COUNT(*) as count FROM articles').first();
      var publishedArticles = await db.prepare('SELECT COUNT(*) as count FROM articles WHERE is_published = 1').first();
      var totalCategories = await db.prepare('SELECT COUNT(*) as count FROM categories').first();
      var pinnedArticles = await db.prepare('SELECT COUNT(*) as count FROM articles WHERE is_pinned = 1').first();

      return json({
        total_articles: totalArticles ? totalArticles.count : 0,
        published_articles: publishedArticles ? publishedArticles.count : 0,
        categories: totalCategories ? totalCategories.count : 0,
        pinned_articles: pinnedArticles ? pinnedArticles.count : 0
      });
    }

    // ────────────────────────────────────────
    // SUBJECTS BY CATEGORY (for spotlight dropdown)
    // ────────────────────────────────────────

    // GET /api/admin/subcategories/by-category/:id
    if (request.method === 'GET' && adminPath.match(/^\/subcategories\/by-category\/\d+$/)) {
      var catIdForSubs = parseInt(adminPath.split('/')[3]);
      
      if (!db) return json([]);
      
      var subsByCat = await db.prepare(
        'SELECT * FROM subcategories WHERE category_id = ? ORDER BY name ASC'
      ).bind(catIdForSubs).all();
      
      return json(subsByCat.results || []);
    }

    return err('Admin route not found: ' + adminPath, 404);
  }

  return err('Route not found: ' + path, 404);
}
