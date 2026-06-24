'use strict';
const settings = require('./settings');
const tg = require('./telegram');
const db = require('./db');

const EVENTS = ['upload_done', 'upload_failed', 'share_download', 'guest_join'];

function getConfig() {
  let c = {};
  try { c = JSON.parse(settings.getRaw('notifications') || '{}'); } catch (_) { c = {}; }
  const out = {};
  for (const e of EVENTS) out[e] = !!c[e];
  return out;
}

function setConfig(obj) {
  const clean = {};
  for (const e of EVENTS) clean[e] = !!(obj && obj[e]);
  settings.setRaw('notifications', JSON.stringify(clean));
  return clean;
}

function ownerChat() {
  try { const o = db.prepare('SELECT telegram_id FROM users WHERE is_owner = 1 LIMIT 1').get(); return o && o.telegram_id ? o.telegram_id : null; } catch (_) { return null; }
}

function notify(event, text) {
  (async () => {
    try {
      if (!getConfig()[event]) return;
      if (!tg.isReady()) return;
      const chat = ownerChat();
      if (!chat) return;
      await tg.sendMessage(chat, text);
    } catch (_) {}
  })();
}

module.exports = { EVENTS, getConfig, setConfig, notify };
