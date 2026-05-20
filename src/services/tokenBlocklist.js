// In-memory blocklist — survives restarts via DB
const db = require('../db');

// Add blocklist table to DB
db.exec(`
  CREATE TABLE IF NOT EXISTS token_blocklist (
    jti       TEXT PRIMARY KEY,
    blocked_at INTEGER DEFAULT (strftime('%s','now') * 1000),
    expires_at INTEGER
  );
`);

// Prune expired tokens on startup
db.prepare('DELETE FROM token_blocklist WHERE expires_at < ?').run(Date.now());

function blockToken(jti, expiresAt) {
  db.prepare('INSERT OR IGNORE INTO token_blocklist (jti, expires_at) VALUES (?, ?)')
    .run(jti, expiresAt);
}

function isBlocked(jti) {
  const row = db.prepare('SELECT 1 FROM token_blocklist WHERE jti = ?').get(jti);
  return !!row;
}

module.exports = { blockToken, isBlocked };