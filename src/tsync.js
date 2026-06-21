'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./db');
const settings = require('./settings');
const storage = require('./storage');

const MIME = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg',
  wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  zip: 'application/zip', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
function mimeOf(name) { const e = (name.split('.').pop() || '').toLowerCase(); return MIME[e] || 'application/octet-stream'; }
function owner() { return db.prepare('SELECT * FROM users WHERE is_owner = 1 LIMIT 1').get(); }
function isHidden(name) { return name.startsWith('.'); }
function relParent(rel) { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); }
function relBase(rel) { const i = rel.lastIndexOf('/'); return i < 0 ? rel : rel.slice(i + 1); }

const _idxUpsert = db.prepare(`INSERT INTO tsync_index (rel_path, file_id, local_size, local_mtime, tcloud_size, synced_at)
  VALUES (?,?,?,?,?,?)
  ON CONFLICT(rel_path) DO UPDATE SET file_id=excluded.file_id, local_size=excluded.local_size,
    local_mtime=excluded.local_mtime, tcloud_size=excluded.tcloud_size, synced_at=excluded.synced_at`);
function recordIndex(rel, L, C) { _idxUpsert.run(rel, C ? C.id : null, L ? L.size : null, L ? L.mtime : null, C ? C.size : null, Date.now()); }

let _busy = false, _lastSync = 0, _lastError = null, _last = { uploaded: 0, downloaded: 0, errors: 0 };

function localWalk(rootDir) {
  const files = {}, dirs = new Set();
  const walk = (abs, base) => {
    let entries; try { entries = fs.readdirSync(abs); } catch (_) { return; }
    for (const name of entries) {
      if (isHidden(name)) continue;
      const full = path.join(abs, name), rel = base ? base + '/' + name : name;
      let st; try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) { dirs.add(rel); walk(full, rel); }
      else if (st.isFile()) files[rel] = { size: st.size, mtime: Math.floor(st.mtimeMs) };
    }
  };
  walk(rootDir, '');
  return { files, dirs };
}

function cloudWalk(rootFolderId, ownerId) {
  const files = {}, dirs = new Set(), folderIdByPath = { '': rootFolderId };
  const stack = [[rootFolderId, '']];
  while (stack.length) {
    const [fid, base] = stack.pop();
    for (const f of storage.listFiles(fid, ownerId)) files[base ? base + '/' + f.name : f.name] = f;
    for (const sub of storage.listFolders(fid, ownerId)) {
      if (sub.system) continue;
      const rel = base ? base + '/' + sub.name : sub.name;
      dirs.add(rel); folderIdByPath[rel] = sub.id; stack.push([sub.id, rel]);
    }
  }
  return { files, dirs, folderIdByPath };
}

function ensureCloudFolder(relDir, rootFolderId, ownerId, folderIdByPath) {
  if (relDir === '') return rootFolderId;
  if (relDir in folderIdByPath && folderIdByPath[relDir] != null) return folderIdByPath[relDir];
  const parts = relDir.split('/');
  let cur = rootFolderId, curPath = '';
  for (const part of parts) {
    curPath = curPath ? curPath + '/' + part : part;
    if (curPath in folderIdByPath && folderIdByPath[curPath] != null) { cur = folderIdByPath[curPath]; continue; }
    let child = storage.listFolders(cur, ownerId).find((f) => f.name === part && !f.system);
    if (!child) child = storage.createFolder(part, cur, ownerId);
    folderIdByPath[curPath] = child.id; cur = child.id;
  }
  return cur;
}

