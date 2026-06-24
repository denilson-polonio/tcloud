'use strict';
const db = require('./db');

const items = new Map();
const recent = [];
const interrupted = [];
const MAX_RECENT = 80;
let seq = 0;

function start(type, name, target, total, ownerId) {
  const id = 'a' + ++seq;
  items.set(id, { id, type: type || 'task', name: name || '', target: target || '', done: 0, total: total || 0, status: 'running', owner_id: ownerId == null ? null : ownerId, started_at: Date.now(), ended_at: null, error: null });
  return id;
}

function update(id, done, total) {
  const it = items.get(id);
  if (!it) return;
  if (typeof done === 'number') it.done = done;
  if (typeof total === 'number') it.total = total;
}

function finish(id, status, error) {
  const it = items.get(id);
  if (!it) return;
  it.status = status || 'done';
  it.ended_at = Date.now();
  it.error = error ? String(error).slice(0, 300) : null;
  recent.unshift(Object.assign({}, it));
  if (recent.length > MAX_RECENT) recent.pop();
  items.delete(id);
}

function setInterrupted(list) {
  interrupted.length = 0;
  for (const x of (list || [])) interrupted.push(x);
}

function clearInterrupted(fileId) {
  const i = interrupted.findIndex((x) => String(x.id) === String(fileId));
  if (i >= 0) interrupted.splice(i, 1);
}

function snapshot() {
  return {
    active: Array.from(items.values()).sort((a, b) => a.started_at - b.started_at),
    interrupted: interrupted.slice(),
    recent: recent.slice(0, 60)
  };
}


const MAX_DETAIL = 500;
function actorName(userId) {
  if (userId == null) return 'system';
  try { const u = db.prepare('SELECT username FROM users WHERE id = ?').get(userId); return (u && u.username) || 'unknown'; } catch (_) { return 'unknown'; }
}
function record(ev) {
  try {
    ev = ev || {};
    db.prepare('INSERT INTO events (ts, kind, actor, action, detail, ip) VALUES (?,?,?,?,?,?)')
      .run(Date.now(), String(ev.kind || 'other'), ev.actor == null ? null : String(ev.actor).slice(0, 120),
           ev.action == null ? null : String(ev.action).slice(0, 120), ev.detail == null ? null : String(ev.detail).slice(0, MAX_DETAIL),
           ev.ip == null ? null : String(ev.ip).slice(0, 60));
  } catch (_) {}
}
function events(beforeId, limit) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  if (beforeId) return db.prepare('SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?').all(parseInt(beforeId, 10), lim);
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(lim);
}
function eventCount() { try { return db.prepare('SELECT COUNT(*) c FROM events').get().c; } catch (_) { return 0; } }
function clearEvents() { try { db.exec('DELETE FROM events'); return true; } catch (_) { return false; } }

module.exports = { start, update, finish, setInterrupted, clearInterrupted, snapshot, record, events, eventCount, clearEvents, actorName };
