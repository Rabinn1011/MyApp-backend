/**
 * LiveKit Cloud / self-hosted integration toggle.
 * Default: stub mode (no LIVEKIT_URL / API keys required).
 * Set LIVEKIT_ENABLED=true in .env when credentials are ready.
 */
const LIVEKIT_ENABLED = process.env.LIVEKIT_ENABLED === 'true';

/** Placeholder JWT for app routes while streaming is disabled */
function stubLiveKitToken(identity, roomName) {
  return `stub-token:${identity}:${roomName}:${Date.now()}`;
}

module.exports = { LIVEKIT_ENABLED, stubLiveKitToken };
