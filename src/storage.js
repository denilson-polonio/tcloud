'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const tg = require('./telegram');
const settings = require('./settings');
const activity = require('./activity');
const notify = require('./notify');

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
async function deleteFolder(id) {
  const fileIds = allFilesUnder(id).map((f) => f.id);
  const { msgs, staged } = collectChunkRefs(fileIds);
  const changes = _delFolderTx(id, msgs);
  unlinkStaged(staged);
  kickPendingDeletions();
  return changes;
}
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
function collectChunkRefs(fileIds) {
  const msgs = [], staged = [];
  for (let i = 0; i < fileIds.length; i += 400) {
    const batch = fileIds.slice(i, i + 400);
    const ph = batch.map(() => '?').join(',');
    for (const c of db.prepare(`SELECT message_id FROM chunks WHERE file_id IN (${ph}) AND message_id IS NOT NULL`).all(...batch)) msgs.push(c.message_id);
    for (const f of db.prepare(`SELECT staged_path FROM files WHERE id IN (${ph}) AND staged_path IS NOT NULL`).all(...batch)) staged.push(f.staged_path);
  }
  return { msgs, staged };
}
function unlinkStaged(paths) { for (const p of paths) { try { fs.unlinkSync(p); } catch (_) {} } }
const _queuePending = db.prepare('INSERT INTO pending_deletions (message_id, attempts, created_at) VALUES (?, 0, ?)');
const _delFolderTx = db.transaction((id, msgs) => {
  const now = Date.now();
  for (const m of msgs) _queuePending.run(m, now);
  return db.prepare('DELETE FROM folders WHERE id = ? AND system = 0').run(id).changes;
});
const _delFileTx = db.transaction((id, msgs) => {
  const now = Date.now();
  for (const m of msgs) _queuePending.run(m, now);
  return db.prepare('DELETE FROM files WHERE id = ?').run(id).changes;
});
async function deleteFile(id) {
  const { msgs, staged } = collectChunkRefs([id]);
  _delFileTx(id, msgs);
  unlinkStaged(staged);
  kickPendingDeletions();
}

let _pdBusy = false;
async function processPendingDeletions() {
  if (_pdBusy || !tg.isReady()) return;
  _pdBusy = true;
  try {
    const rows = db.prepare('SELECT id, message_id, attempts FROM pending_deletions ORDER BY id LIMIT 300').all();
    for (const r of rows) {
      try { await tg.deleteMessageStrict(r.message_id); db.prepare('DELETE FROM pending_deletions WHERE id = ?').run(r.id); }
      catch (e) {
        if (r.attempts + 1 >= 8) db.prepare('DELETE FROM pending_deletions WHERE id = ?').run(r.id);
        else db.prepare('UPDATE pending_deletions SET attempts = attempts + 1 WHERE id = ?').run(r.id);
      }
    }
  } finally { _pdBusy = false; }
}
function kickPendingDeletions() { setTimeout(() => { processPendingDeletions().catch(() => {}); }, 50); }

function repairOrphans() {
  const orphans = db.prepare('SELECT id, message_id FROM chunks WHERE file_id NOT IN (SELECT id FROM files)').all();
  if (!orphans.length) return 0;
  db.transaction(() => {
    const now = Date.now();
    for (const c of orphans) { if (c.message_id != null) _queuePending.run(c.message_id, now); db.prepare('DELETE FROM chunks WHERE id = ?').run(c.id); }
  })();
  kickPendingDeletions();
  return orphans.length;
}
function usedStorage(ownerId) { return db.prepare('SELECT COALESCE(SUM(size),0) s FROM files WHERE owner_id = ?').get(ownerId).s; }
function assertQuota(user, incoming) { if (!user || !user.quota) return; if (usedStorage(user.id) + incoming > user.quota) { const e = new Error('Quota exceeded'); e.code = 'QUOTA'; throw e; } }

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
  const _aid = activity.start('upload', originalName, 'telegram', total, ownerId);
  db.prepare('UPDATE files SET resume_path = ? WHERE id = ?').run(tmpPath, fileId);
  const key = encKey();
  const insertChunk = db.prepare('INSERT INTO chunks (file_id, idx, file_id_tg, message_id, size, enc) VALUES (?,?,?,?,?,?)');
  try {
    const buf = Buffer.allocUnsafe(CHUNK); let offset = 0, idx = 0;
    while (offset < total) {
      const toRead = Math.min(CHUNK, total - offset);
      const bytes = fs.readSync(fd, buf, 0, toRead, offset);
      if (bytes <= 0) break;
      const plainBuf = Buffer.from(buf.subarray(0, bytes));
      const chunkBuf = key ? encryptChunk(plainBuf, key) : plainBuf;
      const r = await tg.uploadChunk(chunkBuf, `${fileId}.part${idx}`);
      insertChunk.run(fileId, idx, r.file_id, r.message_id, r.size, key ? 1 : 0);
      offset += bytes; idx += 1;
      activity.update(_aid, offset);
    }
  } catch (e) { activity.finish(_aid, 'error', e && e.message); notify.notify('upload_failed', '\u26a0\ufe0f Upload failed: ' + originalName); try { const { msgs } = collectChunkRefs([fileId]); _delFileTx(fileId, msgs); kickPendingDeletions(); } catch (_) {} throw e; }
  finally { fs.closeSync(fd); }
  db.prepare('UPDATE files SET resume_path = NULL WHERE id = ?').run(fileId);
  activity.finish(_aid, 'done');
  notify.notify('upload_done', '\u2705 Upload complete: ' + originalName);
  activity.record({ kind: 'upload', actor: activity.actorName(ownerId), action: 'uploaded', detail: originalName });
  return getFile(fileId);
}

