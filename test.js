// Self-check for index.html — run with `node test.js`.
// Extracts the app's inline <script> and drives it against a minimal DOM stub,
// so the thing under test is always the file that actually ships.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
  .match(/<script>\n([\s\S]*?)\n<\/script>/)[1];

/* ---- DOM stub: only what render()/paint() touch ---- */
const node = () => ({
  innerHTML: '', style: {}, dataset: {}, clientWidth: 540,
  addEventListener() {}, querySelector: () => null, focus() {}, setSelectionRange() {}
});
const app = node();
const store = new Map();
const env = {
  document: {
    activeElement: null,
    fonts: { load: () => Promise.resolve() },
    querySelector: (sel) => (sel === '#app' ? app : null),
    createElement: () => ({ ...node(), click() {}, getContext: () => ({}) })
  },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k)
  },
  window: { qrcode: null },
  navigator: {},
  Image: function () {},
  addEventListener() {},
  alert() {}, prompt: () => null, confirm: () => true,
  fetch: () => Promise.reject(new Error('offline'))
};

const exported = 'S,buildPayload,samplePayload,submit,finalize,render,go,esc,' +
  'homeView,cardView,loginView,adminView,editorView,guestModal,inspector,addField,newTextField,fieldName';
const api = new Function(
  ...Object.keys(env),
  `${src}\nreturn {${exported}};`
)(...Object.values(env));

const { S, buildPayload, samplePayload, submit, finalize, esc } = api;
let n = 0;
const check = (name, fn) => { fn(); n++; console.log('  ok', name); };

/* ---- seed ---- */
check('seeds 3 events and persists them', () => {
  assert.equal(S.events.length, 3);
  assert.equal(JSON.parse(store.get('ecard.events')).length, 3);
  assert.equal(S.selEventId, S.events[0].id);
});

/* ---- payload determinism: a reprinted card must carry the same QR ---- */
check('lucky number + QR are a pure function of name+phone', () => {
  const ev = S.events[0];
  const a = buildPayload(ev, { title: 'Ông', name: 'Nguyễn Văn A', phone: '12345' });
  const b = buildPayload(ev, { title: 'Ông', name: 'Nguyễn Văn A', phone: '12345' });
  const c = buildPayload(ev, { title: 'Ông', name: 'Nguyễn Văn A', phone: '99999' });
  assert.equal(a.computed.lucky, b.computed.lucky);
  assert.equal(a.computed.qrContent, b.computed.qrContent);
  assert.notEqual(a.computed.lucky, c.computed.lucky);
  assert.match(a.computed.lucky, /^\d{4}$/);
  assert.equal(a.computed.fullNameDisplay, 'ÔNG NGUYỄN VĂN A');
  assert.equal(a.computed.qrContent, `CHECKIN|${ev.id}|Nguyễn Văn A|12345|${a.computed.lucky}`);
  assert.notEqual(a.id, b.id); // record ids stay unique
});

check('sample payload fills every declared input', () => {
  const p = samplePayload(S.events[0]);
  for (const i of S.events[0].inputs) assert.ok(p.data[i.key] !== undefined, i.key);
  assert.equal(p.data.title, 'Ông');          // select -> first option
  assert.equal(p.data.name, 'NGUYỄN VĂN A');  // text -> placeholder minus the "VD:" lead-in
});

/* ---- form validation ---- */
check('required fields block submit', () => {
  S.formValues = { title: 'Ông', name: '   ' };
  submit();
  assert.match(S.formErr, /Họ và tên/);
  assert.equal(S.guests.length, 0);
  assert.equal(S.view, 'home');
});

check('missing event blocks submit', () => {
  const keep = S.selEventId;
  S.selEventId = '';
  submit();
  assert.match(S.formErr, /chọn sự kiện/i);
  S.selEventId = keep;
});

/* ---- happy path ---- */
check('valid submit stores the guest and shows the card', () => {
  S.formValues = { title: 'Ông', name: 'Nguyễn Văn A', phone: '12345', company: 'NAM VIỆT' };
  submit();
  assert.equal(S.formErr, '');
  assert.equal(S.view, 'card');
  assert.equal(S.guests.length, 1);
  assert.equal(S.card.payload.computed.fullNameDisplay, 'ÔNG NGUYỄN VĂN A');
  assert.equal(JSON.parse(store.get('ecard.guests')).length, 1);
});

