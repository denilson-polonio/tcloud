'use strict';
require('dotenv').config();

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

// config.js only holds process-level defaults read from the environment.
// The live runtime configuration (bot token, channel, appearance, etc.) is
// stored in the database via src/settings.js and can be changed from the
// dashboard or the first-run setup wizard. Environment values, when present,
// are used to SEED the database on first run.
module.exports = {
  // Optional seeds (used only on first run if the DB has no value yet)
  env: {
    botToken: process.env.BOT_TOKEN || '',
    storageChannel: process.env.STORAGE_CHANNEL || '',
    apiRoot: (process.env.TELEGRAM_API_ROOT || '').replace(/\/+$/, ''),
    chunkSizeMB: process.env.CHUNK_SIZE_MB ? parseInt(process.env.CHUNK_SIZE_MB, 10) : null,
    adminUsername: process.env.ADMIN_USERNAME || '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    adminTelegramId: process.env.ADMIN_TELEGRAM_ID || '',
    allowRegistration: process.env.ALLOW_REGISTRATION !== undefined ? bool(process.env.ALLOW_REGISTRATION, false) : null,
  },

  // Hard process settings (cannot be changed at runtime)
  port: parseInt(process.env.PORT || '3000', 10),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  // TCloud licensing/registration server + community channel (overridable).
  // ── Updates (decentralized) ──
  // TCloud updates itself from GitHub Releases of the repo in package.json
  // ("repository" field). Override with UPDATE_REPO=owner/repo if you forked.
  // No other server is contacted; there is no licensing, telemetry or phone-home.
  supportChannel: process.env.SUPPORT_CHANNEL || 'https://t.me/tcloud_support',
  donationUrl: process.env.DONATION_URL || 'https://ko-fi.com/denilson_polonio',
  sessionDays: parseInt(process.env.SESSION_DAYS || '30', 10),
  dbPath: process.env.DB_PATH || './data/tcloud.db',
  tmpDir: process.env.TMP_DIR || './data/tmp',
  dataDir: process.env.DATA_DIR || './data',

  // Defaults applied when no DB value exists
  defaults: {
    apiRoot: 'https://api.telegram.org',
    chunkSizeMB: 18,
  },
};
