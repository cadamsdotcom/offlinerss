'use strict';

// Optional persistent cache backed by Upstash Redis (the engine behind Vercel
// KV), spoken over its REST API so there's no SDK dependency. Serverless hosts
// like Vercel discard the in-memory cache between cold starts, so without this
// every build re-fetches all discussion pages from one IP and gets rate-limited
// (429s). When the env vars are absent (e.g. local dev), this is a no-op and
// the in-memory cache is used alone.
//
// Reads either Vercel KV's variable names or Upstash's native ones, whichever
// the chosen integration injects.
function createKvStore({ keyPrefix = '', ttlMs } = {}) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const enabled = Boolean(url && token);
  const ttlSec = ttlMs ? Math.max(1, Math.round(ttlMs / 1000)) : null;

  async function command(args) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`KV ${res.status}`);
    return (await res.json()).result;
  }

  return {
    enabled,
    // A cache miss or any KV error degrades gracefully to re-rendering: the
    // store is an optimization, never a correctness dependency.
    async get(key) {
      if (!enabled) return undefined;
      try {
        const value = await command(['GET', keyPrefix + key]);
        return value == null ? undefined : value;
      } catch (err) {
        console.error(`KV get failed for ${key}: ${err.message}`);
        return undefined;
      }
    },
    async set(key, value) {
      if (!enabled) return;
      try {
        const args = ['SET', keyPrefix + key, value];
        if (ttlSec) args.push('EX', String(ttlSec));
        await command(args);
      } catch (err) {
        console.error(`KV set failed for ${key}: ${err.message}`);
      }
    },
  };
}

module.exports = { createKvStore };
