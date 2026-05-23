'use strict';

const cheerio = require('cheerio');
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');

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

// Per-level left padding. With nested <details>, this padding indents a
// comment's replies (plus the 3px bar), so the effective step is ~12px — a bit
// tighter than a separate margin, since the bar already signals nesting.
const INDENT_PX = 9;
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
      id,
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
      id: id.slice(2),
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

// Reconstruct the comment tree from the flat, depth-tagged list so each
// comment's replies are nested inside it (needed for collapsing a subtree).
function buildCommentTree(comments) {
  const root = { depth: -1, children: [] };
  const stack = [root];
  for (const cm of comments) {
    const node = { ...cm, children: [] };
    while (stack[stack.length - 1].depth >= node.depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  root.children.forEach(countReplies);
  return root.children;
}

// Annotate each node with its total descendant count (all nested replies), in
// one post-order pass.
function countReplies(node) {
  let total = 0;
  for (const child of node.children) total += 1 + countReplies(child);
  node.replyCount = total;
  return total;
}

function renderComment(node, theme, pageUrl, parentId, rootId) {
  const esc = escapeHtml;
  const meta = [
    node.author ? `<strong style="color:${theme.body};">${esc(node.author)}</strong>` : null,
    node.score ? esc(`${node.score} points`) : null,
    node.age ? esc(node.age) : null,
    node.replyCount > 0 ? esc(`${node.replyCount} ${node.replyCount === 1 ? 'reply' : 'replies'}`) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // "reply" is a genuine external link (open the site to reply). parent/root
  // are in-page jumps to ancestors: a plain #anchor would be treated as
  // external navigation by some readers (NetNewsWire opens it in a browser),
  // so instead we scroll via onclick — a scripted scroll isn't a navigation,
  // so it stays in-page. No href, so it's simply inert if content JS is off
  // (rather than wrongly opening a browser). "root" is omitted at depth 1.
  const extLink = (label, href) =>
    ` · <a href="${esc(href)}" style="color:${theme.accent};text-decoration:none;">${label}</a>`;
  const jumpLink = (label, targetId) => {
    const safe = String(targetId).replace(/[^\w-]/g, '');
    return (
      ` · <a style="color:${theme.accent};text-decoration:none;cursor:pointer;" ` +
      `onclick="event.preventDefault();event.stopPropagation();` +
      `var e=document.getElementById('c-${safe}');if(e){e.open=true;e.scrollIntoView();}">${label}</a>`
    );
  };
  let nav = node.replyUrl ? extLink('reply', node.replyUrl) : '';
  if (parentId) nav += jumpLink('parent', parentId);
  if (rootId && rootId !== parentId) nav += jumpLink('root', rootId);
  // Accent underline + tint differentiate the byline. Readers like NetNewsWire
  // strip background-color but keep borders/font-weight, so the underline is
  // what shows there; the tint is a bonus for readers that honor backgrounds.
  const bylineStyle =
    `font-size:12px;color:${theme.byline};background:${theme.bylineBg};` +
    `border-bottom:1px solid ${theme.rule};padding:2px 6px 3px;margin-bottom:7px;`;
  // Every comment gets the accent bar. Indentation comes from the bar + left
  // padding via DOM nesting (~12px/level); past MAX_INDENT_DEPTH the step
  // shrinks to just the bar so deep threads keep room for text.
  const padLeft = node.depth > MAX_INDENT_DEPTH ? 4 : INDENT_PX;
  const blockStyle =
    `margin:${node.depth === 0 ? 14 : 10}px 0 0 0;` +
    `border-left:3px solid ${theme.rule};padding:1px 0 1px ${padLeft}px;`;
  const body = node.bodyHtml
    ? `<div style="overflow-wrap:anywhere;word-break:break-word;">${cleanBody(node.bodyHtml, pageUrl)}</div>`
    : `<div style="color:${theme.byline};font-style:italic;">[comment removed]</div>`;

  // Every comment is a native disclosure widget: toggling the byline collapses
  // its body and (for parents) the entire reply subtree. This needs no
  // JavaScript (feed readers run none); if a reader strips <details>, the
  // content simply stays expanded. The id anchors the parent/root jumps above.
  const childRoot = rootId || node.id;
  const kids = node.children
    .map((c) => renderComment(c, theme, pageUrl, node.id, childRoot))
    .join('');
  const idAttr = node.id ? ` id="c-${esc(node.id)}"` : '';
  return (
    `<details open${idAttr} style="${blockStyle}">` +
    `<summary style="cursor:pointer;${bylineStyle}">${meta}${nav}</summary>` +
    body +
    kids +
    `</details>`
  );
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

  // Compact header strip. The reader already shows the story title in its own
  // chrome, so repeating it here is redundant; surface just the points/byline
  // and a link into the discussion, set off by an accent rule (kept by readers
  // that strip backgrounds).
  out.push(
    `<div style="font-size:13px;color:${theme.byline};border-bottom:2px solid ${theme.accent};` +
      `padding-bottom:6px;margin-bottom:14px;">${esc(bylineBits.join(' · '))}` +
      ` · <a href="${esc(pageUrl)}" style="color:${theme.accent};text-decoration:none;">open thread</a></div>`
  );

  if (extras.textHtml) {
    out.push(`<div style="margin-bottom:16px;overflow-wrap:anywhere;">${extras.textHtml}</div>`);
  }

  if (comments.length === 0) {
    out.push(
      `<p style="color:${theme.byline};">No comments yet. <a href="${esc(pageUrl)}">Open the discussion</a>.</p>`
    );
  }

  for (const node of buildCommentTree(comments)) {
    out.push(renderComment(node, theme, pageUrl));
  }

  out.push(`</div>`);
  return out.join('');
}

// Build an archive.today "newest snapshot" URL for an article. archive.today
// often has a readable copy of pages that are paywalled or hidden behind bot
// walls, and it serves it from its own infrastructure.
function archiveUrl(url) {
  return `https://archive.ph/newest/${url}`;
}

// Many article hosts now sit behind a proof-of-work / captcha interstitial
// (Anubis, Cloudflare "Just a moment", etc.) that returns a 200 with a
// challenge page instead of the article. Detect the common ones so we can fall
// back instead of extracting the challenge page as if it were the article.
function looksLikeBotWall(status, html) {
  if (status === 403 || status === 503 || status === 429) return true;
  const h = (html || '').slice(0, 4000).toLowerCase();
  return (
    h.includes('making sure you&#39;re not a bot') ||
    h.includes("making sure you're not a bot") ||
    h.includes('id="anubis') ||
    h.includes('anubis_challenge') ||
    h.includes('just a moment') ||
    h.includes('cf-browser-verification') ||
    h.includes('challenge-platform') ||
    h.includes('/cdn-cgi/challenge-platform') ||
    h.includes('enable javascript and cookies to continue')
  );
}

// Run Mozilla Readability over a page's HTML. Returns the parsed article
// ({ title, content, byline, siteName, textContent, ... }) or null. linkedom
// gives us a lightweight DOM without jsdom's weight; relative URLs are fixed up
// later by cleanBody against the page URL, so a missing baseURI doesn't matter.
function extractArticle(html, url) {
  const { document } = parseHTML(html);
  try {
    return new Readability(document).parse();
  } catch {
    return null;
  }
}

function estimateReadingMinutes(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return words ? Math.max(1, Math.round(words / 220)) : 0;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Fetch an article and re-render just its readable body (no comments, nav, or
 * other boilerplate — Readability strips those) with the same light inline
 * styling as the discussion view. If the page is behind a bot wall/captcha or
 * extraction fails, make a best-effort attempt via archive.today, and if that
 * also fails, throw so the caller renders a fallback with links out.
 */
async function renderArticle(articleUrl, feedKey, story = {}) {
  let article = null;
  let extractedFrom = articleUrl;
  let blocked = false;

  try {
    const res = await fetchWithTimeout(articleUrl);
    const html = await res.text();
    if (res.ok && !looksLikeBotWall(res.status, html)) {
      article = extractArticle(html, articleUrl);
    } else {
      blocked = true;
    }
  } catch {
    blocked = true;
  }

  // Best-effort archive.today fallback for blocked or unparseable pages.
  if (!article || !article.content) {
    try {
      const res = await fetchWithTimeout(archiveUrl(articleUrl), 15000, 1);
      const html = await res.text();
      const finalUrl = res.url || archiveUrl(articleUrl);
      if (res.ok && !looksLikeBotWall(res.status, html)) {
        const parsed = extractArticle(html, finalUrl);
        if (parsed && parsed.content) {
          article = parsed;
          extractedFrom = finalUrl;
        }
      }
    } catch {
      // swallow — handled by the throw below
    }
  }

  if (!article || !article.content) {
    throw new Error(
      blocked
        ? 'Article is behind a bot wall / captcha and no archive.today snapshot was available'
        : 'Reader mode could not extract article content'
    );
  }

  const theme = THEMES[feedKey] || THEMES.hn;
  const esc = escapeHtml;
  const isArchived = extractedFrom !== articleUrl;

  const bylineBits = [
    article.byline || (story.author ? `by ${story.author}` : null),
    hostOf(story.link || articleUrl),
    relativeTime(story.pubDate),
  ];
  const minutes = estimateReadingMinutes(article.textContent);
  if (minutes) bylineBits.push(`${minutes} min read`);
  if (isArchived) bylineBits.push('via archive.today');

  const link = (label, href) =>
    `<a href="${esc(href)}" style="color:${theme.accent};text-decoration:none;">${label}</a>`;
  const navLinks = [link('original', story.link || articleUrl)];
  if (story.commentsUrl && story.commentsUrl !== (story.link || articleUrl)) {
    navLinks.push(link('discussion', story.commentsUrl));
  }

  const out = [];
  out.push(`<div style="font-family:${theme.font};color:${theme.body};line-height:1.55;">`);
  out.push(
    `<div style="font-size:13px;color:${theme.byline};border-bottom:2px solid ${theme.accent};` +
      `padding-bottom:6px;margin-bottom:16px;">${esc(bylineBits.filter(Boolean).join(' · '))}` +
      ` · ${navLinks.join(' · ')}</div>`
  );
  out.push(`<div style="overflow-wrap:anywhere;">${cleanBody(article.content, extractedFrom)}</div>`);
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
      `<strong>Couldn't load this page for offline reading.</strong><br>` +
      `<span style="font-size:13px;">${esc(msg)}</span></div>`
  );
  // Offer every route out we have: the article itself, an archive.today
  // snapshot (handy when the original is paywalled or behind a bot wall), and
  // the discussion. Deduplicated so we don't repeat the same URL twice.
  const articleLink = story.link || pageUrl;
  const discussionLink = story.commentsUrl || pageUrl;
  const seen = new Set();
  const links = [];
  const addLink = (label, href) => {
    if (!href || seen.has(href)) return;
    seen.add(href);
    links.push(`<a href="${esc(href)}">${label}</a>`);
  };
  addLink('Article', articleLink);
  addLink('Open in archive.today', archiveUrl(articleLink));
  addLink('Discussion', discussionLink);
  out.push(`<p style="margin-top:12px;">${links.join(' · ')}</p>`);
  out.push(`</div>`);
  return out.join('');
}

module.exports = { renderDiscussion, renderArticle, renderFallback, fetchWithTimeout };
