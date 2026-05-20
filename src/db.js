const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../data.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
    role     TEXT NOT NULL DEFAULT 'user'  -- 'user' | 'astrologer'
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT UNIQUE NOT NULL,
    host_id     INTEGER NOT NULL,
    is_active   INTEGER DEFAULT 1,
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS slot_tiers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    label            TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    price_npr        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS slots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id        INTEGER NOT NULL,
    user_id        INTEGER NOT NULL,
    tier_id        INTEGER NOT NULL,
    payment_ref    TEXT UNIQUE NOT NULL,
    payment_status TEXT DEFAULT 'pending',
    starts_at      INTEGER,
    ends_at        INTEGER,
    is_active      INTEGER DEFAULT 0,
    FOREIGN KEY (room_id)  REFERENCES rooms(id),
    FOREIGN KEY (user_id)  REFERENCES users(id),
    FOREIGN KEY (tier_id)  REFERENCES slot_tiers(id)
  );
`);

// Seed tiers only if table is empty
const tierCount = db.prepare('SELECT COUNT(*) as c FROM slot_tiers').get().c;
if (tierCount === 0) {
  const insert = db.prepare(
    'INSERT INTO slot_tiers (label, duration_seconds, price_npr) VALUES (?, ?, ?)'
  );
  insert.run('Quick',    15 * 60,  99);
  insert.run('Standard', 30 * 60, 179);
  insert.run('Premium',  60 * 60, 299);
  insert.run('Extended', 90 * 60, 449);
}

module.exports = db;