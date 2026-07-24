'use strict';
// One storage interface, two backends.
//   - Upstash Redis (REST over fetch) when UPSTASH_REDIS_REST_URL/_TOKEN are set.
//     Required on Vercel: serverless has no writable, shared filesystem.
//   - A local JSON file otherwise, so `node server.js` still works offline.
// Guests are stored per-record, never as one rewritten blob — two people
// submitting at the same moment must not overwrite each other.
const fs = require('node:fs');
const path = require('node:path');

const R_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const useRedis = !!(R_URL && R_TOKEN);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const LOG_CAP = 50;

async function cmd(...args) {
  const res = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + R_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map(String))
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Redis ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}

// HGETALL comes back as a flat [field, value, …] array over REST.
const pairsToValues = (r) => {
  if (!r) return [];
  if (Array.isArray(r)) {
    const out = [];
    for (let i = 1; i < r.length; i += 2) out.push(r[i]);
    return out;
  }
  return Object.values(r);
};
const parse = (s, fallback) => { try { return JSON.parse(s); } catch (e) { return fallback; } };

/* ---------- file backend ---------- */
let db = null;
function file() {
  if (!db) {
    db = parse(fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : '', null)
      || { events: [], guests: [], logs: [] };
    db.events ||= []; db.guests ||= []; db.logs ||= [];
  }
  return db;
}
function flush() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------- in-memory rate limiting (file backend only) ---------- */
const hits = new Map();

const store = {
  backend: useRedis ? 'redis' : 'file',

  async init(seedEvents) {
    if (useRedis) {
      if (!(await cmd('GET', 'events'))) await cmd('SET', 'events', JSON.stringify(seedEvents()));
      return;
    }
    const d = file();
    if (!d.events.length) { d.events = seedEvents(); flush(); }
  },

  async getEvents() {
    if (useRedis) return parse(await cmd('GET', 'events'), []) || [];
    return file().events;
  },
  async setEvents(events) {
    if (useRedis) { await cmd('SET', 'events', JSON.stringify(events)); return; }
    file().events = events; flush();
  },

  // ponytail: reads every guest and filters in JS. Fine into the low thousands;
  // add a `idx:{event}:{name}:{phone}` key if a single event ever gets huge.
  async getGuests() {
    const list = useRedis
      ? pairsToValues(await cmd('HGETALL', 'guests')).map((s) => parse(s, null)).filter(Boolean)
      : file().guests.slice();
    return list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  },
  async putGuest(g) {
    if (useRedis) { await cmd('HSET', 'guests', g.id, JSON.stringify(g)); return; }
    const d = file();
    const i = d.guests.findIndex((x) => x.id === g.id);
    if (i >= 0) d.guests[i] = g; else d.guests.push(g);
    flush();
  },
  async deleteGuest(id) {
    if (useRedis) { await cmd('HDEL', 'guests', id); return; }
    const d = file();
    d.guests = d.guests.filter((x) => x.id !== id);
    flush();
  },

  async getLogs() {
    if (useRedis) return (await cmd('LRANGE', 'logs', 0, LOG_CAP - 1) || []).map((s) => parse(s, null)).filter(Boolean);
    return file().logs;
  },
  async addLog(entry) {
    if (useRedis) {
      await cmd('LPUSH', 'logs', JSON.stringify(entry));
      await cmd('LTRIM', 'logs', 0, LOG_CAP - 1);
      return;
    }
    const d = file();
    d.logs.unshift(entry);
    d.logs = d.logs.slice(0, LOG_CAP);
    flush();
  },

  // Counts every attempt in the window and returns the running total.
  async rateHit(key, windowSec) {
    if (useRedis) {
      const n = await cmd('INCR', 'rl:' + key);
      if (Number(n) === 1) await cmd('EXPIRE', 'rl:' + key, windowSec);
      return Number(n);
    }
    const now = Date.now(), h = hits.get(key);
    if (!h || h.until < now) { hits.set(key, { n: 1, until: now + windowSec * 1000 }); return 1; }
    h.n++;
    return h.n;
  }
};

module.exports = store;
