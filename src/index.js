'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('../config');

const db = require('./db');
const settings = require('./settings');
const roles = require('./roles');
const auth = require('./auth');
const { router, publicRouter, securityHeaders, mountPublic } = require('./api');
const storage = require('./storage');
const activity = require('./activity');
const tsync = require('./tsync');
const shares = require('./shares');
const backup = require('./backup');
const runtime = require('./runtime');

settings.seed();
roles.ensureDefaults();
auth.cleanupSessions();

(function cleanOrphanedTmp() {
  try {
    let n = 0;
    let keep = new Set();
    try { keep = new Set(storage.resumeSources()); } catch (_) {}
    for (const name of fs.readdirSync(config.tmpDir)) {
      const p = path.join(config.tmpDir, name);
      if (keep.has(p)) continue;
      try { if (fs.statSync(p).isFile()) { fs.unlinkSync(p); n += 1; } } catch (_) {}
    }
    if (n > 0) console.log('Removed ' + n + ' orphaned temp file(s) left by a previous run.');
  } catch (_) {}
})();

(function detectInterruptedUploads() {
  try {
    const list = storage.incompleteUploads();
    activity.setInterrupted(list);
    if (list.length > 0) console.log('Found ' + list.length + ' interrupted upload(s) from a previous run — see the Activity tab.');
  } catch (_) {}
})();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(securityHeaders);

app.use('/api/public', publicRouter);
app.use('/api', router);

app.get('/s/:token', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'share.html')));
const _brandDir = path.join(config.dataDir, 'branding');
try { require('fs').mkdirSync(_brandDir, { recursive: true }); } catch (_) {}
app.use('/branding', express.static(_brandDir, { maxAge: '1d' }));
app.use(express.static(path.join(__dirname, '..', 'public')));


function startServer(port, attemptsLeft) {
  const server = app.listen(port, () => {
    const configured = settings.isConfigured();
    console.log('\n  ┌─ TCloud ─────────────────────────────────────');
    console.log(`  │  Web:     http://localhost:${port}`);
    if (configured) { const tc = settings.telegramConfig(); console.log(`  │  Channel: ${tc.storageChannel}`); console.log(`  │  Chunk:   ${tc.chunkSizeMB} MB`); console.log(`  │  Users:   ${auth.countUsers()}`); }
    else console.log('  │  ⚙ Not configured yet — open the web UI to run setup.');
    if (port !== config.port) console.log(`  │  ℹ Port ${config.port} was busy — using ${port} instead.`);
    console.log('  └──────────────────────────────────────────────\n');
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) { startServer(port + 1, attemptsLeft - 1); }
    else { console.error('Cannot start TCloud — no free port found near ' + config.port + ':', err && err.message); process.exit(1); }
  });
}
startServer(config.port, 50);

const _sharePort = parseInt(settings.getRaw('share_port') || config.sharePort || '0', 10) || 0;
if (_sharePort > 0 && _sharePort !== config.port) {
  const shareApp = express();
  mountPublic(shareApp);
  const shareServer = shareApp.listen(_sharePort, () => {
    console.log('  ┌─ TCloud public shares ───────────────────────');
    console.log(`  │  Shares:  http://localhost:${_sharePort}/s/...`);
    console.log('  │  (this port serves ONLY public share links)');
    console.log('  └──────────────────────────────────────────────\n');
  });
  shareServer.on('error', (err) => { console.error('Public share server could not start on port ' + _sharePort + ': ' + (err && err.message)); });
}

runtime.startTelegram();

setTimeout(() => { try { storage.processStagingQueue(); } catch (_) {} }, 4000);
setInterval(() => { try { storage.processStagingQueue(); } catch (_) {} }, 15000);

setTimeout(() => { try { const n = storage.repairOrphans(); if (n) console.log(`Repaired ${n} orphaned chunk(s).`); } catch (_) {} }, 5000);
setTimeout(() => { try { storage.processPendingDeletions(); } catch (_) {} }, 6000);
setInterval(() => { try { storage.processPendingDeletions(); } catch (_) {} }, 20000);

setTimeout(() => { try { tsync.maybeAutoSync(); } catch (_) {} }, 8000);
setInterval(() => { try { tsync.maybeAutoSync(); } catch (_) {} }, 30000);
const updater = require('./updater');
try { if (settings.getRaw('session_until_restart') === 'true') db.prepare('DELETE FROM sessions').run(); } catch (_) {}

const updateTick = async () => {
  try {
    const hrs = parseInt(settings.getRaw('update_check_interval_hours') || '24', 10);
    const auto = settings.getRaw('auto_update') === 'true';
    const scheduleAt = parseInt(settings.getRaw('update_schedule') || '', 10) || null;
    if (!hrs || hrs <= 0) return;
    const last = parseInt(settings.getRaw('update_last_check') || '0', 10) || 0;
    if (Date.now() - last < hrs * 3600 * 1000 && !scheduleAt) return;
    settings.setRaw('update_last_check', String(Date.now()));
    const c = await updater.checkForUpdate();
    if (!c.available || !c.manifest) return;
    settings.setRaw('update_available_version', c.latest);
    if (updater.shouldAutoApply({ autoUpdate: auto, scheduleAt, available: true, idleMs: updater.idleMs(), idleThreshold: 10 * 60 * 1000, now: Date.now() })) {
      settings.setRaw('update_schedule', '');
      const r = await updater.applyUpdate(c.manifest);
      if (r.ok) { console.log('TCloud auto-updated to ' + r.version + ' — restarting'); process.exit(0); }
      else console.error('Auto-update failed: ' + r.error);
    }
  } catch (_) {}
};
setTimeout(updateTick, 30 * 1000); setInterval(updateTick, 30 * 60 * 1000);

const SNAP_HOURS = parseInt(process.env.AUTO_SNAPSHOT_HOURS || (process.env.BACKUP_PASSPHRASE ? '24' : '0'), 10);
if (SNAP_HOURS > 0) {
  const snap = () => backup.pushToChannel(process.env.BACKUP_PASSPHRASE || undefined).then(() => console.log('DB snapshot pushed to channel')).catch(() => {});
  setTimeout(snap, 60 * 1000);
  setInterval(snap, SNAP_HOURS * 3600 * 1000);
}
process.once('SIGINT', async () => { await runtime.stopTelegram(); process.exit(0); });
process.once('SIGTERM', async () => { await runtime.stopTelegram(); process.exit(0); });
process.on('unhandledRejection', (err) => { console.error('Unhandled promise rejection (server kept running):', (err && err.stack) || err); });
process.on('uncaughtException', (err) => { console.error('Uncaught exception (server kept running):', (err && err.stack) || err); });
