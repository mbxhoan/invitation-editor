'use strict';
// Static host + data store + outbound API proxy. No dependencies.
//   node server.js
// Env:
//   PORT                 default 3000
//   ADMIN_PASSWORD       default "admin" — set this in production
//   DELFI_API_PASSWORD   seeds the Future Menus event's Basic Auth password on
//                        first run. Left blank if unset; an admin can paste it
//                        into the designer instead. Never hardcoded here.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./shared');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const ROOT = __dirname;

/* ---------------- seed ---------------- */
const uid = () => crypto.randomBytes(5).toString('hex');

function defaultInputs() {
  return [
    { key: 'title', label: 'Danh xưng', type: 'select', options: ['Ông', 'Bà'], required: true, placeholder: '' },
    { key: 'name', label: 'Họ và tên', type: 'text', placeholder: 'VD: NGUYỄN VĂN A', required: true },
    { key: 'phone', label: 'Số điện thoại', type: 'text', placeholder: 'VD: 0901234567', required: true },
    { key: 'email', label: 'Email', type: 'text', placeholder: 'VD: vana@gmail.com', required: false },
    { key: 'position', label: 'Chức danh', type: 'text', placeholder: 'VD: GIÁM ĐỐC KINH DOANH', required: false },
    { key: 'company', label: 'Tên công ty / Đại lý', type: 'text', placeholder: 'VD: NAM VIỆT GROUP', required: false }
  ];
}

const DELFI_BODY = `{
  "qrcode": "{{qrcode}}",
  "event_id": 124,
  "name": "{{name}}",
  "email": "{{email}}",
  "type": "API_TEST",
  "custom_fields": {
    "position": "{{position}}",
    "company": "{{company}}",
    "title": "{{title}}",
    "phone": "{{phone}}",
    "lk_number": "{{lucky}}"
  }
}`;

const emptyApi = () => ({
  enabled: false, url: '', method: 'POST',
  auth: { type: 'none', username: '', password: '' },
  headers: { 'Content-Type': 'application/json' },
  bodyTemplate: '{\n  "name": "{{name}}",\n  "phone": "{{phone}}"\n}'
});

