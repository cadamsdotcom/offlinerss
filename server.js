'use strict';

const express = require('express');
const compression = require('compression');
const { BoundedCache } = require('./lib/cache');
const { createKvStore } = require('./lib/kvstore');
const { renderDiscussion, renderArticle, renderFallback } = require('./lib/render');
const { FEEDS, fetchSourceItems } = require('./lib/feeds');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.API_SECRET;

if (!SECRET) {
  console.error('API_SECRET env var required');
  process.exit(1);
}

// Tunables (all optional, with sensible defaults).
const ENTRY_TTL_MS = parseInt(process.env.ENTRY_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const ENTRY_MAX = parseInt(process.env.ENTRY_MAX || '500', 10);
const FEED_TTL_MS = parseInt(process.env.FEED_TTL_MS || String(30 * 60 * 1000), 10);
const FETCH_CONCURRENCY = parseInt(process.env.FETCH_CONCURRENCY || '3', 10);

// id -> rendered HTML of a discussion page. This is the "map from id to
// content" that avoids re-fetching pages we've already rendered; it is bounded
// in both age (TTL) and size (LRU eviction) so memory can't grow forever.
const entryCache = new BoundedCache({ maxEntries: ENTRY_MAX, ttlMs: ENTRY_TTL_MS });

// Optional L2 cache that survives serverless cold starts (see lib/kvstore.js).
// Disabled automatically when its env vars are absent. The deploy's git commit
// (injected by Vercel) namespaces the keys, so a new deploy starts with a fresh
// cache and never serves HTML rendered by older code; stale keys expire by TTL.
const RENDER_VERSION = (process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7);
const entryStore = createKvStore({
  keyPrefix: `offlinerss:${RENDER_VERSION}:entry:`,
  ttlMs: ENTRY_TTL_MS,
});

// feedKey -> { xml, builtAt }. Short-lived so we don't re-fetch/re-parse the
// source feed on every request, while still refreshing periodically.
const feedCache = new Map();

// Each item repeats the same stylesheets, so the assembled feed is large but
// highly compressible; gzip cuts the wire transfer ~7x.
app.use(compression());

// Health check is exempt from the secret so uptime monitors can probe it.
app.get('/health', (_req, res) => res.type('text/plain').send('ok'));

// Auth middleware - require ?secret=xxx (mirrors tpcal).
app.use((req, res, next) => {
  if (req.query.secret !== SECRET) return res.status(404).send('Not found');
  next();
});

/** Run async tasks with bounded concurrency, preserving input order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Get a discussion page's rendered HTML. Checks the in-memory cache (L1), then
 * the persistent KV store (L2) if configured, and only re-renders on a full
 * miss — populating both layers so later builds and cold starts reuse it.
 */
async function getEntryHtml(id, kind, targetUrl, feedKey, story) {
  const local = entryCache.get(id);
  if (local) return local;
  const remote = await entryStore.get(id);
  if (remote) {
    entryCache.set(id, remote);
    return remote;
  }
  const html =
    kind === 'article'
      ? await renderArticle(targetUrl, feedKey, story)
      : await renderDiscussion(targetUrl, feedKey, story);
  entryCache.set(id, html);
  await entryStore.set(id, html);
  return html;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cdata(str) {
  // Safely embed arbitrary HTML in CDATA by splitting any "]]>" sequences.
  return `<![CDATA[${String(str || '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function rfc822(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return (isNaN(d.getTime()) ? new Date() : d).toUTCString();
}

function buildRss(feed, items, selfUrl) {
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">'
  );
  parts.push('<channel>');
  parts.push(`<title>${escapeXml(feed.title)}</title>`);
  parts.push(`<link>${escapeXml(feed.homepage)}</link>`);
  parts.push(`<description>${escapeXml(feed.description)}</description>`);
  parts.push(`<lastBuildDate>${rfc822()}</lastBuildDate>`);
  parts.push(`<generator>offlinerss</generator>`);
  if (selfUrl) {
    parts.push(`<atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>`);
  }

  for (const item of items) {
    parts.push('<item>');
    parts.push(`<title>${escapeXml(item.title)}</title>`);
    if (item.link) parts.push(`<link>${escapeXml(item.link)}</link>`);
    parts.push(`<guid isPermaLink="false">${escapeXml(item.guid)}</guid>`);
    if (item.pubDate) parts.push(`<pubDate>${rfc822(item.pubDate)}</pubDate>`);
    if (item.author) parts.push(`<dc:creator>${escapeXml(item.author)}</dc:creator>`);
    if (item.commentsUrl) parts.push(`<comments>${escapeXml(item.commentsUrl)}</comments>`);
    if (item.origDescription) {
      parts.push(`<description>${cdata(item.origDescription)}</description>`);
    }
    if (item.contentHtml) {
      parts.push(`<content:encoded>${cdata(item.contentHtml)}</content:encoded>`);
    }
    parts.push('</item>');
  }

  parts.push('</channel>');
  parts.push('</rss>');
  return parts.join('\n');
}

async function buildFeedXml(feed, selfUrl) {
  // Query the source feed once. Each source story becomes two output items, in
  // original order: the reader-mode article, then its discussion.
  const sources = await fetchSourceItems(feed);

  const items = [];
  const tasks = [];
  for (const src of sources) {
    const story = {
      title: src.title,
      link: src.link,
      author: src.author,
      pubDate: src.pubDate,
      commentsUrl: src.commentsUrl,
    };

    const articleItem = {
      title: `Article: ${src.title}`,
      link: src.link || src.commentsUrl,
      guid: `article:${src.id}`,
      pubDate: src.pubDate,
      author: src.author,
      commentsUrl: src.commentsUrl,
    };
    const commentsItem = {
      title: `Comments: ${src.title}`,
      link: src.commentsUrl,
      guid: `comments:${src.id}`,
      pubDate: src.pubDate,
      author: src.author,
      commentsUrl: src.commentsUrl,
      origDescription: src.origDescription,
    };
    items.push(articleItem, commentsItem);

    // Self/text posts have no external article; fall back to the discussion
    // page as the article target (reader mode extracts the post body).
    const articleTarget = src.link || src.commentsUrl;
    if (articleTarget) {
      tasks.push({ item: articleItem, kind: 'article', cacheId: `article:${src.id}`, targetUrl: articleTarget, story });
    }
    if (src.commentsUrl) {
      tasks.push({ item: commentsItem, kind: 'comments', cacheId: `comments:${src.id}`, targetUrl: src.commentsUrl, story });
    }
  }

  await mapWithConcurrency(tasks, FETCH_CONCURRENCY, async (t) => {
    try {
      t.item.contentHtml = await getEntryHtml(t.cacheId, t.kind, t.targetUrl, feed.key, t.story);
    } catch (err) {
      console.error(`Failed to render ${t.kind} ${t.cacheId} (${t.targetUrl}): ${err.message}`);
      // Surface the failure in the entry itself (with links out) instead of
      // silently falling back to a bare description, so it's diagnosable.
      // Not cached: the next build retries and may succeed (e.g. after a 429).
      t.item.contentHtml = renderFallback(t.targetUrl, feed.key, t.story, err);
    }
  });

  return buildRss(feed, items, selfUrl);
}

async function getFeedXml(feed, selfUrl) {
  const cached = feedCache.get(feed.key);
  if (cached && Date.now() - cached.builtAt < FEED_TTL_MS) {
    return cached.xml;
  }
  const xml = await buildFeedXml(feed, selfUrl);
  feedCache.set(feed.key, { xml, builtAt: Date.now() });
  return xml;
}

// Feed routes: /hn.xml and /lobsters.xml
app.get('/:feed.xml', async (req, res) => {
  const feed = FEEDS[req.params.feed];
  if (!feed) return res.status(404).type('text/plain').send('Unknown feed');
  try {
    const selfUrl = `${req.protocol}://${req.get('host')}/${feed.key}.xml`;
    const xml = await getFeedXml(feed, selfUrl);
    res.type('application/rss+xml').send(xml);
  } catch (err) {
    console.error(`Error building ${feed.key} feed:`, err);
    res.status(500).type('text/plain').send('Error building feed: ' + err.message);
  }
});

app.get('/', (req, res) => {
  const s = req.query.secret;
  res.send(`
    <h1>offlinerss</h1>
    <p>HN and Lobsters feeds for offline reading. Each story appears as two
    items in the source's order: an <em>Article:</em> item with the full body
    extracted via reader mode (comments stripped), followed by a
    <em>Comments:</em> item with the threaded discussion.</p>
    <ul>
      ${Object.values(FEEDS)
        .map(
          (f) =>
            `<li><strong>${escapeXml(f.title)}</strong> — <a href="/${f.key}.xml?secret=${encodeURIComponent(s)}">/${f.key}.xml</a></li>`
        )
        .join('')}
    </ul>
  `);
});

// Start a listener only when run directly (local dev). On serverless hosts
// the platform imports the exported app and invokes it per request instead.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`offlinerss running at http://localhost:${PORT}`);
    console.log(`Feeds: ${Object.keys(FEEDS).map((k) => `/${k}.xml`).join(', ')}`);
    console.log(`Entry cache: in-memory${entryStore.enabled ? ' + KV (persistent)' : ''}`);
  });
}

module.exports = app;
