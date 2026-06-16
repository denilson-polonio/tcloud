'use strict';
const db = require('./db');
const path = require('path');
const config = require('../config');

function getRaw(key) { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : undefined; }
function setRaw(key, value) { db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value == null ? null : String(value)); }
function getJSON(key, fb) { const v = getRaw(key); if (v == null) return fb; try { return JSON.parse(v); } catch (_) { return fb; } }
function setJSON(key, obj) { setRaw(key, JSON.stringify(obj)); }

const DEFAULT_APPEARANCE = {
  appName: 'TCloud', logo: '☁', theme: 'dark', accent: '#5cc8ff',
  bgStyle: 'grid', bgColor: '#0a0c10', bgColor2: '#11161f', bgImage: '',
  radius: 16, density: 'comfortable', language: 'en', brandSuffix: '',
};

function telegramConfig() {
  return {
    botToken: getRaw('bot_token') || '', storageChannel: getRaw('storage_channel') || '',
    apiRoot: (getRaw('api_root') || config.defaults.apiRoot).replace(/\/+$/, ''),
    chunkSizeMB: parseInt(getRaw('chunk_size_mb') || String(config.defaults.chunkSizeMB), 10),
  };
}
function appearance() { return Object.assign({}, DEFAULT_APPEARANCE, getJSON('appearance', {})); }
function publicConfig() { return { appearance: appearance(), allowRegistration: getRaw('allow_registration') === 'true', mode: orgMode(), orgName: orgName() }; }
function adminConfig() {
  const tg = telegramConfig();
  return {
    storageChannel: tg.storageChannel, apiRoot: tg.apiRoot, chunkSizeMB: tg.chunkSizeMB, botTokenSet: !!tg.botToken,
    acceptDrops: getRaw('accept_drops') !== 'false',
    allowRegistration: getRaw('allow_registration') === 'true',
    defaultRoleId: getRaw('default_role_id') || null,
    defaultQuotaMB: parseInt(getRaw('default_quota_mb') || '0', 10) || 0,
    mode: orgMode(), orgName: orgName(),
    sessionDays: parseInt(getRaw('session_days') || '30', 10) || 30,
    sessionUntilRestart: getRaw('session_until_restart') === 'true',
    encryption: !!getRaw('enc_key'),
    stagingEnabled: getRaw('staging_enabled') === 'true',
    stagingPath: getRaw('staging_path') || '',
    stagingMaxGB: stagingConfig().maxGB,
    autoReload: getRaw('auto_reload') !== 'false',
  };
}
function isConfigured() {
  const tg = telegramConfig();
  const hasAdmin = db.prepare("SELECT COUNT(*) c FROM users u JOIN roles r ON u.role_id=r.id WHERE r.admin=1").get().c > 0;
  return !!(tg.botToken && tg.storageChannel && hasAdmin);
}
function seed() {
  const e = config.env;
  if (getRaw('bot_token') === undefined && e.botToken) setRaw('bot_token', e.botToken);
  if (getRaw('storage_channel') === undefined && e.storageChannel) setRaw('storage_channel', e.storageChannel);
  if (getRaw('api_root') === undefined && e.apiRoot) setRaw('api_root', e.apiRoot);
  if (getRaw('chunk_size_mb') === undefined && e.chunkSizeMB) setRaw('chunk_size_mb', String(e.chunkSizeMB));
  if (getRaw('accept_drops') === undefined) setRaw('accept_drops', 'true');
  if (getRaw('allow_registration') === undefined) setRaw('allow_registration', e.allowRegistration ? 'true' : 'false');
  if (getRaw('default_quota_mb') === undefined) setRaw('default_quota_mb', '0');
  if (getRaw('org_mode') === undefined) setRaw('org_mode', 'organization');
  if (getRaw('session_days') === undefined) setRaw('session_days', '30');
  if (getRaw('session_until_restart') === undefined) setRaw('session_until_restart', 'false');
  if (getRaw('staging_enabled') === undefined) setRaw('staging_enabled', 'false');
  if (getRaw('staging_path') === undefined) setRaw('staging_path', '');
  if (getRaw('staging_max_gb') === undefined) setRaw('staging_max_gb', '5');
  if (getRaw('auto_reload') === undefined) setRaw('auto_reload', 'true');
  if (getJSON('appearance', null) === null) setJSON('appearance', DEFAULT_APPEARANCE);
}

function orgMode() { return 'organization'; }
function orgName() { return getRaw('org_name') || ''; }
function setOrg(mode, name) { setRaw('org_mode', 'organization'); if (name !== undefined) setRaw('org_name', String(name || '').slice(0, 60)); }
function titleSuffix() { return orgName() || 'TCloud'; }

function stagingConfig() {
  const enabled = getRaw('staging_enabled') === 'true';
  const custom = (getRaw('staging_path') || '').trim();
  const dir = custom || path.join(config.dataDir, 'staging');
  let gb = parseFloat(getRaw('staging_max_gb'));
  if (isNaN(gb) || gb <= 0) gb = 5;
  return { enabled, dir, maxGB: gb, maxBytes: Math.round(gb * 1024 * 1024 * 1024) };
}

module.exports = { DEFAULT_APPEARANCE, getRaw, setRaw, getJSON, setJSON, telegramConfig, appearance, publicConfig, adminConfig, isConfigured, seed, stagingConfig, orgMode, orgName, setOrg, titleSuffix };
