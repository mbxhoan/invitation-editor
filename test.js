// Self-check — run with `node test.js`. No dependencies, no framework.
// The server suite runs TWICE: once on the local file store, once on the Postgres
// store (against an in-process fake Neon that implements exactly the queries
// store.js issues), because Postgres is the code path that runs on Vercel.
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let n = 0;
const check = async (label, name, fn) => { await fn(); n++; console.log(`  ok [${label}] ${name}`); };

/* ---------- stand-in for checkin.delfi.vn ---------- */
function delfiStub(received) {
  return http.createServer((rq, rs) => {
    let b = '';
    rq.on('data', (c) => { b += c; });
    rq.on('end', () => {
      received.push({ method: rq.method, headers: rq.headers, body: b });
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ qrcode: 'DELFI-QR-9', ok: true }));
    });
  });
}

/* ---------- in-memory fake of Neon, faithful to store.js's queries ----------
   Both sides are ours, so matching on a distinctive substring of each query is
   stable. This validates param wiring and row parsing; it does NOT validate the
   SQL against a real Postgres (the first deploy / "Gửi thử" does that). */
function neonStub() {
  const state = new Map();   // app_state: key -> parsed value
  const guests = new Map();  // id -> { event_id, created_at, payload }
  let logs = [], logSeq = 0; // { id, at, event_name, kind, line, ok }
  const rate = new Map();    // key -> { n, reset_at }

  return function run(text, params = []) {
    const t = text;
    let rows = [];
    if (t.includes('CREATE TABLE')) {
      /* noop */
    } else if (t.includes('SELECT value FROM app_state')) {
      if (state.has('events')) rows = [{ value: state.get('events') }];
    } else if (t.includes('INSERT INTO app_state')) {
      const val = JSON.parse(params[0]);
      if (t.includes('DO NOTHING')) { if (!state.has('events')) state.set('events', val); }
      else state.set('events', val);
    } else if (t.includes('SELECT payload FROM guests')) {
      rows = [...guests.values()]
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .map((g) => ({ payload: g.payload }));
    } else if (t.includes('INSERT INTO guests')) {
      const [id, event_id, created_at, json] = params;
      guests.set(id, { event_id, created_at, payload: JSON.parse(json) });
    } else if (t.includes('DELETE FROM guests')) {
      guests.delete(params[0]);
    } else if (t.includes('SELECT at, event_name')) {
      rows = logs.slice().sort((a, b) => b.id - a.id).slice(0, 50)
        .map((l) => ({ at: l.at, event_name: l.event_name, kind: l.kind, line: l.line, ok: l.ok }));
    } else if (t.includes('INSERT INTO logs')) {
      const [at, event_name, kind, line, ok] = params;
      logs.push({ id: ++logSeq, at, event_name, kind, line, ok });
    } else if (t.includes('DELETE FROM logs')) {
      const keep = new Set(logs.slice().sort((a, b) => b.id - a.id).slice(0, 50).map((l) => l.id));
      logs = logs.filter((l) => keep.has(l.id));
    } else if (t.includes('INSERT INTO rate')) {
      const [key, until, now] = params;
      const r = rate.get(key);
      let v;
      if (!r || r.reset_at < now) { rate.set(key, { n: 1, reset_at: until }); v = 1; }
      else { r.n++; v = r.n; }
      rows = [{ n: v }];
    } else {
      throw new Error('neonStub: unhandled query: ' + t.slice(0, 70));
    }
    return Promise.resolve(rows);
  };
}

// A fresh module graph, optionally with the Postgres path stubbed in.
function freshServer(injectRun) {
  for (const k of Object.keys(require.cache)) {
    if (/\/(server|store)\.js$/.test(k) || /public\/shared\.js$/.test(k)) delete require.cache[k];
  }
  const store = require('./store');
  if (injectRun) store.__useStub(injectRun);
  return require('./server');
}

