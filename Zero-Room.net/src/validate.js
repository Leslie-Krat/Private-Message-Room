/**
 * Strict input validation for every client-controlled field.
 */
export const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const ROOM_ID_RE = /^[a-f0-9]{32}$/;
const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{87}=$/;   // 65-byte P-256 point, base64
const PROOF_RE = /^[A-Za-z0-9+/]{43}=$/;        // 32-byte HMAC-SHA256, base64
const CLIENT_ID_RE = /^p_[a-f0-9]{16}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export const isRoomId = (v) => typeof v === 'string' && ROOM_ID_RE.test(v);
export const isPublicKey = (v) => typeof v === 'string' && PUBLIC_KEY_RE.test(v);
export const isProof = (v) => typeof v === 'string' && PROOF_RE.test(v);
export const isClientId = (v) => typeof v === 'string' && CLIENT_ID_RE.test(v);
export const isResumeToken = (v) => typeof v === 'string' && TOKEN_RE.test(v);

/** Control, zero-width, line/paragraph separator and bidi-override characters. */
const STRIP_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
const STRIP_RE = new RegExp(
  '[' + STRIP_RANGES.map(([a, b]) => String.fromCodePoint(a) + '-' + String.fromCodePoint(b)).join('') + ']',
  'g'
);

/** Removes invisible/control characters and limits the handle to 20 code points. */
export function cleanNickname(value) {
  if (typeof value !== 'string') return 'Anonymous';
  const limited = Array.from(value.replace(STRIP_RE, '').trim()).slice(0, 20).join('');
  return limited || 'Anonymous';
}

export function cleanExpiry(value) {
  return Number.isInteger(value) && value >= 1 && value <= 1440 ? value : 60;
}

export function cleanSeq(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** { iv, ciphertext } wrapper used for relaying an encrypted room key. */
export function isKeyPayload(v, maxChars) {
  if (!isPlainObject(v)) return false;
  const { iv, ciphertext } = v;
  if (typeof iv !== 'string' || typeof ciphertext !== 'string') return false;
  if (iv.length > 32 || ciphertext.length > maxChars) return false;
  return BASE64_RE.test(iv) && BASE64_RE.test(ciphertext);
}

const DISAPPEAR_OPTIONS = new Set([0, 30, 300, 3600, 86400]);

/** Seconds after which messages vanish. Only a few fixed choices are valid. */
export function cleanDisappear(value) {
  return Number.isInteger(value) && DISAPPEAR_OPTIONS.has(value) ? value : 0;
}

export const isBool = (v) => typeof v === 'boolean';

export const MESSAGE_KINDS = ['text', 'image', 'file', 'ctl'];
