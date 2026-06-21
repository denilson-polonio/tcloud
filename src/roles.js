'use strict';
const crypto = require('crypto');
const db = require('./db');

const CONTENT_PERMS = ['upload', 'delete', 'createFolder', 'share', 'tdrop'];
const ADMIN_PERMS = ['manageUsers', 'manageRoles', 'manageSettings', 'manageTelegram', 'manageBackups'];
const ALL_PERMS = [...CONTENT_PERMS, ...ADMIN_PERMS];

function normalizePerms(input) {
  const out = {};
  for (const p of ALL_PERMS) out[p] = !!(input && input[p]);
  return out;
}
function normalizeOverride(input) {
  const out = {};
  if (input) for (const p of ALL_PERMS) if (p in input) out[p] = !!input[p];
  return out;
}

function getById(id) { return db.prepare('SELECT * FROM roles WHERE id = ?').get(id); }
function getByName(name) { return db.prepare('SELECT * FROM roles WHERE name = ? COLLATE NOCASE').get(name); }
function list() {
  return db.prepare('SELECT * FROM roles ORDER BY admin DESC, name COLLATE NOCASE').all().map(sanitize);
}
function sanitize(r) {
  if (!r) return null;
  let perms = {}; try { perms = JSON.parse(r.perms || '{}'); } catch (_) {}
  return { id: r.id, name: r.name, admin: !!r.admin, builtin: !!r.builtin, perms: r.admin ? normalizePerms(allTrue()) : normalizePerms(perms), created_at: r.created_at };
}
function allTrue() { const o = {}; for (const p of ALL_PERMS) o[p] = true; return o; }

function permsOf(role) {
  if (!role) return normalizePerms({});
  if (role.admin) return normalizePerms(allTrue());
  let p = {}; try { p = JSON.parse(role.perms || '{}'); } catch (_) {}
  return normalizePerms(p);
}

function create({ name, admin, perms }) {
  name = String(name || '').trim();
  if (!/^[\w .-]{2,40}$/.test(name)) throw new Error('Invalid role name (2-40 chars)');
  if (getByName(name)) throw new Error('A role with that name already exists');
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO roles (id, name, admin, perms, builtin, created_at) VALUES (?,?,?,?,0,?)')
    .run(id, name, admin ? 1 : 0, JSON.stringify(normalizePerms(perms || {})), Date.now());
  return sanitize(getById(id));
}
function update(id, fields) {
  const r = getById(id);
  if (!r) throw new Error('Role not found');
  const sets = [], vals = [];
  if (fields.name !== undefined) {
    const n = String(fields.name).trim();
    if (!/^[\w .-]{2,40}$/.test(n)) throw new Error('Invalid role name');
    const ex = getByName(n); if (ex && ex.id !== id) throw new Error('A role with that name already exists');
    if (r.builtin) throw new Error('Built-in roles cannot be renamed');
    sets.push('name = ?'); vals.push(n);
  }
  if (fields.perms !== undefined && !r.admin) { sets.push('perms = ?'); vals.push(JSON.stringify(normalizePerms(fields.perms))); }
  if (fields.admin !== undefined && !r.builtin) { sets.push('admin = ?'); vals.push(fields.admin ? 1 : 0); }
  if (sets.length) { vals.push(id); db.prepare(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
  return sanitize(getById(id));
}
function remove(id) {
  const r = getById(id);
  if (!r) throw new Error('Role not found');
  if (r.builtin) throw new Error('Built-in roles cannot be deleted');
  const inUse = db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ?').get(id).c;
  if (inUse) throw new Error('Role is assigned to ' + inUse + ' user(s); reassign them first');
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
}

function ensureDefaults() {
  if (db.prepare('SELECT COUNT(*) c FROM roles').get().c > 0) return;
  const now = Date.now();
  db.prepare('INSERT INTO roles (id, name, admin, perms, builtin, created_at) VALUES (?,?,1,?,1,?)')
    .run(crypto.randomUUID(), 'Administrator', JSON.stringify(normalizePerms(allTrue())), now);
  db.prepare('INSERT INTO roles (id, name, admin, perms, builtin, created_at) VALUES (?,?,0,?,1,?)')
    .run(crypto.randomUUID(), 'Member', JSON.stringify(normalizePerms({ upload: 1, delete: 1, createFolder: 1, share: 1, tdrop: 1 })), now);
}
function adminRole() { return db.prepare('SELECT * FROM roles WHERE admin = 1 ORDER BY created_at LIMIT 1').get(); }
function memberRole() { return db.prepare("SELECT * FROM roles WHERE admin = 0 ORDER BY builtin DESC, created_at LIMIT 1").get(); }

module.exports = {
  CONTENT_PERMS, ADMIN_PERMS, ALL_PERMS, normalizePerms, normalizeOverride, permsOf,
  getById, getByName, list, sanitize, create, update, remove, ensureDefaults, adminRole, memberRole,
};
