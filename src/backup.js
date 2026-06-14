'use strict';
const zlib = require('zlib');
const crypto = require('crypto');
const db = require('./db');
const tg = require('./telegram');
const settings = require('./settings');

const MAGIC = Buffer.from('TCBK1'); // plaintext gz   header
const MAGIC_ENC = Buffer.from('TCBKE'); // encrypted gz header
const TABLES = ['settings', 'roles', 'users', 'folders', 'files', 'chunks', 'shares'];

/* Build a full JSON snapshot of the database (sessions are intentionally skipped). */
function exportObject() {
  const tables = {};
  for (const t of TABLES) tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
  return { version: 1, exportedAt: Date.now(), tables };
}

/* Serialize → gzip (+ optional AES-256-GCM encryption with a passphrase). */
function serialize(obj, passphrase) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (!passphrase) return Buffer.concat([MAGIC, gz]);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(passphrase), salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(gz), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC_ENC, salt, iv, tag, enc]);
}

function deserialize(buf, passphrase) {
  if (buf.subarray(0, 5).equals(MAGIC)) {
    return JSON.parse(zlib.gunzipSync(buf.subarray(5)).toString());
  }
  if (buf.subarray(0, 5).equals(MAGIC_ENC)) {
    if (!passphrase) { const e = new Error('This backup is encrypted: passphrase required'); e.code = 'ENC'; throw e; }
    const salt = buf.subarray(5, 21), iv = buf.subarray(21, 33), tag = buf.subarray(33, 49), enc = buf.subarray(49);
    const key = crypto.scryptSync(String(passphrase), salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let gz;
    try { gz = Buffer.concat([decipher.update(enc), decipher.final()]); }
    catch (_) { const e = new Error('Wrong passphrase or corrupted backup'); e.code = 'ENC'; throw e; }
    return JSON.parse(zlib.gunzipSync(gz).toString());
  }
  throw new Error('Unrecognized backup file');
}

/* Replace the entire database contents with the snapshot. */
function importObject(obj, { keepBotConfig } = {}) {
  if (!obj || !obj.tables) throw new Error('Invalid backup');
  // Preserve current Telegram config if requested (so a metadata-only restore
  // does not clobber a working token/channel on this instance).
  const preserved = {};
  if (keepBotConfig) {
    for (const k of ['bot_token', 'storage_channel', 'api_root', 'chunk_size_mb']) preserved[k] = settings.getRaw(k);
  }

  db.pragma('foreign_keys = OFF');
  try {
    const run = db.transaction(() => {
      for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
      for (const t of TABLES) {
        const rows = obj.tables[t] || [];
        if (!Array.isArray(rows) || !rows.length) continue;
        // Only accept columns that actually exist in this table: this both makes the
        // import tolerant of schema changes AND stops a crafted backup from smuggling
        // SQL through column names (the names are interpolated into the INSERT).
        const valid = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
        const cols = Object.keys(rows[0]).filter((c) => valid.has(c));
        if (!cols.length) continue;
        const stmt = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
        for (const r of rows) stmt.run(...cols.map((c) => r[c]));
      }
      if (keepBotConfig) {
        for (const [k, v] of Object.entries(preserved)) {
          if (v === undefined) continue;
          db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
        }
      }
    });
    run();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/* ── Channel-side disaster recovery ──────────────────────────────── */
async function pushToChannel(passphrase) {
  const buf = serialize(exportObject(), passphrase);
  const name = `tcloud-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.tcb`;
  const r = await tg.sendBackup(buf, name, `TCloud backup • ${new Date().toUTCString()}${passphrase ? ' • encrypted' : ''}`);
  await tg.pinMessage(r.message_id);
  settings.setRaw('last_backup_at', String(Date.now()));
  settings.setRaw('last_backup_msg', String(r.message_id));
  return { messageId: r.message_id, size: buf.length, encrypted: !!passphrase };
}

async function restoreFromChannel(passphrase) {
  const pin = await tg.getPinnedBackup();
  if (!pin) throw new Error('No pinned backup found in the channel');
  const buf = await tg.downloadChunk(pin.file_id);
  const obj = deserialize(buf, passphrase);
  importObject(obj, { keepBotConfig: true });
  return { restoredAt: Date.now(), from: pin.name };
}

module.exports = { exportObject, serialize, deserialize, importObject, pushToChannel, restoreFromChannel };
