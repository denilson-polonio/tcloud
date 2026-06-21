'use strict';
const crypto = require('crypto');
const db = require('./db');


function normUsername(u) { return String(u || '').trim().replace(/^@/, '').toLowerCase(); }

function add({ username, folderId, days, invitedBy }) {
  username = normUsername(username);
  if (!/^[a-z0-9_]{4,32}$/.test(username)) throw new Error('Invalid Telegram username (4-32 chars: letters, numbers, _)');
  const expiresAt = days > 0 ? Date.now() + days * 86400000 : null;
  const existing = db.prepare('SELECT id FROM tdrop_guests WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE tdrop_guests SET folder_id=?, expires_at=?, invited_by=? WHERE id=?')
      .run(folderId || null, expiresAt, invitedBy, existing.id);
    return get(existing.id);
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO tdrop_guests (id, username, telegram_id, folder_id, invited_by, expires_at, uploads, created_at, linked_at)
              VALUES (?,?,NULL,?,?,?,0,?,NULL)`).run(id, username, folderId || null, invitedBy, expiresAt, Date.now());
  return get(id);
}
function get(id) { return db.prepare('SELECT * FROM tdrop_guests WHERE id = ?').get(id); }
function list() { return db.prepare('SELECT * FROM tdrop_guests ORDER BY created_at DESC').all().map((g) => ({ ...g, active: isActive(g) })); }
function remove(id) { db.prepare('DELETE FROM tdrop_guests WHERE id = ?').run(id); }
function isActive(g) { return !!g && (g.expires_at == null || g.expires_at > Date.now()); }

function match(telegramId, username) {
  let g = db.prepare('SELECT * FROM tdrop_guests WHERE telegram_id = ?').get(String(telegramId));
  if (!g && username) {
    g = db.prepare('SELECT * FROM tdrop_guests WHERE username = ?').get(normUsername(username));
    if (g && !g.telegram_id) { db.prepare('UPDATE tdrop_guests SET telegram_id=?, linked_at=? WHERE id=?').run(String(telegramId), Date.now(), g.id); g = get(g.id); }
  }
  return g || null;
}
function bumpUploads(id) { db.prepare('UPDATE tdrop_guests SET uploads = uploads + 1 WHERE id = ?').run(id); }

module.exports = { add, get, list, remove, isActive, match, bumpUploads, normUsername };
