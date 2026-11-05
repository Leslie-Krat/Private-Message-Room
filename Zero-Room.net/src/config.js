/**
 * Central, validated server configuration.
 * Every limit can be tuned with an environment variable; defaults are conservative.
 */
const int = (value, fallback, min, max) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export const CONFIG = Object.freeze({
  PORT: int(process.env.PORT, 8888, 1, 65535),
  // Bind to loopback by default. Only the reverse proxy should reach this service.
  HOST: process.env.HOST || '127.0.0.1',

  // Transport limits
  MAX_PAYLOAD_BYTES: 2 * 1024 * 1024,          // hard cap for one WebSocket frame (an encrypted image fits)
  MAX_TEXT_CIPHERTEXT_CHARS: 32 * 1024,        // encrypted text messages
  MAX_IMAGE_CIPHERTEXT_CHARS: 2 * 1024 * 1024 - 4096, // encrypted images (must stay under MAX_PAYLOAD_BYTES)
  MAX_FILE_CIPHERTEXT_CHARS: 400 * 1024,       // one encrypted file / voice-note chunk
  MAX_CTL_CIPHERTEXT_CHARS: 8 * 1024,          // encrypted control messages (reactions, deletes)
  MAX_KEY_PAYLOAD_CHARS: 1024,                 // wrapped room keys

  // Connection limits (CGNAT-friendly: many mobile users share one IPv4)
  MAX_CONN_PER_IP: int(process.env.MAX_CONN_PER_IP, 30, 1, 1000),
  MAX_CONNECTIONS: int(process.env.MAX_CONNECTIONS, 4000, 1, 100000),

  // Room limits
  MAX_ROOMS: int(process.env.MAX_ROOMS, 2000, 1, 100000),
  MAX_ROOMS_PER_IP: int(process.env.MAX_ROOMS_PER_IP, 10, 1, 1000),
  MAX_PEERS_PER_ROOM: int(process.env.MAX_PEERS_PER_ROOM, 20, 2, 200),

  // Rate limits (per socket)
  MSG_BUCKET_CAPACITY: 25,
  MSG_BUCKET_REFILL_PER_SEC: 10,
  LIGHT_BUCKET_CAPACITY: 40,        // typing indicators and delivery acks
  LIGHT_BUCKET_REFILL_PER_SEC: 20,
  BYTE_BUCKET_CAPACITY: 6 * 1024 * 1024,
  BYTE_BUCKET_REFILL_PER_SEC: 1024 * 1024,
  ROOM_BYTE_BUCKET_CAPACITY: 10 * 1024 * 1024,
  ROOM_BYTE_BUCKET_REFILL_PER_SEC: 2 * 1024 * 1024,
  MAX_STRIKES: 100,                 // rate-limit violations before the socket is dropped

  // Backpressure: a client that cannot drain this much queued data is disconnected
  MAX_BUFFERED_BYTES: int(process.env.MAX_BUFFERED_BYTES, 4 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024),

  // Ring buffer for reconnect replay (RAM only, text messages only)
  RING_CAPACITY: int(process.env.RING_CAPACITY, 50, 1, 500),
  RING_MAX_BYTES: int(process.env.RING_MAX_BYTES, 512 * 1024, 16 * 1024, 8 * 1024 * 1024),

  // Lifecycle
  RESUME_GRACE_MS: int(process.env.RESUME_GRACE_MS, 3 * 60 * 1000, 5000, 30 * 60 * 1000),   // an abnormally disconnected member keeps its seat this long (phone app switch, Wi-Fi to LTE)
  REAPER_INTERVAL_MS: 30 * 1000,
  HEARTBEAT_INTERVAL_MS: 25 * 1000,

  // Proof-of-work for creating a room (CPU puzzle for the client, no accounts or CAPTCHAs).
  // 0 turns it off. Difficulty rises by one bit for every 10 rooms created in the last minute.
  POW_BASE_BITS: int(process.env.POW_BASE_BITS, 14, 0, 22),
  POW_MAX_EXTRA_BITS: 6,

  // Browser Origin policy for WebSocket upgrades (blocks cross-site WebSocket hijacking)
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  REQUIRE_ORIGIN: process.env.REQUIRE_ORIGIN !== '0',
});
