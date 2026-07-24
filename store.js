'use strict';
// One storage interface, two backends.
//   - Neon Postgres when DATABASE_URL/POSTGRES_URL is set. Required on Vercel:
//     serverless has no writable, shared filesystem.
//   - A local JSON file otherwise, so `node server.js` works offline.
// Guests are one row each (never a rewritten blob), so two people submitting at
// the same moment can't overwrite each other.
const fs = require('node:fs');
const path = require('node:path');

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const LOG_CAP = 50;

/* ---------- Postgres access ----------
   All DB access flows through run(text, params). The Neon serverless driver
   speaks HTTP (no TCP pool), which is what a serverless function needs. Tests
   inject a stub via __useStub so the whole suite can exercise this path. */
let injectedRun = null;
let sqlClient = null;
function pgRun(text, params = []) {
  if (injectedRun) return injectedRun(text, params);
  if (!sqlClient) {
    const { neon } = require('@neondatabase/serverless');
    sqlClient = neon(PG_URL);
  }
  return sqlClient.query(text, params).then((r) => (Array.isArray(r) ? r : (r.rows || [])));
}
const usePg = () => !!injectedRun || !!PG_URL;

/* ---------- file backend ---------- */
let db = null;
const parse = (s, fallback) => { try { return JSON.parse(s); } catch (e) { return fallback; } };
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
const hits = new Map(); // in-memory rate limiting for the file backend

const store = {
  get backend() { return usePg() ? 'postgres' : 'file'; },

  // test seam: force the Postgres path with an in-memory run()
  __useStub(runFn) { injectedRun = runFn; sqlClient = null; },

  async init(seedEvents) {
    if (usePg()) {
      await pgRun(`CREATE TABLE IF NOT EXISTS app_state (key text PRIMARY KEY, value jsonb NOT NULL)`);
      await pgRun(`CREATE TABLE IF NOT EXISTS guests (id text PRIMARY KEY, event_id text NOT NULL, created_at text NOT NULL, payload jsonb NOT NULL)`);
      await pgRun(`CREATE TABLE IF NOT EXISTS logs (id bigserial PRIMARY KEY, at text NOT NULL, event_name text, kind text, line text, ok boolean)`);
      await pgRun(`CREATE TABLE IF NOT EXISTS rate (key text PRIMARY KEY, n int NOT NULL, reset_at bigint NOT NULL)`);
      const rows = await pgRun(`SELECT value FROM app_state WHERE key = 'events'`);
      if (!rows.length) {
        await pgRun(`INSERT INTO app_state (key, value) VALUES ('events', $1::jsonb) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(seedEvents())]);
      }
      return;
    }
    const d = file();
    if (!d.events.length) { d.events = seedEvents(); flush(); }
  },

  async getEvents() {
    if (usePg()) {
      const rows = await pgRun(`SELECT value FROM app_state WHERE key = 'events'`);
      return rows.length ? rows[0].value : [];
    }
    return file().events;
  },
  async setEvents(events) {
    if (usePg()) {
      await pgRun(
        `INSERT INTO app_state (key, value) VALUES ('events', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [JSON.stringify(events)]
      );
      return;
    }
    file().events = events; flush();
  },

  // ponytail: loads every guest and filters in JS (like the file path), so both
  // backends behave identically. Add a WHERE + index if one event ever gets huge.
  async getGuests() {
    if (usePg()) {
      const rows = await pgRun(`SELECT payload FROM guests ORDER BY created_at ASC`);
      return rows.map((r) => r.payload);
    }
    return file().guests.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  },
  async putGuest(g) {
    if (usePg()) {
      await pgRun(
        `INSERT INTO guests (id, event_id, created_at, payload) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (id) DO UPDATE SET event_id = excluded.event_id, created_at = excluded.created_at, payload = excluded.payload`,
        [g.id, g.eventId, g.createdAt, JSON.stringify(g)]
      );
      return;
    }
    const d = file();
    const i = d.guests.findIndex((x) => x.id === g.id);
    if (i >= 0) d.guests[i] = g; else d.guests.push(g);
    flush();
  },
  async deleteGuest(id) {
    if (usePg()) { await pgRun(`DELETE FROM guests WHERE id = $1`, [id]); return; }
    const d = file();
    d.guests = d.guests.filter((x) => x.id !== id);
    flush();
  },

  async getLogs() {
    if (usePg()) {
      const rows = await pgRun(`SELECT at, event_name, kind, line, ok FROM logs ORDER BY id DESC LIMIT ${LOG_CAP}`);
      return rows.map((r) => ({ at: r.at, eventName: r.event_name, kind: r.kind, line: r.line, ok: r.ok }));
    }
    return file().logs;
  },
  async addLog(entry) {
    if (usePg()) {
      await pgRun(
        `INSERT INTO logs (at, event_name, kind, line, ok) VALUES ($1, $2, $3, $4, $5)`,
        [entry.at, entry.eventName, entry.kind, entry.line, !!entry.ok]
      );
      await pgRun(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ${LOG_CAP})`);
      return;
    }
    const d = file();
    d.logs.unshift(entry);
    d.logs = d.logs.slice(0, LOG_CAP);
    flush();
  },

  // Atomic counter within a rolling window; returns the running total.
  async rateHit(key, windowSec) {
    if (usePg()) {
      const now = Date.now(), until = now + windowSec * 1000;
      const rows = await pgRun(
        `INSERT INTO rate (key, n, reset_at) VALUES ($1, 1, $2)
         ON CONFLICT (key) DO UPDATE SET
           n = CASE WHEN rate.reset_at < $3 THEN 1 ELSE rate.n + 1 END,
           reset_at = CASE WHEN rate.reset_at < $3 THEN $2 ELSE rate.reset_at END
         RETURNING n`,
        [key, until, now]
      );
      return Number(rows[0].n);
    }
    const now = Date.now(), h = hits.get(key);
    if (!h || h.until < now) { hits.set(key, { n: 1, until: now + windowSec * 1000 }); return 1; }
    h.n++;
    return h.n;
  }
};

module.exports = store;
