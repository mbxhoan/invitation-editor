// Self-check — run with `node test.js`. No dependencies, no framework.
// Part 1 drives the real HTTP server against a throwaway data file.
// Part 2 loads index.html's inline script against a minimal DOM stub, so the
// thing under test is always the file that actually ships.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), 'ecard-test-' + Date.now() + '.json');
process.env.DATA_FILE = TMP;
process.env.ADMIN_PASSWORD = 'test-secret';
process.env.DELFI_API_PASSWORD = 'seeded-pw';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

(async function run() {
  /* ============ part 1: server ============ */
  const { server } = require('./server');
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
    return { status: res.status, json };
  };

  // Stand-in for checkin.delfi.vn. Tests must never reach a third party, and
  // this also lets us assert on exactly what the proxy puts on the wire.
  const received = [];
  const fake = require('node:http').createServer((rq, rs) => {
    let b = '';
    rq.on('data', (c) => { b += c; });
    rq.on('end', () => {
      received.push({ method: rq.method, headers: rq.headers, body: b });
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ qrcode: 'DELFI-QR-9', ok: true }));
    });
  });
  await new Promise((r) => fake.listen(0, r));
  const fakeUrl = 'http://127.0.0.1:' + fake.address().port + '/api/v1/clients/upsert';

  let events, token;

  await check('bootstrap seeds 3 events and never leaks the API config', async () => {
    const r = await call('/api/bootstrap');
    assert.equal(r.status, 200);
    events = r.json.events;
    assert.equal(events.length, 3);
    // the guest-facing payload must not carry credentials
    for (const e of events) assert.equal(e.api, undefined, 'api block leaked to guests: ' + e.name);
    assert.ok(!JSON.stringify(events).includes('seeded-pw'), 'API password leaked in /api/bootstrap');
  });

  await check('event #1 uses public/1.png with only the name + QR drawn on it', async () => {
    const ev = events[0];
    assert.equal(ev.bg, '/public/1.png');
    assert.equal(ev.w, 1810);
    assert.equal(ev.h, 2560);
    assert.equal(ev.fields.length, 2, 'artwork already carries title/date/venue');
    assert.deepEqual(ev.fields.map((f) => f.type).sort(), ['bind', 'qr']);
    assert.equal(ev.fields.find((f) => f.type === 'bind').bind, 'fullNameDisplay');
    assert.ok(fs.existsSync(path.join(__dirname, 'public', '1.png')), 'public/1.png must exist');
  });

  await check('phone accepts a full number, and email exists for the API payload', async () => {
    const keys = events[0].inputs.map((i) => i.key);
    assert.ok(keys.includes('email'), 'Delfi payload needs an email field');
    const phone = events[0].inputs.find((i) => i.key === 'phone');
    assert.equal(phone.label, 'Số điện thoại');
    assert.ok(!/5 số cuối/i.test(phone.label + phone.placeholder), 'phone must no longer be last-5-digits');
    assert.ok(phone.required);
  });

  await check('admin endpoints are closed without a valid token', async () => {
    assert.equal((await call('/api/admin/state')).status, 401);
    assert.equal((await call('/api/admin/state', { token: 'made-up' })).status, 401);
    assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  });

  await check('admin login issues a token', async () => {
    const r = await call('/api/admin/login', { method: 'POST', body: { password: 'test-secret' } });
    assert.equal(r.status, 200);
    token = r.json.token;
    assert.ok(token && token.length >= 32);
  });

  // Repoint the seeded integration at the local stub BEFORE creating any guest,
  // so nothing in this suite ever calls the real checkin.delfi.vn.
  await check('admin can repoint an event integration to another URL', async () => {
    const state = await call('/api/admin/state', { token });
    const evs = state.json.events;
    evs[0].api.url = fakeUrl;
    const put = await call('/api/admin/events', { method: 'PUT', body: { events: evs }, token });
    assert.equal(put.status, 200);
    assert.equal(put.json.events[0].api.url, fakeUrl);
  });

  await check('required fields are enforced server-side', async () => {
    const r = await call('/api/guests', { method: 'POST', body: { eventId: events[0].id, data: { title: 'Ông' } } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Họ và tên/);
  });

  let guest;
  await check('creating a guest returns a payload with a derived lucky number + QR', async () => {
    const r = await call('/api/guests', {
      method: 'POST',
      body: { eventId: events[0].id, data: { title: 'Ông', name: 'Nguyễn Văn A', phone: '0901234567', email: 'a@x.vn' } }
    });
    assert.equal(r.status, 200);
    guest = r.json.payload;
    assert.equal(guest.computed.fullNameDisplay, 'ÔNG NGUYỄN VĂN A');
    assert.match(guest.computed.lucky, /^\d{4}$/);
    assert.ok(guest.computed.qrContent.includes('0901234567'));
    assert.ok(guest.id);
  });

  await check('a repeated name on the same event asks before writing a second record', async () => {
    const r = await call('/api/guests', {
      method: 'POST',
      body: { eventId: events[0].id, data: { title: 'Bà', name: '  nguyễn   VĂN a ', phone: '0900000000' } }
    });
    assert.equal(r.status, 200);
    assert.ok(r.json.dupe, 'expected a dupe prompt');
    assert.equal(r.json.dupe.length, 1);
    assert.ok(!r.json.payload);
  });

  await check('replace keeps the record id; force creates a new one', async () => {
    const rep = await call('/api/guests', {
      method: 'POST',
      body: { eventId: events[0].id, data: { title: 'Ông', name: 'Nguyễn Văn A', phone: '0911111111' }, replaceId: guest.id }
    });
    assert.equal(rep.json.payload.id, guest.id);
    assert.equal(rep.json.payload.createdAt, guest.createdAt, 'createdAt must survive an edit');
    assert.equal(rep.json.payload.data.phone, '0911111111');

    const add = await call('/api/guests', {
      method: 'POST',
      body: { eventId: events[0].id, data: { title: 'Ông', name: 'Nguyễn Văn A', phone: '0922222222' }, force: true }
    });
    assert.notEqual(add.json.payload.id, guest.id);
  });

  /* ---- lookup ---- */
  await check('lookup needs BOTH the right name and the right phone', async () => {
    const ok = await call('/api/lookup', {
      method: 'POST',
      body: { eventId: events[0].id, name: 'nguyễn văn a', phone: '0911111111' }
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.payload.id, guest.id);

    const wrongPhone = await call('/api/lookup', {
      method: 'POST', body: { eventId: events[0].id, name: 'Nguyễn Văn A', phone: '0999999999' }
    });
    assert.equal(wrongPhone.status, 404, 'name alone must not be enough');

    const noPhone = await call('/api/lookup', {
      method: 'POST', body: { eventId: events[0].id, name: 'Nguyễn Văn A', phone: '' }
    });
    assert.equal(noPhone.status, 404, 'a blank phone must never match');

    const otherEvent = await call('/api/lookup', {
      method: 'POST', body: { eventId: events[1].id, name: 'Nguyễn Văn A', phone: '0911111111' }
    });
    assert.equal(otherEvent.status, 404, 'lookup is scoped to the chosen event');
  });

  await check('lookup ignores phone formatting', async () => {
    const r = await call('/api/lookup', {
      method: 'POST', body: { eventId: events[0].id, name: 'Nguyễn Văn A', phone: '091 111 1111' }
    });
    assert.equal(r.status, 200);
  });

  /* ---- what the proxy actually puts on the wire ---- */
  await check('the proxy sends User-Agent and Basic Auth that a browser could not', async () => {
    assert.ok(received.length, 'the integration should have fired on guest creation');
    const last = received[received.length - 1];
    assert.equal(last.method, 'POST');
    // the whole reason for the server: browsers silently drop User-Agent
    assert.equal(last.headers['user-agent'], 'ApiPortal');
    assert.equal(last.headers['content-type'], 'application/json');
    assert.equal(
      last.headers.authorization,
      'Basic ' + Buffer.from('demo:seeded-pw').toString('base64'),
      'Basic Auth must be built server-side from the stored password'
    );
    const body = JSON.parse(last.body);
    assert.equal(body.event_id, 124);
    assert.equal(body.type, 'API_TEST');
    assert.equal(body.name, 'Nguyễn Văn A');
    assert.match(body.custom_fields.lk_number, /^\d{4}$/);
    assert.equal(body.custom_fields.phone, '0922222222');
  });

  await check('the qrcode returned by the API is stored for the next update', async () => {
    const state = await call('/api/admin/state', { token });
    const g = state.json.guests.find((x) => x.data.phone === '0922222222');
    assert.equal(g.remoteQrcode, 'DELFI-QR-9');

    received.length = 0;
    await call('/api/guests', {
      method: 'POST',
      body: { eventId: events[0].id, data: { ...g.data, position: 'CTO' }, replaceId: g.id }
    });
    const sent = JSON.parse(received[received.length - 1].body);
    assert.equal(sent.qrcode, 'DELFI-QR-9', 'an update must carry the remote id, not create a duplicate client');
  });

  await check('a bad body template is caught before anything is sent', async () => {
    const state = await call('/api/admin/state', { token });
    const evs = state.json.events;
    const good = evs[0].api.bodyTemplate;
    evs[0].api.bodyTemplate = '{ "name": "{{name}}", }';  // trailing comma
    await call('/api/admin/events', { method: 'PUT', body: { events: evs }, token });

    received.length = 0;
    const r = await call('/api/admin/events/' + events[0].id + '/test', { method: 'POST', token });
    assert.equal(received.length, 0, 'invalid JSON must never reach the endpoint');
    assert.equal(r.json.result.ok, false);
    assert.match(r.json.result.line, /JSON hợp lệ/);

    evs[0].api.bodyTemplate = good;
    await call('/api/admin/events', { method: 'PUT', body: { events: evs }, token });
  });

  await check('admin sees the API config but never the password', async () => {
    const r = await call('/api/admin/state', { token });
    assert.equal(r.status, 200);
    const ev = r.json.events[0];
    assert.equal(ev.api.url, fakeUrl); // repointed above; ships pointing at checkin.delfi.vn
    assert.equal(ev.api.auth.username, 'demo');
    assert.equal(ev.api.headers['User-Agent'], 'ApiPortal');
    assert.equal(ev.api.auth.password, null, 'password must be withheld');
    assert.equal(ev.api.auth.hasPassword, true, 'but the admin must see that one is set');
    assert.ok(!JSON.stringify(r.json).includes('seeded-pw'), 'password leaked in /api/admin/state');
  });

  await check('saving events with password:null keeps the stored password', async () => {
    const state = await call('/api/admin/state', { token });
    const evs = state.json.events;
    evs[0].name = 'ĐỔI TÊN THỬ';
    const put = await call('/api/admin/events', { method: 'PUT', body: { events: evs }, token });
    assert.equal(put.status, 200);
    assert.equal(put.json.events[0].name, 'ĐỔI TÊN THỬ');
    assert.equal(put.json.events[0].api.auth.hasPassword, true, 'a rename must not wipe the credential');

    const disk = JSON.parse(fs.readFileSync(TMP, 'utf8'));
    assert.equal(disk.events[0].api.auth.password, 'seeded-pw');
  });

  await check('typing a new password replaces it', async () => {
    const state = await call('/api/admin/state', { token });
    const evs = state.json.events;
    evs[0].api.auth.password = 'rotated-pw';
    await call('/api/admin/events', { method: 'PUT', body: { events: evs }, token });
    const disk = JSON.parse(fs.readFileSync(TMP, 'utf8'));
    assert.equal(disk.events[0].api.auth.password, 'rotated-pw');
  });

  await check('deleting a guest removes it from the shared store', async () => {
    const before = (await call('/api/admin/state', { token })).json.guests.length;
    await call('/api/admin/guests/' + guest.id, { method: 'DELETE', token });
    const after = (await call('/api/admin/state', { token })).json.guests;
    assert.equal(after.length, before - 1);
    assert.ok(!after.find((g) => g.id === guest.id));
  });

  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));

  /* ============ part 2: API body template ============ */
  const Shared = require('./shared');

  await check('placeholders render into valid JSON even with quotes in a name', async () => {
    const ev = {
      id: 'e1', name: 'Sự kiện', inputs: [{ key: 'name' }, { key: 'phone' }, { key: 'email' }],
      api: {}
    };
    const payload = Shared.buildPayload(ev, {
      name: 'Trần "Bo" An\\Lê', phone: '0900', email: 'a@x.vn', position: 'CEO', company: 'ACME', title: 'Ông'
    });
    const tpl = `{
      "qrcode": "{{qrcode}}",
      "event_id": 124,
      "name": "{{name}}",
      "email": "{{email}}",
      "type": "API_TEST",
      "custom_fields": {
        "position": "{{position}}", "company": "{{company}}", "title": "{{title}}",
        "phone": "{{phone}}", "lk_number": "{{lucky}}"
      }
    }`;
    const out = Shared.renderApiBody(tpl, Shared.apiContext(ev, payload));
    const parsed = JSON.parse(out); // must not throw — this is the whole point
    assert.equal(parsed.name, 'Trần "Bo" An\\Lê');
    assert.equal(parsed.event_id, 124);
    assert.equal(parsed.qrcode, '', 'blank qrcode means "create" for Delfi');
    assert.equal(parsed.custom_fields.lk_number, payload.computed.lucky);
    assert.equal(parsed.custom_fields.phone, '0900');
  });

  await check('a known remote qrcode is sent back so Delfi updates instead of duplicating', async () => {
    const ev = { id: 'e1', name: 'X', inputs: [] };
    const payload = Shared.buildPayload(ev, { name: 'A', phone: '1' }, { remoteQrcode: 'QR-123' });
    const out = Shared.renderApiBody('{"qrcode":"{{qrcode}}"}', Shared.apiContext(ev, payload));
    assert.equal(JSON.parse(out).qrcode, 'QR-123');
  });

  await check('unknown placeholders become empty rather than breaking the JSON', async () => {
    const ev = { id: 'e1', name: 'X', inputs: [] };
    const payload = Shared.buildPayload(ev, { name: 'A', phone: '1' });
    const out = Shared.renderApiBody('{"a":"{{nope}}"}', Shared.apiContext(ev, payload));
    assert.equal(JSON.parse(out).a, '');
  });

  /* ============ part 3: client rendering ============ */
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
  const src = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    .match(/<script>\n([\s\S]*?)\n<\/script>/)[1];
  const client = new Function(
    ...Object.keys(env),
    `${src}\nreturn {S,esc,homeView,cardView,lookupView,loginView,adminView,editorView,apiPanel,guestModal,textToHeaders,headersToText};`
  )(...Object.values(env));

  await new Promise((r) => setImmediate(r)); // let the failed boot settle
  const C = client.S;

  await check('client survives a dead server instead of rendering a blank page', async () => {
    assert.ok(C.bootErr.includes('Không kết nối được'));
  });

  await check('every screen renders without throwing', async () => {
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
    assert.ok(ed.includes('checkin.delfi.vn'), 'configured URL should be visible to the admin');
    assert.ok(ed.includes('{{lucky}}'), 'placeholder help must list the derived tokens');
  });

  await check('the lookup page requires an event before searching', async () => {
    C.lookupEventId = ''; C.lookupName = 'A'; C.lookupPhone = '1';
    await client.lookupView; // view is pure; the guard lives in doLookup
    C.lookupEventId = C.events[0].id;
    assert.ok(client.lookupView().includes('Tìm thiệp của tôi'));
  });

  await check('header text round-trips through the config editor', async () => {
    const h = { 'Content-Type': 'application/json', 'User-Agent': 'ApiPortal' };
    assert.deepEqual(client.textToHeaders(client.headersToText(h)), h);
    assert.deepEqual(client.textToHeaders('A: 1\n\nbad line\nB: 2'), { A: '1', B: '2' });
  });

  await check('guest-supplied text is escaped everywhere it is rendered', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    C.guests = [{ ...C.guests[0], id: 'x1', data: { ...C.guests[0].data, name: evil }, computed: { ...C.guests[0].computed, fullNameDisplay: evil } }];
    C.adminTab = 'guests';
    const admin = client.adminView().toLowerCase();
    assert.ok(!admin.includes('<img'), 'raw markup leaked into the admin list');
    assert.ok(admin.includes('&lt;img'));

    C.viewGuest = C.guests[0];
    const modal = client.guestModal().toLowerCase();
    assert.ok(!modal.includes('<img'), 'raw markup leaked into the payload modal');
    C.viewGuest = null;
    assert.equal(client.esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
  });

  fs.rmSync(TMP, { force: true });
  console.log(`\n${n} checks passed`);
})().catch((e) => {
  fs.rmSync(TMP, { force: true });
  console.error('\nFAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
