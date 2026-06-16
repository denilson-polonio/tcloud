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

CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_folders_owner  ON folders(owner_id);
CREATE INDEX IF NOT EXISTS idx_files_folder   ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_owner    ON files(owner_id);
CREATE INDEX IF NOT EXISTS idx_chunks_file    ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_shares_owner   ON shares(owner_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_role     ON users(role_id);
`);

/* ─────────────────────── Schema migrations ───────────────────────
   Additive and idempotent: they only ADD things, never drop or rewrite data, so
   upgrading TCloud to a newer version never loses files or settings. A version
   counter (PRAGMA user_version) ensures each migration runs at most once. To ship
   a schema change in a future release, append a function to MIGRATIONS — existing
   installs run only the new ones on next start. */
function hasColumn(table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch (_) { return false; }
}
function addColumn(table, col, def) { if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }

const MIGRATIONS = [
  // v1 — per-folder customization + share upload-only (backfill old DBs)
  () => {
    addColumn('shares', 'upload_only', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('folders', 'color', 'TEXT');
    addColumn('folders', 'icon', 'TEXT');
    addColumn('folders', 'shadow', 'INTEGER');
  },
  // v2 — Owner & 2FA
  () => {
    addColumn('users', 'is_owner', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('users', 'two_factor_method', 'TEXT');
    addColumn('users', 'two_factor_secret', 'TEXT');
  },
  // v3 — At-rest chunk encryption (AES-256-GCM before sending to Telegram)
  () => {
    addColumn('chunks', 'enc', 'INTEGER NOT NULL DEFAULT 0');
  },
  // v4 — TDrop guests (externals invited by @username, with optional deadline)
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
  // v5 — Native folder notes (a text note pinned to the top of a folder)
  () => {
    addColumn('folders', 'note', 'TEXT');
  },
  // v6 — Local staging buffer: a file can sit in a local folder (staged_path) and
  // be uploaded to Telegram later by a background worker. NULL = normal file that
  // already lives on Telegram, so existing rows are unaffected.
  () => {
    addColumn('files', 'staged_path', 'TEXT');
  }
];
let _v = db.pragma('user_version', { simple: true }) || 0;
for (; _v < MIGRATIONS.length; _v++) { db.transaction(MIGRATIONS[_v])(); db.pragma(`user_version = ${_v + 1}`); }

module.exports = db;
