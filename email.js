'use strict';

const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');
const { Resend } = require('resend');

const PUBLIC_ROOT = path.join(__dirname, 'public');

const escapeHtml = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const defaultEmailTemplates = () => [
  {
    id: 'invitation', type: 'invitation', name: 'Thư mời', enabled: true,
    subject: 'Thư mời tham dự {{eventName}}',
    mode: 'attachments',
    html: '<p>Xin chào {{fullNameDisplay}},</p><p>Trân trọng kính mời bạn tham dự <b>{{eventName}}</b>.</p><p>Vui lòng xem thiệp mời và mã QR check-in đính kèm email.</p><p>Trân trọng.</p>'
  },
  {
    id: 'reminder', type: 'reminder', name: 'Reminder', enabled: false,
    subject: 'Nhắc lịch tham dự {{eventName}}',
    mode: 'inline',
    html: '<p>Xin chào {{fullNameDisplay}},</p><p>Đây là email nhắc lịch tham dự <b>{{eventName}}</b>.</p><p>{{cardImage}}</p><p>Vui lòng sử dụng mã QR dưới đây để check-in:</p><p>{{qrImage}}</p>'
  }
];

const defaultEmail = () => ({
  enabled: false,
  sendOnRegister: false,
  from: '',
  replyTo: '',
  templates: defaultEmailTemplates()
});

function normalizeEmail(email) {
  const e = email && typeof email === 'object' ? email : {};
  const templates = Array.isArray(e.templates) && e.templates.length ? e.templates : defaultEmailTemplates();
  return {
    ...defaultEmail(), ...e,
    templates: templates.map((t) => ({
      id: String(t.id || 'template-' + Math.random().toString(36).slice(2, 8)),
      type: t.type === 'reminder' ? 'reminder' : 'invitation',
      name: String(t.name || 'Email'),
      enabled: t.enabled !== false,
      subject: String(t.subject || ''),
      mode: t.mode === 'inline' ? 'inline' : 'attachments',
      html: String(t.html || '')
    }))
  };
}

function payloadContext(ev, payload) {
  return {
    ...(payload.data || {}), ...(payload.computed || {}),
    fullNameDisplay: payload.computed?.fullNameDisplay || payload.data?.name || '',
    eventName: ev.name || '',
    recordId: payload.id || '',
    createdAt: payload.createdAt || '',
    qrContent: payload.computed?.qrContent || '',
    qrcode: payload.remoteQrcode || ''
  };
}

function renderText(template, context) {
  return String(template || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => escapeHtml(context[key] == null ? '' : context[key]));
}

function bgDataUrl(bg) {
  if (!bg) return '';
  if (bg.startsWith('data:')) return bg;
  if (!bg.startsWith('/')) return '';
  const file = path.join(PUBLIC_ROOT, bg.slice(1));
  if (!file.startsWith(PUBLIC_ROOT + path.sep) || !fs.existsSync(file)) return '';
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

async function invitationAssets(ev, payload) {
  const context = payloadContext(ev, payload);
  const qrPng = await QRCode.toDataURL(context.qrContent || context.recordId || ev.id, { width: 640, margin: 1 });
  const qrBase64 = qrPng.split(',')[1];
  const bg = bgDataUrl(ev.bg);
  const textFields = (ev.fields || []).filter((f) => f.type === 'static' || f.type === 'bind').map((f) => {
    const text = f.type === 'static' ? f.text : (f.prefix || '') + (context[f.bind] || '');
    if (!text) return '';
    return `<text x="${Number(f.x) || 0}" y="${(Number(f.y) || 0) + (Number(f.size) || 24) * .75}" fill="${escapeHtml(f.color || '#fff')}" font-family="${escapeHtml(f.font || 'Arial')}" font-size="${Number(f.size) || 24}" font-weight="${escapeHtml(f.weight || '400')}" text-anchor="${f.align === 'left' ? 'start' : f.align === 'right' ? 'end' : 'middle'}">${escapeHtml(f.upper ? text.toUpperCase() : text)}</text>`;
  }).join('');
  const qrFields = (ev.fields || []).filter((f) => f.type === 'qr').map((f) => {
    const size = Number(f.size) || 300;
    return `<image href="${qrPng}" x="${(Number(f.x) || 0) - size / 2}" y="${Number(f.y) || 0}" width="${size}" height="${size}" preserveAspectRatio="none"/>`;
  }).join('');
  const cardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ev.w}" height="${ev.h}" viewBox="0 0 ${ev.w} ${ev.h}">${bg ? `<image href="${bg}" width="${ev.w}" height="${ev.h}" preserveAspectRatio="none"/>` : ''}${textFields}${qrFields}</svg>`;
  return { qrPng, qrBase64, cardBase64: Buffer.from(cardSvg).toString('base64') };
}

async function sendEventEmail(ev, payload, templateId) {
  if (!process.env.RESEND_API_KEY) throw new Error('Thiếu RESEND_API_KEY trên server.');
  const to = String(payload.data?.email || '').trim();
  if (!to) throw new Error('Khách chưa có email.');
  const cfg = normalizeEmail(ev.email);
  const template = cfg.templates.find((t) => t.id === templateId) || cfg.templates[0];
  if (!template) throw new Error('Sự kiện chưa có template email.');

  const assets = await invitationAssets(ev, payload);
  const context = payloadContext(ev, payload);
  const inline = template.mode === 'inline';
  context.cardImage = inline ? '<img alt="Thiệp mời" style="max-width:100%;height:auto" src="cid:invitation-card">' : '<p>Thiệp mời được đính kèm email.</p>';
  context.qrImage = inline ? '<img alt="QR check-in" width="320" src="cid:qr-code">' : '<p>Mã QR check-in được đính kèm email.</p>';
  const html = String(template.html || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => context[key] == null ? '' : (key === 'cardImage' || key === 'qrImage' ? context[key] : escapeHtml(context[key])));
  const attachments = inline
    ? [{ content: assets.cardBase64, filename: 'thiep-moi.svg', contentId: 'invitation-card' }, { content: assets.qrBase64, filename: 'qrcode.png', contentId: 'qr-code' }]
    : [{ content: assets.cardBase64, filename: 'thiep-moi.svg' }, { content: assets.qrBase64, filename: 'qrcode.png' }];

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: cfg.from || process.env.RESEND_FROM || 'onboarding@resend.dev',
    ...(cfg.replyTo || process.env.RESEND_REPLY_TO ? { replyTo: cfg.replyTo || process.env.RESEND_REPLY_TO } : {}),
    to: [to], subject: renderText(template.subject, context), html, attachments,
    headers: { 'X-Event-Id': String(ev.id), 'X-Email-Template': String(template.id) }
  });
  if (error) throw new Error(error.message || JSON.stringify(error));
  return { id: data && data.id, to, templateId: template.id };
}

module.exports = { defaultEmail, normalizeEmail, defaultEmailTemplates, sendEventEmail };
