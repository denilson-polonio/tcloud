'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const multer = require('multer');
const config = require('../config');
const settings = require('./settings');
const storage = require('./storage');
const auth = require('./auth');
const roles = require('./roles');
const shares = require('./shares');
const backup = require('./backup');
const tg = require('./telegram');
const runtime = require('./runtime');
const org = require('./org');
const net = require('./net');
const updater = require('./updater');
const totp = require('./totp');
const guests = require('./guests');

const upload = multer({ dest: config.tmpDir });

/* ════════════════════════ Hardening ══════════════════════ */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "img-src 'self' https: data: blob:", "media-src 'self' https: data: blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
    "script-src 'self'", "connect-src 'self'", "worker-src 'self'", "manifest-src 'self'",
    "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
  ].join('; '));
  next();
}
const _hits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of _hits) if (v.reset < now) _hits.delete(k); }, 60000).unref?.();
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = bucket + ':' + (req.ip || (req.socket && req.socket.remoteAddress) || 'x');
    const now = Date.now(); let e = _hits.get(key);
    if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; _hits.set(key, e); }
    if (++e.count > max) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    next();
  };
}
function token(req) { return req.headers['x-auth-token'] || req.query.token || null; }
function requireAuth(req, res, next) {
  try { updater.touch(); } catch (_) {} const u = auth.getSessionUser(token(req)); if (!u) return res.status(401).json({ error: 'unauthorized' }); req.user = u; next(); }
function requirePerm(name) { return (req, res, next) => { if (!auth.can(req.user, name)) return res.status(403).json({ error: 'Permission denied' }); next(); }; }
function loadFolderOwned(req, res) { const f = storage.getFolder(req.params.id); if (!f) { res.status(404).json({ error: 'Folder not found' }); return null; } if (f.owner_id !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return null; } return f; }
function loadFileOwned(req, res) { const f = storage.getFile(req.params.id); if (!f) { res.status(404).json({ error: 'File not found' }); return null; } if (f.owner_id !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return null; } return f; }
function shareUrl(req, tk) { const base = config.publicUrl || `${req.protocol}://${req.get('host')}`; return `${base}/s/${tk}`; }

/* ════════════════════════════ Main router ════════════════════════ */
const router = express.Router();

router.use(express.json({ limit: '2mb' }));

