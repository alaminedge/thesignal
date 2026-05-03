// functions/api/[[route]].js
// The Pacific Signal — Complete API Handler
// Professional News Analysis Platform
// Beyond the Headlines

export async function onRequest(context) {

  const { request, env } = context;

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.SIGNAL_DB;

  // Parse request body for POST and PUT requests
  var body = {};
  if (request.method === 'POST' || request.method === 'PUT') {
    try {
      body = await request.json();
    } catch (e) {
      // No JSON body or invalid JSON
    }
  }

  // Helper function to send JSON response
  function json(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: corsHeaders
    });
  }

  // Helper function to send error response
  function err(msg, status) {
    return json({ error: msg }, status || 400);
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

      if (!existing) {
        break;
      }

      slug = baseSlug + '-' + counter;
      counter = counter + 1;
    }

    return slug;
  }

  // ══════════════════════════════════════════════════════════════
  // DATABASE SETUP — Create all tables if they don't exist
  // ══════════════════════════════════════════════════════════════

  if (db && !globalThis.__pacific_signal_db_v1) {

    // Create categories table
    try {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    } catch (e) {}

    // Create articles table
    try {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS articles (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, excerpt TEXT, content TEXT NOT NULL, image_url TEXT, category_id INTEGER, author TEXT DEFAULT 'The Pacific Signal', display_block TEXT DEFAULT NULL, spotlight_label TEXT, is_pinned INTEGER DEFAULT 0, pin_order INTEGER DEFAULT 0, is_published INTEGER DEFAULT 0, view_count INTEGER DEFAULT 0, published_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    } catch (e) {}

    // Create admins table
    try {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, display_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    } catch (e) {}

    // Create settings table
    try {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, site_title TEXT DEFAULT 'The Pacific Signal', site_tagline TEXT DEFAULT 'Beyond the Headlines', logo_url TEXT, about_text TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    } catch (e) {}

    // Create subscribers table
    try {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS subscribers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ).run();
    } catch (e) {}

    // Run safe migrations for existing databases
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
      try {
        await db.prepare(migrationList[i]).run();
      } catch (e) {
        // Column already exists — ignore
      }
    }

    // Create default admin user (username: admin, password: admin123)
    try {
      await db.prepare(
        "INSERT OR IGNORE INTO admins (username, password, display_name) VALUES ('admin', 'admin123', 'Editor')"
      ).run();
    } catch (e) {
      // Admin already exists — ignore
    }

    // Create default settings
    try {
      await db.prepare(
        "INSERT OR IGNORE INTO settings (id, site_title, site_tagline) VALUES (1, 'The Pacific Signal', 'Beyond the Headlines')"
      ).run();
    } catch (e) {
      // Settings already exist — ignore
    }

    // Insert 20 default categories if the categories table is empty
    var categoryCountResult = await db.prepare('SELECT COUNT(*) as count FROM categories').first();

    if (categoryCountResult && categoryCountResult.count === 0) {

      var defaultCategoryNames = [
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

      for (var j = 0; j < defaultCategoryNames.length; j++) {
        var categoryName = defaultCategoryNames[j];
        var categorySlug = slugify(categoryName);

        try {
          await db.prepare(
            'INSERT INTO categories (name, slug) VALUES (?, ?)'
          ).bind(categoryName, categorySlug).run();
        } catch (e) {
          // Skip if slug already exists
        }
      }
    }

    // Mark database as ready to avoid running setup again
    globalThis.__pacific_signal_db_v1 = true;
  }

  // ══════════════════════════════════════════════════════════════
  // PUBLIC API ROUTES — No authentication required
  // ══════════════════════════════════════════════════════════════

  // ────────────────────────────────────────────────────────────
  // GET /api/homepage
  // Returns the Rhythm of the Scroll layout with all four blocks
  // plus latest articles
  // ────────────────────────────────────────────────────────────
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

    // Block A: Hero — One article marked as display_block='hero'
    var heroArticle = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'hero' AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 1"
    ).first();

    // Fallback: If no hero assigned, use the first pinned article
    if (!heroArticle) {
      heroArticle = await db.prepare(
        "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.is_pinned = 1 AND a.is_published = 1 ORDER BY a.pin_order ASC LIMIT 1"
      ).first();
    }

    // Block B: Intelligence Feed — Up to 8 articles marked as display_block='feed'
    var feedArticlesResult = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'feed' AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 8"
    ).all();

    // Block C: Visual Break — One article with image marked as display_block='visual'
    var visualArticle = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'visual' AND a.is_published = 1 AND a.image_url IS NOT NULL ORDER BY a.published_at DESC LIMIT 1"
    ).first();

    // Block D: Category Spotlights — Up to 4 articles marked as display_block='spotlight'
    var spotlightsResult = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block = 'spotlight' AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 4"
    ).all();

    // Latest articles — Not assigned to any block, up to 9 articles
    var latestResult = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.display_block IS NULL AND a.is_published = 1 ORDER BY a.published_at DESC LIMIT 9"
    ).all();

    return json({
      hero: heroArticle || null,
      feed: feedArticlesResult.results || [],
      visual: visualArticle || null,
      spotlights: spotlightsResult.results || [],
      latest: latestResult.results || []
    });
  }

  // ────────────────────────────────────────────────────────────
  // GET /api/article/:slug
  // Returns a single article with related articles
  // Also increments the view counter
  // ────────────────────────────────────────────────────────────
  if (request.method === 'GET' && path.match(/^\/api\/article\/[a-z0-9-]+$/)) {

    if (!db) {
      return err('Article not found', 404);
    }

    var requestedSlug = path.split('/')[3];

    var article = await db.prepare(
      "SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.slug = ? AND a.is_published = 1"
    ).bind(requestedSlug).first();

    if (!article) {
      return err('Article not found', 404);
    }

    // Increment view count silently
    try {
      await db.prepare('UPDATE articles SET view_count = view_count + 1 WHERE id = ?').bind(article.id).run();
    } catch (e) {
      // Silently fail — view count is not critical
    }

    // Get related articles from the same category
    var relatedArticlesResult = await db.prepare(
      "SELECT id, title, slug, excerpt, image_url, author, published_at FROM articles WHERE category_id = ? AND id != ? AND is_published = 1 ORDER BY published_at DESC LIMIT 3"
    ).bind(article.category_id, article.id).all();

    return json({
      article: article,
      related: relatedArticlesResult.results || []
    });
  }

  // ────────────────────────────────────────────────────────────
  // GET /api/categories
  // Returns all categories
  // ────────────────────────────────────────────────────────────
  if (path === '/api/categories' && request.method === 'GET') {

    if (!db) {
      return json([]);
    }

    var allCategoriesResult = await db.prepare('SELECT * FROM categories ORDER BY name ASC').all();

    return json(allCategoriesResult.results || []);
  }

  // ────────────────────────────────────────────────────────────
  // GET /api/category/:slug
  // Returns articles filtered by category
  // ────────────────────────────────────────────────────────────
  if (request.method === 'GET' && path.match(/^\/api\/category\/[a-z0-9-]+$/)) {

    if (!db) {
      return json({ category: null, articles: [] });
    }

    var categorySlugParam = path.split('/')[3];
    var pageNumber = parseInt(url.searchParams.get('page') || '1');
    var pageLimit = 12;
    var pageOffset = (pageNumber - 1) * pageLimit;

    var categoryInfo = await db.prepare('SELECT * FROM categories WHERE slug = ?').bind(categorySlugParam).first();

    if (!categoryInfo) {
      return err('Category not found', 404);
    }

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

  // ────────────────────────────────────────────────────────────
  // POST /api/subscribe
  // Newsletter subscription
  // ────────────────────────────────────────────────────────────
  if (path === '/api/subscribe' && request.method === 'POST') {

    var subscriberEmail = body.email;

    if (!subscriberEmail) {
      return err('Email is required');
    }

    if (!db) {
      return json({ message: 'Subscribed successfully!' }, 201);
    }

    try {
      await db.prepare(
        'INSERT INTO subscribers (email) VALUES (?)'
      ).bind(subscriberEmail.toLowerCase().trim()).run();

      return json({ message: 'Subscribed successfully!' }, 201);
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) {
        return err('This email is already subscribed');
      }
      return err('Error subscribing. Please try again.');
    }
  }

  // ══════════════════════════════════════════════════════════════
  // ADMIN AUTH ROUTES
  // ══════════════════════════════════════════════════════════════

  // ────────────────────────────────────────────────────────────
  // POST /api/admin/login
  // Admin authentication
  // ────────────────────────────────────────────────────────────
  if (path === '/api/admin/login' && request.method === 'POST') {

    var adminUsername = body.username;
    var adminPassword = body.password;

    if (!adminUsername || !adminPassword) {
      return err('Username and password are required');
    }

    // If no database is configured, use default credentials
    if (!db) {
      if (adminUsername === 'admin' && adminPassword === 'admin123') {
        return json({
          token: 'pacific_signal_admin_token_v1',
          admin: {
            id: 1,
            username: 'admin',
            display_name: 'Editor'
          }
        });
      }
      return err('Invalid credentials', 401);
    }

    // Look up admin in database
    var adminRecord = await db.prepare(
      'SELECT * FROM admins WHERE username = ? AND password = ?'
    ).bind(adminUsername, adminPassword).first();

    if (!adminRecord) {
      return err('Invalid credentials', 401);
    }

    return json({
      token: 'pacific_token_' + adminRecord.id + '_' + Date.now(),
      admin: {
        id: adminRecord.id,
        username: adminRecord.username,
        display_name: adminRecord.display_name
      }
    });
  }

  // ══════════════════════════════════════════════════════════════
  // ADMIN ROUTES — Authentication required
  // ══════════════════════════════════════════════════════════════

  if (path.startsWith('/api/admin/')) {

    // Check for authentication token
    var authHeaderValue = request.headers.get('Authorization') || '';

    if (!authHeaderValue.includes('pacific_')) {
      return err('Unauthorized — Please sign in', 401);
    }

    // Extract the admin path by removing the /api/admin prefix
    var adminRoutePath = path.replace('/api/admin', '');

    // ══════════════════════════════════════════════════════════
    // ARTICLES MANAGEMENT
    // ══════════════════════════════════════════════════════════

    // ────────────────────────────────────────────────────────
    // GET /api/admin/articles
    // List all articles with category information
    // ────────────────────────────────────────────────────────
    if (adminRoutePath === '/articles' && request.method === 'GET') {

      if (!db) {
        return json([]);
      }

      var articlesListResult = await db.prepare(
        "SELECT a.*, c.name as category_name FROM articles a LEFT JOIN categories c ON a.category_id = c.id ORDER BY a.created_at DESC"
      ).all();

      return json(articlesListResult.results || []);
    }

    // ────────────────────────────────────────────────────────
    // POST /api/admin/articles
    // Create a new article
    // ────────────────────────────────────────────────────────
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

      // Validate required fields
      if (!newTitle) {
        return err('Title is required');
      }

      if (!newContent) {
        return err('Content is required');
      }

      // Generate or use custom slug
      var finalArticleSlug = newCustomSlug ? slugify(newCustomSlug) : slugify(newTitle);

      if (!finalArticleSlug) {
        finalArticleSlug = 'article-' + Date.now();
      }

      // Ensure unique slug
      finalArticleSlug = await uniqueSlug(finalArticleSlug, 'articles', 0);

      // If no database, return mock success
      if (!db) {
        return json({
          id: Date.now(),
          slug: finalArticleSlug,
          message: 'Article created (test mode)'
        }, 201);
      }

      // Handle pinning logic — maximum 2 pinned articles
      var assignedPinOrder = 0;

      if (newIsPinned) {
        var currentPinnedCountResult = await db.prepare(
          'SELECT COUNT(*) as count FROM articles WHERE is_pinned = 1'
        ).first();

        if (currentPinnedCountResult && currentPinnedCountResult.count >= 2) {
          // Auto-unpin the oldest pinned article
          await db.prepare(
            'UPDATE articles SET is_pinned = 0, pin_order = 0 WHERE is_pinned = 1 ORDER BY pin_order DESC LIMIT 1'
          ).run();
        }

        var maxPinOrderResult = await db.prepare(
          'SELECT MAX(pin_order) as max_order FROM articles WHERE is_pinned = 1'
        ).first();

        assignedPinOrder = (maxPinOrderResult && maxPinOrderResult.max_order !== null)
          ? maxPinOrderResult.max_order + 1
          : 0;
      }

      // Set published date if publishing now
      var publishDate = newIsPublished ? new Date().toISOString() : null;

      try {
        var insertResult = await db.prepare(
          "INSERT INTO articles (title, slug, excerpt, content, image_url, category_id, author, display_block, spotlight_label, is_pinned, pin_order, is_published, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          newTitle,
          finalArticleSlug,
          newExcerpt,
          newContent,
          newImageUrl,
          newCategoryId,
          newAuthor,
          newDisplayBlock,
          newSpotlightLabel,
          newIsPinned ? 1 : 0,
          assignedPinOrder,
          newIsPublished ? 1 : 0,
          publishDate
        ).run();

        return json({
          id: insertResult.meta.last_row_id,
          slug: finalArticleSlug,
          message: 'Article created successfully'
        }, 201);

      } catch (e) {
        return err('Database error: ' + e.message, 500);
      }
    }

    // ────────────────────────────────────────────────────────
    // PUT /api/admin/articles/:id
    // Update an existing article
    // ────────────────────────────────────────────────────────
    if (request.method === 'PUT' && adminRoutePath.match(/^\/articles\/\d+$/)) {

      var updateArticleId = parseInt(adminRoutePath.split('/')[2]);

      if (!db) {
        return json({ message: 'Article updated (test mode)' });
      }

      var updateFields = [];
      var updateValues = [];

      if (body.title !== undefined) {
        updateFields.push('title = ?');
        updateValues.push(body.title);
      }

      if (body.slug !== undefined) {
        var updatedSlug = body.slug ? slugify(body.slug) : (body.title ? slugify(body.title) : null);
        if (updatedSlug) {
          updatedSlug = await uniqueSlug(updatedSlug, 'articles', updateArticleId);
          updateFields.push('slug = ?');
          updateValues.push(updatedSlug);
        }
      }

      if (body.excerpt !== undefined) {
        updateFields.push('excerpt = ?');
        updateValues.push(body.excerpt);
      }

      if (body.content !== undefined) {
        updateFields.push('content = ?');
        updateValues.push(body.content);
      }

      if (body.image_url !== undefined) {
        updateFields.push('image_url = ?');
        updateValues.push(body.image_url);
      }

      if (body.category_id !== undefined) {
        updateFields.push('category_id = ?');
        updateValues.push(body.category_id);
      }

      if (body.author !== undefined) {
        updateFields.push('author = ?');
        updateValues.push(body.author);
      }

      if (body.display_block !== undefined) {
        updateFields.push('display_block = ?');
        updateValues.push(body.display_block);
      }

      if (body.spotlight_label !== undefined) {
        updateFields.push('spotlight_label = ?');
        updateValues.push(body.spotlight_label);
      }

      if (body.is_pinned !== undefined) {
        var updatedPinOrder = 0;

        if (body.is_pinned) {
          var existingArticle = await db.prepare(
            'SELECT is_pinned, pin_order FROM articles WHERE id = ?'
          ).bind(updateArticleId).first();

          if (!existingArticle || !existingArticle.is_pinned) {
            var currentPinCount = await db.prepare(
              'SELECT COUNT(*) as count FROM articles WHERE is_pinned = 1 AND id != ?'
            ).bind(updateArticleId).first();

            if (currentPinCount && currentPinCount.count >= 2) {
              await db.prepare(
                'UPDATE articles SET is_pinned = 0, pin_order = 0 WHERE is_pinned = 1 ORDER BY pin_order DESC LIMIT 1'
              ).run();
            }

            var currentMaxPin = await db.prepare(
              'SELECT MAX(pin_order) as max_order FROM articles WHERE is_pinned = 1 AND id != ?'
            ).bind(updateArticleId).first();

            updatedPinOrder = (currentMaxPin && currentMaxPin.max_order !== null)
              ? currentMaxPin.max_order + 1
              : 0;
          }
        }

        updateFields.push('is_pinned = ?');
        updateValues.push(body.is_pinned ? 1 : 0);
        updateFields.push('pin_order = ?');
        updateValues.push(updatedPinOrder);
      }

      if (body.is_published !== undefined) {
        updateFields.push('is_published = ?');
        updateValues.push(body.is_published ? 1 : 0);

        if (body.is_published) {
          updateFields.push("published_at = COALESCE(published_at, CURRENT_TIMESTAMP)");
        }
      }

      if (updateFields.length > 0) {
        updateFields.push('updated_at = CURRENT_TIMESTAMP');
        updateValues.push(updateArticleId);

        await db.prepare(
          'UPDATE articles SET ' + updateFields.join(', ') + ' WHERE id = ?'
        ).bind(...updateValues).run();
      }

      return json({ message: 'Article updated successfully' });
    }

    // ────────────────────────────────────────────────────────
    // DELETE /api/admin/articles/:id
    // Delete an article
    // ────────────────────────────────────────────────────────
    if (request.method === 'DELETE' && adminRoutePath.match(/^\/articles\/\d+$/)) {

      var deleteArticleId = parseInt(adminRoutePath.split('/')[2]);

      if (db) {
        await db.prepare('DELETE FROM articles WHERE id = ?').bind(deleteArticleId).run();
      }

      return json({ message: 'Article deleted successfully' });
    }

    // ══════════════════════════════════════════════════════════
    // CATEGORIES MANAGEMENT
    // ══════════════════════════════════════════════════════════

    // ────────────────────────────────────────────────────────
    // GET /api/admin/categories
    // List all categories
    // ────────────────────────────────────────────────────────
    if (adminRoutePath === '/categories' && request.method === 'GET') {

      if (!db) {
        return json([]);
      }

      var categoriesListResult = await db.prepare('SELECT * FROM categories ORDER BY name ASC').all();

      return json(categoriesListResult.results || []);
    }

    // ────────────────────────────────────────────────────────
    // POST /api/admin/categories
    // Create a new category
    // ────────────────────────────────────────────────────────
    if (adminRoutePath === '/categories' && request.method === 'POST') {

      var newCategoryName = body.name;

      if (!newCategoryName) {
        return err('Category name is required');
      }

      var newCategorySlug = slugify(newCategoryName);
      newCategorySlug = await uniqueSlug(newCategorySlug, 'categories', 0);

      if (!db) {
        return json({ id: Date.now(), slug: newCategorySlug, message: 'Category created (test mode)' }, 201);
      }

      var categoryInsertResult = await db.prepare(
        'INSERT INTO categories (name, slug) VALUES (?, ?)'
      ).bind(newCategoryName, newCategorySlug).run();

      return json({
        id: categoryInsertResult.meta.last_row_id,
        slug: newCategorySlug,
        message: 'Category created successfully'
      }, 201);
    }

    // ────────────────────────────────────────────────────────
    // PUT /api/admin/categories/:id
    // Update a category
    // ────────────────────────────────────────────────────────
    if (request.method === 'PUT' && adminRoutePath.match(/^\/categories\/\d+$/)) {

      var updateCategoryId = parseInt(adminRoutePath.split('/')[2]);

      if (!db) {
        return json({ message: 'Category updated (test mode)' });
      }

      var categoryUpdateFields = [];
      var categoryUpdateValues = [];

      if (body.name !== undefined) {
        var updatedCategorySlug = slugify(body.name);
        updatedCategorySlug = await uniqueSlug(updatedCategorySlug, 'categories', updateCategoryId);
        categoryUpdateFields.push('name = ?');
        categoryUpdateValues.push(body.name);
        categoryUpdateFields.push('slug = ?');
        categoryUpdateValues.push(updatedCategorySlug);
      }

      if (categoryUpdateFields.length > 0) {
        categoryUpdateValues.push(updateCategoryId);
        await db.prepare(
          'UPDATE categories SET ' + categoryUpdateFields.join(', ') + ' WHERE id = ?'
        ).bind(...categoryUpdateValues).run();
      }

      return json({ message: 'Category updated successfully' });
    }

    // ────────────────────────────────────────────────────────
    // DELETE /api/admin/categories/:id
    // Delete a category
    // ────────────────────────────────────────────────────────
    if (request.method === 'DELETE' && adminRoutePath.match(/^\/categories\/\d+$/)) {

      var deleteCategoryId = parseInt(adminRoutePath.split('/')[2]);

      if (db) {
        // Remove category reference from articles first
        await db.prepare('UPDATE articles SET category_id = NULL WHERE category_id = ?').bind(deleteCategoryId).run();
        // Then delete the category
        await db.prepare('DELETE FROM categories WHERE id = ?').bind(deleteCategoryId).run();
      }

      return json({ message: 'Category deleted successfully' });
    }

    // ══════════════════════════════════════════════════════════
    // SETTINGS MANAGEMENT
    // ══════════════════════════════════════════════════════════

    // ────────────────────────────────────────────────────────
    // GET /api/admin/settings
    // Get site settings
    // ────────────────────────────────────────────────────────
    if (adminRoutePath === '/settings' && request.method === 'GET') {

      if (!db) {
        return json({
          site_title: 'The Pacific Signal',
          site_tagline: 'Beyond the Headlines'
        });
      }

      var settingsRecord = await db.prepare('SELECT * FROM settings WHERE id = 1').first();

      return json(settingsRecord || {
        site_title: 'The Pacific Signal',
        site_tagline: 'Beyond the Headlines'
      });
    }

    // ────────────────────────────────────────────────────────
    // PUT /api/admin/settings
    // Update site settings
    // ────────────────────────────────────────────────────────
    if (adminRoutePath === '/settings' && request.method === 'PUT') {

      if (!db) {
        return json({ message: 'Settings saved (test mode)' });
      }

      await db.prepare(
        "UPDATE settings SET site_title = ?, site_tagline = ?, logo_url = ?, about_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1"
      ).bind(
        body.site_title || 'The Pacific Signal',
        body.site_tagline || 'Beyond the Headlines',
        body.logo_url || null,
        body.about_text || ''
      ).run();

      return json({ message: 'Settings saved successfully' });
    }

    // ══════════════════════════════════════════════════════════
    // DASHBOARD STATISTICS
    // ══════════════════════════════════════════════════════════

    // ────────────────────────────────────────────────────────
    // GET /api/admin/stats
    // Get dashboard statistics
    // ────────────────────────────────────────────────────────
    if (adminRoutePath === '/stats' && request.method === 'GET') {

      if (!db) {
        return json({
          total_articles: 0,
          published_articles: 0,
          categories: 0,
          pinned_articles: 0,
          total_subscribers: 0
        });
      }

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

    // ────────────────────────────────────────────────────────
    // GET /api/admin/subscribers
    // List all newsletter subscribers
    // ────────────────────────────────────────────────────────
    if (adminRoutePath === '/subscribers' && request.method === 'GET') {

      if (!db) {
        return json([]);
      }

      var subscribersListResult = await db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC').all();

      return json(subscribersListResult.results || []);
    }

    // If no admin route matched
    return err('Admin route not found: ' + adminRoutePath, 404);
  }

  // ══════════════════════════════════════════════════════════════
  // 404 — No route matched at all
  // ══════════════════════════════════════════════════════════════
  return err('API route not found: ' + path, 404);
}
