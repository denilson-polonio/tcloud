'use strict';
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
const storage = require('./storage');
const notify = require('./notify');
const activity = require('./activity');

function genToken() { return crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 16); }
function getById(id) { return db.prepare('SELECT * FROM shares WHERE id = ?').get(id); }
const SLUG_RE = /^[a-zA-Z0-9._-]{3,40}$/;

function sanitize(s) {
  if (!s) return null;
  return {
    id: s.id, token: s.id, resource_type: s.resource_type, resource_id: s.resource_id, label: s.label || null,
    permission: s.permission, allow_upload: !!s.allow_upload, upload_only: !!s.upload_only, has_password: !!s.pass_hash,
    expires_at: s.expires_at || null, max_downloads: s.max_downloads || null, downloads: s.downloads,
    disabled: !!s.disabled, created_at: s.created_at,
  };
}

function createShare({ ownerId, resourceType, resourceId, password, expiresAt, maxDownloads, allowUpload, uploadOnly, permission, label, slug }) {
  if (resourceType !== 'file' && resourceType !== 'folder') throw new Error('Invalid resource type');
  if (resourceType === 'file') { if (!storage.ownsFile(ownerId, resourceId)) throw new Error('File not found'); }
  else { if (!storage.ownsFolder(ownerId, resourceId)) throw new Error('Folder not found'); }

  let id;
  if (slug) {
    slug = String(slug).trim();
    if (!SLUG_RE.test(slug)) throw new Error('Custom link must be 3-40 chars: letters, numbers, . _ -');
    if (getById(slug)) throw new Error('That custom link is already taken');
    id = slug;
  } else {
    do { id = genToken(); } while (getById(id));
  }
  let hash = null, salt = null;
  if (password) { const h = auth.hashPassword(password); hash = h.hash; salt = h.salt; }
  db.prepare(
    `INSERT INTO shares (id, owner_id, resource_type, resource_id, label, permission, allow_upload, upload_only, pass_hash, pass_salt, expires_at, max_downloads, downloads, disabled, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 0, 0, ?)`
  ).run(id, ownerId, resourceType, resourceId, label || null, permission === 'view' ? 'view' : 'download',
        resourceType === 'folder' && allowUpload ? 1 : 0, resourceType === 'folder' && allowUpload && uploadOnly ? 1 : 0,
        hash, salt, expiresAt || null, maxDownloads ? parseInt(maxDownloads, 10) : null, Date.now());
  return sanitize(getById(id));
}

