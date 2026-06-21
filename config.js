'use strict';
require('dotenv').config();

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

module.exports = {
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

  port: parseInt(process.env.PORT || '3000', 10),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  sharePort: parseInt(process.env.SHARE_PORT || '0', 10) || 0,
  shareUrl: (process.env.SHARE_URL || '').replace(/\/+$/, ''),
  supportChannel: process.env.SUPPORT_CHANNEL || 'https://t.me/tcloud_support',
  donationUrl: process.env.DONATION_URL || 'https://ko-fi.com/denilson_polonio',
  sessionDays: parseInt(process.env.SESSION_DAYS || '30', 10),
  dbPath: process.env.DB_PATH || './data/tcloud.db',
  tmpDir: process.env.TMP_DIR || './data/tmp',
  dataDir: process.env.DATA_DIR || './data',

  defaults: {
    apiRoot: 'https://api.telegram.org',
    chunkSizeMB: 18,
  },
};
