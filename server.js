'use strict';

const express = require('express');
const { BoundedCache } = require('./lib/cache');
const { buildSelfContainedPage } = require('./lib/inline');
const { FEEDS, fetchSourceItems } = require('./lib/feeds');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.API_SECRET;

if (!SECRET) {
  console.error('API_SECRET env var required');
  process.exit(1);
}

// Tunables (all optional, with sensible defaults).
const MAX_ITEMS = parseInt(process.env.MAX_ITEMS || '25', 10);
const ENTRY_TTL_MS = parseInt(process.env.ENTRY_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const ENTRY_MAX = parseInt(process.env.ENTRY_MAX || '500', 10);
const FEED_TTL_MS = parseInt(process.env.FEED_TTL_MS || String(30 * 60 * 1000), 10);
const FETCH_CONCURRENCY = parseInt(process.env.FETCH_CONCURRENCY || '4', 10);
const MAX_ASSET_BYTES = parseInt(process.env.MAX_ASSET_BYTES || String(256 * 1024), 10);

// id -> self-contained HTML of a discussion page. This is the "map from id to
// content" that avoids re-fetching pages we've already rendered; it is bounded
// in both age (TTL) and size (LRU eviction) so memory can't grow forever.
const entryCache = new BoundedCache({ maxEntries: ENTRY_MAX, ttlMs: ENTRY_TTL_MS });

// feedKey -> { xml, builtAt }. Short-lived so we don't re-fetch/re-parse the
// source feed on every request, while still refreshing periodically.
const feedCache = new Map();

// Health check is exempt from the secret so container orchestration can probe it.
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

/** Get a discussion page's self-contained HTML, using the bounded cache. */
async function getEntryHtml(id, commentsUrl) {
  const cached = entryCache.get(id);
  if (cached) return cached;
  const html = await buildSelfContainedPage(commentsUrl, { maxAssetBytes: MAX_ASSET_BYTES });
  entryCache.set(id, html);
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
  const sourceItems = await fetchSourceItems(feed);
  const items = sourceItems.slice(0, MAX_ITEMS);

  await mapWithConcurrency(items, FETCH_CONCURRENCY, async (item) => {
    if (!item.commentsUrl) return;
    try {
      item.contentHtml = await getEntryHtml(item.id, item.commentsUrl);
    } catch (err) {
      console.error(`Failed to render ${item.id} (${item.commentsUrl}): ${err.message}`);
      // Leave contentHtml unset; the item still appears with its original
      // description and link so the feed never fully fails on one bad page.
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
    <p>HN and Lobsters feeds with discussion pages embedded for offline reading.</p>
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

app.listen(PORT, () => {
  console.log(`offlinerss running at http://localhost:${PORT}`);
  console.log(`Feeds: ${Object.keys(FEEDS).map((k) => `/${k}.xml`).join(', ')}`);
});
