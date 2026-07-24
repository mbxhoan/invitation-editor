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

// Node does not read .env files by itself. Load a tiny dotenv-compatible
// subset for local development without adding another dependency. Existing
// shell/Vercel variables always win.
function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] != null) continue;
    let value = m[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}
loadDotEnv();
const S = require('./public/shared');
const Email = require('./email');
const store = require('./store');

const PORT = Number(process.env.PORT) || 3001;
// Keep the convenient local default, but never silently fall back on Vercel:
// otherwise a typo in the Environment Variable name looks like a bad password.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (process.env.VERCEL ? '' : 'admin');
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
    email: Email.defaultEmail(),
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

  // The artwork already contains the event copy. Only draw the QR into the
  // reserved box; adding another title/date layer would duplicate the design.
  const artwork = (name, bg, w, h, x, y, size) => ({
    id: uid(), name, w, h, bg, theme: null,
    inputs: defaultInputs(),
    email: Email.defaultEmail(),
    api: emptyApi(),
    fields: [{ id: uid(), type: 'qr', x, y, size }]
  });

  return [
    futureMenus,
    artwork('KỶ NIỆM 50 NĂM PINACO – TRỌN VẸN TÂM KHÁT VỌNG', '/2.png', 1080, 1920, 540, 1450, 390),
    artwork('SỰ KIỆN KICK-OFF DỰ ÁN THE FULTON REGAL', '/3.png', 1440, 2560, 720, 1370, 470)
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
const publicEvent = (e) => { const { api, email, ...rest } = e; return rest; };
// Admins get everything except the password itself; null means "unchanged".
const adminEvent = (e) => {
  const api = e.api || emptyApi();
  const auth = api.auth || {};
  return { ...e, email: Email.normalizeEmail(e.email), api: { ...api, auth: { ...auth, password: null, hasPassword: !!auth.password } } };
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
  // Vercel's single entrypoint rewrite carries the original API path in the
  // query string. Local requests continue to use the normal pathname.
  const p = url.searchParams.get('__path') || url.pathname;
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
      let emailOut = null;
      const emailCfg = Email.normalizeEmail(ev.email);
      const invitation = emailCfg.templates.find((t) => t.type === 'invitation') || emailCfg.templates[0];
      if (emailCfg.enabled && emailCfg.sendOnRegister && invitation && payload.data.email) {
        try {
          emailOut = await Email.sendEventEmail(ev, payload, invitation.id);
        } catch (e) {
          emailOut = { ok: false, line: e.message };
          await store.addLog({ at: new Date().toISOString(), eventName: ev.name, kind: 'gửi email tự động', line: e.message, ok: false });
        }
      }
      return send(res, 200, { payload, api: out && { ok: out.ok, line: out.line }, email: emailOut });
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
      if (!ADMIN_PASSWORD) {
        return send(res, 500, { error: 'Thiếu biến môi trường ADMIN_PASSWORD trên Vercel. Hãy kiểm tra đúng tên biến và redeploy.' });
      }
      const { password } = await readBody(req);
      if (!safeEqual(String(password || ''), ADMIN_PASSWORD)) {
        if (await store.rateHit('login:' + ip, 900) > 10) {
          return send(res, 429, { error: 'Sai quá nhiều lần. Đợi 15 phút.' });
        }
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

      const emailMatch = p.match(/^\/api\/admin\/guests\/([^/]+)\/email$/);
      if (emailMatch && req.method === 'POST') {
        const guests = await store.getGuests();
        const guest = guests.find((g) => g.id === decodeURIComponent(emailMatch[1]));
        if (!guest) return send(res, 404, { error: 'Khách không tồn tại.' });
        const events = await store.getEvents();
        const ev = events.find((e) => e.id === guest.eventId);
        if (!ev) return send(res, 404, { error: 'Sự kiện không tồn tại.' });
        const { templateId } = await readBody(req);
        try {
          const result = await Email.sendEventEmail(ev, guest, templateId);
          await store.addLog({ at: new Date().toISOString(), eventName: ev.name, kind: 'gửi email thủ công', line: `Đã gửi tới ${result.to} · template ${result.templateId}`, ok: true });
          return send(res, 200, { result, logs: await store.getLogs() });
        } catch (e) {
          await store.addLog({ at: new Date().toISOString(), eventName: ev.name, kind: 'gửi email thủ công', line: e.message, ok: false });
          return send(res, 400, { error: e.message, logs: await store.getLogs() });
        }
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