router.get('/appearance', (req, res) => { res.json(Object.assign({}, settings.appearance(), { mode: settings.orgMode(), orgName: settings.orgName() })); });
// Connectivity: device internet (needed for Telegram storage)
router.get('/health', async (req, res) => { let online = true; try { online = await net.internetOk(); } catch (_) {} res.json({ online, support: config.supportChannel }); });
router.get('/setup/status', (req, res) => res.json({ configured: settings.isConfigured() }));
// Setup step: save ONLY the bot token and bring the bot up immediately, so the
// user can send /id (in a private chat or inside the channel) to learn the IDs
// needed for the next steps. Safe to call repeatedly during setup.
router.post('/setup/bot', rateLimit('setup', 20, 60000), async (req, res) => {
  if (settings.isConfigured()) return res.status(403).json({ error: 'Already configured' });
  const botToken = String((req.body || {}).botToken || '').trim();
  const apiRoot = String((req.body || {}).apiRoot || '').trim() || config.defaults.apiRoot;
  if (!botToken) return res.status(400).json({ error: 'Bot token is required' });
  let info;
  try { info = await tg.probeToken({ botToken, apiRoot }); }
  catch (e) { return res.status(400).json({ error: 'Invalid bot token: ' + (e.description || e.message || e) }); }
  settings.setRaw('bot_token', botToken); settings.setRaw('api_root', apiRoot);
  try { await runtime.restartTelegram(); } catch (_) {}
  res.json({ ok: true, username: info.username });
});
router.post('/setup', rateLimit('setup', 10, 60000), async (req, res) => {
  if (settings.isConfigured()) return res.status(403).json({ error: 'Already configured' });
  const b = req.body || {};
  const botToken = String(b.botToken || '').trim(), storageChannel = String(b.storageChannel || '').trim();
  const apiRoot = String(b.apiRoot || '').trim() || config.defaults.apiRoot, chunkSizeMB = parseInt(b.chunkSizeMB, 10) || config.defaults.chunkSizeMB;
  if (!botToken || !storageChannel) return res.status(400).json({ error: 'Bot token and channel are required' });
  if (!b.adminUsername || !b.adminPassword) return res.status(400).json({ error: 'Username and password are required' });
  try { await tg.probe({ botToken, storageChannel, apiRoot }); }
  catch (e) { return res.status(400).json({ error: 'Telegram check failed: ' + (e.description || e.message || e) + '. Make sure the bot is an admin of the channel.' }); }
  try {
    settings.setRaw('bot_token', botToken); settings.setRaw('storage_channel', storageChannel); settings.setRaw('api_root', apiRoot); settings.setRaw('chunk_size_mb', String(chunkSizeMB));
    // Session lifetime chosen at setup: N days, or 0 = "until the machine restarts".
    const sd = parseInt(b.sessionDays, 10);
    if (b.sessionUntilRestart === true || sd === 0) { settings.setRaw('session_until_restart', 'true'); settings.setRaw('session_days', '30'); }
    else if (sd > 0) { settings.setRaw('session_until_restart', 'false'); settings.setRaw('session_days', String(Math.min(sd, 3650))); }
    // At-rest encryption: ON by default. Key is auto-generated, or derived from a
    // custom passphrase (scrypt) if the user typed one. Stored in the local DB so
    // downloads keep working; Telegram only ever sees ciphertext.
    if (b.encrypt !== false) {
      const key = b.encPassphrase ? crypto.scryptSync(String(b.encPassphrase), 'tcloud-chunks-v1', 32) : crypto.randomBytes(32);
      settings.setRaw('enc_key', key.toString('hex'));
    }
    const admin = auth.createAdmin({ username: b.adminUsername, password: b.adminPassword, telegramId: b.adminTelegramId ? String(b.adminTelegramId).trim() : null });
    storage.getTDropFolderId(admin.id);
    settings.setOrg('organization', '');
    await runtime.restartTelegram();
    res.json({ ok: true, token: auth.createSession(admin.id, true), user: auth.sanitizeUser(admin) });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

/* Auth */
router.get('/auth/status', (req, res) => {
  const u = auth.getSessionUser(token(req));
  res.json({ authenticated: !!u, user: u ? auth.sanitizeUser(u) : null, allowRegistration: settings.publicConfig().allowRegistration && settings.orgMode() === 'organization', configured: settings.isConfigured(), mode: settings.orgMode(), orgName: settings.orgName(), support: config.supportChannel, donation: config.donationUrl, version: updater.current });
});
// Pending 2FA logins: password already verified, waiting for the second factor.
const _pending2fa = new Map(); // id -> { userId, remember, method, code?, attempts, exp }
function _newPending(u, remember) {
  const id = crypto.randomBytes(16).toString('hex');
  _pending2fa.set(id, { userId: u.id, remember: !!remember, method: u.two_factor_method, code: null, attempts: 0, exp: Date.now() + 5 * 60000 });
  return id;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of _pending2fa) if (v.exp < now) _pending2fa.delete(k); }, 60000).unref();

router.post('/auth/login', rateLimit('login', 12, 60000), async (req, res) => {
  const { username, password, remember } = req.body || {};
  const u = auth.getUserByUsername(String(username || '').trim());
  if (!u || u.disabled || !auth.verifyPassword(password, u.pass_hash, u.pass_salt)) return res.status(401).json({ error: 'Invalid credentials' });
  if (u.two_factor_method) {
    const pid = _newPending(u, remember);
    if (u.two_factor_method === 'telegram') {
      const p = _pending2fa.get(pid); p.code = totp.numericCode();
      try { await tg.sendMessage(u.telegram_id, '🔐 TCloud login code: ' + p.code + '\nIt expires in 5 minutes. If this was not you, change your password.'); }
      catch (e) { _pending2fa.delete(pid); return res.status(503).json({ error: 'Could not send the Telegram code. Ask an admin to check the bot, or use a recovery option.' }); }
    }
    return res.json({ twoFactor: true, method: u.two_factor_method, pending: pid });
  }
  res.json({ token: auth.createSession(u.id, !!remember), user: auth.sanitizeUser(u) });
});
router.post('/auth/2fa', rateLimit('2fa', 15, 60000), (req, res) => {
  const { pending, code } = req.body || {};
  const p = _pending2fa.get(String(pending || ''));
  if (!p || p.exp < Date.now()) return res.status(401).json({ error: 'Login expired — start again' });
  if (++p.attempts > 6) { _pending2fa.delete(pending); return res.status(429).json({ error: 'Too many attempts — start again' }); }
  const u = auth.getUserById(p.userId);
  if (!u || u.disabled) { _pending2fa.delete(pending); return res.status(401).json({ error: 'Invalid login' }); }
  const ok = p.method === 'telegram'
    ? (p.code && String(code || '').trim() === p.code)
    : totp.verify(u.two_factor_secret, code);
  if (!ok) return res.status(401).json({ error: 'Wrong code' });
  _pending2fa.delete(pending);
  res.json({ token: auth.createSession(u.id, p.remember), user: auth.sanitizeUser(u) });
});
router.post('/auth/register', rateLimit('register', 6, 60000), (req, res) => {
  if (settings.orgMode() !== 'organization' || !settings.publicConfig().allowRegistration) return res.status(403).json({ error: 'Registrations are disabled' });
  try { const { username, password, remember } = req.body || {}; const u = auth.registerUser({ username, password }); res.json({ token: auth.createSession(u.id, !!remember), user: auth.sanitizeUser(u) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
router.post('/auth/logout', (req, res) => { auth.deleteSession(token(req)); res.json({ ok: true }); });


router.use(requireAuth);

/* Profile */
router.get('/me', (req, res) => res.json({ user: auth.sanitizeUser(req.user), used: storage.usedStorage(req.user.id) }));
router.patch('/me', (req, res) => {
  try {
    const { password, telegram_id, prefs } = req.body || {};
    const fields = {};
    if (telegram_id !== undefined) fields.telegramId = telegram_id;
    if (prefs !== undefined) fields.prefs = prefs;
    if (password) fields.password = password;
    auth.updateUser(req.user.id, fields);
    res.json({ user: auth.sanitizeUser(auth.getUserById(req.user.id)) });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

/* Two-factor auth (optional for every user; recommended) */
const _pending2faSetup = new Map(); // userId -> { method, secret?, code?, exp }
router.post('/me/2fa/setup', async (req, res) => {
  const method = String((req.body || {}).method || '');
  if (method === 'totp') {
    const secret = totp.genSecret();
    _pending2faSetup.set(req.user.id, { method, secret, exp: Date.now() + 10 * 60000 });
    const otpauth = totp.otpauthURL(req.user.username, 'TCloud', secret);
    let qr = null; try { qr = await QRCode.toString(otpauth, { type: 'svg', margin: 1, width: 200, color: { dark: '#0b0e13', light: '#ffffff' } }); } catch (_) {}
    return res.json({ method, secret, otpauth, qr });
  }
  if (method === 'telegram') {
    if (!req.user.telegram_id) return res.status(400).json({ error: 'Link your Telegram ID in your profile first' });
    if (!tg.isReady()) return res.status(503).json({ error: 'Telegram bot is not running' });
    const code = totp.numericCode();
    _pending2faSetup.set(req.user.id, { method, code, exp: Date.now() + 10 * 60000 });
    return tg.sendMessage(req.user.telegram_id, '🔐 TCloud verification code: ' + code)
      .then(() => res.json({ method, sent: true }))
      .catch(() => { _pending2faSetup.delete(req.user.id); res.status(503).json({ error: 'Could not send the code on Telegram. Send /start to the bot first, then retry.' }); });
  }
  res.status(400).json({ error: 'Unknown method' });
});
router.post('/me/2fa/enable', (req, res) => {
  const p = _pending2faSetup.get(req.user.id);
  if (!p || p.exp < Date.now()) return res.status(400).json({ error: 'Setup expired — start again' });
  const code = String((req.body || {}).code || '').trim();
  const ok = p.method === 'telegram' ? code === p.code : totp.verify(p.secret, code);
  if (!ok) return res.status(401).json({ error: 'Wrong code' });
  auth.setTwoFactor(req.user.id, p.method, p.method === 'totp' ? p.secret : null);
  _pending2faSetup.delete(req.user.id);
  res.json({ ok: true, method: p.method });
});
router.post('/me/2fa/disable', (req, res) => {
  const { password } = req.body || {};
  const u = auth.getUserById(req.user.id);
  if (!password || !auth.verifyPassword(password, u.pass_hash, u.pass_salt)) return res.status(401).json({ error: 'Invalid password' });
  auth.setTwoFactor(req.user.id, null, null);
  res.json({ ok: true });
});

/* Browsing */
router.get('/list', (req, res) => {
  const folderId = req.query.folder || null;
  let f = null;
  if (folderId) { f = storage.getFolder(folderId); if (!f || f.owner_id !== req.user.id) return res.status(404).json({ error: 'Folder not found' }); }
  res.json({ path: folderId ? storage.folderPath(folderId) : [], folders: storage.listFolders(folderId, req.user.id), files: storage.listFiles(folderId, req.user.id), note: f ? (f.note || '') : null });
});
router.get('/tree', (req, res) => {
  const tdropId = storage.getTDropFolderId(req.user.id);
  res.json({ tree: storage.folderTree(req.user.id), stats: storage.stats(req.user.id), quota: req.user.quota, used: storage.usedStorage(req.user.id), tdropFolder: tdropId, tdropCount: storage.listFiles(tdropId, req.user.id).length });
});
router.get('/tdrop', (req, res) => res.json({ files: storage.listFiles(storage.getTDropFolderId(req.user.id), req.user.id) }));
router.get('/tdrop/shared', requirePerm('tdrop'), (req, res) => res.json({ files: storage.listSharedTDrop(), me: req.user.id, canModerate: auth.can(req.user, 'manageUsers') }));
router.get('/starred', (req, res) => res.json({ files: storage.listStarred(req.user.id) }));
router.get('/search', (req, res) => res.json(storage.search(String(req.query.q || ''), req.user.id)));

/* Folders */
router.post('/folders', requirePerm('createFolder'), (req, res) => {
  const { name, parent } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (parent) { const p = storage.getFolder(parent); if (!p || p.owner_id !== req.user.id) return res.status(404).json({ error: 'Parent folder not found' }); }
  res.json(storage.createFolder(String(name).slice(0, 200), parent || null, req.user.id));
});
router.patch('/folders/:id', (req, res) => {
  const f = loadFolderOwned(req, res); if (!f) return;
  if (f.system) return res.status(400).json({ error: 'System folder cannot be changed' });
  const { name, parent } = req.body || {};
  if (parent !== undefined) {
    if (parent) { const p = storage.getFolder(parent); if (!p || p.owner_id !== req.user.id) return res.status(404).json({ error: 'Target folder not found' }); if (parent === f.id || storage.isWithin(parent, f.id)) return res.status(400).json({ error: 'Cannot move a folder into itself' }); }
    storage.moveFolder(f.id, parent || null);
  }
  if (name !== undefined) storage.renameFolder(f.id, String(name).slice(0, 200));
  if (req.body && (req.body.color !== undefined || req.body.icon !== undefined || req.body.shadow !== undefined)) { storage.setFolderAppearance(f.id, req.body.color === undefined ? null : req.body.color, req.body.icon === undefined ? null : req.body.icon, req.body.shadow === undefined ? null : req.body.shadow); }
  if (req.body && req.body.note !== undefined) storage.setFolderNote(f.id, String(req.body.note || '').slice(0, 20000));
  res.json(storage.getFolder(f.id));
});
router.delete('/folders/:id', requirePerm('delete'), async (req, res) => {
  const f = loadFolderOwned(req, res); if (!f) return;
  if (f.system) return res.status(400).json({ error: 'System folder cannot be deleted' });
  await storage.deleteFolder(f.id); res.json({ ok: true });
});

/* Files */
router.post('/upload', requirePerm('upload'), upload.array('files'), async (req, res) => {
  const files = req.files || [];
  const cleanup = () => files.forEach((f) => fs.unlink(f.path, () => {}));
  if (!tg.isReady()) { cleanup(); return res.status(503).json({ error: 'Storage backend not ready' }); }
  try {
    const folderId = (req.body || {}).folder || null;
    if (folderId) { const p = storage.getFolder(folderId); if (!p || p.owner_id !== req.user.id) { cleanup(); return res.status(404).json({ error: 'Folder not found' }); } }
    try { storage.assertQuota(req.user, files.reduce((n, f) => n + f.size, 0)); } catch (e) { cleanup(); return res.status(413).json({ error: 'Not enough space: quota exceeded.' }); }
    const out = [];
    for (const f of files) { const s = await storage.uploadFile(f.path, f.originalname, f.mimetype, folderId, req.user.id, 'web'); fs.unlink(f.path, () => {}); out.push(s); }
    res.json({ files: out });
  } catch (e) { console.error('Upload error:', e); cleanup(); res.status(500).json({ error: String(e.message || e) }); }
});
router.post('/files/new', requirePerm('upload'), async (req, res) => {
  if (!tg.isReady()) return res.status(503).json({ error: 'Storage backend not ready' });
  const b = req.body || {};
  let name = String(b.name || '').trim(); if (!name) return res.status(400).json({ error: 'name required' });
  if (!/\.[a-z0-9]{1,8}$/i.test(name)) name += '.txt';
  const folderId = b.folder || null;
  if (folderId) { const p = storage.getFolder(folderId); if (!p || p.owner_id !== req.user.id) return res.status(404).json({ error: 'Folder not found' }); }
  const tmp = path.join(config.tmpDir, 'new-' + Date.now());
  fs.writeFileSync(tmp, String(b.content || ''));
  try { const s = await storage.uploadFile(tmp, name, 'text/plain', folderId, req.user.id, 'web'); fs.unlink(tmp, () => {}); res.json(s); }
  catch (e) { fs.unlink(tmp, () => {}); res.status(500).json({ error: String(e.message || e) }); }
});
// Read access: your own files, plus anything in the shared TDrop (visible to
// every user with the tdrop permission).
function canReadFile(req, f) {
  if (f.owner_id === req.user.id) return true;
  const sid = storage.getSharedTDropFolderId(false);
  return !!sid && f.folder_id === sid && auth.can(req.user, 'tdrop');
}
router.get('/download/:id', async (req, res) => {
  const f = storage.getFile(req.params.id); if (!f) return res.status(404).json({ error: 'File not found' });
  if (!canReadFile(req, f)) return res.status(403).json({ error: 'Forbidden' });
  try { await storage.streamFile(req.params.id, res, true); } catch (e) { if (!res.headersSent) res.status(500).json({ error: String(e.message || e) }); else res.end(); }
});
router.get('/view/:id', async (req, res) => {
  const f = storage.getFile(req.params.id); if (!f) return res.status(404).json({ error: 'File not found' });
  if (!canReadFile(req, f)) return res.status(403).json({ error: 'Forbidden' });
  try { await storage.streamFile(req.params.id, res, false); } catch (e) { if (!res.headersSent) res.status(500).json({ error: String(e.message || e) }); else res.end(); }
});
router.patch('/files/:id', (req, res) => {
  const f = loadFileOwned(req, res); if (!f) return;
  const { name, folder, meta, star } = req.body || {};
  if (folder !== undefined && folder) { const p = storage.getFolder(folder); if (!p || p.owner_id !== req.user.id) return res.status(404).json({ error: 'Folder not found' }); }
  if (name !== undefined) storage.renameFile(f.id, String(name).slice(0, 300));
  if (folder !== undefined) storage.moveFile(f.id, folder);
  if (meta !== undefined) storage.setMeta(f.id, meta);
  if (star !== undefined) storage.setStar(f.id, !!star);
  res.json(storage.getFile(f.id));
});
router.delete('/files/:id', requirePerm('delete'), async (req, res) => {
  const f = storage.getFile(req.params.id); if (!f) return res.status(404).json({ error: 'File not found' });
  let ok = f.owner_id === req.user.id;
  if (!ok) { // shared-TDrop moderation: the uploader (or a user manager) may delete
    const sid = storage.getSharedTDropFolderId(false);
    let m = {}; try { m = JSON.parse(f.meta || '{}'); } catch (_) {}
    ok = !!sid && f.folder_id === sid && (m.uploaderId === req.user.id || auth.can(req.user, 'manageUsers'));
  }
  if (!ok) return res.status(403).json({ error: 'Forbidden' });
  await storage.deleteFile(f.id); res.json({ ok: true });
});

/* Shares */
router.get('/shares', (req, res) => res.json({ shares: shares.listByOwner(req.user.id) }));
router.post('/shares', requirePerm('share'), (req, res) => {
  try {
    const b = req.body || {};
    let expiresAt = b.expiresAt || null; if (!expiresAt && b.expiresIn) expiresAt = Date.now() + parseInt(b.expiresIn, 10) * 1000;
    const s = shares.createShare({ ownerId: req.user.id, resourceType: b.resourceType, resourceId: b.resourceId, password: b.password || null, expiresAt, maxDownloads: b.maxDownloads || null, allowUpload: !!b.allowUpload, uploadOnly: !!b.uploadOnly, permission: b.permission || 'download', label: b.label || null, slug: b.slug || null });
    res.json({ share: s, url: shareUrl(req, s.token) });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
router.patch('/shares/:id', (req, res) => {
  try { const b = req.body || {}; if (b.expiresIn !== undefined && !b.expiresAt) b.expiresAt = b.expiresIn ? Date.now() + parseInt(b.expiresIn, 10) * 1000 : null; const s = shares.updateShare(req.params.id, req.user.id, b); res.json({ share: s, url: shareUrl(req, s.id) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
router.delete('/shares/:id', (req, res) => { shares.deleteShare(req.params.id, req.user.id); res.json({ ok: true }); });

/* ── Admin: roles ── */
router.get('/admin/roles', requirePerm('manageUsers'), (req, res) => res.json({ roles: roles.list(), permKeys: { content: roles.CONTENT_PERMS, admin: roles.ADMIN_PERMS } }));
router.post('/admin/roles', requirePerm('manageRoles'), (req, res) => { try { res.json({ role: roles.create(req.body || {}) }); } catch (e) { res.status(400).json({ error: String(e.message || e) }); } });
router.patch('/admin/roles/:id', requirePerm('manageRoles'), (req, res) => { try { res.json({ role: roles.update(req.params.id, req.body || {}) }); } catch (e) { res.status(400).json({ error: String(e.message || e) }); } });
router.delete('/admin/roles/:id', requirePerm('manageRoles'), (req, res) => { try { roles.remove(req.params.id); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: String(e.message || e) }); } });

/* ── Admin: users ── */
router.get('/admin/users', requirePerm('manageUsers'), (req, res) => res.json({ users: auth.listUsers().map((u) => ({ ...u, used: storage.usedStorage(u.id) })) }));
router.post('/admin/users', requirePerm('manageUsers'), (req, res) => {
  try {
    if (settings.orgMode() !== 'organization') return res.status(400).json({ error: 'Create an organization first to add users' });
    const b = req.body || {};
    const u = auth.createUser({ username: b.username, password: b.password, roleId: b.roleId, permsOverride: b.permsOverride || {}, quota: b.quotaMB ? parseInt(b.quotaMB, 10) * 1024 * 1024 : 0, telegramId: b.telegramId || null });
    res.json({ user: auth.sanitizeUser(u) });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
router.patch('/admin/users/:id', requirePerm('manageUsers'), (req, res) => {
  try {
    const b = req.body || {};
    const target = auth.getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.id === req.user.id && b.disabled) return res.status(400).json({ error: 'You cannot disable your own account' });
    const willManage = (() => {
      const fake = Object.assign({}, target);
      if (b.roleId !== undefined) fake.role_id = b.roleId || null;
      if (b.permsOverride !== undefined) fake.perms_override = JSON.stringify(roles.normalizeOverride(b.permsOverride));
      if (b.disabled !== undefined) fake.disabled = b.disabled ? 1 : 0;
      return !fake.disabled && auth.effectivePerms(fake).manageUsers;
    })();
    if (auth.effectivePerms(target).manageUsers && !willManage && auth.countUserManagers(target.id) === 0)
      return res.status(400).json({ error: 'At least one enabled user must keep the Manage users permission' });
    const fields = {};
    if (b.roleId !== undefined) fields.roleId = b.roleId;
    if (b.permsOverride !== undefined) fields.permsOverride = b.permsOverride;
    if (b.quotaMB !== undefined) fields.quota = (parseInt(b.quotaMB, 10) || 0) * 1024 * 1024;
    if (b.disabled !== undefined) fields.disabled = b.disabled;
    if (b.telegramId !== undefined) fields.telegramId = b.telegramId;
    if (b.username !== undefined) fields.username = b.username;
    if (b.password) fields.password = b.password;
    res.json({ user: auth.sanitizeUser(auth.updateUser(req.params.id, fields)) });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
router.delete('/admin/users/:id', requirePerm('manageUsers'), (req, res) => {
  const target = auth.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (auth.effectivePerms(target).manageUsers && auth.countUserManagers(target.id) === 0) return res.status(400).json({ error: 'At least one user manager must remain' });
  auth.deleteUser(req.params.id); res.json({ ok: true });
});

/* ── Admin: owner ── */
router.post('/admin/transfer-ownership', requirePerm('manageUsers'), (req, res) => {
  if (!req.user.is_owner) return res.status(403).json({ error: 'Only the owner can transfer ownership' });
  const b = req.body || {};
  if (!b.password || !b.targetUserId) return res.status(400).json({ error: 'Password and target user ID are required' });
  const u = auth.getUserById(req.user.id);
  if (!auth.verifyPassword(b.password, u.pass_hash, u.pass_salt)) return res.status(401).json({ error: 'Invalid password' });
  const target = auth.getUserById(b.targetUserId);
  if (!target) return res.status(404).json({ error: 'Target user not found' });
  if (target.disabled) return res.status(400).json({ error: 'Cannot transfer ownership to a disabled user' });
  const db = require('./db');
  db.prepare('UPDATE users SET is_owner = 0 WHERE id = ?').run(req.user.id);
  db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').run(target.id);
  res.json({ ok: true });
});
router.post('/admin/uninstall', requirePerm('manageUsers'), (req, res) => {
  if (!req.user.is_owner) return res.status(403).json({ error: 'Only the owner can uninstall TCloud' });
  const b = req.body || {};
  if (!b.password) return res.status(400).json({ error: 'Password is required' });
  const u = auth.getUserById(req.user.id);
  if (!auth.verifyPassword(b.password, u.pass_hash, u.pass_salt)) return res.status(401).json({ error: 'Invalid password' });
  const dir = path.resolve(__dirname, '..');
  const script = path.join(dir, 'uninstall.sh');
  // We try to remove ourselves now; if the box needs root we couldn't get, the user
  // finishes with this exact command (the same uninstaller, shipped with the app).
  res.json({ ok: true, command: 'sudo bash ' + script });
  setTimeout(() => {
    try { require('./db').close(); } catch (_) {}
    try { fs.rmSync(config.dataDir, { recursive: true, force: true }); } catch (_) {}
    try {
      const q = JSON.stringify(script);
      const sh = fs.existsSync(script)
        ? ('sudo bash ' + q + ' --yes 2>/dev/null || bash ' + q + ' --yes 2>/dev/null')
        : 'systemctl stop tcloud 2>/dev/null; systemctl disable tcloud 2>/dev/null; sudo systemctl stop tcloud 2>/dev/null; sudo systemctl disable tcloud 2>/dev/null';
      require('child_process').spawn('sh', ['-c', sh], { detached: true, stdio: 'ignore' }).unref();
    } catch (_) {}
    process.exit(0);
  }, 800);
});
/* TDrop guests — externals invited by Telegram @username (see src/guests.js) */
router.get('/admin/tdrop/guests', requirePerm('manageUsers'), (req, res) => {
  const out = guests.list().map((g) => {
    let dest = 'Shared TDrop';
    if (g.folder_id) { const f = storage.getFolder(g.folder_id); dest = f ? f.name : '(deleted folder)'; }
    return { ...g, dest };
  });
  res.json({ guests: out });
});
router.post('/admin/tdrop/guests', requirePerm('manageUsers'), (req, res) => {
  try {
    const b = req.body || {};
    let folderId = null;
    if (b.dest && b.dest !== 'shared') {
      const f = storage.getFolder(String(b.dest));
      if (!f || f.owner_id !== req.user.id) return res.status(404).json({ error: 'Folder not found' });
      folderId = f.id;
    } else { storage.getSharedTDropFolderId(true); }
    const g = guests.add({ username: b.username, folderId, days: parseInt(b.days, 10) || 0, invitedBy: req.user.id });
    res.json({ guest: g });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
router.delete('/admin/tdrop/guests/:id', requirePerm('manageUsers'), (req, res) => { guests.remove(req.params.id); res.json({ ok: true }); });

// Owner-only: wipe ALL data and return to the first-run setup wizard, WITHOUT
// uninstalling the program (the service keeps running and restarts into setup).
router.post('/admin/reset', requirePerm('manageUsers'), (req, res) => {
  if (!req.user.is_owner) return res.status(403).json({ error: 'Only the owner can reset TCloud' });
  const b = req.body || {};
  if (!b.password) return res.status(400).json({ error: 'Password is required' });
  const u = auth.getUserById(req.user.id);
  if (!auth.verifyPassword(b.password, u.pass_hash, u.pass_salt)) return res.status(401).json({ error: 'Invalid password' });
  res.json({ ok: true });
  setTimeout(() => {
    try { require('./db').close(); } catch (_) {}
    try { fs.rmSync(config.dataDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(0); // a process manager (systemd Restart=always) restarts into the setup wizard
  }, 800);
});

/* ── Admin: settings / appearance / telegram / stats ── */
router.get('/admin/settings', requirePerm('manageSettings'), (req, res) => res.json(settings.adminConfig()));
router.patch('/admin/settings', requirePerm('manageSettings'), (req, res) => {
  const b = req.body || {};
  if (b.acceptDrops !== undefined) settings.setRaw('accept_drops', b.acceptDrops ? 'true' : 'false');
  if (b.allowRegistration !== undefined) settings.setRaw('allow_registration', b.allowRegistration ? 'true' : 'false');
  if (b.defaultRoleId !== undefined) settings.setRaw('default_role_id', b.defaultRoleId || '');
  if (b.defaultQuotaMB !== undefined) settings.setRaw('default_quota_mb', String(parseInt(b.defaultQuotaMB, 10) || 0));
  if (b.sessionUntilRestart !== undefined) settings.setRaw('session_until_restart', b.sessionUntilRestart ? 'true' : 'false');
  if (b.sessionDays !== undefined) { const d = parseInt(b.sessionDays, 10); if (d > 0) settings.setRaw('session_days', String(Math.min(d, 3650))); }
  res.json(settings.adminConfig());
});
router.patch('/admin/appearance', requirePerm('manageSettings'), (req, res) => { const merged = Object.assign({}, settings.appearance(), req.body || {}); settings.setJSON('appearance', merged); res.json(merged); });
// Upload a background image that stays LOCAL (saved on this machine, never sent to
// Telegram) and is served from /branding. Returns the URL to store in appearance.
const BRAND_DIR = require('path').join(config.dataDir, 'branding');
try { require('fs').mkdirSync(BRAND_DIR, { recursive: true }); } catch (_) {}
router.post('/admin/appearance/bg-image', requirePerm('manageSettings'), upload.single('file'), (req, res) => {
  const fs = require('fs'), path = require('path');
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const type = req.file.mimetype || '';
    if (!/^image\//.test(type)) { try { fs.rmSync(req.file.path, { force: true }); } catch (_) {} return res.status(400).json({ error: 'Only image files are allowed' }); }
    if ((req.file.size || 0) > 8 * 1024 * 1024) { try { fs.rmSync(req.file.path, { force: true }); } catch (_) {} return res.status(400).json({ error: 'Image too large (max 8 MB)' }); }
    const ext = (type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
    // single, overwritten file so we never accumulate orphans
    for (const f of fs.readdirSync(BRAND_DIR)) { if (f.startsWith('bg.')) try { fs.rmSync(path.join(BRAND_DIR, f), { force: true }); } catch (_) {} }
    const filename = 'bg.' + ext;
    fs.copyFileSync(req.file.path, path.join(BRAND_DIR, filename));
    try { fs.rmSync(req.file.path, { force: true }); } catch (_) {}
    const url = '/branding/' + filename + '?v=' + Date.now();
    const merged = Object.assign({}, settings.appearance(), { bgImage: url, bgStyle: 'image' });
    settings.setJSON('appearance', merged);
    res.json({ ok: true, url, appearance: merged });
  } catch (e) { res.status(500).json({ error: 'Upload failed' }); }
});
router.patch('/admin/telegram', requirePerm('manageTelegram'), async (req, res) => {
  const b = req.body || {}, cur = settings.telegramConfig();
  const next = { botToken: b.botToken ? String(b.botToken).trim() : cur.botToken, storageChannel: b.storageChannel !== undefined ? String(b.storageChannel).trim() : cur.storageChannel, apiRoot: b.apiRoot !== undefined ? (String(b.apiRoot).trim() || config.defaults.apiRoot) : cur.apiRoot, chunkSizeMB: b.chunkSizeMB !== undefined ? (parseInt(b.chunkSizeMB, 10) || config.defaults.chunkSizeMB) : cur.chunkSizeMB };
  try { await tg.probe(next); } catch (e) { return res.status(400).json({ error: 'Telegram check failed: ' + (e.description || e.message || e) }); }
  settings.setRaw('bot_token', next.botToken); settings.setRaw('storage_channel', next.storageChannel); settings.setRaw('api_root', next.apiRoot); settings.setRaw('chunk_size_mb', String(next.chunkSizeMB));
  await runtime.restartTelegram();
  res.json(settings.adminConfig());
});
router.get('/admin/stats', requirePerm('manageSettings'), (req, res) => res.json(storage.globalStats()));

/* ── Updates (verified, signed by the publisher) ── */
router.get('/admin/update/check', requirePerm('manageSettings'), async (req, res) => { try { const c = await updater.checkForUpdate(); c.autoUpdate = settings.getRaw('auto_update') === 'true'; c.scheduleAt = parseInt(settings.getRaw('update_schedule') || '', 10) || null; res.json(c); } catch (e) { res.json({ current: updater.current, latest: updater.current, available: false, serverDown: true }); } });
router.post('/admin/update/auto', requirePerm('manageSettings'), (req, res) => { settings.setRaw('auto_update', (req.body || {}).enabled ? 'true' : 'false'); res.json({ ok: true, autoUpdate: settings.getRaw('auto_update') === 'true' }); });
router.post('/admin/update/interval', requirePerm('manageSettings'), (req, res) => { let h = parseInt((req.body || {}).hours, 10); if (isNaN(h) || h < 0) h = 24; settings.setRaw('update_check_interval_hours', String(Math.min(h, 8760))); res.json({ ok: true, hours: parseInt(settings.getRaw('update_check_interval_hours') || '24', 10) }); });
router.post('/admin/update/schedule', requirePerm('manageSettings'), (req, res) => { const at = parseInt((req.body || {}).at, 10) || 0; settings.setRaw('update_schedule', at > 0 ? String(at) : ''); res.json({ ok: true, scheduleAt: at > 0 ? at : null }); });
router.post('/admin/update/apply', requirePerm('manageSettings'), async (req, res) => { const c = await updater.checkForUpdate(); if (!c.available || !c.manifest) return res.status(400).json({ error: 'No update available' }); const r = await updater.applyUpdate(c.manifest); if (r.ok) { res.json({ ok: true, version: r.version, restarting: true }); setTimeout(() => process.exit(0), 900); } else res.status(500).json(r); });

/* ── Admin: organization ── */
router.patch('/admin/org', requirePerm('manageSettings'), (req, res) => {
  const b = req.body || {};
  if (b.mode === 'organization') { org.enable(b.name || settings.orgName() || 'My Organization'); return res.json(settings.adminConfig()); }
  res.status(400).json({ error: 'To switch back to Personal, use Delete organization (your files are kept).' });
});
router.delete('/admin/org', requirePerm('manageSettings'), (req, res) => {
  if (settings.orgMode() !== 'organization') return res.status(400).json({ error: 'No organization is active' });
  try { const r = org.disableAndMigrate(req.user.id); res.json(Object.assign({ ok: true }, r, settings.adminConfig())); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

/* ── Admin: backup ── */
router.get('/admin/backup/info', requirePerm('manageBackups'), (req, res) => { const l = settings.getRaw('last_backup_at'); res.json({ lastBackupAt: l ? parseInt(l, 10) : null, telegramReady: tg.isReady() }); });
router.get('/admin/backup/export', requirePerm('manageBackups'), (req, res) => {
  try { const buf = backup.serialize(backup.exportObject(), req.query.pass || null); res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', `attachment; filename="tcloud-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.tcb"`); res.send(buf); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
router.post('/admin/backup/restore', requirePerm('manageBackups'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No backup file' });
  try { const obj = backup.deserialize(fs.readFileSync(req.file.path), (req.body || {}).pass || null); backup.importObject(obj, { keepBotConfig: true }); fs.unlink(req.file.path, () => {}); res.json({ ok: true }); }
  catch (e) { fs.unlink(req.file.path, () => {}); res.status(400).json({ error: String(e.message || e) }); }
});
router.post('/admin/backup/channel/push', requirePerm('manageBackups'), async (req, res) => { if (!tg.isReady()) return res.status(503).json({ error: 'Storage backend not ready' }); try { res.json(await backup.pushToChannel((req.body || {}).pass || null)); } catch (e) { res.status(500).json({ error: String(e.message || e) }); } });
router.post('/admin/backup/channel/restore', requirePerm('manageBackups'), async (req, res) => { if (!tg.isReady()) return res.status(503).json({ error: 'Storage backend not ready' }); try { res.json(await backup.restoreFromChannel((req.body || {}).pass || null)); } catch (e) { res.status(400).json({ error: String(e.message || e) }); } });

/* ── Public (unauthenticated) router: language list + share links ── */
const publicRouter = express.Router();

/* Languages: discovered from public/i18n/*.json — drop a new <code>.json in that
   folder (a copy of en.json, translated) and it appears in the language picker.
   A file may include "__name__" for its display name (e.g. "Deutsch"). */
const LANG_NAMES = { en: 'English', it: 'Italiano', de: 'Deutsch', fr: 'Français', es: 'Español', pt: 'Português', nl: 'Nederlands', pl: 'Polski', ru: 'Русский', uk: 'Українська', tr: 'Türkçe', ar: 'العربية', zh: '中文', ja: '日本語', ko: '한국어', hi: 'हिन्दी' };
publicRouter.get('/locales', (req, res) => {
  const out = [];
  try {
    const dir = path.join(__dirname, '..', 'public', 'i18n');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const code = f.slice(0, -5);
      let name = LANG_NAMES[code] || code.toUpperCase();
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (j.__name__) name = String(j.__name__); } catch (_) {}
      out.push({ code, name });
    }
  } catch (_) {}
  if (!out.length) out.push({ code: 'en', name: 'English' });
  out.sort((a, b) => (a.code === 'en' ? -1 : b.code === 'en' ? 1 : a.code.localeCompare(b.code)));
  res.json({ locales: out });
});
publicRouter.use(express.json());
function sharePassword(req) { return req.headers['x-share-password'] || req.query.pw || null; }
publicRouter.get('/:token', rateLimit('pubview', 120, 60000), (req, res) => {
  const r = shares.resolve(req.params.token, sharePassword(req));
  if (!r.ok) return res.status(r.status).json({ error: r.reason, needsPassword: !!r.needsPassword });
  try { res.json(shares.publicView(r.share, req.query.folder || null)); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
publicRouter.post('/:token/verify', rateLimit('pubverify', 30, 60000), (req, res) => {
  const r = shares.resolve(req.params.token, (req.body || {}).password);
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.reason, needsPassword: !!r.needsPassword });
  res.json({ ok: true });
});
publicRouter.get('/:token/download/:fileId', async (req, res) => {
  const r = shares.resolve(req.params.token, sharePassword(req));
  if (!r.ok) return res.status(r.status).json({ error: r.reason, needsPassword: !!r.needsPassword });
  if (!shares.fileBelongsToShare(r.share, req.params.fileId)) return res.status(404).json({ error: 'File not found' });
  try { shares.recordDownload(r.share.id); await storage.streamFile(req.params.fileId, res, true); } catch (e) { if (!res.headersSent) res.status(500).json({ error: String(e.message || e) }); else res.end(); }
});
publicRouter.get('/:token/view/:fileId', async (req, res) => {
  const r = shares.resolve(req.params.token, sharePassword(req));
  if (!r.ok) return res.status(r.status).json({ error: r.reason });
  if (!shares.fileBelongsToShare(r.share, req.params.fileId)) return res.status(404).json({ error: 'File not found' });
  try { await storage.streamFile(req.params.fileId, res, false); } catch (e) { if (!res.headersSent) res.status(500).json({ error: String(e.message || e) }); else res.end(); }
});
publicRouter.post('/:token/upload', upload.array('files'), async (req, res) => {
  const files = req.files || [];
  const cleanup = () => files.forEach((f) => fs.unlink(f.path, () => {}));
  const r = shares.resolve(req.params.token, sharePassword(req));
  if (!r.ok) { cleanup(); return res.status(r.status).json({ error: r.reason, needsPassword: !!r.needsPassword }); }
  const share = r.share;
  if (share.resource_type !== 'folder' || !share.allow_upload) { cleanup(); return res.status(403).json({ error: 'Upload not allowed' }); }
  if (!tg.isReady()) { cleanup(); return res.status(503).json({ error: 'Storage backend not ready' }); }
  let targetFolder = share.resource_id;
  if (req.query.folder) { if (!storage.isWithin(req.query.folder, share.resource_id)) { cleanup(); return res.status(403).json({ error: 'Folder not allowed' }); } targetFolder = req.query.folder; }
  const owner = auth.getUserById(share.owner_id);
  try {
    try { storage.assertQuota(owner, files.reduce((n, f) => n + f.size, 0)); } catch (e) { cleanup(); return res.status(413).json({ error: 'Not enough space.' }); }
    const out = [];
    for (const f of files) { const s = await storage.uploadFile(f.path, f.originalname, f.mimetype, targetFolder, share.owner_id, 'share'); fs.unlink(f.path, () => {}); out.push({ id: s.id, name: s.name, size: s.size }); }
    res.json({ files: out });
  } catch (e) { cleanup(); res.status(500).json({ error: String(e.message || e) }); }
});

module.exports = { router, publicRouter, securityHeaders };
