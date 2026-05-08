const { RoomServiceClient } = require('livekit-server-sdk');

// Map of payment_ref -> { kickTimer, warnTimer }
const activeTimers = new Map();

const roomService = new RoomServiceClient(
  process.env.LIVEKIT_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

/**
 * Schedule a warning Data Message + kick for a slot.
 *
 * @param {object} opts
 * @param {string} opts.roomName
 * @param {string} opts.participantIdentity  - "user_{id}" string
 * @param {string} opts.paymentRef
 * @param {number} opts.endsAt               - Unix ms timestamp
 * @param {function} opts.onKick             - called after kick (to update DB)
 */
function scheduleKick({ roomName, participantIdentity, paymentRef, endsAt, onKick }) {
  // Clear any existing timers for this ref (handles extensions)
  cancelKick(paymentRef);

  const now       = Date.now();
  const msLeft    = endsAt - now;
  const warnMs    = msLeft - 5 * 60 * 1000; // 5 min before end

  const timers = {};

  // 5-minute warning via LiveKit Data Message
  if (warnMs > 0) {
    timers.warnTimer = setTimeout(async () => {
      try {
        const payload = Buffer.from(JSON.stringify({
          type: 'SLOT_WARNING',
          message: '5 minutes remaining in your time slot!',
          endsAt,
        }));
        await roomService.sendData(roomName, payload, 0 /* RELIABLE */, {
          destinationIdentities: [participantIdentity],
        });
      } catch (e) {
        console.warn(`[kickScheduler] Warning send failed for ${participantIdentity}:`, e.message);
      }
    }, warnMs);
  }

  // Hard kick at endsAt
  timers.kickTimer = setTimeout(async () => {
    try {
      await roomService.removeParticipant(roomName, participantIdentity);
      console.log(`[kickScheduler] Kicked ${participantIdentity} from ${roomName}`);
    } catch (e) {
      // Participant may have already left — not an error worth crashing over
      console.warn(`[kickScheduler] Kick failed (already left?):`, e.message);
    } finally {
      activeTimers.delete(paymentRef);
      if (onKick) onKick();
    }
  }, msLeft);

  activeTimers.set(paymentRef, timers);
  console.log(`[kickScheduler] Scheduled kick for ${participantIdentity} in ${Math.round(msLeft/1000)}s`);
}

function cancelKick(paymentRef) {
  const existing = activeTimers.get(paymentRef);
  if (existing) {
    clearTimeout(existing.kickTimer);
    clearTimeout(existing.warnTimer);
    activeTimers.delete(paymentRef);
    console.log(`[kickScheduler] Cancelled timers for ref ${paymentRef}`);
  }
}

module.exports = { scheduleKick, cancelKick };