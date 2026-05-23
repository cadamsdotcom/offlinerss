'use strict';

const cheerio = require('cheerio');

const USER_AGENT =
  'Mozilla/5.0 (compatible; offlinerss/1.0; +https://github.com/cadamsdotcom/offlinerss)';

// 1x1 transparent GIF, used to replace HN's spacer image (s.gif) so comment
// thread indentation survives offline without a network round-trip.
const TRANSPARENT_GIF =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Full-site layouts (HN especially) are fixed-width and don't reflow, so they
// overflow a feed reader's article pane and scroll horizontally. This override
// stylesheet is appended last so it wins the cascade and forces content to fit.
// Note: deliberately no `height:auto` on images — that would stretch HN's 1x1
// spacer gifs into large squares once their width is constrained.
const OVERRIDE_CSS = `
html { -webkit-text-size-adjust: 100%; }
html, body { margin: 0 !important; max-width: 100% !important; overflow-x: hidden !important; }
img, video, svg, canvas, iframe { max-width: 100% !important; }
table { max-width: 100% !important; }
textarea, input, select, button { max-width: 100% !important; box-sizing: border-box !important; }
pre, code { white-space: pre-wrap !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
`.trim();

// HN indents nested comments with a spacer image of width = depth * 40px, which
// pushes deep replies off-screen. Re-scale to a gentler per-level width capped
// at a maximum so threads stay readable on a narrow pane.
const HN_INDENT_PX_PER_LEVEL = 13;
const HN_INDENT_MAX_PX = 130;

async function fetchText(url, { timeoutMs = 20000 } = {}) {
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a binary asset and return it as a data: URI, or null if it can't be
 * fetched or is larger than maxBytes (so we don't bloat the feed with big
 * images — those keep their absolute URL instead).
 */
async function fetchAsDataUri(url, maxBytes) {
  try {
    const res = await fetchWithTimeout(url, 15000);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return null;
    const contentType =
      res.headers.get('content-type') || guessContentType(url);
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function guessContentType(url) {
  const ext = url.split('?')[0].split('.').pop().toLowerCase();
  const map = {
    svg: 'image/svg+xml',
    png: 'image/png',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    ico: 'image/x-icon',
  };
  return map[ext] || 'application/octet-stream';
}

function absolutize(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * Rewrite url(...) references inside a stylesheet: inline small assets as
 * data URIs, otherwise make them absolute so they at least resolve online.
 */
async function inlineCssUrls(cssText, cssUrl, maxBytes) {
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const matches = [...cssText.matchAll(urlRe)];
  const replacements = new Map();

  await Promise.all(
    matches.map(async (m) => {
      const raw = m[2].trim();
      if (raw.startsWith('data:') || replacements.has(raw)) return;
      const abs = absolutize(raw, cssUrl);
      if (!abs) return;
      const dataUri = await fetchAsDataUri(abs, maxBytes);
      replacements.set(raw, dataUri || abs);
    })
  );

  return cssText.replace(urlRe, (full, _q, raw) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('data:')) return full;
    const replacement = replacements.get(trimmed);
    return replacement ? `url("${replacement}")` : full;
  });
}

/**
 * Fetch a comment page and return a single self-contained HTML document with
 * stylesheets and small images inlined and scripts removed, so it renders
 * offline (e.g. inside NetNewsWire) without any further network access.
 */
async function buildSelfContainedPage(pageUrl, opts = {}) {
  const maxAssetBytes = opts.maxAssetBytes ?? 256 * 1024;
  const html = await fetchText(pageUrl);
  const $ = cheerio.load(html);

  // Scripts are unnecessary for reading comments offline and may try to make
  // network calls (turbo, analytics), so drop them entirely.
  $('script, link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"]').remove();

  // Inline stylesheets.
  const styleLinks = $('link[rel="stylesheet"]').toArray();
  await Promise.all(
    styleLinks.map(async (el) => {
      const link = $(el);
      const href = link.attr('href');
      const abs = href && absolutize(href, pageUrl);
      if (!abs) {
        link.remove();
        return;
      }
      try {
        const css = await fetchText(abs);
        const inlined = await inlineCssUrls(css, abs, maxAssetBytes);
        link.replaceWith(`<style>${inlined}</style>`);
      } catch {
        // If a stylesheet can't be fetched, point it at the absolute URL so
        // it still works online and doesn't 404 against our own host.
        link.attr('href', abs);
      }
    })
  );

  // Favicon: make absolute so it doesn't 404 against our host.
  $('link[rel*="icon"]').each((_, el) => {
    const link = $(el);
    const href = link.attr('href');
    const abs = href && absolutize(href, pageUrl);
    if (abs) link.attr('href', abs);
  });

  // Inline images.
  const imgs = $('img[src]').toArray();
  const dataUriCache = new Map();
  await Promise.all(
    imgs.map(async (el) => {
      const img = $(el);
      const src = img.attr('src');
      if (!src || src.startsWith('data:')) return;
      const abs = absolutize(src, pageUrl);
      if (!abs) return;

      // HN uses a 1x1 spacer gif for thread indentation; swap in an inline
      // transparent pixel so indentation survives offline.
      if (/\/s\.gif(\?|$)/.test(abs) || /\bs\.gif$/.test(src)) {
        img.attr('src', TRANSPARENT_GIF);
        if (opts.compactIndent && img.closest('td.ind').length) {
          const level = Math.round(parseInt(img.attr('width') || '0', 10) / 40);
          if (level > 0) {
            img.attr('width', String(Math.min(level * HN_INDENT_PX_PER_LEVEL, HN_INDENT_MAX_PX)));
          }
        }
        return;
      }

      if (!dataUriCache.has(abs)) {
        dataUriCache.set(abs, await fetchAsDataUri(abs, maxAssetBytes));
      }
      const dataUri = dataUriCache.get(abs);
      img.attr('src', dataUri || abs);
    })
  );

  // Absolutize remaining links so they're meaningful when online; offline
  // they simply won't navigate, which is fine.
  $('a[href]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    if (!href || href.startsWith('#') || href.startsWith('data:')) return;
    const abs = absolutize(href, pageUrl);
    if (abs) a.attr('href', abs);
  });

  // Make the page fit a reader's article pane: ensure a mobile viewport and
  // append the override stylesheet last so it overrides the site's own CSS.
  const head = $('head').length ? $('head') : $('html').length ? $('html') : $.root();
  if (!$('meta[name="viewport"]').length) {
    head.prepend('<meta name="viewport" content="width=device-width, initial-scale=1">');
  }
  head.append(`<style>${OVERRIDE_CSS}</style>`);

  return $.html();
}

module.exports = { buildSelfContainedPage, USER_AGENT, fetchWithTimeout };
