'use strict';
const path = require('path');
const express = require('express');
const config = require('../config');

const db = require('./db');
const settings = require('./settings');
const roles = require('./roles');
const auth = require('./auth');
const { router, publicRouter, securityHeaders } = require('./api');
const storage = require('./storage');
const shares = require('./shares');
const backup = require('./backup');
const runtime = require('./runtime');

settings.seed();
roles.ensureDefaults();
auth.cleanupSessions();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(securityHeaders);

app.use('/api/public', publicRouter);
app.use('/api', router);

app.get('/s/:token', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'share.html')));
// Locally-stored branding assets (e.g. uploaded background image). Never on Telegram.
const _brandDir = path.join(config.dataDir, 'branding');
try { require('fs').mkdirSync(_brandDir, { recursive: true }); } catch (_) {}
app.use('/branding', express.static(_brandDir, { maxAge: '1d' }));
app.use(express.static(path.join(__dirname, '..', 'public')));


// Bind config.port; if it is busy (e.g. another TCloud instance on the same
// machine) automatically try the next ports until a free one is found.
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

runtime.startTelegram();

/* Background staging worker: drains locally-staged uploads to Telegram one file
   at a time. It no-ops when nothing is staged, the backend isn't ready, or a run
   is already in progress. Runs shortly after boot so a restart resumes pending
   uploads, then periodically. */
setTimeout(() => { try { storage.processStagingQueue(); } catch (_) {} }, 4000);
setInterval(() => { try { storage.processStagingQueue(); } catch (_) {} }, 15000);
// Best-effort: register this instance (powers the public counter) and pull any
// license bound to it (e.g. issued via Ko-fi). Never blocks startup or throws.
const updater = require('./updater');
// "Until restart" sessions: wipe all sessions at boot so logins last exactly
// until the machine/process restarts (admin-selectable in Settings/Setup).
try { if (settings.getRaw('session_until_restart') === 'true') db.prepare('DELETE FROM sessions').run(); } catch (_) {}

// ── Decentralized updates: each instance checks the project's GitHub repo on its
// own schedule (default once a day; 0 = never) and applies automatically when
// enabled — when idle or at a scheduled time. Manual check/apply always works
// from the UI. data/ and .env are never touched by an update.
const updateTick = async () => {
  try {
    const hrs = parseInt(settings.getRaw('update_check_interval_hours') || '24', 10);
    const auto = settings.getRaw('auto_update') === 'true';
    const scheduleAt = parseInt(settings.getRaw('update_schedule') || '', 10) || null;
    if (!hrs || hrs <= 0) return;                       // automatic checks disabled
    const last = parseInt(settings.getRaw('update_last_check') || '0', 10) || 0;
    if (Date.now() - last < hrs * 3600 * 1000 && !scheduleAt) return; // not due yet
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

// Automatic encrypted DB snapshot to the Telegram channel, so the database also "lives" on
// Telegram as a recoverable copy. Enabled when AUTO_SNAPSHOT_HOURS>0 (default 24h if a
// BACKUP_PASSPHRASE is set; off otherwise to avoid pushing an unencrypted snapshot).
const SNAP_HOURS = parseInt(process.env.AUTO_SNAPSHOT_HOURS || (process.env.BACKUP_PASSPHRASE ? '24' : '0'), 10);
if (SNAP_HOURS > 0) {
  const snap = () => backup.pushToChannel(process.env.BACKUP_PASSPHRASE || undefined).then(() => console.log('DB snapshot pushed to channel')).catch(() => {});
  setTimeout(snap, 60 * 1000);
  setInterval(snap, SNAP_HOURS * 3600 * 1000);
}
process.once('SIGINT', async () => { await runtime.stopTelegram(); process.exit(0); });
process.once('SIGTERM', async () => { await runtime.stopTelegram(); process.exit(0); });
