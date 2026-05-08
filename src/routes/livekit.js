const express = require('express');
const { RoomServiceClient, AccessToken } = require('livekit-server-sdk');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const roomService = new RoomServiceClient(
  process.env.LIVEKIT_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

// POST /livekit/create-room
// Broadcaster calls this to start a stream
router.post('/create-room', authMiddleware, async (req, res) => {
  const { roomName } = req.body;

  if (!roomName) {
    return res.status(400).json({ error: 'roomName is required' });
  }

  try {
    // Create room in LiveKit
    await roomService.createRoom({ name: roomName });

    // Save room in DB
    const existing = db.prepare('SELECT * FROM rooms WHERE room_name = ?').get(roomName);
    if (existing) {
      return res.status(409).json({ error: 'Room name already taken' });
    }

    db.prepare('INSERT INTO rooms (room_name, host_id) VALUES (?, ?)').run(roomName, req.user.id);

    // Generate publisher token for broadcaster
    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: req.user.username }
    );

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,       // broadcaster can send video/audio
      canSubscribe: true,
    });

    return res.json({ token: await token.toJwt(), roomName });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create room' });
  }
});

// POST /livekit/join-room
// Viewer calls this to get a token and join
router.post('/join-room', authMiddleware, async (req, res) => {
  const { roomName } = req.body;

  if (!roomName) {
    return res.status(400).json({ error: 'roomName is required' });
  }

  try {
    const room = db.prepare('SELECT * FROM rooms WHERE room_name = ? AND is_active = 1').get(roomName);
    if (!room) {
      return res.status(404).json({ error: 'Room not found or has ended' });
    }

    // Generate subscriber token for viewer
    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: req.user.username }
    );

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: false,      // viewer cannot send video/audio
      canSubscribe: true,
    });

    return res.json({ token: await token.toJwt(), roomName });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to join room' });
  }
});

// GET /livekit/rooms
// Anyone can see active rooms
router.get('/rooms', authMiddleware, async (req, res) => {
  try {
    const rooms = db.prepare(`
      SELECT r.id, r.room_name, r.created_at, u.username as host_username
      FROM rooms r
      JOIN users u ON r.host_id = u.id
      WHERE r.is_active = 1
      ORDER BY r.created_at DESC
    `).all();

    return res.json({ rooms });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// POST /livekit/end-room
// Only the broadcaster can end their own room
router.post('/end-room', authMiddleware, async (req, res) => {
  const { roomName } = req.body;

  try {
    const room = db.prepare('SELECT * FROM rooms WHERE room_name = ? AND host_id = ?').get(roomName, req.user.id);
    if (!room) {
      return res.status(403).json({ error: 'Room not found or you are not the host' });
    }

    await roomService.deleteRoom(roomName);
    db.prepare('UPDATE rooms SET is_active = 0 WHERE room_name = ?').run(roomName);

    return res.json({ message: 'Room ended' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to end room' });
  }
});

module.exports = router;