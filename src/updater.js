'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');
const config = require('../config');


const appRoot = path.join(__dirname, '..');
let current = '0.0.0';
try { current = require('../package.json').version || '0.0.0'; } catch (_) {}

const API_BASE = (process.env.UPDATE_API_BASE || 'https://api.github.com').replace(/\/+$/, '');

function repoSlug() {
  const env = (process.env.UPDATE_REPO || '').trim();
  if (env) return env.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  try {
    const pkg = require('../package.json');
    const r = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository && pkg.repository.url) || '';
    const m = String(r).match(/github\.com[:/]+([^/]+\/[^/.]+)/i);
    if (m) return m[1];
  } catch (_) {}
  return '';
}

function compareVersions(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
  return 0;
}

function timedFetch(url, opts, ms) { const c = new AbortController(); const to = setTimeout(() => c.abort(), ms || 8000); return fetch(url, Object.assign({ headers: { 'User-Agent': 'TCloud-Updater', 'Accept': 'application/vnd.github+json' } }, opts, { signal: c.signal })).finally(() => clearTimeout(to)); }

async function getManifest() {
  const repo = repoSlug();
  if (!repo) return null;
  try {
    const r = await timedFetch(API_BASE + '/repos/' + repo + '/releases/latest', {}, 8000);
    if (!r.ok) return null;
    const j = await r.json();
    const version = String(j.tag_name || '').replace(/^v/i, '');
    if (!version || !j.tarball_url) return null;
    return { version, tarball_url: j.tarball_url, notes: String(j.body || '').slice(0, 4000), url: j.html_url || ('https://github.com/' + repo + '/releases') };
  } catch (_) { return null; }
}

async function checkForUpdate() {
  const repo = repoSlug();
  if (!repo) return { current, latest: current, available: false, noRepo: true };
  const m = await getManifest();
  if (!m) return { current, latest: current, available: false, serverDown: true };
  return { current, latest: m.version, available: compareVersions(m.version, current) > 0, notes: m.notes, url: m.url, manifest: m };
}

const MAX_TARBALL = 150 * 1024 * 1024;
async function download(manifest) {
  try {
    const r = await timedFetch(manifest.tarball_url, {}, 180000);
    if (!r.ok) return { ok: false, error: 'download failed (' + r.status + ')' };
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { ok: false, error: 'empty download' };
    if (buf.length > MAX_TARBALL) return { ok: false, error: 'archive too large' };
    const tmp = path.join(os.tmpdir(), 'tcloud-' + manifest.version + '-' + crypto.randomBytes(4).toString('hex') + '.tgz');
    fs.writeFileSync(tmp, buf);
    return { ok: true, file: tmp };
  } catch (e) { return { ok: false, error: 'download error' }; }
}

function findRoot(work) {
  if (fs.existsSync(path.join(work, 'package.json'))) return work;
  const entries = fs.readdirSync(work).filter((e) => !e.startsWith('.'));
  for (const e of entries) {
    const p = path.join(work, e);
    try { if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'package.json'))) return p; } catch (_) {}
  }
  return null;
}

function verifyTree(root, expectedVersion) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (_) { return 'package.json missing or invalid in the release'; }
  if (String(pkg.version || '') !== String(expectedVersion)) return 'release content (' + pkg.version + ') does not match the release tag (' + expectedVersion + ')';
  if (!fs.existsSync(path.join(root, 'src', 'index.js'))) return 'src/index.js missing in the release';
  const checkDirs = [path.join(root, 'src')];
  if (fs.existsSync(path.join(root, 'config.js'))) checkDirs.push(path.join(root, 'config.js'));
  try {
    for (const target of checkDirs) {
      const files = fs.statSync(target).isDirectory() ? fs.readdirSync(target).filter((f) => f.endsWith('.js')).map((f) => path.join(target, f)) : [target];
      for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'ignore', timeout: 15000 });
    }
  } catch (_) { return 'a source file in the release fails to parse — refusing to apply it'; }
  return null;
}

const ROLLBACK = path.join(appRoot, '.update-rollback');
const SKIP = new Set(['data', 'node_modules', '.env', '.update-rollback', '.git']);

function snapshotCurrent() {
  fs.rmSync(ROLLBACK, { recursive: true, force: true });
  fs.mkdirSync(ROLLBACK, { recursive: true });
  for (const e of fs.readdirSync(appRoot)) {
    if (SKIP.has(e)) continue;
    execSync('cp -a ' + JSON.stringify(path.join(appRoot, e)) + ' ' + JSON.stringify(path.join(ROLLBACK, e)), { stdio: 'ignore' });
  }
}
function restoreRollback() {
  if (!fs.existsSync(ROLLBACK)) return false;
  execSync('cp -a ' + JSON.stringify(ROLLBACK + '/.') + ' ' + JSON.stringify(appRoot + '/'), { stdio: 'ignore' });
  return true;
}

async function applyUpdate(manifest) {
  if (!manifest || !manifest.version || !manifest.tarball_url) return { ok: false, error: 'no update manifest' };
  const dl = await download(manifest);
  if (!dl.ok) return dl;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tcup-'));
  try {
    try { execSync('tar -xzmf ' + JSON.stringify(dl.file) + ' -C ' + JSON.stringify(work), { stdio: 'ignore' }); }
    catch (_) { return { ok: false, error: 'archive extraction failed' }; }
    const root = findRoot(work);
    if (!root) return { ok: false, error: 'unexpected archive layout (no package.json found)' };
    const bad = verifyTree(root, manifest.version);
    if (bad) return { ok: false, error: bad };
    for (const strip of ['data', '.env', 'node_modules', '.git', '.update-rollback']) fs.rmSync(path.join(root, strip), { recursive: true, force: true });
    snapshotCurrent();
    try {
      execSync('cp -a ' + JSON.stringify(root + '/.') + ' ' + JSON.stringify(appRoot + '/'), { stdio: 'ignore' });
    } catch (e) { restoreRollback(); return { ok: false, error: 'apply failed — previous version restored' }; }
    try { execSync('npm install --omit=dev --no-audit --no-fund', { cwd: appRoot, stdio: 'ignore', timeout: 10 * 60 * 1000 }); }
    catch (_) { restoreRollback(); return { ok: false, error: 'dependency install failed — previous version restored' }; }
    return { ok: true, version: manifest.version };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(dl.file, { force: true }); } catch (_) {}
  }
}

let _last = Date.now();
function touch() { _last = Date.now(); }
function idleMs() { return Date.now() - _last; }
function shouldAutoApply(o) { try { if (!o || !o.available) return false; if (o.scheduleAt && o.now >= o.scheduleAt) return true; if (o.autoUpdate && o.idleMs >= o.idleThreshold) return true; return false; } catch (_) { return false; } }

module.exports = { current, repoSlug, compareVersions, getManifest, checkForUpdate, download, applyUpdate, verifyTree, findRoot, touch, idleMs, shouldAutoApply };