function seedEvents() {
  // #1 — artwork already carries the title/date/venue, so the only things drawn
  // on top are the guest name and the QR that fills the blank "Registration code" box.
  const futureMenus = {
    id: uid(),
    name: 'FUTURE MENUS VIETNAM 2026 — UNILEVER FOOD SOLUTIONS',
    w: 1810, h: 2560, bg: '/public/1.png', theme: null,
    inputs: defaultInputs(),
    fields: [
      { id: uid(), type: 'bind', bind: 'fullNameDisplay', prefix: '', x: 909, y: 158, size: 60,
        font: 'Montserrat', weight: '700', color: '#ffffff', align: 'center', upper: true, ls: 1, maxW: 1450 },
      { id: uid(), type: 'qr', x: 909, y: 996, size: 600 }
    ],
    api: {
      enabled: true,
      url: 'https://checkin.delfi.vn/api/v1/clients/upsert',
      method: 'POST',
      auth: { type: 'basic', username: 'demo', password: process.env.DELFI_API_PASSWORD || '' },
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ApiPortal' },
      bodyTemplate: DELFI_BODY
    }
  };

  const mk = (name, theme, title, date, venue) => ({
    id: uid(), name, w: 1080, h: 1350, bg: null, theme,
    inputs: defaultInputs(),
    api: emptyApi(),
    fields: [
      { id: uid(), type: 'static', text: 'TRÂN TRỌNG KÍNH MỜI', x: 540, y: 200, size: 28, font: 'Montserrat', weight: '600', color: theme.gold, align: 'center', upper: false, ls: 8, maxW: 0 },
      { id: uid(), type: 'bind', bind: 'fullNameDisplay', prefix: '', x: 540, y: 285, size: 58, font: 'Playfair Display', weight: '700', color: '#ffffff', align: 'center', upper: true, ls: 1, maxW: 940 },
      { id: uid(), type: 'bind', bind: 'position', prefix: '', x: 540, y: 345, size: 26, font: 'Montserrat', weight: '600', color: theme.gold, align: 'center', upper: true, ls: 3, maxW: 900 },
      { id: uid(), type: 'bind', bind: 'company', prefix: '', x: 540, y: 398, size: 29, font: 'Montserrat', weight: '500', color: theme.soft, align: 'center', upper: true, ls: 1, maxW: 960 },
      { id: uid(), type: 'static', text: 'tới tham dự sự kiện', x: 540, y: 465, size: 26, font: 'Cormorant Garamond', weight: '600', color: theme.soft, align: 'center', upper: false, ls: 2, maxW: 0 },
      { id: uid(), type: 'static', text: title, x: 540, y: 575, size: 50, font: 'Playfair Display', weight: '800', color: theme.gold, align: 'center', upper: true, ls: 1, maxW: 980 },
      { id: uid(), type: 'static', text: date, x: 540, y: 655, size: 30, font: 'Montserrat', weight: '700', color: '#ffffff', align: 'center', upper: false, ls: 1, maxW: 0 },
      { id: uid(), type: 'static', text: venue, x: 540, y: 703, size: 24, font: 'Montserrat', weight: '500', color: theme.soft, align: 'center', upper: false, ls: 1, maxW: 960 },
      { id: uid(), type: 'static', text: 'Rất hân hạnh được đón tiếp!', x: 540, y: 905, size: 30, font: 'Cormorant Garamond', weight: '600', color: theme.gold, align: 'center', upper: false, ls: 0, maxW: 0 },
      { id: uid(), type: 'bind', bind: 'lucky', prefix: 'Lucky Number: ', x: 540, y: 960, size: 33, font: 'Montserrat', weight: '700', color: '#ffffff', align: 'center', upper: false, ls: 1, maxW: 0 },
      { id: uid(), type: 'qr', x: 540, y: 1010, size: 230 },
      { id: uid(), type: 'static', text: 'MÃ QR ĐỂ CHECK-IN', x: 540, y: 1295, size: 20, font: 'Montserrat', weight: '600', color: theme.soft, align: 'center', upper: false, ls: 4, maxW: 0 }
    ]
  });

  return [
    futureMenus,
    mk('GALA DINNER TRI ÂN ĐỐI TÁC 2026', { c1: '#0e2148', c2: '#050b18', glow: 'rgba(64,120,255,.35)', gold: '#f0d9a0', soft: '#c6d4f2' }, 'ĐÊM TRI ÂN – KẾT NỐI THỊNH VƯỢNG', '12.09.2026  |  18:00 - Thứ Bảy', 'BALLROOM A – REX HOTEL, TP. HỒ CHÍ MINH'),
    mk('LỄ RA MẮT SẢN PHẨM AURORA', { c1: '#0b3d35', c2: '#02120f', glow: 'rgba(45,212,168,.32)', gold: '#e8dcb8', soft: '#bfe3d6' }, 'AURORA – BỪNG SÁNG KỶ NGUYÊN MỚI', '05.10.2026  |  09:00 - Thứ Hai', 'TRUNG TÂM HỘI NGHỊ QUỐC GIA, HÀ NỘI')
  ];
}

/* ---------------- store ---------------- */
let db;
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  db = { events: seedEvents(), guests: [], logs: [] };
}
db.events ||= []; db.guests ||= []; db.logs ||= [];

function persist() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE); // ponytail: sync write, fine at this scale; queue it if writes ever overlap
}
if (!fs.existsSync(DATA_FILE)) persist();

function addLog(eventName, kind, line, ok) {
  db.logs.unshift({ at: new Date().toISOString(), eventName, kind, line, ok });
  db.logs = db.logs.slice(0, 50);
}

/* ---------------- auth ---------------- */
const tokens = new Map(); // token -> expiry
const TOKEN_TTL = 8 * 60 * 60 * 1000;

// One shared throttle for the two guessable endpoints: admin login and guest lookup.
const attempts = new Map(); // ip -> { n, until }
function throttled(ip, limit) {
  const a = attempts.get(ip);
  if (a && a.until > Date.now() && a.n >= limit) return true;
  return false;
}
function noteFail(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until < Date.now()) { a.n = 0; a.until = Date.now() + 15 * 60 * 1000; }
  a.n++;
  attempts.set(ip, a);
}
function isAdmin(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const exp = tokens.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { tokens.delete(t); return false; }
  return true;
}

