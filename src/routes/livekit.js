const express = require('express');
const router  = express.Router();
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { scheduleKick } = require('../services/kickScheduler');

const roomService = new RoomServiceClient(
  process.env.LIVEKIT_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

// ── Existing: create-room ────────────────────────────────────────────────────
router.post('/create-room', authMiddleware, async (req, res) => {
  if (req.user.role !== 'astrologer') {
    return res.status(403).json({ error: 'Only astrologers can broadcast' });
  }
  
  const { room_name } = req.body;
  const host_id = req.user.id;

  // Create LiveKit room first
  try {
    await roomService.createRoom({ name: room_name, emptyTimeout: 300, maxParticipants: 100 });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to create LiveKit room: ' + e.message });
  }

  // Fix 5 — if DB insert fails, clean up the LiveKit room
  try {
    db.prepare('INSERT INTO rooms (name, host_id) VALUES (?, ?)').run(room_name, host_id);
  } catch (e) {
    console.error('[create-room] DB insert failed, rolling back LiveKit room:', e.message);
    try {
      await roomService.deleteRoom(room_name);
    } catch (cleanupErr) {
      console.error('[create-room] LiveKit cleanup also failed:', cleanupErr.message);
    }
    return res.status(500).json({ error: 'Failed to persist room, please try again' });
  }

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    { identity: `user_${host_id}`, name: req.user.username }
  );
  at.addGrant({ roomJoin: true, room: room_name, canPublish: true, canSubscribe: true });

  res.json({ token: await at.toJwt(), room_name });
});

// ── Existing: rooms list ─────────────────────────────────────────────────────
router.get('/rooms', authMiddleware, (req, res) => {
  const rooms = db.prepare(
    'SELECT r.*, u.username as host_name FROM rooms r JOIN users u ON r.host_id = u.id WHERE r.is_active = 1'
  ).all();
  res.json(rooms);
});

// ── Existing: end-room ───────────────────────────────────────────────────────
router.post('/end-room', authMiddleware, async (req, res) => {
  const { room_name } = req.body;

  // Fix 4 — validate ownership before doing anything
  const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(room_name);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  if (room.host_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the host can end this room' });
  }

  try {
    await roomService.deleteRoom(room_name);
    db.prepare('UPDATE rooms SET is_active = 0 WHERE name = ?').run(room_name);
    // Also deactivate all active slots in this room
    db.prepare('UPDATE slots SET is_active = 0 WHERE room_id = ?').run(room.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── New: join-slot (paid viewer) ─────────────────────────────────────────────
router.post('/join-slot', authMiddleware, async (req, res) => {
  const { room_id } = req.body;
  const user_id = req.user.id;

  const slot = db.prepare(`
    SELECT s.*, t.duration_seconds, t.label as tier_label
    FROM slots s
    JOIN slot_tiers t ON s.tier_id = t.id
    WHERE s.room_id = ? AND s.user_id = ?
      AND s.payment_status = 'completed'
      AND s.is_active = 0
    ORDER BY s.id DESC LIMIT 1
  `).get(room_id, user_id);

  if (!slot) return res.status(403).json({ error: 'No valid paid slot found' });

  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND is_active = 1').get(room_id);
  if (!room) return res.status(404).json({ error: 'Room not found or ended' });

  const now    = Date.now();
  const endsAt = now + slot.duration_seconds * 1000;

  // Fix 3 — wrap DB write + kick scheduling in a transaction
  // If anything throws, the DB update rolls back automatically
  const activate = db.transaction(() => {
    db.prepare(`
      UPDATE slots SET is_active = 1, starts_at = ?, ends_at = ? WHERE id = ?
    `).run(now, endsAt, slot.id);
  });

  try {
    activate(); // DB write is atomic

    // Schedule kick only after DB is committed
    scheduleKick({
      roomName:            room.name,
      participantIdentity: `user_${user_id}`,
      paymentRef:          slot.payment_ref,
      endsAt,
      onKick: () => {
        db.prepare('UPDATE slots SET is_active = 0 WHERE id = ?').run(slot.id);
      },
    });
  } catch (e) {
    console.error('[join-slot] Transaction failed:', e.message);
    return res.status(500).json({ error: 'Failed to activate slot' });
  }

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    { identity: `user_${user_id}`, name: req.user.username }
  );
  at.addGrant({ roomJoin: true, room: room.name, canPublish: false, canSubscribe: true });

  res.json({
    token: await at.toJwt(),
    room_name: room.name,
    slot: { id: slot.id, endsAt, tierLabel: slot.tier_label, durationSeconds: slot.duration_seconds },
  });
});

module.exports = router;