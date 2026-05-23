'use strict';

const cheerio = require('cheerio');
const { fetchWithTimeout } = require('./inline');

/**
 * Feed definitions. `link` is preserved from the source item so it points at
 * the target article (Show HN / text posts and pure Lobsters discussions
 * naturally point back at the HN/Lobsters page, which is fine). `commentsUrl`
 * is the HN/Lobsters discussion page whose HTML we fetch and embed for
 * offline reading.
 */
const FEEDS = {
  hn: {
    key: 'hn',
    title: 'Hacker News (offline)',
    description: 'Hacker News front page with discussion pages embedded for offline reading.',
    homepage: 'https://news.ycombinator.com/',
    sourceUrl: 'https://hnrss.org/frontpage',
    compactIndent: true,
    idFromComments: (url) => {
      const m = /[?&]id=(\d+)/.exec(url || '');
      return m ? `hn-${m[1]}` : null;
    },
  },
  lobsters: {
    key: 'lobsters',
    title: 'Lobsters (offline)',
    description: 'Lobsters top stories of the past week with discussion pages embedded for offline reading.',
    homepage: 'https://lobste.rs/',
    sourceUrl: 'https://lobste.rs/top/1w/rss',
    idFromComments: (url) => {
      const m = /lobste\.rs\/s\/([a-z0-9]+)/i.exec(url || '');
      return m ? `lobsters-${m[1]}` : null;
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
    const id = feed.idFromComments(commentsUrl) || commentsUrl || link;

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
