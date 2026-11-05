import crypto from 'node:crypto';

/** Number of leading zero bits in a hash. */
export function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Proof-of-work gate for room creation.
 *
 * The relay hands every socket a random seed and a difficulty. To create a room the client must find a
 * nonce so that SHA-256("<seed>:<roomId>:<nonce>") starts with `bits` zero bits. Checking costs one hash;
 * finding it costs the client about 2^bits hashes. Binding it to the room id means a solution cannot be reused.
 * The difficulty follows a sliding window of recent room creations, so a flood of bots makes each room more
 * expensive while normal use stays near-instant.
 */
export class PowGate {
  constructor({ baseBits = 14, maxExtraBits = 6, windowMs = 60_000, stepEvery = 10, ttlMs = 10 * 60_000 } = {}) {
    this.baseBits = baseBits;
    this.maxExtraBits = maxExtraBits;
    this.windowMs = windowMs;
    this.stepEvery = stepEvery;
    this.ttlMs = ttlMs;
    this.creates = [];   // timestamps of recent room creations, oldest first
    this.head = 0;       // index of the oldest entry still inside the window
  }

  #prune(now) {
    while (this.head < this.creates.length && now - this.creates[this.head] > this.windowMs) this.head += 1;
    if (this.head > 1024) { this.creates = this.creates.slice(this.head); this.head = 0; }
  }

  recordCreate(now = Date.now()) {
    this.creates.push(now);
    this.#prune(now);
  }

  bits(now = Date.now()) {
    if (!this.baseBits) return 0;
    this.#prune(now);
    const recent = this.creates.length - this.head;
    return this.baseBits + Math.min(this.maxExtraBits, Math.floor(recent / this.stepEvery));
  }

  issue(now = Date.now()) {
    return { seed: crypto.randomBytes(12).toString('hex'), bits: this.bits(now), issuedAt: now };
  }

  verify(challenge, roomId, nonce, now = Date.now()) {
    if (!challenge) return false;
    if (challenge.bits === 0) return true;
    if (typeof nonce !== 'string' || !/^[a-z0-9]{1,16}$/.test(nonce)) return false;
    if (now - challenge.issuedAt > this.ttlMs) return false;
    const hash = crypto.createHash('sha256').update(`${challenge.seed}:${roomId}:${nonce}`).digest();
    return leadingZeroBits(hash) >= challenge.bits;
  }
}
