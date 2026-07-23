// Loaded by both server.js (require) and the browser (<script src="/shared.js">).
// Anything the server treats as authoritative lives here so the client's preview
// can't drift from what actually gets stored and sent.
(function (root) {
  'use strict';

  function hash(s) {
    let h = 0;
    for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  // Guests are matched on name within one event, case- and spacing-insensitive.
  const normName = (x) => String(x == null ? '' : x).trim().toLowerCase().replace(/\s+/g, ' ');

  function buildPayload(ev, data, base) {
    const name = data.name || '', title = data.title || '';
    const lucky = 1000 + hash((name + '|' + (data.phone || '')).toLowerCase()) % 9000;
    return {
      id: (base && base.id) || null,
      eventId: ev.id,
      eventName: ev.name,
      createdAt: (base && base.createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data,
      computed: {
        fullNameDisplay: ((title ? title + ' ' : '') + name).toUpperCase().trim(),
        lucky: String(lucky),
        qrContent: 'CHECKIN|' + ev.id + '|' + name + '|' + (data.phone || '') + '|' + lucky
      },
      // filled from the integration's response so a later edit updates the same
      // remote client instead of creating a duplicate one
      remoteQrcode: (base && base.remoteQrcode) || '',
      source: 'event-card-app'
    };
  }

  function samplePayload(ev) {
    const data = {};
    for (const i of ev.inputs || []) {
      data[i.key] = i.type === 'select'
        ? (i.options && i.options[0]) || ''
        : String(i.placeholder || i.label || '').replace(/^VD:\s*/i, '');
    }
    return buildPayload(ev, data);
  }

  // Values available to {{placeholders}} in an event's API body template.
  function apiContext(ev, payload) {
    return {
      ...(payload.data || {}),
      ...(payload.computed || {}),
      qrcode: payload.remoteQrcode || '',
      recordId: payload.id || '',
      eventName: ev.name || '',
      createdAt: payload.createdAt || ''
    };
  }

  // Placeholders sit inside JSON string literals, so substitute a JSON-escaped
  // value (quotes/backslashes/newlines) WITHOUT the surrounding quotes. A guest
  // named  Trần "Bo" An  would otherwise produce invalid JSON.
  function renderApiBody(tpl, ctx) {
    return String(tpl == null ? '' : tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
      const v = ctx[key];
      return v == null ? '' : JSON.stringify(String(v)).slice(1, -1);
    });
  }

  // The tokens an admin can use, shown as help text under the template editor.
  function apiPlaceholders(ev) {
    return [
      ...(ev.inputs || []).map((i) => i.key),
      'fullNameDisplay', 'lucky', 'qrContent', 'qrcode', 'recordId', 'eventName', 'createdAt'
    ];
  }

  root.hash = hash;
  root.normName = normName;
  root.buildPayload = buildPayload;
  root.samplePayload = samplePayload;
  root.apiContext = apiContext;
  root.renderApiBody = renderApiBody;
  root.apiPlaceholders = apiPlaceholders;
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.Shared = {}));
