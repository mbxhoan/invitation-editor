'use strict';
// Request handler + local dev server. No dependencies of its own.
//   node server.js            → http://localhost:3001 (uses data.json)
//   exported `handler`        → used by api/[...path].js on Vercel
// Env:
//   PORT                       default 3001 (local only)
//   ADMIN_PASSWORD             default "admin" — set this in production
//   ADMIN_TOKEN_SECRET         signs admin sessions. REQUIRED on Vercel, else a
//                              cold start invalidates everyone's login.
//   DATABASE_URL               Neon connection string. REQUIRED on Vercel
//   (or POSTGRES_URL)          (no writable filesystem). Absent → local file.
//   DELFI_API_PASSWORD         seeds the Future Menus Basic Auth password on the
//                              very first run only. Never hardcoded here.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./public/shared');
const store = require('./store');

const PORT = Number(process.env.PORT) || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const TOKEN_TTL = 8 * 60 * 60 * 1000;
const STATIC_ROOT = path.join(__dirname, 'public');

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
    w: 1810, h: 2560, bg: '/1.png', theme: null,
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

// Seeding + schema creation run once per cold start, not per request.
let readyP = null;
const ready = () => (readyP ||= store.init(seedEvents));

/* ---------------- auth ---------------- */
// Stateless HMAC session: serverless instances share no memory, so a token has
// to verify from the secret alone rather than from a lookup table.
const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const sign = (s) => crypto.createHmac('sha256', TOKEN_SECRET).update(String(s)).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function mintToken() {
  const exp = Date.now() + TOKEN_TTL;
  return exp + '.' + sign(exp);
}
function isAdmin(req) {
  const h = req.headers.authorization || '';
  const raw = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [exp, sig] = raw.split('.');
  if (!exp || !sig) return false;
  if (!(Number(exp) > Date.now())) return false;
  return safeEqual(sig, sign(exp));
}

