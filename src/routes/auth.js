const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { blockToken } = require('../services/tokenBlocklist');

router.post('/register', async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = req.body.password;
  const role = req.body.role ?? 'user';

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const allowedRoles = ['user', 'astrologer'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(400).json({ error: 'Username already taken' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(
      username,
      hash,
      role,
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[register] failed:', e.message);
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Username already taken' });
    }
    return res.status(500).json({ error: 'Registration failed. Restart the backend and try again.' });
  }
});

router.post('/login', async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const { password } = req.body;

  if (!username || !password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const jti = uuidv4();
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, jti },
    process.env.JWT_SECRET,
    { expiresIn: '7d' },
  );

  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
  });
});

router.post('/logout', authMiddleware, (req, res) => {
  const { jti, exp } = req.user;
  if (jti) {
    blockToken(jti, exp * 1000);
  }
  res.json({ success: true });
});

module.exports = router;