function moveFileSync(src, dst) {
  try { fs.renameSync(src, dst); }
  catch (e) { if (e.code === 'EXDEV') { fs.copyFileSync(src, dst); fs.unlinkSync(src); } else throw e; }
}
function stagingDir() { const d = settings.stagingConfig().dir; fs.mkdirSync(d, { recursive: true }); return d; }
function stagingUsage() { return db.prepare('SELECT COALESCE(SUM(size),0) s FROM files WHERE staged_path IS NOT NULL').get().s; }
function checkStagingDir(customPath) {
  const dir = (customPath && String(customPath).trim()) || settings.stagingConfig().dir;
  let created = false;
  try {
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); created = true; }
    if (!fs.statSync(dir).isDirectory()) return { ok: false, path: dir, error: 'not a directory' };
    const probe = path.join(dir, '.tcloud_write_test');
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    return { ok: true, created, path: dir };
  } catch (e) {
    const err = e.code === 'EACCES' || e.code === 'EPERM' ? 'permission denied'
      : e.code === 'ENOENT' ? 'path not found (is the drive/NAS mounted?)'
      : e.code === 'EROFS' ? 'read-only filesystem' : (e.message || String(e));
    return { ok: false, path: dir, error: err };
  }
}
async function stageFile(tmpPath, originalName, mime, folderId, ownerId, source = 'web') {
  const total = fs.statSync(tmpPath).size;
  const cfg = settings.stagingConfig();
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
  for (const c of db.prepare('SELECT message_id FROM chunks WHERE file_id = ?').all(file.id)) { try { await tg.deleteMessage(c.message_id); } catch (_) {} }
  db.prepare('DELETE FROM chunks WHERE file_id = ?').run(file.id);
  const total = fs.statSync(p).size;
  const CHUNK = tg.chunkSize();
  const key = encKey();
  const fd = fs.openSync(p, 'r');
  const _aid = activity.start('upload', file.name, 'telegram', total, file.owner_id);
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
      activity.update(_aid, offset);
    }
  } catch (e) { activity.finish(_aid, 'error', e && e.message); notify.notify('upload_failed', '\u26a0\ufe0f Upload failed: ' + file.name); throw e; } finally { fs.closeSync(fd); }
  db.prepare('UPDATE files SET staged_path = NULL WHERE id = ?').run(file.id);
  activity.finish(_aid, 'done');
  notify.notify('upload_done', '\u2705 Upload complete: ' + file.name);
  activity.record({ kind: 'upload', actor: activity.actorName(file.owner_id), action: 'uploaded', detail: file.name });
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
function getSyncFolderId(create = true) {
  const own = db.prepare('SELECT id FROM users WHERE is_owner = 1 LIMIT 1').get();
  if (!own) return null;
  const f = db.prepare('SELECT id FROM folders WHERE system = 3 LIMIT 1').get();
  if (f) return f.id;
  if (!create) return null;
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO folders (id, name, parent_id, owner_id, system, created_at) VALUES (?,?,?,?,3,?)').run(id, 'TSync', null, own.id, Date.now());
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
async function streamFile(id, res, asDownload = true, rangeHeader = null) {
  const file = getFile(id);
  if (!file) { res.status(404).json({ error: 'not found' }); return; }
  const total = file.size;
  res.setHeader('Accept-Ranges', 'bytes');
  let start = 0, end = total > 0 ? total - 1 : 0, isRange = false;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') { start = Math.max(0, total - parseInt(m[2], 10)); end = total - 1; }
      else { start = parseInt(m[1], 10); end = m[2] !== '' ? Math.min(parseInt(m[2], 10), total - 1) : total - 1; }
      if (isNaN(start) || isNaN(end) || start > end || start >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`); res.end(); return;
      }
      isRange = true;
    }
  }
  const len = end - start + 1;
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${asDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.setHeader('Content-Length', String(len));
  if (isRange) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`); }

  if (file.staged_path && fs.existsSync(file.staged_path)) {
    const rs = fs.createReadStream(file.staged_path, { start, end });
    rs.on('error', () => { try { res.destroy(); } catch (_) {} });
    rs.pipe(res);
    return;
  }

  const chunks = db.prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY idx').all(id);
  const key = encKey();
  let pos = 0;
  for (const c of chunks) {
    const psize = c.enc ? (c.size - 28) : c.size;
    const cStart = pos, cEnd = pos + psize - 1;
    pos += psize;
    if (cEnd < start) continue;
    if (cStart > end) break;
    let buf = await tg.downloadChunk(c.file_id_tg);
    if (c.enc) {
      if (!key) throw new Error('This file is encrypted but no encryption key is configured');
      buf = decryptChunk(buf, key);
    }
    const from = Math.max(0, start - cStart);
    const to = Math.min(buf.length, end - cStart + 1);
    const out = (from <= 0 && to >= buf.length) ? buf : buf.subarray(from, to);
    if (out.length && !res.write(out)) await new Promise((r) => res.once('drain', r));
  }
  res.end();
}