async function pushLocal(rel, L, existingCloud, ownerId, rootDir, rootFolderId, folderIdByPath) {
  if (existingCloud) await storage.deleteFile(existingCloud.id);
  const parentId = ensureCloudFolder(relParent(rel), rootFolderId, ownerId, folderIdByPath);
  const full = path.join(rootDir, rel);
  const f = await storage.uploadFile(full, relBase(rel), mimeOf(rel), parentId, ownerId, 'tsync');
  recordIndex(rel, L, f);
}
async function pullCloud(rel, C, rootDir) {
  const full = path.join(rootDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = path.join(path.dirname(full), '.tsync.' + path.basename(full) + '.tmp');
  await storage.downloadToFile(C.id, tmp);
  fs.renameSync(tmp, full);
  const st = fs.statSync(full);
  recordIndex(rel, { size: st.size, mtime: Math.floor(st.mtimeMs) }, C);
}

async function runSync() {
  const cfg = settings.tsyncConfig();
  if (!cfg.enabled) return { skipped: 'disabled' };
  if (_busy) return { skipped: 'busy' };
  if (!cfg.dir) { _lastError = 'No local folder configured'; return { error: _lastError }; }
  const own = owner();
  if (!own) { _lastError = 'No owner account'; return { error: _lastError }; }
  try { fs.mkdirSync(cfg.dir, { recursive: true }); } catch (e) { _lastError = 'Local folder not reachable (' + (e.code || e.message) + ')'; return { error: _lastError }; }
  const rootFolderId = storage.getSyncFolderId(true);
  if (!rootFolderId) { _lastError = 'Could not create the sync folder'; return { error: _lastError }; }

  _busy = true;
  let uploaded = 0, downloaded = 0, deletedLocal = 0, deletedCloud = 0, errors = 0;
  const mode = cfg.mode;
  try {
    const L = localWalk(cfg.dir);
    const C = cloudWalk(rootFolderId, own.id);


    const idx = {};
    for (const r of db.prepare('SELECT * FROM tsync_index').all()) idx[r.rel_path] = r;
    const rels = new Set([...Object.keys(L.files), ...Object.keys(C.files), ...Object.keys(idx)]);
    const localDirsToPrune = new Set();
    for (const rel of rels) {
      const lf = L.files[rel], cf = C.files[rel], I = idx[rel];
      try {
        if (lf && cf) {
          const localChanged = !I || I.local_size !== lf.size || I.local_mtime !== lf.mtime;
          const cloudChanged = !I || I.file_id !== cf.id || I.tcloud_size !== cf.size;
          if (localChanged && cloudChanged) {
            const localNewer = lf.mtime >= (cf.created_at || 0);
            if (localNewer && (mode === 'two-way' || mode === 'send')) { await pushLocal(rel, lf, cf, own.id, cfg.dir, rootFolderId, C.folderIdByPath); uploaded++; }
            else if (!localNewer && (mode === 'two-way' || mode === 'receive')) { await pullCloud(rel, cf, cfg.dir); downloaded++; }
            else recordIndex(rel, lf, cf);
          } else if (localChanged && (mode === 'two-way' || mode === 'send')) { await pushLocal(rel, lf, cf, own.id, cfg.dir, rootFolderId, C.folderIdByPath); uploaded++; }
          else if (cloudChanged && (mode === 'two-way' || mode === 'receive')) { await pullCloud(rel, cf, cfg.dir); downloaded++; }
          else recordIndex(rel, lf, cf);
        } else if (lf && !cf) {
          if (I) {
            if (mode === 'two-way' || mode === 'receive') { try { fs.unlinkSync(path.join(cfg.dir, rel)); } catch (_) {} localDirsToPrune.add(relParent(rel)); db.prepare('DELETE FROM tsync_index WHERE rel_path = ?').run(rel); deletedLocal++; }
            else { await pushLocal(rel, lf, null, own.id, cfg.dir, rootFolderId, C.folderIdByPath); uploaded++; }
          } else if (mode === 'two-way' || mode === 'send') { await pushLocal(rel, lf, null, own.id, cfg.dir, rootFolderId, C.folderIdByPath); uploaded++; }
        } else if (!lf && cf) {
          if (I) {
            if (mode === 'two-way' || mode === 'send') { await storage.deleteFile(cf.id); db.prepare('DELETE FROM tsync_index WHERE rel_path = ?').run(rel); deletedCloud++; }
            else { await pullCloud(rel, cf, cfg.dir); downloaded++; }
          } else if (mode === 'two-way' || mode === 'receive') { await pullCloud(rel, cf, cfg.dir); downloaded++; }
        } else {
          db.prepare('DELETE FROM tsync_index WHERE rel_path = ?').run(rel);
        }
      } catch (e) { errors++; console.error('TSync item failed (' + rel + '):', e.message); }
    }
    for (const d of [...localDirsToPrune].filter(Boolean).sort((a, b) => b.split('/').length - a.split('/').length)) {
      try { const abs = path.join(cfg.dir, d); if (fs.existsSync(abs) && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs); } catch (_) {}
    }
    _lastError = errors ? (errors + ' item(s) failed') : null;
    _lastSync = Date.now();
  } catch (e) {
    _lastError = e.message || String(e);
  } finally { _busy = false; }
  _last = { uploaded, downloaded, deletedLocal, deletedCloud, errors };
  return _last;
}

function kickSync() { setTimeout(() => { runSync().catch(() => {}); }, 80); }

let _lastAuto = 0;
async function maybeAutoSync() {
  const cfg = settings.tsyncConfig();
  if (!cfg.enabled || !cfg.intervalMin) return;
  if (Date.now() - _lastAuto < cfg.intervalMin * 60000) return;
  _lastAuto = Date.now();
  return runSync();
}

function status() {
  const cfg = settings.tsyncConfig();
  let pathExists = false;
  try { pathExists = !!cfg.dir && fs.existsSync(cfg.dir) && fs.statSync(cfg.dir).isDirectory(); } catch (_) {}
  const count = db.prepare('SELECT COUNT(*) c FROM tsync_index').get().c;
  return {
    enabled: cfg.enabled, mode: cfg.mode, path: cfg.dir, pathExists,
    folderId: storage.getSyncFolderId(true),
    busy: _busy, lastSync: _lastSync || null, lastError: _lastError,
    synced: count, last: _last,
  };
}

function contents() {
  const root = storage.getSyncFolderId(false);
  if (!root) return { items: [] };
  const own = owner(); if (!own) return { items: [] };
  const C = cloudWalk(root, own.id);
  const items = [];
  for (const d of C.dirs) items.push({ type: 'folder', rel: d });
  for (const rel of Object.keys(C.files)) { const f = C.files[rel]; items.push({ type: 'file', rel, id: f.id, name: f.name, size: f.size }); }
  items.sort((a, b) => a.rel.localeCompare(b.rel));
  return { items };
}

module.exports = { runSync, kickSync, maybeAutoSync, status, contents, mimeOf };
