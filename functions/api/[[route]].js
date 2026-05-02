// The Signal - Complete API Handler
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
    try { body = await request.json(); } catch(e) {}
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

  // ═══════════════ DATABASE SETUP ═══════════════
  if (db && !globalThis.__signal_db_ready) {
    const tables = [
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

    for (const sql of tables) {
      try { await db.prepare(sql).run(); } catch(e) {}
    }

    // Add missing columns to existing tables
    const migrations = [
      "ALTER TABLE articles ADD COLUMN excerpt TEXT",
      "ALTER TABLE articles ADD COLUMN image_url TEXT",
      "ALTER TABLE articles ADD COLUMN is_pinned INTEGER DEFAULT 0",
      "ALTER TABLE articles ADD COLUMN pin_order INTEGER DEFAULT 0"
    ];
    for (const sql of migrations) {
      try { await db.prepare(sql).run(); } catch(e) {}
    }

    // Create default admin (password: admin123)
    try {
      await db.prepare(`INSERT OR IGNORE INTO admins (username, password, display_name) VALUES ('admin', 'admin123', 'Admin')`).run();
    } catch(e) {}

    // Create default settings
    try {
      await db.prepare(`INSERT OR IGNORE INTO settings (id, site_title, site_tagline) VALUES (1, 'The Signal', 'Smart Analysis & Insights')`).run();
    } catch(e) {}

    globalThis.__signal_db_ready = true;
  }

  // Helper function to generate slug
  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 80);
  }

  // Helper to ensure unique slug
  async function uniqueSlug(baseSlug, table, excludeId) {
    let slug = baseSlug;
    let counter = 1;
    while (true) {
      const existing = await db.prepare(
        `SELECT id FROM ${table} WHERE slug = ? AND id != ?`
      ).bind(slug, excludeId || 0).first();
      if (!existing) break;
      slug = baseSlug + '-' + counter;
      counter++;
    }
    return slug;
  }

  // ═══════════════ PUBLIC ROUTES ═══════════════

  // GET /api/homepage - Get pinned + latest articles
  if (path === '/api/homepage' && request.method === 'GET') {
    if (!db) return json({ pinned: [], latest: [] });

    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = 9;
    const offset = (page - 1) * limit;

    // Get pinned articles (max 2, published)
    const pinnedResult = await db.prepare(`
      SELECT a.*, c.name as category_name, c.slug as category_slug,
             s.name as subcategory_name, s.slug as subcategory_slug
      FROM articles a
      LEFT JOIN categories c ON a.category_id = c.id
      LEFT JOIN subcategories s ON a.subcategory_id = s.id
      WHERE a.is_pinned = 1 AND a.is_published = 1
      ORDER BY a.pin_order ASC
      LIMIT 2
    `).all();

    // Get latest articles (not pinned, published)
    const latestResult = await db.prepare(`
      SELECT a.*, c.name as category_name, c.slug as category_slug,
             s.name as subcategory_name, s.slug as subcategory_slug
      FROM articles a
      LEFT JOIN categories c ON a.category_id = c.id
      LEFT JOIN subcategories s ON a.subcategory_id = s.id
      WHERE a.is_pinned = 0 AND a.is_published = 1
      ORDER BY a.published_at DESC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all();

    return json({
      pinned: pinnedResult.results || [],
      latest: latestResult.results || [],
      page: page,
      hasMore: (latestResult.results || []).length === limit
    });
  }

  // GET /api/article/:slug - Single article
  if (request.method === 'GET' && path.match(/^\/api\/article\/[a-z0-9-]+$/)) {
    const slug = path.split('/')[3];
    if (!db) return err('Article not found', 404);

    const article = await db.prepare(`
      SELECT a.*, c.name as category_name, c.slug as category_slug,
             s.name as subcategory_name, s.slug as subcategory_slug
      FROM articles a
      LEFT JOIN categories c ON a.category_id = c.id
      LEFT JOIN subcategories s ON a.subcategory_id = s.id
      WHERE a.slug = ? AND a.is_published = 1
    `).bind(slug).first();

    if (!article) return err('Article not found', 404);

    // Get related articles (same category)
    const related = await db.prepare(`
      SELECT id, title, slug, excerpt, image_url, author, published_at
      FROM articles
      WHERE category_id = ? AND id != ? AND is_published = 1
      ORDER BY published_at DESC
      LIMIT 3
    `).bind(article.category_id, article.id).all();

    return json({
      article: article,
      related: related.results || []
    });
  }

  // GET /api/categories - All categories with subcategories
  if (path === '/api/categories' && request.method === 'GET') {
    if (!db) return json([]);

    const categories = await db.prepare('SELECT * FROM categories ORDER BY name ASC').all();

    for (const cat of (categories.results || [])) {
      const subs = await db.prepare(
        'SELECT * FROM subcategories WHERE category_id = ? ORDER BY name ASC'
      ).bind(cat.id).all();
      cat.subcategories = subs.results || [];
    }

    return json(categories.results || []);
  }

  // GET /api/articles/by-category/:slug
  if (request.method === 'GET' && path.match(/^\/api\/articles\/by-category\/[a-z0-9-]+$/)) {
    const categorySlug = path.split('/')[4];
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = 9;
    const offset = (page - 1) * limit;

    const articles = await db.prepare(`
      SELECT a.*, c.name as category_name, s.name as subcategory_name
      FROM articles a
      JOIN categories c ON a.category_id = c.id
      LEFT JOIN subcategories s ON a.subcategory_id = s.id
      WHERE c.slug = ? AND a.is_published = 1
      ORDER BY a.is_pinned DESC, a.published_at DESC
      LIMIT ? OFFSET ?
    `).bind(categorySlug, limit, offset).all();

    return json({
      articles: articles.results || [],
      page: page,
      hasMore: (articles.results || []).length === limit
    });
  }

  // ═══════════════ AUTH ROUTES ═══════════════

  // POST /api/admin/login
  if (path === '/api/admin/login' && request.method === 'POST') {
    const { username, password } = body;
    if (!username || !password) return err('Username and password required');

    if (!db) {
      if (username === 'admin' && password === 'admin123') {
        return json({ token: 'signal_admin_token', admin: { id: 1, username: 'admin', display_name: 'Admin' } });
      }
      return err('Invalid credentials', 401);
    }

    const admin = await db.prepare(
      'SELECT * FROM admins WHERE username = ? AND password = ?'
    ).bind(username, password).first();

    if (!admin) return err('Invalid credentials', 401);

    return json({
      token: 'signal_token_' + admin.id,
      admin: { id: admin.id, username: admin.username, display_name: admin.display_name }
    });
  }

  // ═══════════════ ADMIN ROUTES ═══════════════

  if (path.startsWith('/api/admin/')) {
    // Simple auth check
    const auth = request.headers.get('Authorization') || '';
    if (!auth.includes('signal_')) return err('Unauthorized', 401);

    const adminPath = path.replace('/api/admin', '');

    // ═══ ARTICLES ═══

    // GET /api/admin/articles
    if (adminPath === '/articles' && request.method === 'GET') {
      if (!db) return json([]);
      const result = await db.prepare(`
        SELECT a.*, c.name as category_name, s.name as subcategory_name
        FROM articles a
        LEFT JOIN categories c ON a.category_id = c.id
        LEFT JOIN subcategories s ON a.subcategory_id = s.id
        ORDER BY a.is_pinned DESC, a.created_at DESC
      `).all();
      return json(result.results || []);
    }

    // POST /api/admin/articles
    if (adminPath === '/articles' && request.method === 'POST') {
      const { title, slug, excerpt, content, image_url, category_id, subcategory_id, author, is_pinned, is_published } = body;

      if (!title) return err('Title is required');
      if (!content) return err('Content is required');

      // Generate or use custom slug
      let finalSlug = slug ? slugify(slug) : slugify(title);
      if (!finalSlug) finalSlug = 'article-' + Date.now();
      finalSlug = await uniqueSlug(finalSlug, 'articles', 0);

      if (!db) {
        return json({
          id: Date.now(),
          slug: finalSlug,
          message: 'Article created (test mode)'
        }, 201);
      }

      // Handle pinning - max 2 pinned
      let pinOrder = 0;
      if (is_pinned) {
        const pinnedCount = await db.prepare(
          'SELECT COUNT(*) as count FROM articles WHERE is_pinned = 1'
        ).first();
        if (pinnedCount.count >= 2) {
          // Auto-unpin the oldest pinned article
          await db.prepare(
            'UPDATE articles SET is_pinned = 0, pin_order = 0 WHERE is_pinned = 1 ORDER BY pin_order DESC LIMIT 1'
          ).run();
        }
        const maxPin = await db.prepare(
          'SELECT MAX(pin_order) as max_order FROM articles WHERE is_pinned = 1'
        ).first();
        pinOrder = (maxPin.max_order || -1) + 1;
      }

      const publishedAt = is_published ? new Date().toISOString() : null;

      try {
        const result = await db.prepare(`
          INSERT INTO articles (title, slug, excerpt, content, image_url, category_id, subcategory_id, author, is_pinned, pin_order, is_published, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          title, finalSlug, excerpt || '', content, image_url || null,
          category_id || null, subcategory_id || null,
          author || 'The Signal', is_pinned ? 1 : 0, pinOrder,
          is_published ? 1 : 0, publishedAt
        ).run();

        return json({
          id: result.meta.last_row_id,
          slug: finalSlug,
          message: 'Article created'
        }, 201);
      } catch(e) {
        return err('Error: ' + e.message, 500);
      }
    }

    // PUT /api/admin/articles/:id
    if (request.method === 'PUT' && adminPath.match(/^\/articles\/\d+$/)) {
      const articleId = parseInt(adminPath.split('/')[2]);
      const { title, slug, excerpt, content, image_url, category_id, subcategory_id, author, is_pinned, is_published } = body;

      if (!db) return json({ message: 'Updated (test mode)' });

      let finalSlug = null;
      if (slug !== undefined) {
        finalSlug = slug ? slugify(slug) : (title ? slugify(title) : null);
        if (finalSlug) {
          finalSlug = await uniqueSlug(finalSlug, 'articles', articleId);
        }
      }

      // Handle pinning
      let pinOrder = 0;
      if (is_pinned) {
        const currentArticle = await db.prepare('SELECT is_pinned, pin_order FROM articles WHERE id = ?').bind(articleId).first();
        if (!currentArticle || !currentArticle.is_pinned) {
          const pinnedCount = await db.prepare('SELECT COUNT(*) as count FROM articles WHERE is_pinned = 1 AND id != ?').bind(articleId).first();
          if ((pinnedCount?.count || 0) >= 2) {
            await db.prepare('UPDATE articles SET is_pinned = 0, pin_order = 0 WHERE is_pinned = 1 ORDER BY pin_order DESC LIMIT 1').run();
          }
          const maxPin = await db.prepare('SELECT MAX(pin_order) as max_order FROM articles WHERE is_pinned = 1 AND id != ?').bind(articleId).first();
          pinOrder = (maxPin?.max_order || -1) + 1;
        }
      }

      const updates = [];
      const values = [];
      if (title !== undefined) { updates.push('title = ?'); values.push(title); }
      if (finalSlug) { updates.push('slug = ?'); values.push(finalSlug); }
      if (excerpt !== undefined) { updates.push('excerpt = ?'); values.push(excerpt); }
      if (content !== undefined) { updates.push('content = ?'); values.push(content); }
      if (image_url !== undefined) { updates.push('image_url = ?'); values.push(image_url); }
      if (category_id !== undefined) { updates.push('category_id = ?'); values.push(category_id); }
      if (subcategory_id !== undefined) { updates.push('subcategory_id = ?'); values.push(subcategory_id); }
      if (author !== undefined) { updates.push('author = ?'); values.push(author); }
      if (is_pinned !== undefined) { updates.push('is_pinned = ?'); updates.push('pin_order = ?'); values.push(is_pinned ? 1 : 0, pinOrder); }
      if (is_published !== undefined) {
        updates.push('is_published = ?');
        values.push(is_published ? 1 : 0);
        if (is_published) {
          updates.push('published_at = COALESCE(published_at, CURRENT_TIMESTAMP)');
        }
      }

      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(articleId);
        await db.prepare(`UPDATE articles SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
      }

      return json({ message: 'Article updated' });
    }

    // DELETE /api/admin/articles/:id
    if (request.method === 'DELETE' && adminPath.match(/^\/articles\/\d+$/)) {
      const articleId = parseInt(adminPath.split('/')[2]);
      if (db) await db.prepare('DELETE FROM articles WHERE id = ?').bind(articleId).run();
      return json({ message: 'Article deleted' });
    }

    // ═══ CATEGORIES ═══

    // GET /api/admin/categories
    if (adminPath === '/categories' && request.method === 'GET') {
      if (!db) return json([]);
      const result = await db.prepare('SELECT * FROM categories ORDER BY name ASC').all();
      return json(result.results || []);
    }

    // POST /api/admin/categories
    if (adminPath === '/categories' && request.method === 'POST') {
      const { name, description } = body;
      if (!name) return err('Category name required');

      let catSlug = slugify(name);
      catSlug = await uniqueSlug(catSlug, 'categories', 0);

      if (!db) return json({ id: Date.now(), slug: catSlug, message: 'Created (test mode)' }, 201);

      const result = await db.prepare(
        'INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)'
      ).bind(name, catSlug, description || '').run();

      return json({ id: result.meta.last_row_id, slug: catSlug, message: 'Category created' }, 201);
    }

    // PUT /api/admin/categories/:id
    if (request.method === 'PUT' && adminPath.match(/^\/categories\/\d+$/)) {
      const catId = parseInt(adminPath.split('/')[2]);
      const { name, description } = body;

      if (!db) return json({ message: 'Updated (test mode)' });

      const updates = [];
      const values = [];
      if (name !== undefined) {
        let catSlug = slugify(name);
        catSlug = await uniqueSlug(catSlug, 'categories', catId);
        updates.push('name = ?', 'slug = ?');
        values.push(name, catSlug);
      }
      if (description !== undefined) { updates.push('description = ?'); values.push(description); }

      if (updates.length > 0) {
        values.push(catId);
        await db.prepare(`UPDATE categories SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
      }

      return json({ message: 'Category updated' });
    }

    // DELETE /api/admin/categories/:id
    if (request.method === 'DELETE' && adminPath.match(/^\/categories\/\d+$/)) {
      const catId = parseInt(adminPath.split('/')[2]);
      if (db) {
        await db.prepare('DELETE FROM subcategories WHERE category_id = ?').bind(catId).run();
        await db.prepare('UPDATE articles SET category_id = NULL WHERE category_id = ?').bind(catId).run();
        await db.prepare('DELETE FROM categories WHERE id = ?').bind(catId).run();
      }
      return json({ message: 'Category deleted' });
    }

    // ═══ SUBCATEGORIES ═══

    // GET /api/admin/subcategories
    if (adminPath === '/subcategories' && request.method === 'GET') {
      if (!db) return json([]);
      const result = await db.prepare(`
        SELECT s.*, c.name as category_name
        FROM subcategories s
        LEFT JOIN categories c ON s.category_id = c.id
        ORDER BY c.name ASC, s.name ASC
      `).all();
      return json(result.results || []);
    }

    // POST /api/admin/subcategories
    if (adminPath === '/subcategories' && request.method === 'POST') {
      const { category_id, name } = body;
      if (!category_id || !name) return err('Category and name required');

      let subSlug = slugify(name);
      subSlug = await uniqueSlug(subSlug, 'subcategories', 0);

      if (!db) return json({ id: Date.now(), slug: subSlug, message: 'Created (test mode)' }, 201);

      const result = await db.prepare(
        'INSERT INTO subcategories (category_id, name, slug) VALUES (?, ?, ?)'
      ).bind(category_id, name, subSlug).run();

      return json({ id: result.meta.last_row_id, slug: subSlug, message: 'Subcategory created' }, 201);
    }

    // DELETE /api/admin/subcategories/:id
    if (request.method === 'DELETE' && adminPath.match(/^\/subcategories\/\d+$/)) {
      const subId = parseInt(adminPath.split('/')[2]);
      if (db) {
        await db.prepare('UPDATE articles SET subcategory_id = NULL WHERE subcategory_id = ?').bind(subId).run();
        await db.prepare('DELETE FROM subcategories WHERE id = ?').bind(subId).run();
      }
      return json({ message: 'Subcategory deleted' });
    }

    // ═══ SETTINGS ═══

    // GET /api/admin/settings
    if (adminPath === '/settings' && request.method === 'GET') {
      if (!db) return json({ site_title: 'The Signal', site_tagline: 'Smart Analysis & Insights' });
      const settings = await db.prepare('SELECT * FROM settings WHERE id = 1').first();
      return json(settings || { site_title: 'The Signal', site_tagline: 'Smart Analysis & Insights' });
    }

    // PUT /api/admin/settings
    if (adminPath === '/settings' && request.method === 'PUT') {
      const { site_title, site_tagline, logo_url, about_text } = body;
      if (!db) return json({ message: 'Settings saved (test mode)' });

      await db.prepare(`
        UPDATE settings SET site_title = ?, site_tagline = ?, logo_url = ?, about_text = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).bind(
        site_title || 'The Signal',
        site_tagline || 'Smart Analysis & Insights',
        logo_url || null,
        about_text || ''
      ).run();

      return json({ message: 'Settings saved' });
    }

    // ═══ STATS ═══
    if (adminPath === '/stats' && request.method === 'GET') {
      if (!db) return json({ articles: 0, published: 0, categories: 0 });

      const articles = await db.prepare('SELECT COUNT(*) as count FROM articles').first();
      const published = await db.prepare('SELECT COUNT(*) as count FROM articles WHERE is_published = 1').first();
      const categories = await db.prepare('SELECT COUNT(*) as count FROM categories').first();
      const pinned = await db.prepare('SELECT COUNT(*) as count FROM articles WHERE is_pinned = 1').first();

      return json({
        total_articles: articles?.count || 0,
        published_articles: published?.count || 0,
        categories: categories?.count || 0,
        pinned_articles: pinned?.count || 0
      });
    }

    return err('Admin route not found: ' + adminPath, 404);
  }

  return err('Route not found: ' + path, 404);
}
