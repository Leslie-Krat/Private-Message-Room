/**
 * Proof-of-work solver (pure JS, no DOM). Finds a nonce so that SHA-256("<seed>:<roomId>:<nonce>")
 * starts with `bits` zero bits. A small hand-written SHA-256 is about 5x faster here than calling
 * SubtleCrypto once per attempt, which matters because the work is done in the visitor's browser.
 */
const PRIMES = [];
for (let n = 2; PRIMES.length < 64; n++) {
  if (PRIMES.every((p) => n % p !== 0)) PRIMES.push(n);
}
const frac32 = (x) => Math.floor((x - Math.floor(x)) * 4294967296) >>> 0;
const K = Uint32Array.from(PRIMES, (p) => frac32(Math.cbrt(p)));
const H0 = Uint32Array.from(PRIMES.slice(0, 8), (p) => frac32(Math.sqrt(p)));

const W = new Uint32Array(64);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

function compress(state, block, offset) {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    W[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15], b = W[i - 2];
    const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
    const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = 0; i < 64; i++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0; state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0; state[5] = (state[5] + f) | 0; state[6] = (state[6] + g) | 0; state[7] = (state[7] + h) | 0;
}

/** SHA-256 of a byte array. Returns the 32-byte digest. */
export function sha256(bytes) {
  const len = bytes.length;
  const blocks = Math.ceil((len + 9) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(buf.length - 8, Math.floor((len * 8) / 4294967296));
  view.setUint32(buf.length - 4, (len * 8) >>> 0);
  const state = Int32Array.from(H0);
  for (let o = 0; o < buf.length; o += 64) compress(state, buf, o);
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, state[i]);
  return out;
}

export function leadingZeroBits(hash) {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Searches nonces start, start+step, start+2*step, ... (written in base 36). Several workers can share the
 * search by using different starts and the same step. Returns the nonce, or null when `shouldStop()` says so.
 */
export function solve({ seed, roomId, bits, start = 0, step = 1, shouldStop = () => false, onProgress = null }) {
  const prefix = new TextEncoder().encode(`${seed}:${roomId}:`);
  const buf = new Uint8Array(prefix.length + 16);
  buf.set(prefix);
  for (let n = start, tries = 0; ; n += step, tries++) {
    const nonce = n.toString(36);
    for (let i = 0; i < nonce.length; i++) buf[prefix.length + i] = nonce.charCodeAt(i);
    if (leadingZeroBits(sha256(buf.subarray(0, prefix.length + nonce.length))) >= bits) return nonce;
    if ((tries & 0x3fff) === 0x3fff) {
      if (shouldStop()) return null;
      onProgress?.(tries);
    }
  }
}
