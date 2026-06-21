'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.tmpDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
-- ─────────────────────────────── Roles ───────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  admin      INTEGER NOT NULL DEFAULT 0,   -- 1 = superuser (all permissions)
  perms      TEXT NOT NULL DEFAULT '{}',   -- JSON permission set
  builtin    INTEGER NOT NULL DEFAULT 0,   -- 1 = cannot be deleted
  created_at INTEGER NOT NULL
);

-- ─────────────────────────────── Users ───────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash     TEXT NOT NULL,
  pass_salt     TEXT NOT NULL,
  role_id       TEXT,
  perms_override TEXT NOT NULL DEFAULT '{}', -- per-user overrides on top of the role
  quota         INTEGER NOT NULL DEFAULT 0,  -- bytes, 0 = unlimited
  telegram_id   TEXT,
  prefs         TEXT NOT NULL DEFAULT '{}',
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  persistent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT,
  owner_id   TEXT NOT NULL,
  system     INTEGER NOT NULL DEFAULT 0,   -- 1 = per-user TDrop inbox
  created_at INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id)  REFERENCES users(id)   ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  folder_id  TEXT,
  owner_id   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mime       TEXT,
  source     TEXT NOT NULL DEFAULT 'web',   -- web | tdrop | share | restored
  meta       TEXT NOT NULL DEFAULT '{}',
  starred    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id)  REFERENCES users(id)   ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  file_id_tg  TEXT NOT NULL,
  message_id  INTEGER,
  size        INTEGER NOT NULL,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shares (
  id            TEXT PRIMARY KEY,            -- public token / custom slug
  owner_id      TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  label         TEXT,
  permission    TEXT NOT NULL DEFAULT 'download',
  allow_upload  INTEGER NOT NULL DEFAULT 0,
  upload_only   INTEGER NOT NULL DEFAULT 0,
  pass_hash     TEXT,
  pass_salt     TEXT,
  expires_at    INTEGER,
  max_downloads INTEGER,
  downloads     INTEGER NOT NULL DEFAULT 0,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Durable queue of Telegram message IDs to delete in the background. Populated in
-- the same transaction as a file/folder delete, so TCloud's DB is always cleaned
-- up atomically while the (slow, rate-limited) Telegram cleanup happens after and
-- survives crashes/restarts. No foreign key: the source rows are already gone.
CREATE TABLE IF NOT EXISTS pending_deletions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- TSync index: maps a file in the local sync folder (by name) to the TCloud file
-- it syncs with, plus the last-synced local size/mtime, so the sync engine can
-- detect what changed on each side without re-transferring unchanged files.
CREATE TABLE IF NOT EXISTS tsync_index (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path    TEXT NOT NULL,
  file_id     TEXT,
  local_size  INTEGER,
  local_mtime INTEGER,
  tcloud_size INTEGER,
  synced_at   INTEGER,
  UNIQUE(rel_path)
);

CREATE TABLE IF NOT EXISTS extensions (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  version      TEXT,
  repo         TEXT,
  ref          TEXT,
  manifest     TEXT,
  code         TEXT,
  enabled      INTEGER DEFAULT 1,
  installed_at INTEGER,
  updated_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_folders_owner  ON folders(owner_id);
CREATE INDEX IF NOT EXISTS idx_files_folder   ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_owner    ON files(owner_id);
CREATE INDEX IF NOT EXISTS idx_chunks_file    ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_shares_owner   ON shares(owner_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_role     ON users(role_id);
`);

function hasColumn(table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch (_) { return false; }
}
function addColumn(table, col, def) { if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }

const MIGRATIONS = [
  () => {
    addColumn('shares', 'upload_only', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('folders', 'color', 'TEXT');
    addColumn('folders', 'icon', 'TEXT');
    addColumn('folders', 'shadow', 'INTEGER');
  },
  () => {
    addColumn('users', 'is_owner', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('users', 'two_factor_method', 'TEXT');
    addColumn('users', 'two_factor_secret', 'TEXT');
  },
  () => {
    addColumn('chunks', 'enc', 'INTEGER NOT NULL DEFAULT 0');
  },
  () => {
    db.exec(`CREATE TABLE IF NOT EXISTS tdrop_guests (
      id          TEXT PRIMARY KEY,
      username    TEXT NOT NULL COLLATE NOCASE UNIQUE,
      telegram_id TEXT,
      folder_id   TEXT,
      invited_by  TEXT NOT NULL,
      expires_at  INTEGER,
      uploads     INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      linked_at   INTEGER
    );`);
  },
  () => {
    addColumn('folders', 'note', 'TEXT');
  },
  () => {
    addColumn('files', 'staged_path', 'TEXT');
  }
];
let _v = db.pragma('user_version', { simple: true }) || 0;
for (; _v < MIGRATIONS.length; _v++) { db.transaction(MIGRATIONS[_v])(); db.pragma(`user_version = ${_v + 1}`); }

module.exports = db;
