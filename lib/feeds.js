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
 * Each feed is built by querying its source once; every source story then
 * yields two output items, in original order: the article (reader mode) and
 * its discussion. `idFromComments` gives each story a stable, human-readable
 * id that the builder namespaces (`article:`/`comments:`) into per-view cache
 * keys so the two renderings of a story never collide.
 */
const FEEDS = {
  hn: {
    key: 'hn',
    title: 'Hacker News (offline)',
    description:
      'Hacker News front page: each story as a reader-mode article followed by its discussion, embedded for offline reading.',
    homepage: 'https://news.ycombinator.com/',
    sourceUrl: HN_SOURCE,
    idFromComments: (url) => {
      const id = hnStoryId(url);
      return id ? `hn-${id}` : null;
    },
  },
  lobsters: {
    key: 'lobsters',
    title: 'Lobsters (offline)',
    description:
      'Lobsters top stories of the past week: each story as a reader-mode article followed by its discussion, embedded for offline reading.',
    homepage: 'https://lobste.rs/',
    sourceUrl: LOBSTERS_SOURCE,
    idFromComments: (url) => {
      const id = lobstersStoryId(url);
      return id ? `lobsters-${id}` : null;
    },
  },
};

/**
 * Parse a source RSS feed into a normalized list of items. Each item keeps the
 * original `link` (target page) and exposes the discussion `commentsUrl`.
 */
async function fetchSourceItems(feed) {
  // A 20KB RSS file normally returns in under ~2s; when the source (e.g.
  // hnrss.org) has a flaky day and stalls, fail fast so the caller can fall back
  // to the last-good story list rather than waiting out a long timeout (and
  // eating the build's time budget). The caller's last-good fallback makes a
  // failure here non-fatal, so a tighter bound is safe.
  const res = await fetchWithTimeout(feed.sourceUrl, 10000);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${feed.sourceUrl}`);
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  const items = [];
  $('item').each((_, el) => {
    const item = $(el);
    const text = (sel) => item.children(sel).first().text().trim() || null;

    const link = text('link');
    const commentsUrl = text('comments') || link;
    // Stable per-story id; the builder derives article:/comments: cache keys
    // from it. Fall back to a feed-key-namespaced URL when there's no id.
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