function listByOwner(ownerId) {
  return db.prepare('SELECT * FROM shares WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId).map((s) => {
    const out = sanitize(s);
    const r = s.resource_type === 'file' ? storage.getFile(s.resource_id) : storage.getFolder(s.resource_id);
    out.resource_name = r ? r.name : '(deleted)'; out.resource_missing = !r;
    return out;
  });
}
function updateShare(id, ownerId, f) {
  const s = getById(id);
  if (!s || s.owner_id !== ownerId) throw new Error('Share not found');
  const sets = [], vals = [];
  if (f.label !== undefined) { sets.push('label = ?'); vals.push(f.label || null); }
  if (f.permission !== undefined) { sets.push('permission = ?'); vals.push(f.permission === 'view' ? 'view' : 'download'); }
  if (f.allowUpload !== undefined) { sets.push('allow_upload = ?'); vals.push(f.allowUpload && s.resource_type === 'folder' ? 1 : 0); if (!f.allowUpload) { sets.push('upload_only = 0'); } }
  if (f.uploadOnly !== undefined) { sets.push('upload_only = ?'); vals.push(f.uploadOnly && s.resource_type === 'folder' ? 1 : 0); }
  if (f.disabled !== undefined) { sets.push('disabled = ?'); vals.push(f.disabled ? 1 : 0); }
  if (f.expiresAt !== undefined) { sets.push('expires_at = ?'); vals.push(f.expiresAt || null); }
  if (f.maxDownloads !== undefined) { sets.push('max_downloads = ?'); vals.push(f.maxDownloads ? parseInt(f.maxDownloads, 10) : null); }
  if (f.password !== undefined) {
    if (f.password) { const h = auth.hashPassword(f.password); sets.push('pass_hash = ?', 'pass_salt = ?'); vals.push(h.hash, h.salt); }
    else { sets.push('pass_hash = NULL', 'pass_salt = NULL'); }
  }
  if (sets.length) { vals.push(id); db.prepare(`UPDATE shares SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
  return sanitize(getById(id));
}
function deleteShare(id, ownerId) { db.prepare('DELETE FROM shares WHERE id = ? AND owner_id = ?').run(id, ownerId); }

function resolve(token, password) {
  const s = getById(token);
  if (!s || s.disabled) return { ok: false, status: 404, reason: 'This link is invalid or disabled.' };
  const exists = s.resource_type === 'file' ? storage.getFile(s.resource_id) : storage.getFolder(s.resource_id);
  if (!exists) return { ok: false, status: 404, reason: 'The shared content no longer exists.' };
  if (s.expires_at && s.expires_at < Date.now()) return { ok: false, status: 410, reason: 'This link has expired.' };
  if (s.max_downloads && s.downloads >= s.max_downloads) return { ok: false, status: 410, reason: 'Download limit reached.' };
  if (s.pass_hash) {
    if (password == null) return { ok: false, status: 401, needsPassword: true, reason: 'Password required.' };
    if (!auth.verifyPassword(password, s.pass_hash, s.pass_salt)) return { ok: false, status: 401, needsPassword: true, reason: 'Wrong password.' };
  }
  return { ok: true, share: s };
}
function recordDownload(id) {
  db.prepare('UPDATE shares SET downloads = downloads + 1 WHERE id = ?').run(id);
  try {
    const sh = getById(id);
    if (sh) {
      let nm = sh.label || '';
      if (!nm) { const r = sh.resource_type === 'folder' ? storage.getFolder(sh.resource_id) : storage.getFile(sh.resource_id); nm = (r && r.name) || sh.resource_type; }
      notify.notify('share_download', '\u2b07\ufe0f Shared item downloaded: ' + nm);
      activity.record({ kind: 'share', actor: '(public link)', action: 'downloaded via share', detail: nm });
    }
  } catch (_) {}
}

function publicView(share, subFolderId) {
  if (share.resource_type === 'file') {
    const f = storage.getFile(share.resource_id);
    return { type: 'file', permission: share.permission, label: share.label || null, file: { id: f.id, name: f.name, size: f.size, mime: f.mime, created_at: f.created_at } };
  }
  const root = storage.getFolder(share.resource_id);
  let current = root;
  if (subFolderId && subFolderId !== root.id) {
    if (!storage.isWithin(subFolderId, root.id)) throw new Error('Access denied');
    current = storage.getFolder(subFolderId);
    if (!current) throw new Error('Folder not found');
  }
  const owner = share.owner_id;
  const hideList = !!share.upload_only;
  const full = storage.folderPath(current.id);
  const ri = full.findIndex((p) => p.id === root.id);
  const pathArr = ri >= 0 ? full.slice(ri) : [{ id: root.id, name: root.name }];
  return {
    type: 'folder', permission: share.permission, allow_upload: !!share.allow_upload, upload_only: !!share.upload_only, label: share.label || null,
    root: { id: root.id, name: root.name }, current: { id: current.id, name: current.name },
    note: hideList ? null : (current.note || null),
    path: pathArr.map((p) => ({ id: p.id, name: p.name })),
    folders: hideList ? [] : storage.listFolders(current.id, owner).map((f) => ({ id: f.id, name: f.name })),
    files: hideList ? [] : storage.listFiles(current.id, owner).map((f) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime })),
  };
}
function fileBelongsToShare(share, fileId) {
  const f = storage.getFile(fileId);
  if (!f || f.owner_id !== share.owner_id) return false;
  if (share.resource_type === 'file') return f.id === share.resource_id;
  return f.folder_id ? storage.isWithin(f.folder_id, share.resource_id) : false;
}

function countByOwner(ownerId) { try { return db.prepare('SELECT COUNT(*) c FROM shares WHERE owner_id = ?').get(ownerId).c; } catch (_) { return 0; } }

module.exports = { createShare, listByOwner, updateShare, deleteShare, resolve, recordDownload, publicView, fileBelongsToShare, getById, sanitize, countByOwner };