/* ---------------- event views ---------------- */
// Guests must never receive the integration block — it holds the credentials.
const publicEvent = (e) => {
  const { api, ...rest } = e;
  return rest;
};
// Admins get everything except the password itself; null means "unchanged".
const adminEvent = (e) => {
  const api = e.api || emptyApi();
  return {
    ...e,
    api: { ...api, auth: { ...api.auth, password: null, hasPassword: !!(api.auth && api.auth.password) } }
  };
};

/* ---------------- outbound integration ---------------- */
async function forwardToApi(ev, payload, kind) {
  const api = ev.api;
  if (!api || !api.enabled || !api.url) return null;

  const body = S.renderApiBody(api.bodyTemplate, S.apiContext(ev, payload));
  try {
    JSON.parse(body);
  } catch (e) {
    const line = `body template không tạo ra JSON hợp lệ: ${e.message}`;
    addLog(ev.name, kind, line, false);
    return { ok: false, line };
  }

  const headers = { ...(api.headers || {}) };
  if (api.auth && api.auth.type === 'basic' && api.auth.username) {
    const raw = api.auth.username + ':' + (api.auth.password || '');
    headers.Authorization = 'Basic ' + Buffer.from(raw).toString('base64');
  }

  try {
    const res = await fetch(api.url, { method: api.method || 'POST', headers, body });
    const text = (await res.text()).slice(0, 2000);
    let remoteQrcode = '';
    try {
      const j = JSON.parse(text);
      remoteQrcode = j.qrcode || (j.data && j.data.qrcode) || '';
    } catch (e) { /* non-JSON response is fine, just nothing to capture */ }
    // never log the Authorization header
    const line = `${api.method || 'POST'} ${api.url} → HTTP ${res.status}${text ? ' · ' + text.slice(0, 300) : ''}`;
    addLog(ev.name, kind, line, res.ok);
    return { ok: res.ok, status: res.status, remoteQrcode, line };
  } catch (e) {
    const line = `${api.url} → LỖI: ${e.message}`;
    addLog(ev.name, kind, line, false);
    return { ok: false, line };
  }
}

