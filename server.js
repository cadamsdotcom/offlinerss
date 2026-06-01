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
const FETCH_CONCURRENCY = parseInt(process.env.FETCH_CONCURRENCY || '3', 10);

// Per-kind entry lifetimes. Articles are immutable once published, so they get
// the long default; discussions are append-only and grow while a story is hot,
// so comments get a much shorter TTL to re-render and pick up new replies.
// ENTRY_TTL_MS remains the article default for backward compatibility.
const ARTICLE_TTL_MS = parseInt(process.env.ARTICLE_TTL_MS || String(ENTRY_TTL_MS), 10);
const COMMENTS_TTL_MS = parseInt(process.env.COMMENTS_TTL_MS || String(30 * 60 * 1000), 10);

// id -> rendered HTML of a discussion page. This is the "map from id to
// content" that avoids re-fetching pages we've already rendered; it is bounded
// in both age (TTL) and size (LRU eviction) so memory can't grow forever. The
// default ttl is the longer (article) one; comments entries pass their own
// shorter ttl per set() below.
const entryCache = new BoundedCache({ maxEntries: ENTRY_MAX, ttlMs: ARTICLE_TTL_MS });

// Optional L2 cache that survives serverless cold starts (see lib/kvstore.js).
// Disabled automatically when its env vars are absent. The deploy's git commit
// (injected by Vercel) namespaces the keys, so a new deploy starts with a fresh
// cache and never serves HTML rendered by older code; stale keys expire by TTL.
const RENDER_VERSION = (process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7);
const entryStore = createKvStore({
  keyPrefix: `offlinerss:${RENDER_VERSION}:entry:`,
  ttlMs: ARTICLE_TTL_MS,
});

// Negative cache. When an entry can't be rendered (every article fallback
// missed, a fetch timed out, etc.) we remember that briefly so we don't
// re-attempt it — and re-spend its whole fetch budget — on every single build.
// Without this, one persistently failing page is retried on each refresh and
// can keep timing the function out indefinitely even when the rest is cached.
// The TTL is short so an entry recovers on its own once the upstream issue
// clears (e.g. a transient 429). Mirrors the entry cache's L1 + L2 layering.
const FAIL_TTL_MS = parseInt(process.env.FAIL_TTL_MS || String(10 * 60 * 1000), 10);
const failCache = new BoundedCache({ maxEntries: ENTRY_MAX, ttlMs: FAIL_TTL_MS });
const failStore = createKvStore({
  keyPrefix: `offlinerss:${RENDER_VERSION}:fail:`,
  ttlMs: FAIL_TTL_MS,
});

