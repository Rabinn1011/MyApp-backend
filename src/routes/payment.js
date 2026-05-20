const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { scheduleKick, cancelKick } = require('../services/kickScheduler');

const EXT_PAYMENT_PREFIX = 'ESEWA-STUB-EXT-';

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
      // Keep payment_ref unchanged — the app polls with the original ESEWA-STUB-* ref
      db.prepare(`UPDATE slots SET payment_status = 'completed' WHERE payment_ref = ?`).run(
        payment_ref,
      );
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

  const body = {
    payment_status: slot.payment_status,
    tier_id: slot.tier_id,
    room_id: slot.room_id,
  };

  if (
    req.params.ref.startsWith(EXT_PAYMENT_PREFIX) &&
    (slot.payment_status === 'completed' || slot.payment_status === 'applied')
  ) {
    const active = db.prepare(`
      SELECT ends_at FROM slots
      WHERE room_id = ? AND user_id = ? AND is_active = 1
    `).get(slot.room_id, slot.user_id);
    if (active) {
      body.new_ends_at = active.ends_at;
    }
  }

  res.json(body);
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
    simulateEsewaWebhook(payment_ref);
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

function applySlotExtension(extensionPaymentRef) {
  const extSlot = db.prepare('SELECT * FROM slots WHERE payment_ref = ?').get(
    extensionPaymentRef,
  );
  if (!extSlot) {
    return null;
  }

  const tier = db.prepare('SELECT * FROM slot_tiers WHERE id = ?').get(extSlot.tier_id);
  const active = db.prepare(`
    SELECT s.*, r.name as room_name
    FROM slots s
    JOIN rooms r ON s.room_id = r.id
    WHERE s.room_id = ? AND s.user_id = ? AND s.is_active = 1
  `).get(extSlot.room_id, extSlot.user_id);

  if (!tier || !active) {
    console.warn('[payment] No active slot to extend for', extensionPaymentRef);
    return null;
  }

  const newEndsAt = active.ends_at + tier.duration_seconds * 1000;
  db.prepare('UPDATE slots SET ends_at = ? WHERE id = ?').run(newEndsAt, active.id);

  cancelKick(active.payment_ref);
  scheduleKick({
    roomName: active.room_name,
    participantIdentity: `user_${active.user_id}`,
    paymentRef: active.payment_ref,
    endsAt: newEndsAt,
    onKick: () => {
      db.prepare('UPDATE slots SET is_active = 0 WHERE id = ?').run(active.id);
    },
  });

  db.prepare(`UPDATE slots SET payment_status = 'applied' WHERE payment_ref = ?`).run(
    extensionPaymentRef,
  );

  console.log(
    `[payment] Extended slot ${active.id} by ${tier.duration_seconds}s → ends ${newEndsAt}`,
  );
  return newEndsAt;
}

function completeStubPayment(payment_ref) {
  const slot = db.prepare('SELECT * FROM slots WHERE payment_ref = ?').get(payment_ref);
  if (!slot) {
    console.warn('[payment] Stub complete: slot not found for', payment_ref);
    return false;
  }
  if (slot.payment_status !== 'pending') {
    return true;
  }
  db.prepare(`UPDATE slots SET payment_status = 'completed' WHERE payment_ref = ?`).run(
    payment_ref,
  );
  console.log('[payment] Stub payment completed:', payment_ref);

  if (payment_ref.startsWith(EXT_PAYMENT_PREFIX)) {
    applySlotExtension(payment_ref);
  }
  return true;
}

function simulateEsewaWebhook(payment_ref) {
  try {
    completeStubPayment(payment_ref);
  } catch (e) {
    console.error('[simulateEsewaWebhook] failed:', e.message);
  }
}

module.exports = router;