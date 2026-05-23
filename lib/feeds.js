'use strict';

const cheerio = require('cheerio');
const { fetchWithTimeout } = require('./render');

const HN_SOURCE = 'https://hnrss.org/frontpage';
const LOBSTERS_SOURCE = 'https://lobste.rs/top/1w/rss';

// Extract the numeric/slug story id from a discussion URL, used to build a
// stable, human-readable cache id for each story.
const hnStoryId = (url) => {
  const m = /[?&]id=(\d+)/.exec(url || '');
  return m ? m[1] : null;
};
const lobstersStoryId = (url) => {
  const m = /lobste\.rs\/s\/([a-z0-9]+)/i.exec(url || '');
  return m ? m[1] : null;
};

/**
 * Feed definitions. `link` is preserved from the source item so it points at
 * the target article (Show HN / text posts and pure Lobsters discussions
 * naturally point back at the HN/Lobsters page, which is fine). `commentsUrl`
 * is the HN/Lobsters discussion page.
 *
 * Two modes:
 *  - `discussion`: fetch `commentsUrl` and embed the threaded comments
 *    (the original offline feeds).
 *  - `article`: fetch `link` and run it through reader-mode extraction
 *    (Mozilla Readability), embedding just the article body — comments,
 *    nav, and other boilerplate are stripped by the extractor itself.
 *
 * The reader feeds reuse the same source feeds (and thus the same story URLs)
 * as their discussion counterparts. Each feed's `idFromComments` namespaces
 * its cache ids by feed key so the discussion and article renderings of the
 * same story never collide in the entry cache.
 */
const FEEDS = {
  hn: {
    key: 'hn',
    mode: 'discussion',
    title: 'Hacker News (offline)',
    description: 'Hacker News front page with discussion pages embedded for offline reading.',
    homepage: 'https://news.ycombinator.com/',
    sourceUrl: HN_SOURCE,
    idFromComments: (url) => {
      const id = hnStoryId(url);
      return id ? `hn-${id}` : null;
    },
  },
  lobsters: {
    key: 'lobsters',
    mode: 'discussion',
    title: 'Lobsters (offline)',
    description: 'Lobsters top stories of the past week with discussion pages embedded for offline reading.',
    homepage: 'https://lobste.rs/',
    sourceUrl: LOBSTERS_SOURCE,
    idFromComments: (url) => {
      const id = lobstersStoryId(url);
      return id ? `lobsters-${id}` : null;
    },
  },
  'hn-reader': {
    key: 'hn-reader',
    mode: 'article',
    title: 'Hacker News (reader)',
    description: 'Hacker News front page with full articles extracted via reader mode for offline reading.',
    homepage: 'https://news.ycombinator.com/',
    sourceUrl: HN_SOURCE,
    idFromComments: (url) => {
      const id = hnStoryId(url);
      return id ? `hn-reader-${id}` : null;
    },
  },
  'lobsters-reader': {
    key: 'lobsters-reader',
    mode: 'article',
    title: 'Lobsters (reader)',
    description: 'Lobsters top stories of the past week with full articles extracted via reader mode for offline reading.',
    homepage: 'https://lobste.rs/',
    sourceUrl: LOBSTERS_SOURCE,
    idFromComments: (url) => {
      const id = lobstersStoryId(url);
      return id ? `lobsters-reader-${id}` : null;
    },
  },
};

/**
 * Parse a source RSS feed into a normalized list of items. Each item keeps the
 * original `link` (target page) and exposes the discussion `commentsUrl`.
 */
async function fetchSourceItems(feed) {
  const res = await fetchWithTimeout(feed.sourceUrl, 20000);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${feed.sourceUrl}`);
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  const items = [];
  $('item').each((_, el) => {
    const item = $(el);
    const text = (sel) => item.children(sel).first().text().trim() || null;

    const link = text('link');
    const commentsUrl = text('comments') || link;
    // Fall back to a feed-key-namespaced URL id so the same story rendered by
    // two different feeds (e.g. hn vs hn-reader) never shares a cache entry.
    const id = feed.idFromComments(commentsUrl) || `${feed.key}:${link || commentsUrl}`;

    items.push({
      id,
      title: text('title') || '(untitled)',
      link,
      commentsUrl,
      author: text('dc\\:creator') || text('author'),
      pubDate: text('pubDate'),
      guid: text('guid') || commentsUrl || link,
      origDescription: text('description'),
    });
  });

  return items;
}

module.exports = { FEEDS, fetchSourceItems };