/* ---------------- http helpers ---------------- */
const send = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
};
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('payload quá lớn')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON không hợp lệ')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function serveFile(res, rel) {
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ---------------- routes ---------------- */
const APP_ROUTES = new Set(['/', '/tra-cuu', '/admin']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = req.socket.remoteAddress || '?';

  try {
    /* ----- public API ----- */
    if (p === '/api/bootstrap' && req.method === 'GET') {
      return send(res, 200, { events: db.events.map(publicEvent) });
    }

    if (p === '/api/guests' && req.method === 'POST') {
      const { eventId, data, replaceId, force } = await readBody(req);
      const ev = db.events.find((e) => e.id === eventId);
      if (!ev) return send(res, 400, { error: 'Sự kiện không tồn tại.' });
      for (const i of ev.inputs) {
        if (i.required && !String((data || {})[i.key] || '').trim()) {
          return send(res, 400, { error: 'Vui lòng nhập: ' + i.label });
        }
      }

      if (!replaceId && !force) {
        const matches = db.guests.filter(
          (g) => g.eventId === ev.id && S.normName(g.data.name) === S.normName(data.name)
        );
        if (matches.length) return send(res, 200, { dupe: matches });
      }

      const prev = replaceId ? db.guests.find((g) => g.id === replaceId) : null;
      const payload = S.buildPayload(ev, data, prev);
      payload.id = prev ? prev.id : uid();

      const out = await forwardToApi(ev, payload, prev ? 'cập nhật' : 'tạo mới');
      if (out && out.remoteQrcode) payload.remoteQrcode = out.remoteQrcode;

      db.guests = prev
        ? db.guests.map((g) => (g.id === prev.id ? payload : g))
        : [...db.guests, payload];
      persist();
      return send(res, 200, { payload, api: out && { ok: out.ok, line: out.line } });
    }

    if (p === '/api/lookup' && req.method === 'POST') {
      if (throttled(ip, 20)) return send(res, 429, { error: 'Bạn thử quá nhiều lần. Đợi ít phút rồi thử lại.' });
      const { eventId, name, phone } = await readBody(req);
      const digits = (x) => String(x || '').replace(/\D/g, '');
      const hit = db.guests.find((g) =>
        g.eventId === eventId &&
        S.normName(g.data.name) === S.normName(name) &&
        digits(g.data.phone) === digits(phone) && digits(phone) !== ''
      );
      if (!hit) { noteFail(ip); return send(res, 404, { error: 'Không tìm thấy thiệp khớp với thông tin bạn nhập.' }); }
      return send(res, 200, { payload: hit });
    }

    /* ----- admin ----- */
    if (p === '/api/admin/login' && req.method === 'POST') {
      if (throttled(ip, 10)) return send(res, 429, { error: 'Sai quá nhiều lần. Đợi 15 phút.' });
      const { password } = await readBody(req);
      if (String(password || '') !== ADMIN_PASSWORD) { noteFail(ip); return send(res, 401, { error: 'Mật khẩu chưa đúng.' }); }
      const token = crypto.randomBytes(24).toString('hex');
      tokens.set(token, Date.now() + TOKEN_TTL);
      return send(res, 200, { token });
    }

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Phiên đăng nhập đã hết hạn.' });

      if (p === '/api/admin/state' && req.method === 'GET') {
        return send(res, 200, { events: db.events.map(adminEvent), guests: db.guests, logs: db.logs });
      }

      if (p === '/api/admin/events' && req.method === 'PUT') {
        const { events } = await readBody(req);
        if (!Array.isArray(events)) return send(res, 400, { error: 'events phải là mảng.' });
        db.events = events.map((incoming) => {
          const old = db.events.find((e) => e.id === incoming.id);
          const api = incoming.api || emptyApi();
          const auth = api.auth || { type: 'none', username: '', password: '' };
          // password === null means the admin did not retype it — keep the stored one
          const password = auth.password == null
            ? (old && old.api && old.api.auth ? old.api.auth.password || '' : '')
            : String(auth.password);
          const { hasPassword, ...authRest } = auth;
          return { ...incoming, api: { ...api, auth: { ...authRest, password } } };
        });
        persist();
        return send(res, 200, { events: db.events.map(adminEvent) });
      }

      if (p.startsWith('/api/admin/guests/') && req.method === 'DELETE') {
        const id = decodeURIComponent(p.slice('/api/admin/guests/'.length));
        db.guests = db.guests.filter((g) => g.id !== id);
        persist();
        return send(res, 200, { ok: true });
      }

      const testMatch = p.match(/^\/api\/admin\/events\/([\w-]+)\/test$/);
      if (testMatch && req.method === 'POST') {
        const ev = db.events.find((e) => e.id === testMatch[1]);
        if (!ev) return send(res, 404, { error: 'Sự kiện không tồn tại.' });
        const sample = S.samplePayload(ev);
        sample.id = 'sample';
        const preview = S.renderApiBody(ev.api && ev.api.bodyTemplate, S.apiContext(ev, sample));
        const out = await forwardToApi(ev, sample, 'gửi thử');
        persist();
        return send(res, 200, {
          preview,
          result: out || { ok: false, line: 'Tích hợp đang tắt hoặc chưa có URL.' },
          logs: db.logs
        });
      }

      return send(res, 404, { error: 'not found' });
    }

    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    /* ----- static ----- */
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (APP_ROUTES.has(p)) return serveFile(res, 'index.html');
    if (p === '/shared.js') return serveFile(res, 'shared.js');
    if (p.startsWith('/public/')) return serveFile(res, decodeURIComponent(p.slice(1)));
    return serveFile(res, 'index.html'); // unknown paths fall back to the app
  } catch (e) {
    return send(res, 400, { error: e.message || 'Yêu cầu không hợp lệ.' });
  }
});

if (require.main === module) server.listen(PORT, () => {
  console.log(`→ http://localhost:${PORT}          trang khách`);
  console.log(`→ http://localhost:${PORT}/tra-cuu  tra cứu thiệp`);
  console.log(`→ http://localhost:${PORT}/admin    quản trị`);
  if (ADMIN_PASSWORD === 'admin') console.log('!  ADMIN_PASSWORD chưa đặt — đang dùng mặc định "admin".');
  const fm = db.events[0];
  if (fm && fm.api && fm.api.enabled && !fm.api.auth.password) {
    console.log('!  Chưa có mật khẩu API Delfi. Đặt DELFI_API_PASSWORD hoặc nhập trong trang quản trị.');
  }
});

module.exports = { server, db, seedEvents, defaultInputs, emptyApi, forwardToApi };
