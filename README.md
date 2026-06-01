# offlinerss

Re-exports Hacker News and Lobsters RSS feeds with extra content embedded for
offline reading in a feed reader like NetNewsWire.

| Feed | Contents |
|------|----------|
| `/hn.xml` | HN front page |
| `/lobsters.xml` | Lobsters top stories (past week) |

Each source feed is queried **once**, and every story produces **two items**, in
the source's original order:

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
https://your-host/hn-reader.xml?secret=YOUR_SECRET
```

`/health` is exempt so uptime monitors can probe it.

## Bot walls & captchas

Some article pages sit behind a proof-of-work / captcha interstitial (Anubis,
Cloudflare "Just a moment", etc.). The reader feeds detect these and fall back,
in order:

1. **[Jina Reader](https://r.jina.ai)** — fetches/renders the page from Jina's
   infrastructure (gets past most walls), on by default. Set `JINA_READER=0` to
   opt out. Sends the article URL to Jina's servers.
2. **archive.today** — best-effort snapshot fetch (often blocked from
   datacenter IPs, so mostly a last resort).
3. **Link-out** — if all else fails, the entry shows links to the article, an
   archive.today snapshot, and the discussion.

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

Deploys to Vercel as-is (`api/index.js` is the serverless entrypoint; routes are
funneled there by `vercel.json`).
