'use strict';

const cheerio = require('cheerio');

const USER_AGENT =
  'Mozilla/5.0 (compatible; offlinerss/1.0; +https://github.com/cadamsdotcom/offlinerss)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry transient failures (network errors, timeouts, 429/5xx) with backoff.
// Hosts like Lobsters rate-limit bursts from datacenter IPs (e.g. a serverless
// host), which otherwise makes some entries fall back to a bare description.
async function fetchWithTimeout(url, timeoutMs = 20000, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function fetchText(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function absolutize(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A light touch of each site's identity, expressed only through inline styles
// (NetNewsWire keeps inline style="" but strips <style> blocks).
const THEMES = {
  hn: {
    font: 'Verdana, Geneva, sans-serif',
    accent: '#ff6600',
    onAccent: '#ffffff',
    byline: '#828282',
    bylineBg: '#fff3e9',
    body: '#1a1a1a',
    rule: '#ff6600',
  },
  lobsters: {
    font: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    accent: '#ac130d',
    onAccent: '#ffffff',
    byline: '#888888',
    bylineBg: '#fbecea',
    body: '#111111',
    rule: '#ac130d',
  },
};

const INDENT_PX = 14;
const MAX_INDENT_DEPTH = 8;

// Clean a comment body fragment for offline reading: drop scripts/styles,
// make links/images absolute, and keep wide content (code) from overflowing.
function cleanBody(html, pageUrl) {
  const $ = cheerio.load(html || '', null, false);
  $('script, style').remove();
  $('a[href]').each((_, a) => {
    const abs = absolutize($(a).attr('href'), pageUrl);
    if (abs) $(a).attr('href', abs);
  });
  $('img[src]').each((_, im) => {
    const abs = absolutize($(im).attr('src'), pageUrl);
    if (abs) $(im).attr('src', abs);
    $(im).attr('style', `max-width:100%;${$(im).attr('style') || ''}`);
  });
  $('pre').each((_, p) => {
    $(p).attr('style', `white-space:pre-wrap;overflow-wrap:anywhere;${$(p).attr('style') || ''}`);
  });
  return $.html();
}

function parseHN($, pageUrl) {
  const comments = [];
  $('tr.comtr').each((_, el) => {
    const row = $(el);
    const depth = parseInt(row.find('td.ind').first().attr('indent') || '0', 10);
    const author = row.find('.hnuser').first().text().trim();
    const age = row.find('.age').first().text().trim();
    const body = row.find('.commtext').first();
    const replyHref = row.find('.reply a[href^="reply"]').first().attr('href');
    const id = row.attr('id');
    const replyUrl = replyHref
      ? absolutize(replyHref, pageUrl)
      : id
        ? absolutize(`reply?id=${id}`, pageUrl)
        : null;
    comments.push({
      depth: isNaN(depth) ? 0 : depth,
      author,
      age,
      score: null,
      replyUrl,
      bodyHtml: body.length ? body.html() : null,
    });
  });
  return comments;
}

function parseLobsters($, pageUrl) {
  const comments = [];
  $('div.comment').each((_, el) => {
    const c = $(el);
    const id = c.attr('id') || '';
    if (!id.startsWith('c_')) return;
    const depth = Math.max(0, c.parents('ol.comments:not(.comments1)').length - 1);
    let author = '';
    c.find('.byline a[href^="/~"]').each((_, a) => {
      const t = $(a).text().trim();
      if (t && !author) author = t;
    });
    const time = c.find('.byline time').first();
    const age = time.text().trim() || time.attr('title') || '';
    const score = c.find('.voters .upvoter, .voters .score').first().text().trim();
    const body = c.find('.comment_text').first();
    comments.push({
      depth,
      author,
      age,
      score: score && /\d/.test(score) ? score : null,
      replyUrl: absolutize(`/c/${id.slice(2)}`, pageUrl),
      bodyHtml: body.length ? body.html() : null,
    });
  });
  return comments;
}

// Pull points/score and any self-post body text from the page for the header.
function parseStoryExtras($, feedKey, pageUrl) {
  if (feedKey === 'lobsters') {
    const points = $('.story .score, .voters .score').first().text().trim();
    const text = $('.story_text, .story .story_text').first();
    return {
      points: points && /\d/.test(points) ? `${points} points` : null,
      textHtml: text.length ? cleanBody(text.html(), pageUrl) : null,
    };
  }
  const points = $('.subline .score, .score').first().text().trim();
  const text = $('.toptext').first();
  return {
    points: points || null,
    textHtml: text.length ? cleanBody(text.html(), pageUrl) : null,
  };
}

function relativeTime(dateStr) {
  const d = dateStr ? new Date(dateStr) : null;
  if (!d || isNaN(d.getTime())) return '';
  const diff = Math.max(0, (Date.now() - d.getTime()) / 1000);
  const units = [
    [86400 * 365, 'y'],
    [86400 * 30, 'mo'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [secs, label] of units) {
    if (diff >= secs) return `${Math.floor(diff / secs)}${label} ago`;
  }
  return 'just now';
}

/**
 * Fetch a discussion page and re-render it as clean, threaded semantic HTML
 * with a light inline-styled nod to the source site's aesthetic. Designed for
 * feed readers (e.g. NetNewsWire) that strip <style> but honor inline styles.
 */
async function renderDiscussion(pageUrl, feedKey, story = {}) {
  const html = await fetchText(pageUrl);
  const $ = cheerio.load(html);
  const theme = THEMES[feedKey] || THEMES.hn;

  const comments = feedKey === 'lobsters' ? parseLobsters($, pageUrl) : parseHN($, pageUrl);
  const extras = parseStoryExtras($, feedKey, pageUrl);

  const esc = escapeHtml;
  const bylineBits = [
    extras.points,
    story.author ? `by ${story.author}` : null,
    relativeTime(story.pubDate),
  ].filter(Boolean);

  const out = [];
  out.push(`<div style="font-family:${theme.font};color:${theme.body};line-height:1.45;">`);

  // Header card with the source site's accent colour.
  out.push(
    `<div style="background:${theme.accent};color:${theme.onAccent};padding:10px 12px;border-radius:5px;margin-bottom:14px;">`
  );
  out.push(
    `<div style="font-size:16px;font-weight:bold;line-height:1.3;">` +
      `<a href="${esc(story.link || pageUrl)}" style="color:${theme.onAccent};text-decoration:none;">${esc(story.title || 'Discussion')}</a></div>`
  );
  out.push(
    `<div style="font-size:12px;margin-top:5px;">${esc(bylineBits.join(' · '))}` +
      ` · <a href="${esc(pageUrl)}" style="color:${theme.onAccent};text-decoration:underline;">open thread</a></div>`
  );
  out.push(`</div>`);

  if (extras.textHtml) {
    out.push(`<div style="margin-bottom:16px;overflow-wrap:anywhere;">${extras.textHtml}</div>`);
  }

  if (comments.length === 0) {
    out.push(
      `<p style="color:${theme.byline};">No comments yet. <a href="${esc(pageUrl)}">Open the discussion</a>.</p>`
    );
  }

  for (const cm of comments) {
    const indent = Math.min(cm.depth, MAX_INDENT_DEPTH) * INDENT_PX;
    const meta = [
      cm.author ? `<strong style="color:${theme.body};">${esc(cm.author)}</strong>` : null,
      cm.score ? esc(`${cm.score} points`) : null,
      cm.age ? esc(cm.age) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const reply = cm.replyUrl
      ? ` · <a href="${esc(cm.replyUrl)}" style="color:${theme.accent};text-decoration:none;">reply</a>`
      : '';
    out.push(
      `<div style="margin:10px 0 0 ${indent}px;border-left:3px solid ${theme.rule};padding:1px 0 1px 9px;">`
    );
    out.push(
      `<div style="font-size:12px;color:${theme.byline};background:${theme.bylineBg};padding:3px 7px;border-radius:3px;margin-bottom:5px;">${meta}${reply}</div>`
    );
    if (cm.bodyHtml) {
      out.push(
        `<div style="overflow-wrap:anywhere;word-break:break-word;">${cleanBody(cm.bodyHtml, pageUrl)}</div>`
      );
    } else {
      out.push(`<div style="color:${theme.byline};font-style:italic;">[comment removed]</div>`);
    }
    out.push(`</div>`);
  }

  out.push(`</div>`);
  return out.join('');
}

/**
 * When a discussion can't be fetched/rendered (e.g. the source rate-limits us),
 * produce a content body that says so — with the error — and still links out,
 * rather than silently falling back to a bare description.
 */
function renderFallback(pageUrl, feedKey, story = {}, error) {
  const theme = THEMES[feedKey] || THEMES.hn;
  const esc = escapeHtml;
  const msg = (error && error.message) || String(error || 'unknown error');

  const out = [];
  out.push(`<div style="font-family:${theme.font};color:${theme.body};line-height:1.45;">`);
  out.push(
    `<div style="background:${theme.accent};color:${theme.onAccent};padding:10px 12px;border-radius:5px;margin-bottom:14px;">` +
      `<div style="font-size:16px;font-weight:bold;line-height:1.3;">` +
      `<a href="${esc(story.link || pageUrl)}" style="color:${theme.onAccent};text-decoration:none;">${esc(story.title || 'Discussion')}</a></div></div>`
  );
  out.push(
    `<div style="background:#fdecea;border-left:3px solid #d32f2f;padding:8px 10px;border-radius:3px;color:#611a15;">` +
      `<strong>Couldn't load this discussion for offline reading.</strong><br>` +
      `<span style="font-size:13px;">${esc(msg)}</span></div>`
  );
  const links = [];
  if (story.link) links.push(`<a href="${esc(story.link)}">Article</a>`);
  links.push(`<a href="${esc(pageUrl)}">Open discussion</a>`);
  out.push(`<p style="margin-top:12px;">${links.join(' · ')}</p>`);
  out.push(`</div>`);
  return out.join('');
}

module.exports = { renderDiscussion, renderFallback, fetchWithTimeout };
