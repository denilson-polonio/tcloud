'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const tg = require('./telegram');
const settings = require('./settings');

/* ──────────────────────────── Folders ──────────────────────────── */
function getFolder(id) { return db.prepare('SELECT * FROM folders WHERE id = ?').get(id); }
function ownsFolder(userId, id) { const f = getFolder(id); return !!f && f.owner_id === userId; }

function getTDropFolderId(ownerId) {
  let f = db.prepare('SELECT id FROM folders WHERE owner_id = ? AND system = 1').get(ownerId);
  if (!f) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO folders (id, name, parent_id, owner_id, system, created_at) VALUES (?,?,?,?,1,?)').run(id, 'TDrop', null, ownerId, Date.now());
    return id;
  }
  return f.id;
}
function createFolder(name, parentId, ownerId) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO folders (id, name, parent_id, owner_id, system, created_at) VALUES (?,?,?,?,0,?)').run(id, name, parentId || null, ownerId, Date.now());
  return getFolder(id);
}
function listFolders(parentId, ownerId) {
  if (parentId == null) return db.prepare('SELECT * FROM folders WHERE parent_id IS NULL AND owner_id = ? AND system = 0 ORDER BY name COLLATE NOCASE').all(ownerId);
  return db.prepare('SELECT * FROM folders WHERE parent_id = ? AND owner_id = ? ORDER BY name COLLATE NOCASE').all(parentId, ownerId);
}
function renameFolder(id, name) { db.prepare('UPDATE folders SET name = ? WHERE id = ? AND system = 0').run(name, id); }
function moveFolder(id, parentId) { db.prepare('UPDATE folders SET parent_id = ? WHERE id = ? AND system = 0').run(parentId || null, id); }
function setFolderNote(id, note) { const f = getFolder(id); if (!f || f.system) return; db.prepare('UPDATE folders SET note = ? WHERE id = ?').run(note ? String(note) : null, id); }
function setFolderAppearance(id, color, icon, shadow) { const f = getFolder(id); if (!f || f.system) return; db.prepare('UPDATE folders SET color = ?, icon = ?, shadow = ? WHERE id = ?').run(color == null ? f.color : (color || null), icon == null ? f.icon : (icon || null), shadow == null ? (f.shadow || 0) : (shadow ? 1 : 0), id); }
async function deleteFolder(id) { for (const f of allFilesUnder(id)) await purgeFileChunks(f.id); db.prepare('DELETE FROM folders WHERE id = ? AND system = 0').run(id); }
function allFilesUnder(folderId) {
  const out = [], stack = [folderId];
  while (stack.length) { const fid = stack.pop(); out.push(...db.prepare('SELECT id FROM files WHERE folder_id = ?').all(fid)); for (const s of db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(fid)) stack.push(s.id); }
  return out;
}
function folderPath(id) { const out = []; let cur = id; while (cur) { const f = getFolder(cur); if (!f) break; out.unshift({ id: f.id, name: f.name, system: f.system }); cur = f.parent_id; } return out; }
function folderTree(ownerId) {
  const all = db.prepare('SELECT id, name, parent_id, system FROM folders WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(ownerId);
  const byParent = {}; for (const f of all) (byParent[f.parent_id || 'root'] ||= []).push(f);
  const build = (pid) => (byParent[pid] || []).filter((f) => !f.system).map((f) => ({ id: f.id, name: f.name, children: build(f.id) }));
  return build('root');
}
function isWithin(folderId, ancestorId) { let cur = folderId; while (cur) { if (cur === ancestorId) return true; const f = getFolder(cur); if (!f) break; cur = f.parent_id; } return false; }

/* ───────────────────────────── Files ───────────────────────────── */
function getFile(id) { return db.prepare('SELECT * FROM files WHERE id = ?').get(id); }
function ownsFile(userId, id) { const f = getFile(id); return !!f && f.owner_id === userId; }
function listFiles(folderId, ownerId) {
  if (folderId == null) return db.prepare('SELECT * FROM files WHERE folder_id IS NULL AND owner_id = ? ORDER BY name COLLATE NOCASE').all(ownerId);
  return db.prepare('SELECT * FROM files WHERE folder_id = ? AND owner_id = ? ORDER BY name COLLATE NOCASE').all(folderId, ownerId);
}
function listStarred(ownerId) { return db.prepare('SELECT * FROM files WHERE owner_id = ? AND starred = 1 ORDER BY name COLLATE NOCASE').all(ownerId); }
function renameFile(id, name) { db.prepare('UPDATE files SET name = ? WHERE id = ?').run(name, id); }
function moveFile(id, folderId) { db.prepare('UPDATE files SET folder_id = ? WHERE id = ?').run(folderId || null, id); }
function setMeta(id, m) { db.prepare('UPDATE files SET meta = ? WHERE id = ?').run(JSON.stringify(m || {}), id); }
function setStar(id, v) { db.prepare('UPDATE files SET starred = ? WHERE id = ?').run(v ? 1 : 0, id); }
async function purgeFileChunks(fileId) { for (const c of db.prepare('SELECT message_id FROM chunks WHERE file_id = ?').all(fileId)) await tg.deleteMessage(c.message_id); const f = db.prepare('SELECT staged_path FROM files WHERE id = ?').get(fileId); if (f && f.staged_path) { try { fs.unlinkSync(f.staged_path); } catch (_) {} } }
async function deleteFile(id) { await purgeFileChunks(id); db.prepare('DELETE FROM files WHERE id = ?').run(id); }
function usedStorage(ownerId) { return db.prepare('SELECT COALESCE(SUM(size),0) s FROM files WHERE owner_id = ?').get(ownerId).s; }
function assertQuota(user, incoming) { if (!user || !user.quota) return; if (usedStorage(user.id) + incoming > user.quota) { const e = new Error('Quota exceeded'); e.code = 'QUOTA'; throw e; } }

/* ─────────────────────────── Upload / stream ───────────────────── */
/* ── At-rest encryption (AES-256-GCM) ──
   When an encryption key is set (default for new setups), every chunk is encrypted
   BEFORE leaving this machine; Telegram only stores ciphertext. Layout per chunk:
   [12-byte IV][16-byte GCM tag][ciphertext]. Decryption authenticates the tag, so a
   tampered or corrupted chunk fails loudly instead of returning garbage. */
function encKey() { const h = settings.getRaw('enc_key'); return h ? Buffer.from(h, 'hex') : null; }
function encryptChunk(buf, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}
function decryptChunk(buf, key) {
  if (buf.length < 29) throw new Error('Encrypted chunk too short');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  try { return Buffer.concat([d.update(data), d.final()]); }
  catch (_) { throw new Error('Chunk decryption failed — the file is corrupted or the encryption key changed'); }
}

async function uploadFile(tmpPath, originalName, mime, folderId, ownerId, source = 'web') {
  const total = fs.statSync(tmpPath).size;
  const CHUNK = tg.chunkSize();
  const fileId = crypto.randomUUID();
  db.prepare(`INSERT INTO files (id, name, folder_id, owner_id, size, mime, source, meta, created_at) VALUES (?,?,?,?,?,?,?, '{}', ?)`).run(fileId, originalName, folderId || null, ownerId, total, mime || null, source, Date.now());
  const fd = fs.openSync(tmpPath, 'r');
  const key = encKey();
  const insertChunk = db.prepare('INSERT INTO chunks (file_id, idx, file_id_tg, message_id, size, enc) VALUES (?,?,?,?,?,?)');
  try {
    const buf = Buffer.allocUnsafe(CHUNK); let offset = 0, idx = 0;
    // Empty files (0 bytes) store zero chunks — Telegram rejects empty uploads.
    while (offset < total) {
      const toRead = Math.min(CHUNK, total - offset);
      const bytes = fs.readSync(fd, buf, 0, toRead, offset);
      if (bytes <= 0) break;
      const plainBuf = Buffer.from(buf.subarray(0, bytes));
      const chunkBuf = key ? encryptChunk(plainBuf, key) : plainBuf;
      const r = await tg.uploadChunk(chunkBuf, `${fileId}.part${idx}`);
      insertChunk.run(fileId, idx, r.file_id, r.message_id, r.size, key ? 1 : 0);
      offset += bytes; idx += 1;
    }
  } catch (e) { try { db.prepare('DELETE FROM files WHERE id = ?').run(fileId); } catch (_) {} throw e; }
  finally { fs.closeSync(fd); }
  return getFile(fileId);
}

/* ─────────────────────── Local staging buffer ──────────────────────
   When enabled, an upload is written to a local folder and returned immediately;
   a background worker (processStagingQueue) then sends staged files to Telegram
   one at a time so the channel isn't hammered. While a file is still staged it's
   served straight from disk. A staged file is just a normal `files` row with
   `staged_path` set (and no chunks yet), so turning the feature off or upgrading
   never touches existing data. */
function moveFileSync(src, dst) {
  try { fs.renameSync(src, dst); }
  catch (e) { if (e.code === 'EXDEV') { fs.copyFileSync(src, dst); fs.unlinkSync(src); } else throw e; }
}
function stagingDir() { const d = settings.stagingConfig().dir; fs.mkdirSync(d, { recursive: true }); return d; }
function stagingUsage() { return db.prepare('SELECT COALESCE(SUM(size),0) s FROM files WHERE staged_path IS NOT NULL').get().s; }
async function stageFile(tmpPath, originalName, mime, folderId, ownerId, source = 'web') {
  const total = fs.statSync(tmpPath).size;
  const cfg = settings.stagingConfig();
  // Respect the size cap: if this file wouldn't fit, return null so the caller
  // falls back to a direct Telegram upload instead of overflowing the buffer.
  if (stagingUsage() + total > cfg.maxBytes) return null;
  const fileId = crypto.randomUUID();
  const dest = path.join(stagingDir(), fileId);
  moveFileSync(tmpPath, dest);
  try {
    db.prepare(`INSERT INTO files (id, name, folder_id, owner_id, size, mime, source, meta, staged_path, created_at) VALUES (?,?,?,?,?,?,?, '{}', ?, ?)`)
      .run(fileId, originalName, folderId || null, ownerId, total, mime || null, source, dest, Date.now());
  } catch (e) { try { fs.unlinkSync(dest); } catch (_) {} throw e; }
  return getFile(fileId);
}
async function processStagedFile(file) {
  const p = file.staged_path;
  if (!p || !fs.existsSync(p)) { db.prepare('DELETE FROM files WHERE id = ?').run(file.id); return; }
  // Drop any partial chunks from a previously interrupted attempt so a resume
  // can't duplicate them (NOT purgeFileChunks — that would delete staged_path).
  for (const c of db.prepare('SELECT message_id FROM chunks WHERE file_id = ?').all(file.id)) { try { await tg.deleteMessage(c.message_id); } catch (_) {} }
  db.prepare('DELETE FROM chunks WHERE file_id = ?').run(file.id);
  const total = fs.statSync(p).size;
  const CHUNK = tg.chunkSize();
  const key = encKey();
  const fd = fs.openSync(p, 'r');
  const insertChunk = db.prepare('INSERT INTO chunks (file_id, idx, file_id_tg, message_id, size, enc) VALUES (?,?,?,?,?,?)');
  try {
    const buf = Buffer.allocUnsafe(CHUNK); let offset = 0, idx = 0;
    while (offset < total) {
      const toRead = Math.min(CHUNK, total - offset);
      const bytes = fs.readSync(fd, buf, 0, toRead, offset);
      if (bytes <= 0) break;
      const plainBuf = Buffer.from(buf.subarray(0, bytes));
      const chunkBuf = key ? encryptChunk(plainBuf, key) : plainBuf;
      const r = await tg.uploadChunk(chunkBuf, `${file.id}.part${idx}`);
      insertChunk.run(file.id, idx, r.file_id, r.message_id, r.size, key ? 1 : 0);
      offset += bytes; idx += 1;
    }
  } finally { fs.closeSync(fd); }
  db.prepare('UPDATE files SET staged_path = NULL WHERE id = ?').run(file.id);
  try { fs.unlinkSync(p); } catch (_) {}
}
let _stagingBusy = false;
async function processStagingQueue() {
  if (_stagingBusy || !tg.isReady()) return;
  _stagingBusy = true;
  try {
    const staged = db.prepare('SELECT * FROM files WHERE staged_path IS NOT NULL ORDER BY created_at').all();
    for (const f of staged) {
      if (!tg.isReady()) break;
      try { await processStagedFile(f); }
      catch (e) { console.error('Staging upload failed for', f.id + ':', e.message); }
    }
  } finally { _stagingBusy = false; }
}
function kickStaging() { setTimeout(() => { processStagingQueue().catch(() => {}); }, 50); }
// The shared TDrop: ONE system folder (owned by the instance owner) where any
// collaborator or invited guest can drop files via the bot. system=2 keeps it
// out of normal folder trees and protected from rename/delete, like TDrop.
function getSharedTDropFolderId(create = true) {
  const owner = db.prepare('SELECT id FROM users WHERE is_owner = 1 LIMIT 1').get();
  if (!owner) return null;
  const f = db.prepare("SELECT id FROM folders WHERE system = 2 LIMIT 1").get();
  if (f) return f.id;
  if (!create) return null;
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO folders (id, name, parent_id, owner_id, system, created_at) VALUES (?,?,?,?,2,?)').run(id, 'TDrop (shared)', null, owner.id, Date.now());
  return id;
}
function listSharedTDrop() {
  const sid = getSharedTDropFolderId(false);
  if (!sid) return [];
  return db.prepare('SELECT * FROM files WHERE folder_id = ? ORDER BY created_at DESC').all(sid).map((f) => {
    let m = {}; try { m = JSON.parse(f.meta || '{}'); } catch (_) {}
    return { id: f.id, name: f.name, size: f.size, mime: f.mime, created_at: f.created_at, source: f.source, from: m.from || null, uploaderId: m.uploaderId || null, guest: !!m.guest };
  });
}

function registerSingleChunkFile({ name, mime, size, ownerId, folderId, source, tgFileId, messageId, meta }) {
  const fileId = crypto.randomUUID();
  db.prepare(`INSERT INTO files (id, name, folder_id, owner_id, size, mime, source, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(fileId, name, folderId || null, ownerId, size || 0, mime || null, source || 'tdrop', JSON.stringify(meta || {}), Date.now());
  db.prepare('INSERT INTO chunks (file_id, idx, file_id_tg, message_id, size) VALUES (?,0,?,?,?)').run(fileId, tgFileId, messageId || null, size || 0);
  return getFile(fileId);
}
async function streamFile(id, res, asDownload = true) {
  const file = getFile(id);
  if (!file) { res.status(404).json({ error: 'not found' }); return; }
  if (file.staged_path && fs.existsSync(file.staged_path)) {
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', `${asDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    const rs = fs.createReadStream(file.staged_path);
    rs.on('error', () => { try { res.destroy(); } catch (_) {} });
    rs.pipe(res);
    return;
  }
  const chunks = db.prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY idx').all(id);
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('Content-Disposition', `${asDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  const key = encKey();
  for (const c of chunks) {
    let buf = await tg.downloadChunk(c.file_id_tg);
    if (c.enc) {
      if (!key) throw new Error('This file is encrypted but no encryption key is configured');
      buf = decryptChunk(buf, key);
    }
    if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
  }
  res.end();
}

/* ─────────────────────────── Search / stats ────────────────────── */
function search(q, ownerId) {
  const like = `%${q}%`;
  return {
    folders: db.prepare('SELECT * FROM folders WHERE name LIKE ? AND owner_id = ? AND system = 0 ORDER BY name COLLATE NOCASE LIMIT 100').all(like, ownerId),
    files: db.prepare('SELECT * FROM files WHERE name LIKE ? AND owner_id = ? ORDER BY name COLLATE NOCASE LIMIT 100').all(like, ownerId),
  };
}
function stats(ownerId) {
  const f = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM files WHERE owner_id = ?').get(ownerId);
  const fo = db.prepare('SELECT COUNT(*) c FROM folders WHERE owner_id = ? AND system = 0').get(ownerId);
  return { files: f.c, totalSize: f.s, folders: fo.c };
}
function globalStats() {
  const f = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM files').get();
  const u = db.prepare('SELECT COUNT(*) c FROM users').get();
  const sh = db.prepare('SELECT COUNT(*) c FROM shares WHERE disabled = 0').get();
  return { files: f.c, totalSize: f.s, users: u.c, shares: sh.c };
}

module.exports = {
  getSharedTDropFolderId, listSharedTDrop,
  getFolder, ownsFolder, getTDropFolderId, createFolder, listFolders, renameFolder, moveFolder, deleteFolder,
  folderPath, folderTree, isWithin, setFolderAppearance, setFolderNote,
  getFile, ownsFile, listFiles, listStarred, renameFile, moveFile, setMeta, setStar, deleteFile, usedStorage, assertQuota,
  uploadFile, registerSingleChunkFile, streamFile, search, stats, globalStats,
  stageFile, processStagingQueue, kickStaging, stagingUsage,
};
