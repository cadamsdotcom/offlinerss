# offlinerss

Re-exports Hacker News and Lobsters RSS feeds with extra content embedded for
offline reading in a feed reader.

It's designed and tested primarily for [NetNewsWire](https://netnewswire.com/):
the embedded content is styled with inline CSS (NetNewsWire strips `<style>`
blocks but keeps inline styles) and comment threads use native `<details>` for
collapsing. Other readers should work, but may render the embedded content
differently.

| Feed | Contents |
|------|----------|
| `/hn.xml` | HN front page |
| `/lobsters.xml` | Lobsters top stories (past week) |

Each source feed is queried **once per request** (the feed is rebuilt fresh
every time — see [Caching & freshness](#caching--freshness)), and every story
produces **two items**, in the source's original order:

1. **`Article: <title>`** — the full article body extracted via reader mode
   (comments, nav, and boilerplate stripped).
2. **`Comments: <title>`** — the HN/Lobsters discussion rendered as clean,
   threaded comments.

Article extraction uses
[Mozilla Readability](https://github.com/mozilla/readability) (the engine behind
Firefox Reader View) over a lightweight [linkedom](https://github.com/WebReflection/linkedom)
DOM, so only the main article remains.

## Auth

Every request requires a shared secret as a query param:

```
https://your-host/hn.xml?secret=YOUR_SECRET
```

The secret is passed as a URL query parameter rather than an `Authorization`
header or HTTP Basic auth because many RSS readers don't let you attach custom
headers (or credentials) to a feed subscription — a query param is the lowest
common denominator that works in every reader. The usual trade-off applies:
query-string secrets can surface in server/proxy access logs, so treat the feed
URL itself as sensitive.

`/health` is exempt so uptime monitors can probe it.

## Bot walls & captchas

Some article pages sit behind a proof-of-work / captcha interstitial (Anubis,
Cloudflare "Just a moment", etc.). The feeds detect these and fall back,
in order:

1. **[Jina Reader](https://r.jina.ai)** — fetches/renders the page from Jina's
   infrastructure (gets past most walls), on by default. Set `JINA_READER=0` to
   opt out. Sends the article URL to Jina's servers.
2. **archive.today** — best-effort snapshot fetch (often blocked from
   datacenter IPs, so mostly a last resort).
3. **Link-out** — if all else fails and there's no prior render to fall back to
   (see stale-on-error below), the entry shows links to the article, an
   archive.today snapshot, and the discussion.

## Caching & freshness

The feed is **rebuilt from a fresh source fetch on every request**, so the story
list always reflects the current front page. Rebuilds stay cheap because each
story's rendered content is cached and only re-rendered when stale:

- **Articles** are immutable once published → cached for `ARTICLE_TTL_MS` (24h).
- **Comments** grow while a story is active → cached only for `COMMENTS_TTL_MS`
  (30m), then re-rendered to pick up new replies. Item guids are stable, so a
  refreshed thread updates *in place* in your reader instead of appearing as a
  duplicate.
- **Stale-on-error**: if a re-render fails (e.g. an HN 429 on a comments
  refresh), the last good render keeps being served for up to `STALE_TTL_MS`
  (24h) rather than degrading to the link-out card — a transient upstream error
  means "slightly stale," not "unavailable."

With [Upstash/Vercel KV](#configuration) configured, this cache persists across
serverless cold starts (and is namespaced per deploy, so a new deploy starts
fresh); without it, an in-memory cache is used per instance.

## Configuration

Set via environment variables (on Vercel, project env vars; locally, `.env` —
see `.env.example`).

| Var | Default | Purpose |
|-----|---------|---------|
| `API_SECRET` | _(required)_ | Shared secret for `?secret=` |
| `ENTRY_TTL_MS` | `86400000` (24h) | Default cached lifetime; also the fallback for `ARTICLE_TTL_MS` |
| `ARTICLE_TTL_MS` | _(= `ENTRY_TTL_MS`)_ | How long a rendered **article** stays cached (immutable, so long) |
| `COMMENTS_TTL_MS` | `1800000` (30m) | How long a rendered **discussion** stays cached before re-rendering to pick up new comments |
| `FAIL_TTL_MS` | `600000` (10m) | How long a failed render is remembered (and skipped) before being retried |
| `STALE_TTL_MS` | `86400000` (24h) | How long the last good render is kept to serve on a failed re-render (stale-on-error) before falling back to link-out |
| `ENTRY_MAX` | `500` | Max cached entries before LRU eviction |
| `FETCH_CONCURRENCY` | `3` | Parallel page fetches per feed build |
| `JINA_READER` | _(on)_ | Set `0`/`false`/`off`/`no` to disable the Jina fallback |
| `JINA_API_KEY` | _(none)_ | Optional; raises Jina's rate limit |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | _(none)_ | Optional Upstash/Vercel KV for a persistent cache across cold starts |

## Running

```sh
npm install
API_SECRET=dev npm start          # or: npm run start (reads .env)
```

Then open `http://localhost:3000/?secret=dev` for the feed index.

## Deploying (Vercel)

The app runs as a zero-config Vercel serverless function — no build step or
framework settings needed. `vercel.json` routes every request to `api/index.js`
(which exports the Express app) and sets the function timeout.

1. **Import the repo.** In Vercel, *Add New → Project* and import this Git
   repository. Leave the build/output settings at their defaults.
2. **Set `API_SECRET`.** Under *Settings → Environment Variables*, add
   `API_SECRET` with a long random value. It's the only required variable; see
   [Configuration](#configuration) for the optional tunables.
3. **(Recommended) Add a KV store.** Under *Storage*, create or connect an
   Upstash Redis store (via Vercel's Marketplace) and attach it to the project.
   Vercel injects the credentials automatically — the code reads either Vercel
   KV's `KV_REST_API_URL` / `KV_REST_API_TOKEN` or Upstash's
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, so no code changes are
   needed. Without it the cache is in-memory only, which on serverless is wiped
   on every cold start — so each build re-fetches every page from one IP and is
   far more likely to be rate-limited. See [Caching & freshness](#caching--freshness).
4. **Deploy** — or redeploy after adding the env var / KV store so they take
   effect.

Your feeds are then at `https://<your-deployment>/hn.xml?secret=YOUR_SECRET` (and
`/lobsters.xml?secret=…`); open `https://<your-deployment>/?secret=…` for the
index, then subscribe to the feed URLs in your reader.
