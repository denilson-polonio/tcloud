'use strict';
const crypto = require('crypto');
const db = require('./db');
const config = require('../config');
const roles = require('./roles');
const settings = require('./settings');

/* ───────────────────────── Password hashing ───────────────────────── */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  let test; try { test = crypto.scryptSync(String(password), salt, 64).toString('hex'); } catch (_) { return false; }
  const a = Buffer.from(test, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ─────────────────────────── Permissions ──────────────────────────── */
// Role permissions, with the user's per-user overrides applied on top.
function effectivePerms(user) {
  if (!user) return roles.normalizePerms({});
  const role = user.role_id ? roles.getById(user.role_id) : null;
  const base = roles.permsOf(role);
  let ov = {}; try { ov = JSON.parse(user.perms_override || '{}'); } catch (_) {}
  const out = Object.assign({}, base);
  for (const k of roles.ALL_PERMS) if (k in ov) out[k] = !!ov[k];
  // A superuser role can't be downgraded by overrides.
  if (role && role.admin) return roles.normalizePerms(Object.assign({}, base));
  return roles.normalizePerms(out);
}
function isAdmin(user) { const r = user && user.role_id ? roles.getById(user.role_id) : null; return !!(r && r.admin); }
function can(user, perm) { return !!effectivePerms(user)[perm]; }

/* ────────────────────────────── Users ─────────────────────────────── */
function sanitizeUser(u) {
  if (!u) return null;
  let prefs = {}, ov = {};
  try { prefs = JSON.parse(u.prefs || '{}'); } catch (_) {}
  try { ov = JSON.parse(u.perms_override || '{}'); } catch (_) {}
  const role = u.role_id ? roles.getById(u.role_id) : null;
  return {
    id: u.id, username: u.username, role_id: u.role_id || null, role: role ? role.name : null,
    admin: isAdmin(u), perms: effectivePerms(u), perms_override: ov,
    quota: u.quota, telegram_id: u.telegram_id || null, prefs, disabled: !!u.disabled, created_at: u.created_at,
    is_owner: !!u.is_owner, two_factor_method: u.two_factor_method || null
  };
}
function getUserById(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
function getUserByUsername(u) { return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(u); }
function getUserByTelegram(t) { return t ? db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(t)) : null; }
function countUsers() { return db.prepare('SELECT COUNT(*) c FROM users').get().c; }
function listUsers() { return db.prepare('SELECT * FROM users ORDER BY created_at').all().map(sanitizeUser); }

// Number of enabled users who can manage users (admins or override-granted) — for lockout guards.
function countUserManagers(excludeId) {
  return db.prepare('SELECT * FROM users WHERE disabled = 0').all()
    .filter((u) => u.id !== excludeId && effectivePerms(u).manageUsers).length;
}

function createUser({ username, password, roleId, permsOverride, quota, telegramId }) {
  username = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) throw new Error('Invalid username (2-32 chars: letters, numbers, . _ -)');
  if (!password || String(password).length < 4) throw new Error('Password too short (min 4)');
  if (getUserByUsername(username)) throw new Error('Username already taken');
  if (roleId && !roles.getById(roleId)) throw new Error('Role not found');
  const id = crypto.randomUUID();
  const isOwner = countUsers() === 0 ? 1 : 0;
  db.prepare(`INSERT INTO users (id, username, pass_hash, pass_salt, role_id, perms_override, quota, telegram_id, prefs, disabled, created_at, is_owner)
              VALUES (?,?,?,?,?,?,?,?, '{}', 0, ?, ?)`)
    .run(id, username, ...(() => { const h = hashPassword(password); return [h.hash, h.salt]; })(),
         roleId || null, JSON.stringify(roles.normalizeOverride(permsOverride)), quota != null ? quota : 0,
         telegramId ? String(telegramId) : null, Date.now(), isOwner);
  return getUserById(id);
}
function updateUser(id, fields) {
  const u = getUserById(id);
  if (!u) throw new Error('User not found');
  const sets = [], vals = [];
  if (fields.roleId !== undefined) { 
    if (u.is_owner) throw new Error('Cannot change role of the owner');
    if (fields.roleId && !roles.getById(fields.roleId)) throw new Error('Role not found'); 
    sets.push('role_id = ?'); vals.push(fields.roleId || null); 
  }
  if (fields.permsOverride !== undefined) { sets.push('perms_override = ?'); vals.push(JSON.stringify(roles.normalizeOverride(fields.permsOverride))); }
  if (fields.quota !== undefined) { sets.push('quota = ?'); vals.push(parseInt(fields.quota, 10) || 0); }
  if (fields.disabled !== undefined) { 
    if (u.is_owner && fields.disabled) throw new Error('Cannot disable the owner');
    sets.push('disabled = ?'); vals.push(fields.disabled ? 1 : 0); 
  }
  if (fields.telegramId !== undefined) { sets.push('telegram_id = ?'); vals.push(fields.telegramId ? String(fields.telegramId) : null); }
  if (fields.prefs !== undefined) { sets.push('prefs = ?'); vals.push(JSON.stringify(fields.prefs || {})); }
  if (fields.twoFactorMethod !== undefined) { sets.push('two_factor_method = ?'); vals.push(fields.twoFactorMethod || null); }
  if (fields.twoFactorSecret !== undefined) { sets.push('two_factor_secret = ?'); vals.push(fields.twoFactorSecret || null); }
  if (fields.username !== undefined) {
    const n = String(fields.username).trim();
    if (!/^[a-zA-Z0-9._-]{2,32}$/.test(n)) throw new Error('Invalid username');
    const ex = getUserByUsername(n); if (ex && ex.id !== id) throw new Error('Username already taken');
    sets.push('username = ?'); vals.push(n);
  }
  if (sets.length) { vals.push(id); db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
  if (fields.password) setPassword(id, fields.password);
  return getUserById(id);
}
function setPassword(id, password) {
  if (!password || String(password).length < 4) throw new Error('Password too short (min 4)');
  const { hash, salt } = hashPassword(password);
  db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').run(hash, salt, id);
}
function deleteUser(id) { 
  const u = getUserById(id);
  if (u && u.is_owner) throw new Error('Cannot delete the owner');
  db.prepare('DELETE FROM users WHERE id = ?').run(id); 
}
/* ───────────────────────────── Sessions ───────────────────────────── */
function createSession(userId, persistent) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  // Session lifetime is an admin setting: N days, or "until the machine restarts"
  // (sessions are wiped on boot in that mode — see src/index.js).
  const untilRestart = settings.getRaw('session_until_restart') === 'true';
  const days = parseInt(settings.getRaw('session_days') || String(config.sessionDays), 10) || config.sessionDays;
  const expires = untilRestart ? now + 3650 * 86400000 : now + days * 86400000;
  db.prepare('INSERT INTO sessions (token, user_id, persistent, created_at, expires_at) VALUES (?,?,?,?,?)')
    .run(token, userId, persistent ? 1 : 0, now, expires);
  return token;
}
function setTwoFactor(userId, method, secret) {
  db.prepare('UPDATE users SET two_factor_method = ?, two_factor_secret = ? WHERE id = ?').run(method || null, secret || null, userId);
}
function getSessionUser(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (s.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); return null; }
  const u = getUserById(s.user_id);
  if (!u || u.disabled) return null;
  return u;
}
function deleteSession(token) { if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
function cleanupSessions() { db.prepare('DELETE FROM sessions WHERE expires_at < ? OR persistent = 0').run(Date.now()); }

/* ─────────────────────── Setup / registration ─────────────────────── */
function createAdmin({ username, password, telegramId }) {
  if (countUsers() > 0) throw new Error('An account already exists');
  roles.ensureDefaults();
  const adminRole = roles.adminRole();
  return createUser({ username, password, roleId: adminRole.id, telegramId });
}
function registerUser({ username, password }) {
  const roleId = settings.getRaw('default_role_id') || (roles.memberRole() && roles.memberRole().id) || null;
  const quotaMB = parseInt(settings.getRaw('default_quota_mb') || '0', 10) || 0;
  return createUser({ username, password, roleId, quota: quotaMB * 1024 * 1024 });
}

module.exports = {
  hashPassword, verifyPassword, effectivePerms, isAdmin, can, sanitizeUser,
  getUserById, getUserByUsername, getUserByTelegram, countUsers, listUsers, countUserManagers,
  createUser, updateUser, setPassword, deleteUser,
  createSession, getSessionUser, deleteSession, cleanupSessions, setTwoFactor,
  createAdmin, registerUser,
};