/* ---------------- event views ---------------- */
// Guests must never receive the integration block — it holds the credentials.
const publicEvent = (e) => { const { api, ...rest } = e; return rest; };
// Admins get everything except the password itself; null means "unchanged".
const adminEvent = (e) => {
  const api = e.api || emptyApi();
  const auth = api.auth || {};
  return { ...e, api: { ...api, auth: { ...auth, password: null, hasPassword: !!auth.password } } };
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
    await store.addLog({ at: new Date().toISOString(), eventName: ev.name, kind, line, ok: false });
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
    } catch (e) { /* a non-JSON response is fine, there is just nothing to capture */ }
    // the Authorization header is deliberately never logged
    const line = `${api.method || 'POST'} ${api.url} → HTTP ${res.status}${text ? ' · ' + text.slice(0, 300) : ''}`;
    await store.addLog({ at: new Date().toISOString(), eventName: ev.name, kind, line, ok: res.ok });
    return { ok: res.ok, status: res.status, remoteQrcode, line };
  } catch (e) {
    const line = `${api.url} → LỖI: ${e.message}`;
    await store.addLog({ at: new Date().toISOString(), eventName: ev.name, kind, line, ok: false });
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
  // Vercel may have parsed the body already
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
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
const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  (req.socket && req.socket.remoteAddress) || '?';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
// Local dev only — on Vercel everything under public/ is served by the CDN.
function serveStatic(res, rel) {
  const file = path.join(STATIC_ROOT, rel);
  const index = path.join(STATIC_ROOT, 'index.html');
  const target = file.startsWith(STATIC_ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()
    ? file : index;
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ---------------- routes ---------------- */
async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = clientIp(req);

  try {
    await ready();

    /* ----- public API ----- */
    if (p === '/api/bootstrap' && req.method === 'GET') {
      const events = await store.getEvents();
      return send(res, 200, { events: events.map(publicEvent) });
    }

    if (p === '/api/guests' && req.method === 'POST') {
      const { eventId, data, replaceId, force } = await readBody(req);
      const events = await store.getEvents();
      const ev = events.find((e) => e.id === eventId);
      if (!ev) return send(res, 400, { error: 'Sự kiện không tồn tại.' });
      for (const i of ev.inputs) {
        if (i.required && !String((data || {})[i.key] || '').trim()) {
          return send(res, 400, { error: 'Vui lòng nhập: ' + i.label });
        }
      }

      const guests = await store.getGuests();
      if (!replaceId && !force) {
        const matches = guests.filter(
          (g) => g.eventId === ev.id && S.normName(g.data.name) === S.normName(data.name)
        );
        if (matches.length) return send(res, 200, { dupe: matches });
      }

      const prev = replaceId ? guests.find((g) => g.id === replaceId) : null;
      const payload = S.buildPayload(ev, data, prev);
      payload.id = prev ? prev.id : uid();

      const out = await forwardToApi(ev, payload, prev ? 'cập nhật' : 'tạo mới');
      if (out && out.remoteQrcode) payload.remoteQrcode = out.remoteQrcode;

      await store.putGuest(payload);
      return send(res, 200, { payload, api: out && { ok: out.ok, line: out.line } });
    }

    if (p === '/api/lookup' && req.method === 'POST') {
      if (await store.rateHit('lookup:' + ip, 900) > 20) {
        return send(res, 429, { error: 'Bạn thử quá nhiều lần. Đợi ít phút rồi thử lại.' });
      }
      const { eventId, name, phone } = await readBody(req);
      const digits = (x) => String(x || '').replace(/\D/g, '');
      const guests = await store.getGuests();
      const hit = guests.find((g) =>
        g.eventId === eventId &&
        S.normName(g.data.name) === S.normName(name) &&
        digits(g.data.phone) === digits(phone) && digits(phone) !== ''
      );
      if (!hit) return send(res, 404, { error: 'Không tìm thấy thiệp khớp với thông tin bạn nhập.' });
      return send(res, 200, { payload: hit });
    }

    /* ----- admin ----- */
    if (p === '/api/admin/login' && req.method === 'POST') {
      if (await store.rateHit('login:' + ip, 900) > 10) {
        return send(res, 429, { error: 'Sai quá nhiều lần. Đợi 15 phút.' });
      }
      const { password } = await readBody(req);
      if (!safeEqual(String(password || ''), ADMIN_PASSWORD)) {
        return send(res, 401, { error: 'Mật khẩu chưa đúng.' });
      }
      return send(res, 200, { token: mintToken() });
    }

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Phiên đăng nhập đã hết hạn.' });

      if (p === '/api/admin/state' && req.method === 'GET') {
        const [events, guests, logs] = await Promise.all([store.getEvents(), store.getGuests(), store.getLogs()]);
        return send(res, 200, { events: events.map(adminEvent), guests, logs });
      }

      if (p === '/api/admin/events' && req.method === 'PUT') {
        const { events } = await readBody(req);
        if (!Array.isArray(events)) return send(res, 400, { error: 'events phải là mảng.' });
        const old = await store.getEvents();
        const merged = events.map((incoming) => {
          const prev = old.find((e) => e.id === incoming.id);
          const api = incoming.api || emptyApi();
          const auth = api.auth || { type: 'none', username: '', password: '' };
          // password === null means the admin did not retype it — keep the stored one
          const password = auth.password == null
            ? (prev && prev.api && prev.api.auth ? prev.api.auth.password || '' : '')
            : String(auth.password);
          const { hasPassword, ...authRest } = auth;
          return { ...incoming, api: { ...api, auth: { ...authRest, password } } };
        });
        await store.setEvents(merged);
        return send(res, 200, { events: merged.map(adminEvent) });
      }

      if (p.startsWith('/api/admin/guests/') && req.method === 'DELETE') {
        await store.deleteGuest(decodeURIComponent(p.slice('/api/admin/guests/'.length)));
        return send(res, 200, { ok: true });
      }

      const testMatch = p.match(/^\/api\/admin\/events\/([\w-]+)\/test$/);
      if (testMatch && req.method === 'POST') {
        const events = await store.getEvents();
        const ev = events.find((e) => e.id === testMatch[1]);
        if (!ev) return send(res, 404, { error: 'Sự kiện không tồn tại.' });
        const sample = S.samplePayload(ev);
        sample.id = 'sample';
        const preview = S.renderApiBody(ev.api && ev.api.bodyTemplate, S.apiContext(ev, sample));
        const out = await forwardToApi(ev, sample, 'gửi thử');
        return send(res, 200, {
          preview,
          result: out || { ok: false, line: 'Tích hợp đang tắt hoặc chưa có URL.' },
          logs: await store.getLogs()
        });
      }

      return send(res, 404, { error: 'not found' });
    }

    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    /* ----- static (local dev; Vercel serves public/ from its CDN) ----- */
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    return serveStatic(res, decodeURIComponent(p.replace(/^\/+/, '')));
  } catch (e) {
    return send(res, 400, { error: e.message || 'Yêu cầu không hợp lệ.' });
  }
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`→ http://localhost:${PORT}          trang khách`);
    console.log(`→ http://localhost:${PORT}/tra-cuu  tra cứu thiệp`);
    console.log(`→ http://localhost:${PORT}/admin    quản trị`);
    console.log(`   lưu trữ: ${store.backend === 'postgres' ? 'Neon Postgres' : 'data.json (file)'}`);
    if (ADMIN_PASSWORD === 'admin') console.log('!  ADMIN_PASSWORD chưa đặt — đang dùng mặc định "admin".');
    if (store.backend === 'postgres' && !process.env.ADMIN_TOKEN_SECRET) {
      console.log('!  ADMIN_TOKEN_SECRET chưa đặt — phiên đăng nhập sẽ mất khi cold start.');
    }
  });
}

module.exports = { handler, server, seedEvents, defaultInputs, emptyApi };