/* ---- duplicate handling ---- */
check('same name on same event raises the dupe prompt, not a second record', () => {
  S.view = 'home';
  S.formValues = { title: 'Bà', name: '  nguyễn văn a  ', phone: '55555' };
  submit();
  assert.ok(S.dupe, 'expected dupe prompt');
  assert.equal(S.dupe.matches.length, 1);
  assert.equal(S.guests.length, 1);
});

check('replacing overwrites in place; creating adds', () => {
  finalize(S.dupe.payload, S.dupe.checkedId);
  assert.equal(S.guests.length, 1);
  assert.equal(S.guests[0].data.phone, '55555');
  assert.equal(S.dupe, null);

  S.view = 'home';
  S.formValues = { title: 'Ông', name: 'Nguyễn Văn A', phone: '77777' };
  submit();
  finalize(S.dupe.payload, null);
  assert.equal(S.guests.length, 2);
});

check('same name under a different event is not a duplicate', () => {
  S.view = 'home';
  S.selEventId = S.events[1].id;
  S.formValues = { title: 'Ông', name: 'Nguyễn Văn A', phone: '12345' };
  submit();
  assert.equal(S.dupe, null);
  assert.equal(S.guests.length, 3);
  S.selEventId = S.events[0].id;
});

/* ---- every screen renders ---- */
check('all screens render without throwing', () => {
  assert.ok(api.homeView().includes('Tạo thiệp online'));
  assert.ok(api.cardView().includes('Tải ảnh về'));
  assert.ok(api.loginView().includes('Đăng nhập'));
  for (const tab of ['events', 'guests', 'webhook']) {
    S.adminTab = tab;
    assert.ok(api.adminView().length > 100, tab);
  }
  S.adminTab = 'events';
  api.go('home');
});

/* ---- editor ---- */
check('editor adds, selects and removes card components', () => {
  const ev = structuredClone(S.events[0]);
  const before = ev.fields.length;
  api.go('editor', { editor: { ev, sel: null } });

  const f = api.newTextField({ type: 'static', text: 'Nội dung mới' });
  api.addField(f);
  assert.equal(ev.fields.length, before + 1);
  assert.equal(S.editor.sel, f.id);

  const html = api.editorView();
  assert.ok(html.includes('THUỘC TÍNH'), 'inspector should show for the selection');
  assert.ok(html.includes('Nội dung mới'));
  assert.ok(api.inspector(ev, f).includes('Nội dung chữ'));
  assert.ok(api.inspector(ev, ev.fields.find((x) => x.type === 'qr')).includes('Cỡ QR'));

  // cancelling must not touch the saved event
  api.go('admin', { editor: null });
  assert.equal(S.events[0].fields.length, before);
});

check('field labels stay readable for each component type', () => {
  assert.equal(api.fieldName({ type: 'qr' }), '▣ QR check-in');
  assert.equal(api.fieldName({ type: 'bind', bind: 'lucky' }), '⤷ Lucky Number');
  assert.equal(api.fieldName({ type: 'static', text: 'Xin chào' }), '“Xin chào”');
});

/* ---- trust boundary: guest text is rendered into admin HTML ---- */
check('guest-supplied text is escaped everywhere it is rendered', () => {
  const evil = '<img src=x onerror=alert(1)>';
  S.view = 'home';
  S.selEventId = S.events[2].id;
  S.formValues = { title: 'Ông', name: evil, phone: '11111' };
  submit();

  S.adminTab = 'guests';
  const admin = api.adminView().toLowerCase(); // list shows the UPPERCASED display name
  assert.ok(!admin.includes('<img'), 'raw markup leaked into the admin list');
  assert.ok(admin.includes('&lt;img'), 'expected escaped form');

  S.viewGuest = S.guests[S.guests.length - 1];
  const modal = api.guestModal();
  assert.ok(!modal.includes('<img'), 'raw markup leaked into the payload modal');
  assert.ok(modal.includes('&lt;img'), 'expected escaped form');
  S.viewGuest = null;

  assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
  S.adminTab = 'events';
});

console.log(`\n${n} checks passed`);