// Stale-on-error cache. Holds the last successfully rendered HTML for each
// entry far longer than its freshness TTL, so when a re-render fails (e.g. an
// HN 429 on a comments refresh, after the short comments TTL has already
// evicted the fresh copy) we can serve the previous render instead of the
// link-out fallback. Refreshed on every successful render, so it only ages
// while renders keep failing. A slightly stale comment thread — or a day-old
// copy of an immutable article — beats a "couldn't load" card. Read only on
// the failure paths below, so the warm/success path never touches it. Mirrors
// the entry cache's L1 + L2 layering.
const STALE_TTL_MS = parseInt(process.env.STALE_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const lastGoodCache = new BoundedCache({ maxEntries: ENTRY_MAX, ttlMs: STALE_TTL_MS });
const lastGoodStore = createKvStore({
  keyPrefix: `offlinerss:${RENDER_VERSION}:good:`,
  ttlMs: STALE_TTL_MS,
});

// Each feed is reassembled from a fresh source fetch on every request, so the
// story list always reflects the current front page (nothing falls through a
// stale-feed window). This stays cheap because per-story rendered content is
// cached above — a rebuild only fetches/renders stories it hasn't seen yet.

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
 * Last successfully rendered HTML for an entry (the stale-on-error fallback),
 * checked L1 then L2 and promoting an L2 hit into L1. Undefined when there's no
 * prior good render to fall back to.
 */
async function getLastGood(id) {
  const local = lastGoodCache.get(id);
  if (local) return local;
  const remote = await lastGoodStore.get(id);
  if (remote) {
    lastGoodCache.set(id, remote);
    return remote;
  }
  return undefined;
}

/**
 * Get a discussion page's rendered HTML. Checks the in-memory cache (L1), then
 * the persistent KV store (L2) if configured, and only re-renders on a full
 * miss — populating both layers so later builds and cold starts reuse it. When
 * a re-render fails, falls back to the last good render (stale-on-error) before
 * giving up and letting the caller show the link-out fallback.
 */
async function getEntryHtml(id, kind, targetUrl, feedKey, story, stats) {
  // Comments are append-only and grow while a story is active, so they expire
  // quickly to be re-rendered; articles are immutable and kept for the long
  // default. Computed once here and reused for every positive-cache write
  // below, so an entry's L1 and L2 copies share the same expiry.
  const ttl = kind === 'comments' ? COMMENTS_TTL_MS : ARTICLE_TTL_MS;
  const local = entryCache.get(id);
  if (local) {
    if (stats) stats.l1++;
    return local;
  }
  const remote = await entryStore.get(id);
  if (remote) {
    if (stats) stats.l2++;
    entryCache.set(id, remote, ttl);
    return remote;
  }
  // If we recently failed to render this entry, don't retry it on this build:
  // serve the last good render if we have one, else re-throw the remembered
  // error so the caller shows the link-out fallback — either way without
  // re-spending the fetch budget. Checked only on a positive-cache miss, so the
  // warm/success path pays no extra lookups.
  const failedLocal = failCache.get(id);
  if (failedLocal) {
    if (stats) stats.skipped++;
    const stale = await getLastGood(id);
    if (stale) {
      if (stats) stats.stale++;
      return stale;
    }
    throw new Error(failedLocal);
  }
  const failedRemote = await failStore.get(id);
  if (failedRemote) {
    if (stats) stats.skipped++;
    failCache.set(id, failedRemote);
    const stale = await getLastGood(id);
    if (stale) {
      if (stats) stats.stale++;
      return stale;
    }
    throw new Error(failedRemote);
  }
  // Cold render. Log the start so an entry that's still in flight when the
  // function is killed (FUNCTION_INVOCATION_TIMEOUT) is identifiable: it leaves
  // a "start" line with no matching completion. The render functions log their
  // own fetch/parse/tier timing on completion; here we just time the whole
  // entry and report failures (with elapsed ms).
  const t0 = Date.now();
  console.log(`[entry] start ${id} ${targetUrl}`);
  try {
    const html =
      kind === 'article'
        ? await renderArticle(targetUrl, feedKey, story)
        : await renderDiscussion(targetUrl, feedKey, story);
    if (stats) stats.rendered++;
    console.log(`[entry] ok ${id} ${Date.now() - t0}ms ${html.length}b`);
    entryCache.set(id, html, ttl);
    await entryStore.set(id, html, ttl);
    // Refresh the stale-on-error copy (long TTL) so it only ages while renders
    // are failing.
    lastGoodCache.set(id, html);
    await lastGoodStore.set(id, html);
    return html;
  } catch (err) {
    // Remember the failure (short TTL) so the next build doesn't re-attempt the
    // same slow render. Then, rather than failing outright, serve the last good
    // render if we have one (stale-on-error) — better a slightly old thread than
    // a "couldn't load" card. Only with no prior render do we re-throw, letting
    // the caller show the link-out fallback.
    const msg = err.message || String(err);
    if (stats) stats.failed++;
    console.warn(`[entry] FAIL ${id} ${Date.now() - t0}ms: ${msg}`);
    failCache.set(id, msg);
    await failStore.set(id, msg);
    const stale = await getLastGood(id);
    if (stale) {
      if (stats) stats.stale++;
      console.warn(`[entry] stale-served ${id} (render failed; using last good render)`);
      return stale;
    }
    throw err;
  }
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

// Return an RFC-822 date `ms` milliseconds before the given date string, or the
// original value when it isn't a parseable date.
function olderBy(dateStr, ms) {
  const t = Date.parse(dateStr || '');
  return isNaN(t) ? dateStr : new Date(t - ms).toUTCString();
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
  const buildStart = Date.now();
  // Query the source feed once. Each source story becomes two output items, in
  // original order: the reader-mode article, then its discussion.
  const srcStart = Date.now();
  const sources = await fetchSourceItems(feed);
  console.log(`[build] ${feed.key} source: ${sources.length} stories in ${Date.now() - srcStart}ms`);

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
      // Same story time as the article, minus one second. Readers sort the
      // timeline by date (newest first) and break ties internally, which made
      // the pair flip. Nudging Comments 1s older keeps it directly below its
      // Article (which keeps the real pubDate) without distorting the time.
      pubDate: olderBy(src.pubDate, 1000),
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

  // Per-build tally of how each entry resolved (cache hits vs. fresh renders vs.
  // failures), summarized at the end. getEntryHtml does the per-entry logging.
  const stats = { l1: 0, l2: 0, rendered: 0, failed: 0, skipped: 0, stale: 0 };
  await mapWithConcurrency(tasks, FETCH_CONCURRENCY, async (t) => {
    try {
      t.item.contentHtml = await getEntryHtml(t.cacheId, t.kind, t.targetUrl, feed.key, t.story, stats);
    } catch (err) {
      // Surface the failure in the entry itself (with links out) instead of
      // silently falling back to a bare description, so it's diagnosable. The
      // failure is negative-cached (short TTL) in getEntryHtml, so the next few
      // builds serve this fallback cheaply instead of re-attempting the render.
      // getEntryHtml already logged the failure/skip; no need to log again here.
      t.item.contentHtml = renderFallback(t.targetUrl, feed.key, t.story, err);
    }
  });

  // Final tally. If the function times out, this line never prints — the
  // unmatched `[entry] start` line(s) above pinpoint what was still in flight.
  console.log(
    `[build] ${feed.key} done in ${Date.now() - buildStart}ms — ${tasks.length} entries ` +
      `(L1 ${stats.l1}, L2 ${stats.l2}, rendered ${stats.rendered}, ` +
      `failed ${stats.failed}, neg-skipped ${stats.skipped}, stale-served ${stats.stale})`
  );

  return buildRss(feed, items, selfUrl);
}

// Feed routes: /hn.xml and /lobsters.xml
app.get('/:feed.xml', async (req, res) => {
  const feed = FEEDS[req.params.feed];
  if (!feed) return res.status(404).type('text/plain').send('Unknown feed');
  try {
    const selfUrl = `${req.protocol}://${req.get('host')}/${feed.key}.xml`;
    const xml = await buildFeedXml(feed, selfUrl);
    res.type('application/rss+xml').send(xml);
  } catch (err) {
    console.error(`Error building ${feed.key} feed:`, err);
    res.status(500).type('text/plain').send('Error building feed: ' + err.message);
  }
});

// Report whether the persistent KV cache is not just configured but actually
// reachable, by doing a real set/get round-trip. Surfaced on the home page so
// the KV status is checkable at runtime (the startup log only runs in local
// dev, never on serverless).
async function kvStatus() {
  if (!entryStore.enabled) return 'disabled — no KV env vars detected (in-memory cache only)';
  try {
    const token = `ping-${Date.now()}`;
    await entryStore.set('__healthcheck', token);
    const got = await entryStore.get('__healthcheck');
    return got === token
      ? 'enabled and reachable (set/get round-trip OK)'
      : 'configured, but the set/get round-trip failed (check the KV URL/token)';
  } catch (err) {
    return `configured, but unreachable: ${err.message}`;
  }
}

app.get('/', async (req, res) => {
  const s = req.query.secret;
  const kv = await kvStatus();
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
    <p><strong>Persistent cache (KV):</strong> ${escapeXml(kv)}</p>
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