async function downloadToFile(id, destPath) {
  const file = getFile(id);
  if (!file) throw new Error('file not found');
  if (file.staged_path && fs.existsSync(file.staged_path)) { fs.copyFileSync(file.staged_path, destPath); return; }
  const chunks = db.prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY idx').all(id);
  const key = encKey();
  const fd = fs.openSync(destPath, 'w');
  try {
    for (const c of chunks) {
      let buf = await tg.downloadChunk(c.file_id_tg);
      if (c.enc) { if (!key) throw new Error('This file is encrypted but no encryption key is configured'); buf = decryptChunk(buf, key); }
      fs.writeSync(fd, buf);
    }
  } finally { fs.closeSync(fd); }
}
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

function incompleteUploads() {
  const rows = db.prepare("SELECT f.id, f.name, f.size, f.owner_id, f.created_at, f.resume_path, COALESCE(SUM(c.size),0) uploaded FROM files f LEFT JOIN chunks c ON c.file_id = f.id WHERE f.staged_path IS NULL GROUP BY f.id HAVING uploaded < f.size").all();
  return rows.map((r) => ({ id: r.id, name: r.name, size: r.size, owner_id: r.owner_id, created_at: r.created_at, uploaded: r.uploaded, resumable: !!(r.resume_path && fs.existsSync(r.resume_path)) }));
}
function resumeSources() { return db.prepare("SELECT resume_path FROM files WHERE resume_path IS NOT NULL").all().map((r) => r.resume_path).filter(Boolean); }
async function abandonUpload(id) { const f = getFile(id); if (f && f.resume_path) { try { fs.unlinkSync(f.resume_path); } catch (_) {} } return deleteFile(id); }
async function resumeUpload(id) {
  const f = getFile(id);
  if (!f) throw new Error('File not found');
  if (!f.resume_path || !fs.existsSync(f.resume_path)) throw new Error('Source no longer available to resume');
  const total = f.size;
  const agg = db.prepare('SELECT COALESCE(SUM(size),0) s, COALESCE(MAX(idx),-1) mx FROM chunks WHERE file_id = ?').get(id);
  let offset = agg.s, idx = agg.mx + 1;
  const CHUNK = tg.chunkSize();
  const key = encKey();
  const fd = fs.openSync(f.resume_path, 'r');
  const insertChunk = db.prepare('INSERT INTO chunks (file_id, idx, file_id_tg, message_id, size, enc) VALUES (?,?,?,?,?,?)');
  const _aid = activity.start('upload', f.name, 'telegram', total, f.owner_id);
  activity.update(_aid, offset);
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    while (offset < total) {
      const toRead = Math.min(CHUNK, total - offset);
      const bytes = fs.readSync(fd, buf, 0, toRead, offset);
      if (bytes <= 0) break;
      const plainBuf = Buffer.from(buf.subarray(0, bytes));
      const chunkBuf = key ? encryptChunk(plainBuf, key) : plainBuf;
      const r = await tg.uploadChunk(chunkBuf, `${id}.part${idx}`);
      insertChunk.run(id, idx, r.file_id, r.message_id, r.size, key ? 1 : 0);
      offset += bytes; idx += 1;
      activity.update(_aid, offset);
    }
  } catch (e) { activity.finish(_aid, 'error', e && e.message); notify.notify('upload_failed', '\u26a0\ufe0f Upload failed: ' + f.name); throw e; } finally { fs.closeSync(fd); }
  db.prepare('UPDATE files SET resume_path = NULL WHERE id = ?').run(id);
  try { fs.unlinkSync(f.resume_path); } catch (_) {}
  activity.finish(_aid, 'done');
  notify.notify('upload_done', '\u2705 Upload complete: ' + f.name);
  activity.record({ kind: 'upload', actor: activity.actorName(f.owner_id), action: 'resumed upload', detail: f.name });
  return getFile(id);
}

module.exports = {
  getSharedTDropFolderId, listSharedTDrop, getSyncFolderId,
  getFolder, ownsFolder, getTDropFolderId, createFolder, listFolders, renameFolder, moveFolder, deleteFolder,
  folderPath, folderTree, isWithin, setFolderAppearance, setFolderNote,
  getFile, ownsFile, listFiles, listStarred, renameFile, moveFile, setMeta, setStar, deleteFile, usedStorage, assertQuota,
  uploadFile, registerSingleChunkFile, streamFile, downloadToFile, search, stats, globalStats,
  incompleteUploads, abandonUpload, resumeUpload, resumeSources, processStagedFile,
  stageFile, processStagingQueue, kickStaging, stagingUsage, checkStagingDir,
  processPendingDeletions, kickPendingDeletions, repairOrphans,
};
