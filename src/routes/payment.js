const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

/**
 * GET /payment/tiers
 * Returns available slot tiers — called by the app to build the tier picker UI.
 */
router.get('/tiers', authMiddleware, (req, res) => {
  const tiers = db.prepare('SELECT * FROM slot_tiers').all();
  res.json(tiers);
});

/**
 * POST /payment/initiate
 * App calls this when user taps "Pay".
 * Creates a pending slot + payment_ref, then simulates eSewa
 * by scheduling a self-webhook after 2 seconds.
 *
 * Body: { room_id, tier_id }
 */
router.post('/initiate', authMiddleware, (req, res) => {
  if (req.user.role !== 'user') {
    return res.status(403).json({ error: 'Only users can initiate payments' });
  }
  const { room_id, tier_id } = req.body;
  const user_id = req.user.id;

  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND is_active = 1').get(room_id);
  if (!room) return res.status(404).json({ error: 'Room not found or not active' });

  const tier = db.prepare('SELECT * FROM slot_tiers WHERE id = ?').get(tier_id);
  if (!tier) return res.status(400).json({ error: 'Invalid tier' });

  // Check if user already has an active slot in this room
  const existing = db.prepare(
    'SELECT * FROM slots WHERE room_id = ? AND user_id = ? AND is_active = 1'
  ).get(room_id, user_id);
  if (existing) {
    return res.status(400).json({ error: 'You already have an active slot in this room. Use the extend endpoint.' });
  }

  const payment_ref = `ESEWA-STUB-${uuidv4().toUpperCase()}`;

  db.prepare(`
    INSERT INTO slots (room_id, user_id, tier_id, payment_ref, payment_status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(room_id, user_id, tier_id, payment_ref);

  // Simulate eSewa processing delay (2 seconds) then fire webhook internally
  setTimeout(() => {
    simulateEsewaWebhook(payment_ref);
  }, 2000);

  res.json({
    payment_ref,
    // In real eSewa this would be a redirect URL to their payment page.
    // The app shows a fake payment screen for this duration.
    esewa_redirect_url: `STUB://pay?ref=${payment_ref}&amount=${tier.price_npr}&product=${encodeURIComponent(tier.label)}`,
    amount: tier.price_npr,
    tier,
  });
});

/**
 * POST /payment/webhook
 * In production, eSewa hits this URL after payment is confirmed.
 * In stub mode, simulateEsewaWebhook() calls this internally.
 *
 * Body: { payment_ref, status: 'COMPLETE' | 'FAILED', transaction_id }
 */
router.post('/webhook', (req, res) => {
    // Fix 7 — validate secret header
    // Real eSewa uses HMAC signature verification.
    // For the stub, we use a shared secret header.
    const incomingSecret = req.headers['x-esewa-secret'];
    if (incomingSecret !== process.env.WEBHOOK_SECRET) {
      console.warn('[webhook] Unauthorized webhook attempt');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  
    const { payment_ref, status, transaction_id } = req.body;
  
    const slot = db.prepare('SELECT * FROM slots WHERE payment_ref = ?').get(payment_ref);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    if (slot.payment_status !== 'pending') {
      return res.status(400).json({ error: 'Slot already processed' });
    }
  
    if (status === 'COMPLETE') {
      db.prepare(`UPDATE slots SET payment_status = 'completed', payment_ref = ? WHERE payment_ref = ?`)
        .run(transaction_id || payment_ref, payment_ref);
      return res.json({ success: true });
    }
  
    db.prepare(`UPDATE slots SET payment_status = 'failed' WHERE payment_ref = ?`).run(payment_ref);
    return res.json({ success: false });
  });

/**
 * GET /payment/status/:ref
 * App polls this every 1s after initiating payment.
 * Returns payment_status so the app knows when to proceed.
 */
router.get('/status/:ref', authMiddleware, (req, res) => {
  const slot = db.prepare('SELECT * FROM slots WHERE payment_ref = ?')
    .get(req.params.ref);
  if (!slot) return res.status(404).json({ error: 'Not found' });

  // Only return what the app needs — don't expose internal fields
  res.json({
    payment_status: slot.payment_status,
    tier_id: slot.tier_id,
    room_id: slot.room_id,
  });
});

/**
 * POST /payment/extend
 * User buys more time while already in the room.
 * Cancels existing kick timer, pushes ends_at forward.
 *
 * Body: { room_id, tier_id }
 */
router.post('/extend', authMiddleware, (req, res) => {
  const { room_id, tier_id } = req.body;
  const user_id = req.user.id;

  const activeSlot = db.prepare(
    'SELECT * FROM slots WHERE room_id = ? AND user_id = ? AND is_active = 1'
  ).get(room_id, user_id);
  if (!activeSlot) {
    return res.status(400).json({ error: 'No active slot to extend' });
  }

  const tier = db.prepare('SELECT * FROM slot_tiers WHERE id = ?').get(tier_id);
  if (!tier) return res.status(400).json({ error: 'Invalid tier' });

  const payment_ref = `ESEWA-STUB-EXT-${uuidv4().toUpperCase()}`;

  // Store extension as a pending slot linked to same room/user
  // We'll activate it in the webhook
  db.prepare(`
    INSERT INTO slots (room_id, user_id, tier_id, payment_ref, payment_status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(room_id, user_id, tier_id, payment_ref);

  // Simulate eSewa 2s delay
  setTimeout(() => {
    simulateEsewaWebhook(payment_ref, { isExtension: true, existingSlotId: activeSlot.id });
  }, 2000);

  res.json({
    payment_ref,
    esewa_redirect_url: `STUB://pay?ref=${payment_ref}&amount=${tier.price_npr}&product=Extension+${tier.label}`,
    amount: tier.price_npr,
    tier,
    current_ends_at: activeSlot.ends_at,
  });
});

// ─── Internal stub helper ────────────────────────────────────────────────────

function simulateEsewaWebhook(payment_ref, meta = {}) {
    // Internal call — attach the secret just like real eSewa would
    const axios = require('axios');
    axios.post(`http://localhost:${process.env.PORT || 3000}/payment/webhook`, {
      payment_ref,
      status: 'COMPLETE',
      transaction_id: `TXN-${require('uuid').v4().toUpperCase()}`,
      ...meta,
    }, {
      headers: { 'x-esewa-secret': process.env.WEBHOOK_SECRET }
    }).catch(e => console.error('[simulateEsewaWebhook] Self-call failed:', e.message));
  }

module.exports = router;