/* ============ the server suite, run once per storage backend ============ */
async function serverSuite(label, injectRun) {
  const received = [];
  const delfi = delfiStub(received);
  await new Promise((r) => delfi.listen(0, r));
  const delfiUrl = 'http://127.0.0.1:' + delfi.address().port + '/api/v1/clients/upsert';

  const { server } = freshServer(injectRun);
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const call = async (p, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (e) {}
    return { status: res.status, json, res };
  };
  const it = (name, fn) => check(label, name, fn);

  let events, token, guest;

  await it('bootstrap seeds 3 events and never leaks the API config', async () => {
    const r = await call('/api/bootstrap');
    assert.equal(r.status, 200);
    events = r.json.events;
    assert.equal(events.length, 3);
    for (const e of events) assert.equal(e.api, undefined, 'api block leaked to guests: ' + e.name);
    assert.ok(!JSON.stringify(events).includes('seeded-pw'), 'API password leaked in /api/bootstrap');
  });

  await it('event #1 points at /1.png — the path Vercel serves public/ from', async () => {
    const ev = events[0];
    assert.equal(ev.bg, '/1.png', 'Vercel serves public/ at the root, not /public/');
    assert.ok(fs.existsSync(path.join(__dirname, 'public', '1.png')));
    assert.equal(ev.w, 1810);
    assert.equal(ev.h, 2560);
    assert.equal(ev.fields.length, 2, 'artwork already carries title/date/venue');
    assert.deepEqual(ev.fields.map((f) => f.type).sort(), ['bind', 'qr']);
  });

  await it('static files and app routes are served locally', async () => {
    for (const p of ['/', '/tra-cuu', '/admin']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.ok((await r.text()).includes('<title>'), p + ' should return the app shell');
    }
    const js = await fetch(base + '/shared.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  });

  await it('phone accepts a full number, and email exists for the API payload', async () => {
    const keys = events[0].inputs.map((i) => i.key);
    assert.ok(keys.includes('email'), 'Delfi payload needs an email field');
    const phone = events[0].inputs.find((i) => i.key === 'phone');
    assert.equal(phone.label, 'Số điện thoại');
    assert.ok(!/5 số cuối/i.test(phone.label + phone.placeholder));
    assert.ok(phone.required);
  });

  await it('admin endpoints are closed without a valid token', async () => {
    assert.equal((await call('/api/admin/state')).status, 401);
    assert.equal((await call('/api/admin/state', { token: 'made-up' })).status, 401);
    assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  });

  await it('admin login issues a token', async () => {
    const r = await call('/api/admin/login', { method: 'POST', body: { password: 'test-secret' } });
    assert.equal(r.status, 200);
    token = r.json.token;
    assert.ok(token.includes('.'));
  });

  await it('a tampered or expired token is rejected', async () => {
    const [exp, sig] = token.split('.');
    assert.equal((await call('/api/admin/state', { token: exp + '.' + 'f'.repeat(sig.length) })).status, 401);
    assert.equal((await call('/api/admin/state', { token: (Date.now() + 9e9) + '.' + sig })).status, 401);
    assert.equal((await call('/api/admin/state', { token: (Date.now() - 1000) + '.' + sig })).status, 401);
  });

  // Repoint the integration at the local stub BEFORE any guest is created, so
  // nothing in this suite ever reaches the real checkin.delfi.vn.
  await it('admin can repoint an event integration to another URL', async () => {
    const state = await call('/api/admin/state', { token });
    const evs = state.json.events;
    evs[0].api.url = delfiUrl;
    const put = await call('/api/admin/events', { method: 'PUT', body: { events: evs }, token });
    assert.equal(put.status, 200);
    assert.equal(put.json.events[0].api.url, delfiUrl);
  });

  await it('required fields are enforced server-side', async () => {
    const r = await call('/api/guests', { method: 'POST', body: { eventId: events[0].id, data: { title: 'Ông' } } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Họ và tên/);
  });

  await it('creating a guest returns a payload with a derived lucky number + QR', async () => {
    const r = await call('/api/guests', {
      method: 'POST',
      body: { eventId: events[0].id, data: { title: 'Ông', name: 'Nguyễn Văn A', phone: '0901234567', email: 'a@x.vn' } }
    });
    assert.equal(r.status, 200);
    guest = r.json.payload;
    assert.equal(guest.computed.fullNameDisplay, 'ÔNG NGUYỄN VĂN A');
    assert.match(guest.computed.lucky, /^\d{4}$/);
    assert.ok(guest.computed.qrContent.includes('0901234567'));
  });

  await it('a repeated name on the same event asks before writing a second record', async () => {
    const r = await call('/api/guests', {
      method: 'POST',
      body: { eventId: events[0].id, data: { title: 'Bà', name: '  nguyễn   VĂN a ', phone: '0900000000' } }
    });
    assert.ok(r.json.dupe);
    assert.equal(r.json.dupe.length, 1);
    assert.ok(!r.json.payload);
  });

  await it('replace keeps the record id; force creates a new one', async () => {
    const rep = await call('/api/guests', {
      method: 'POST',
      body: { eventId: events[0].id, data: { title: 'Ông', name: 'Nguyễn Văn A', phone: '0911111111' }, replaceId: guest.id }
    });
    assert.equal(rep.json.payload.id, guest.id);
    assert.equal(rep.json.payload.createdAt, guest.createdAt, 'createdAt must survive an edit');

    const add = await call('/api/guests', {
      method: 'POST',
      body: { eventId: events[0].id, data: { title: 'Ông', name: 'Nguyễn Văn A', phone: '0922222222' }, force: true }
    });
    assert.notEqual(add.json.payload.id, guest.id);
    const all = (await call('/api/admin/state', { token })).json.guests;
    assert.equal(all.length, 2, 'replace must not have created a third record');
  });

  await it('lookup needs BOTH the right name and the right phone', async () => {
    const ok = await call('/api/lookup', { method: 'POST', body: { eventId: events[0].id, name: 'nguyễn văn a', phone: '0911111111' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.payload.id, guest.id);

    for (const bad of [
      { name: 'Nguyễn Văn A', phone: '0999999999' },
      { name: 'Nguyễn Văn A', phone: '' },
      { name: 'Người Khác', phone: '0911111111' }
    ]) {
      const r = await call('/api/lookup', { method: 'POST', body: { eventId: events[0].id, ...bad } });
      assert.equal(r.status, 404, JSON.stringify(bad));
    }
    const otherEvent = await call('/api/lookup', { method: 'POST', body: { eventId: events[1].id, name: 'Nguyễn Văn A', phone: '0911111111' } });
    assert.equal(otherEvent.status, 404, 'lookup is scoped to the chosen event');
  });

  await it('lookup ignores phone formatting', async () => {
    const r = await call('/api/lookup', { method: 'POST', body: { eventId: events[0].id, name: 'Nguyễn Văn A', phone: '091 111-1111' } });
    assert.equal(r.status, 200);
  });

  await it('the proxy sends User-Agent and Basic Auth that a browser could not', async () => {
    assert.ok(received.length, 'the integration should have fired on guest creation');
    const last = received[received.length - 1];
    assert.equal(last.method, 'POST');
    assert.equal(last.headers['user-agent'], 'ApiPortal', 'browsers silently drop this header — the server must not');
    assert.equal(last.headers['content-type'], 'application/json');
    assert.equal(last.headers.authorization, 'Basic ' + Buffer.from('demo:seeded-pw').toString('base64'));
    const body = JSON.parse(last.body);
    assert.equal(body.event_id, 124);
    assert.equal(body.type, 'API_TEST');
    assert.equal(body.name, 'Nguyễn Văn A');
    assert.match(body.custom_fields.lk_number, /^\d{4}$/);
  });

  await it('the qrcode returned by the API is stored for the next update', async () => {
    const g = (await call('/api/admin/state', { token })).json.guests.find((x) => x.data.phone === '0922222222');
    assert.equal(g.remoteQrcode, 'DELFI-QR-9');
    received.length = 0;
    await call('/api/guests', { method: 'POST', body: { eventId: events[0].id, data: { ...g.data, position: 'CTO' }, replaceId: g.id } });
    assert.equal(JSON.parse(received.at(-1).body).qrcode, 'DELFI-QR-9', 'an update must carry the remote id, not create a duplicate client');
  });

  await it('a bad body template is caught before anything is sent', async () => {
    const state = await call('/api/admin/state', { token });
    const evs = state.json.events;
    const good = evs[0].api.bodyTemplate;
    evs[0].api.bodyTemplate = '{ "name": "{{name}}", }';
    await call('/api/admin/events', { method: 'PUT', body: { events: evs }, token });

    received.length = 0;
    const r = await call('/api/admin/events/' + events[0].id + '/test', { method: 'POST', token });
    assert.equal(received.length, 0, 'invalid JSON must never reach the endpoint');
    assert.equal(r.json.result.ok, false);
    assert.match(r.json.result.line, /JSON hợp lệ/);

    evs[0].api.bodyTemplate = good;
    await call('/api/admin/events', { method: 'PUT', body: { events: evs }, token });
  });

  await it('admin sees the API config but never the password', async () => {
    const r = await call('/api/admin/state', { token });
    const ev = r.json.events[0];
    assert.equal(ev.api.auth.username, 'demo');
    assert.equal(ev.api.headers['User-Agent'], 'ApiPortal');
    assert.equal(ev.api.auth.password, null, 'password must be withheld');
    assert.equal(ev.api.auth.hasPassword, true, 'but the admin must see that one is set');
    assert.ok(!JSON.stringify(r.json).includes('seeded-pw'), 'password leaked in /api/admin/state');
  });

  await it('saving with password:null keeps it; a typed value replaces it', async () => {
    const evs = (await call('/api/admin/state', { token })).json.events;
    evs[0].name = 'ĐỔI TÊN THỬ';
    let put = await call('/api/admin/events', { method: 'PUT', body: { events: evs }, token });
    assert.equal(put.json.events[0].name, 'ĐỔI TÊN THỬ');
    assert.equal(put.json.events[0].api.auth.hasPassword, true, 'a rename must not wipe the credential');

    received.length = 0;
    await call('/api/admin/events/' + events[0].id + '/test', { method: 'POST', token });
    assert.equal(received.at(-1).headers.authorization, 'Basic ' + Buffer.from('demo:seeded-pw').toString('base64'));

    const evs2 = (await call('/api/admin/state', { token })).json.events;
    evs2[0].api.auth.password = 'rotated-pw';
    await call('/api/admin/events', { method: 'PUT', body: { events: evs2 }, token });
    received.length = 0;
    await call('/api/admin/events/' + events[0].id + '/test', { method: 'POST', token });
    assert.equal(received.at(-1).headers.authorization, 'Basic ' + Buffer.from('demo:rotated-pw').toString('base64'));
  });

  await it('deleting a guest removes it from the shared store', async () => {
    const before = (await call('/api/admin/state', { token })).json.guests.length;
    await call('/api/admin/guests/' + guest.id, { method: 'DELETE', token });
    const after = (await call('/api/admin/state', { token })).json.guests;
    assert.equal(after.length, before - 1);
    assert.ok(!after.find((g) => g.id === guest.id));
  });

  await it('the API send log is readable back and never contains the auth header', async () => {
    const logs = (await call('/api/admin/state', { token })).json.logs;
    assert.ok(logs.length > 0);
    assert.ok(logs[0].at && logs[0].line);
    assert.ok(!JSON.stringify(logs).toLowerCase().includes('authorization'));
    assert.ok(logs.length <= 50, 'log list is capped');
  });

  await new Promise((r) => server.close(r));
  await new Promise((r) => delfi.close(r));
  return token;
}

/* ============ run ============ */
(async function run() {
  const TMP = path.join(os.tmpdir(), 'ecard-test-' + Date.now() + '.json');
  process.env.ADMIN_PASSWORD = 'test-secret';
  process.env.ADMIN_TOKEN_SECRET = 'fixed-secret-for-tests';
  process.env.DELFI_API_PASSWORD = 'seeded-pw';

  /* ---- backend 1: local JSON file ---- */
  process.env.DATA_FILE = TMP;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  await serverSuite('file', null);

  await check('file', 'the file backend actually wrote to disk', async () => {
    const disk = JSON.parse(fs.readFileSync(TMP, 'utf8'));
    assert.equal(disk.events.length, 3);
    assert.ok(disk.guests.length >= 1);
    assert.equal(disk.events[0].api.auth.password, 'rotated-pw', 'credentials live server-side only');
  });

  /* ---- backend 2: Postgres (the Vercel path) ---- */
  const pg = neonStub();
  process.env.DATA_FILE = path.join(os.tmpdir(), 'should-never-be-written.json');
  const pgToken = await serverSuite('postgres', pg);

  await check('postgres', 'nothing was written to the filesystem', async () => {
    assert.ok(!fs.existsSync(process.env.DATA_FILE), 'Postgres backend must not touch the disk — Vercel is read-only');
  });

  await check('postgres', 'a session survives a cold start (stateless HMAC token)', async () => {
    // a brand-new instance backed by the SAME db — the old token must still work
    const { server } = freshServer(pg);
    await new Promise((r) => server.listen(0, r));
    const url = 'http://127.0.0.1:' + server.address().port + '/api/admin/state';
    const ok = await fetch(url, { headers: { Authorization: 'Bearer ' + pgToken } });
    assert.equal(ok.status, 200, 'token must verify from the secret alone, not from in-memory state');
    await new Promise((r) => server.close(r));

    process.env.ADMIN_TOKEN_SECRET = 'a-different-secret';
    const { server: s2 } = freshServer(pg);
    await new Promise((r) => s2.listen(0, r));
    const bad = await fetch('http://127.0.0.1:' + s2.address().port + '/api/admin/state', {
      headers: { Authorization: 'Bearer ' + pgToken }
    });
    assert.equal(bad.status, 401, 'a different secret must invalidate the token');
    process.env.ADMIN_TOKEN_SECRET = 'fixed-secret-for-tests';
    await new Promise((r) => s2.close(r));
  });

  /* ============ API body template ============ */
  const Shared = require('./public/shared');

  await check('tpl', 'placeholders render into valid JSON even with quotes in a name', async () => {
    const ev = { id: 'e1', name: 'Sự kiện', inputs: [{ key: 'name' }, { key: 'phone' }, { key: 'email' }] };
    const payload = Shared.buildPayload(ev, {
      name: 'Trần "Bo" An\\Lê', phone: '0900', email: 'a@x.vn', position: 'CEO', company: 'ACME', title: 'Ông'
    });
    const tpl = `{
      "qrcode": "{{qrcode}}", "event_id": 124, "name": "{{name}}", "email": "{{email}}", "type": "API_TEST",
      "custom_fields": { "position": "{{position}}", "company": "{{company}}", "title": "{{title}}",
                         "phone": "{{phone}}", "lk_number": "{{lucky}}" }
    }`;
    const parsed = JSON.parse(Shared.renderApiBody(tpl, Shared.apiContext(ev, payload)));
    assert.equal(parsed.name, 'Trần "Bo" An\\Lê');
    assert.equal(parsed.qrcode, '', 'blank qrcode means "create" for Delfi');
    assert.equal(parsed.custom_fields.lk_number, payload.computed.lucky);
  });

  await check('tpl', 'unknown placeholders become empty rather than breaking the JSON', async () => {
    const ev = { id: 'e1', name: 'X', inputs: [] };
    const payload = Shared.buildPayload(ev, { name: 'A', phone: '1' });
    assert.equal(JSON.parse(Shared.renderApiBody('{"a":"{{nope}}"}', Shared.apiContext(ev, payload))).a, '');
  });

  /* ============ client rendering ============ */
  const node = () => ({
    innerHTML: '', style: {}, dataset: {}, clientWidth: 0,
    addEventListener() {}, querySelector: () => null, focus() {}, setSelectionRange() {}
  });
  const appEl = node();
  const env = {
    document: {
      activeElement: null,
      fonts: { load: () => Promise.resolve() },
      querySelector: (s) => (s === '#app' ? appEl : null),
      createElement: () => ({ ...node(), click() {}, getContext: () => ({}) })
    },
    window: { qrcode: null, scrollY: 0, scrollTo() {}, addEventListener() {}, removeEventListener() {} },
    location: { pathname: '/' },
    history: { pushState() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {},
    Shared,
    Image: function () {},
    addEventListener() {},
    alert() {}, prompt: () => null, confirm: () => true,
    fetch: () => Promise.reject(new Error('offline in tests'))
  };
  const src = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
    .match(/<script>\n([\s\S]*?)\n<\/script>/)[1];
  const client = new Function(
    ...Object.keys(env),
    `${src}\nreturn {S,esc,homeView,cardView,lookupView,loginView,adminView,editorView,guestModal,textToHeaders,headersToText};`
  )(...Object.values(env));

  await new Promise((r) => setImmediate(r));
  const C = client.S;

  await check('client', 'survives a dead server instead of rendering a blank page', async () => {
    assert.ok(C.bootErr.includes('Không kết nối được'));
  });

  await check('client', 'every screen renders without throwing', async () => {
    const disk = JSON.parse(fs.readFileSync(TMP, 'utf8'));
    C.booted = true; C.events = disk.events; C.guests = disk.guests; C.logs = disk.logs;
    C.selEventId = C.events[0].id; C.lookupEventId = C.events[0].id;

    assert.ok(client.homeView().includes('Tạo thiệp online'));
    assert.ok(client.lookupView().includes('TRA CỨU THIỆP MỜI'));
    assert.ok(client.loginView().includes('Đăng nhập'));
    for (const tab of ['events', 'guests', 'logs']) {
      C.adminTab = tab;
      assert.ok(client.adminView().length > 100, tab);
    }
    C.adminTab = 'events';

    C.card = { eventId: C.events[0].id, payload: disk.guests[0] };
    C.cardEdit = { ...disk.guests[0].data };
    assert.ok(client.cardView().includes('Tải ảnh về'));

    C.editor = { ev: structuredClone(C.events[0]), sel: null };
    const ed = client.editorView();
    assert.ok(ed.includes('TÍCH HỢP API'), 'the designer must expose the API config');
    assert.ok(ed.includes('{{lucky}}'), 'placeholder help must list the derived tokens');
  });

  await check('client', 'header text round-trips through the config editor', async () => {
    const h = { 'Content-Type': 'application/json', 'User-Agent': 'ApiPortal' };
    assert.deepEqual(client.textToHeaders(client.headersToText(h)), h);
    assert.deepEqual(client.textToHeaders('A: 1\n\nbad line\nB: 2'), { A: '1', B: '2' });
  });

  await check('client', 'guest-supplied text is escaped everywhere it is rendered', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    C.guests = [{ ...C.guests[0], id: 'x1', data: { ...C.guests[0].data, name: evil }, computed: { ...C.guests[0].computed, fullNameDisplay: evil } }];
    C.adminTab = 'guests';
    const admin = client.adminView().toLowerCase();
    assert.ok(!admin.includes('<img'), 'raw markup leaked into the admin list');
    assert.ok(admin.includes('&lt;img'));

    C.viewGuest = C.guests[0];
    assert.ok(!client.guestModal().toLowerCase().includes('<img'));
    C.viewGuest = null;
    assert.equal(client.esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
  });

  fs.rmSync(TMP, { force: true });
  console.log(`\n${n} checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
