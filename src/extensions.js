'use strict';
const db = require('./db');

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
const RAW = 'https://raw.githubusercontent.com';
const API = 'https://api.github.com';
const MAX_CODE = 2 * 1024 * 1024;

function parseRepo(url) {
  if (typeof url !== 'string') return null;
  const m = url.trim().match(/github\.com[/:]([^/\s]+)\/([^/#?\s]+)/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  return { owner, repo };
}

async function fetchText(url, accept) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 15000);
  try {
    const headers = { 'User-Agent': 'TCloud-Extensions' };
    if (accept) headers.Accept = accept;
    const r = await fetch(url, { signal: ctl.signal, headers });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, text: await r.text() };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(to);
  }
}

async function resolveRef(owner, repo) {
  const rel = await fetchText(API + '/repos/' + owner + '/' + repo + '/releases/latest', 'application/vnd.github+json');
  if (rel.ok) { try { const j = JSON.parse(rel.text); if (j.tag_name) return j.tag_name; } catch (_) {} }
  const info = await fetchText(API + '/repos/' + owner + '/' + repo, 'application/vnd.github+json');
  if (info.ok) { try { const j = JSON.parse(info.text); if (j.default_branch) return j.default_branch; } catch (_) {} }
  return 'main';
}

function validateManifest(m) {
  if (!m || typeof m !== 'object') return 'Invalid manifest';
  if (!ID_RE.test(m.id || '')) return 'Manifest field "id" is missing or invalid';
  if (!m.name || typeof m.name !== 'string') return 'Manifest field "name" is missing';
  if (!m.version || typeof m.version !== 'string') return 'Manifest field "version" is missing';
  if (!m.entry || typeof m.entry !== 'string' || m.entry.includes('..')) return 'Manifest field "entry" is missing or invalid';
  return null;
}

function rowOf(id) {
  const e = db.prepare('SELECT * FROM extensions WHERE id = ?').get(id);
  if (!e) return null;
  let manifest = {};
  try { manifest = JSON.parse(e.manifest || '{}'); } catch (_) {}
  return { id: e.id, name: e.name, version: e.version, repo: e.repo, ref: e.ref, enabled: !!e.enabled, manifest, installedAt: e.installed_at, updatedAt: e.updated_at };
}

async function installFromUrl(url) {
  const pr = parseRepo(url);
  if (!pr) throw new Error('Only GitHub repository URLs are supported');
  const { owner, repo } = pr;
  const ref = await resolveRef(owner, repo);
  const man = await fetchText(RAW + '/' + owner + '/' + repo + '/' + ref + '/extension.json');
  if (!man.ok) throw new Error('extension.json was not found in the repository (' + (man.status || man.error) + ')');
  let manifest;
  try { manifest = JSON.parse(man.text); } catch (_) { throw new Error('extension.json is not valid JSON'); }
  const err = validateManifest(manifest);
  if (err) throw new Error(err);
  const entryPath = manifest.entry.replace(/^\.?\//, '');
  const codeRes = await fetchText(RAW + '/' + owner + '/' + repo + '/' + ref + '/' + entryPath);
  if (!codeRes.ok) throw new Error('Entry file "' + manifest.entry + '" was not found (' + (codeRes.status || codeRes.error) + ')');
  if (codeRes.text.length > MAX_CODE) throw new Error('Entry file is too large');
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM extensions WHERE id = ?').get(manifest.id);
  if (existing) {
    db.prepare('UPDATE extensions SET name=?, version=?, repo=?, ref=?, manifest=?, code=?, updated_at=? WHERE id=?')
      .run(manifest.name, manifest.version, owner + '/' + repo, ref, JSON.stringify(manifest), codeRes.text, now, manifest.id);
  } else {
    db.prepare('INSERT INTO extensions (id,name,version,repo,ref,manifest,code,enabled,installed_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)')
      .run(manifest.id, manifest.name, manifest.version, owner + '/' + repo, ref, JSON.stringify(manifest), codeRes.text, now, now);
  }
  return rowOf(manifest.id);
}

function list() {
  return db.prepare('SELECT id FROM extensions ORDER BY installed_at').all().map((r) => rowOf(r.id));
}

function active() {
  return db.prepare('SELECT * FROM extensions WHERE enabled = 1 ORDER BY installed_at').all().map((e) => {
    let manifest = {};
    try { manifest = JSON.parse(e.manifest || '{}'); } catch (_) {}
    return { id: e.id, name: e.name, version: e.version, repo: e.repo, ref: e.ref, manifest, code: e.code };
  });
}

function setEnabled(id, on) {
  if (!db.prepare('SELECT id FROM extensions WHERE id = ?').get(id)) throw new Error('Extension not found');
  db.prepare('UPDATE extensions SET enabled = ? WHERE id = ?').run(on ? 1 : 0, id);
  return rowOf(id);
}

function remove(id) {
  db.prepare('DELETE FROM extensions WHERE id = ?').run(id);
}

async function update(id) {
  const e = db.prepare('SELECT repo FROM extensions WHERE id = ?').get(id);
  if (!e) throw new Error('Extension not found');
  return installFromUrl('https://github.com/' + e.repo);
}

module.exports = { installFromUrl, list, active, setEnabled, remove, update, parseRepo };
