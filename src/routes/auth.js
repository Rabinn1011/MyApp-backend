const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db');
const authMiddleware  = require('../middleware/auth');
const { blockToken }  = require('../services/tokenBlocklist');

router.post('/register', async (req, res) => {
  const { username, password, role = 'user' } = req.body;

  // Validate role — don't let someone self-assign astrologer in production
  // For now we allow it since there's no admin panel yet
  const allowedRoles = ['user', 'astrologer'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
      .run(username, hash, role);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: 'Username already taken' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const jti   = uuidv4();
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, jti }, // role in JWT
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// Fix 10 — logout blocklists the token immediately
router.post('/logout', authMiddleware, (req, res) => {
  const { jti, exp } = req.user;
  if (jti) {
    blockToken(jti, exp * 1000); // exp is in seconds, convert to ms
  }
  res.json({ success: true });
});

module.exports = router;