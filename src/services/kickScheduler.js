const { LIVEKIT_ENABLED } = require('../config/livekit');

// LiveKit SDK — used only when LIVEKIT_ENABLED=true:
// const { RoomServiceClient } = require('livekit-server-sdk');
// const roomService = new RoomServiceClient(
//   process.env.LIVEKIT_URL,
//   process.env.LIVEKIT_API_KEY,
//   process.env.LIVEKIT_API_SECRET
// );

let roomService = null;
if (LIVEKIT_ENABLED) {
  const { RoomServiceClient } = require('livekit-server-sdk');
  roomService = new RoomServiceClient(
    process.env.LIVEKIT_URL,
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
}

const activeTimers = new Map();

function scheduleKick({ roomName, participantIdentity, paymentRef, endsAt, onKick }) {
  cancelKick(paymentRef);

  const now = Date.now();
  const msLeft = endsAt - now;
  const warnMs = msLeft - 5 * 60 * 1000;

  if (msLeft <= 0) {
    console.warn(`[kickScheduler] Slot already expired for ${participantIdentity}, kicking now`);
    _doKick(roomName, participantIdentity, paymentRef, onKick);
    return;
  }

  const timers = {};

  if (warnMs > 0) {
    timers.warnTimer = setTimeout(async () => {
      if (!LIVEKIT_ENABLED) {
        console.log(
          `[kickScheduler] Stub mode: SLOT_WARNING skipped for ${participantIdentity} (app uses local timer)`,
        );
        return;
      }
      try {
        const payload = Buffer.from(
          JSON.stringify({
            type: 'SLOT_WARNING',
            message: '5 minutes remaining in your time slot!',
            endsAt,
          }),
        );
        await roomService.sendData(roomName, payload, 0, {
          destinationIdentities: [participantIdentity],
        });
      } catch (e) {
        console.warn('[kickScheduler] Warning send failed:', e.message);
      }
    }, warnMs);
  }

  timers.kickTimer = setTimeout(() => {
    _doKick(roomName, participantIdentity, paymentRef, onKick);
  }, msLeft);

  activeTimers.set(paymentRef, timers);
  console.log(
    `[kickScheduler] Scheduled kick for ${participantIdentity} in ${Math.round(msLeft / 1000)}s` +
      (LIVEKIT_ENABLED ? '' : ' (stub — DB slot deactivate only)'),
  );
}

async function _doKick(roomName, participantIdentity, paymentRef, onKick) {
  if (LIVEKIT_ENABLED) {
    try {
      await roomService.removeParticipant(roomName, participantIdentity);
      console.log(`[kickScheduler] Kicked ${participantIdentity} from ${roomName}`);
    } catch (e) {
      console.warn('[kickScheduler] Kick failed (already left?):', e.message);
    }
  } else {
    console.log(
      `[kickScheduler] Stub mode: removeParticipant skipped for ${participantIdentity} in ${roomName}`,
    );
  }
  activeTimers.delete(paymentRef);
  if (onKick) onKick();
}

function cancelKick(paymentRef) {
  const existing = activeTimers.get(paymentRef);
  if (existing) {
    clearTimeout(existing.kickTimer);
    clearTimeout(existing.warnTimer);
    activeTimers.delete(paymentRef);
    console.log(`[kickScheduler] Cancelled timers for ${paymentRef}`);
  }
}

function restoreTimersFromDB(db) {
  const activeSlots = db
    .prepare(
      `
    SELECT s.*, r.name as room_name
    FROM slots s
    JOIN rooms r ON s.room_id = r.id
    WHERE s.is_active = 1
      AND s.ends_at > ?
  `,
    )
    .all(Date.now());

  if (activeSlots.length === 0) {
    console.log('[kickScheduler] No active slots to restore');
    return;
  }

  console.log(`[kickScheduler] Restoring ${activeSlots.length} kick timer(s) after restart`);

  for (const slot of activeSlots) {
    scheduleKick({
      roomName: slot.room_name,
      participantIdentity: `user_${slot.user_id}`,
      paymentRef: slot.payment_ref,
      endsAt: slot.ends_at,
      onKick: () => {
        db.prepare('UPDATE slots SET is_active = 0 WHERE id = ?').run(slot.id);
      },
    });
  }
}

module.exports = { scheduleKick, cancelKick, restoreTimersFromDB };
