const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { scheduleKick } = require('../services/kickScheduler');
const { LIVEKIT_ENABLED, stubLiveKitToken } = require('../config/livekit');

// LiveKit SDK — enable when LIVEKIT_ENABLED=true in .env:
// const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
// const roomService = new RoomServiceClient(
//   process.env.LIVEKIT_URL,
//   process.env.LIVEKIT_API_KEY,
//   process.env.LIVEKIT_API_SECRET
// );

let roomService = null;
let AccessToken = null;
if (LIVEKIT_ENABLED) {
  const sdk = require('livekit-server-sdk');
  AccessToken = sdk.AccessToken;
  roomService = new sdk.RoomServiceClient(
    process.env.LIVEKIT_URL,
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
}

async function issueHostToken(hostId, username, roomName) {
  if (!LIVEKIT_ENABLED) {
    return stubLiveKitToken(`user_${hostId}`, roomName);
  }
  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    { identity: `user_${hostId}`, name: username },
  );
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  return at.toJwt();
}

async function issueViewerToken(userId, username, roomName) {
  if (!LIVEKIT_ENABLED) {
    return stubLiveKitToken(`user_${userId}`, roomName);
  }
  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    { identity: `user_${userId}`, name: username },
  );
  at.addGrant({ roomJoin: true, room: roomName, canPublish: false, canSubscribe: true });
  return at.toJwt();
}

router.post('/create-room', authMiddleware, async (req, res) => {
  if (req.user.role !== 'astrologer') {
    return res.status(403).json({ error: 'Only astrologers can broadcast' });
  }

  const { room_name } = req.body;
  const host_id = req.user.id;

  if (LIVEKIT_ENABLED) {
    try {
      await roomService.createRoom({
        name: room_name,
        emptyTimeout: 300,
        maxParticipants: 100,
      });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to create LiveKit room: ' + e.message });
    }
  } else {
    console.log(`[create-room] Stub mode: skipping LiveKit createRoom for ${room_name}`);
  }

  try {
    db.prepare('INSERT INTO rooms (name, host_id) VALUES (?, ?)').run(room_name, host_id);
  } catch (e) {
    console.error('[create-room] DB insert failed:', e.message);
    if (LIVEKIT_ENABLED) {
      try {
        await roomService.deleteRoom(room_name);
      } catch (cleanupErr) {
        console.error('[create-room] LiveKit cleanup also failed:', cleanupErr.message);
      }
    }
    return res.status(500).json({ error: 'Failed to persist room, please try again' });
  }

  const token = await issueHostToken(host_id, req.user.username, room_name);
  res.json({ token, room_name });
});

router.get('/rooms', authMiddleware, (req, res) => {
  const rooms = db
    .prepare(
      'SELECT r.*, u.username as host_name FROM rooms r JOIN users u ON r.host_id = u.id WHERE r.is_active = 1',
    )
    .all();
  res.json(rooms);
});

router.post('/end-room', authMiddleware, async (req, res) => {
  const { room_name } = req.body;

  const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(room_name);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  if (room.host_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the host can end this room' });
  }

  try {
    if (LIVEKIT_ENABLED) {
      await roomService.deleteRoom(room_name);
    } else {
      console.log(`[end-room] Stub mode: skipping LiveKit deleteRoom for ${room_name}`);
    }
    db.prepare('UPDATE rooms SET is_active = 0 WHERE name = ?').run(room_name);
    db.prepare('UPDATE slots SET is_active = 0 WHERE room_id = ?').run(room.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function slotPayload(slot, endsAt) {
  return {
    id: slot.id,
    endsAt,
    tierLabel: slot.tier_label,
    durationSeconds: slot.duration_seconds,
  };
}

router.post('/join-slot', authMiddleware, async (req, res) => {
  const { room_id } = req.body;
  const user_id = req.user.id;
  const now = Date.now();

  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND is_active = 1').get(room_id);
  if (!room) return res.status(404).json({ error: 'Room not found or ended' });

  // Expire finished slots so the user can purchase again
  db.prepare(`
    UPDATE slots SET is_active = 0
    WHERE room_id = ? AND user_id = ? AND is_active = 1 AND ends_at <= ?
  `).run(room_id, user_id, now);

  // Rejoin: already in the room with time remaining (e.g. app was closed)
  const activeSlot = db
    .prepare(
      `
    SELECT s.*, t.duration_seconds, t.label as tier_label
    FROM slots s
    JOIN slot_tiers t ON s.tier_id = t.id
    WHERE s.room_id = ? AND s.user_id = ?
      AND s.is_active = 1
      AND s.ends_at > ?
    ORDER BY s.id DESC LIMIT 1
  `,
    )
    .get(room_id, user_id, now);

  if (activeSlot) {
    try {
      scheduleKick({
        roomName: room.name,
        participantIdentity: `user_${user_id}`,
        paymentRef: activeSlot.payment_ref,
        endsAt: activeSlot.ends_at,
        onKick: () => {
          db.prepare('UPDATE slots SET is_active = 0 WHERE id = ?').run(activeSlot.id);
        },
      });
    } catch (e) {
      console.error('[join-slot] Rejoin schedule failed:', e.message);
    }

    const token = await issueViewerToken(user_id, req.user.username, room.name);
    return res.json({
      token,
      room_name: room.name,
      slot: slotPayload(activeSlot, activeSlot.ends_at),
      rejoin: true,
    });
  }

  // First join: activate a paid slot that has not been used yet
  const slot = db
    .prepare(
      `
    SELECT s.*, t.duration_seconds, t.label as tier_label
    FROM slots s
    JOIN slot_tiers t ON s.tier_id = t.id
    WHERE s.room_id = ? AND s.user_id = ?
      AND s.payment_status = 'completed'
      AND s.is_active = 0
    ORDER BY s.id DESC LIMIT 1
  `,
    )
    .get(room_id, user_id);

  if (!slot) {
    return res.status(403).json({ error: 'No valid paid slot found' });
  }

  const endsAt = now + slot.duration_seconds * 1000;

  const activate = db.transaction(() => {
    db.prepare(`
      UPDATE slots SET is_active = 1, starts_at = ?, ends_at = ? WHERE id = ?
    `).run(now, endsAt, slot.id);
  });

  try {
    activate();

    scheduleKick({
      roomName: room.name,
      participantIdentity: `user_${user_id}`,
      paymentRef: slot.payment_ref,
      endsAt,
      onKick: () => {
        db.prepare('UPDATE slots SET is_active = 0 WHERE id = ?').run(slot.id);
      },
    });
  } catch (e) {
    console.error('[join-slot] Transaction failed:', e.message);
    return res.status(500).json({ error: 'Failed to activate slot' });
  }

  const token = await issueViewerToken(user_id, req.user.username, room.name);

  res.json({
    token,
    room_name: room.name,
    slot: slotPayload(slot, endsAt),
    rejoin: false,
  });
});

module.exports = router;
