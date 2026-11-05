/**
 * Zero-Room crypto engine, protocol v2.
 *
 * Trust model
 * - The invite link carries a random 128-bit secret in its URL fragment (#...). Browsers never send
 *   the fragment to any server, so neither the relay nor nginx ever sees it.
 * - Both the room id (a hash) and a member-authentication key are derived from that secret with HKDF.
 *   The relay only ever sees the room id.
 * - Each member signs (HMAC) its ECDH public key together with its server-assigned client id. Peers
 *   only trust keys with a valid proof, so a relay or an uninvited visitor cannot slip in a key.
 * - The room key is distributed with ECDH + HKDF + AES-256-GCM, bound to room, sender and receiver
 *   through the AAD. Keys carry an epoch number; the key rotates when someone leaves.
 * - Messages are AES-256-GCM with the sender id, kind and epoch bound through the AAD.
 *
 * Keys live only in memory (JS heap). Nothing is written to disk or to web storage.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

const HKDF_SALT = enc.encode('zeroroom/v2');
const INVITE_RE = /^[A-Za-z0-9_-]{22}$/;
const INVITE_TOKEN_RE = /^([A-Za-z0-9_-]{22})(\.p)?$/;   // optional ".p" marks a passphrase-protected invite
const PBKDF2_ITERATIONS = 250_000;
const MAX_EPOCH = 1_000_000;
const KEYRING_DEPTH = 3; // current epoch + the 3 before it, so in-flight messages survive a rotation

// ------------------------------------------------------------------ encoding

export function bufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(bytes) {
  return bufferToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBuffer(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------ invite helpers

/** Fresh random invite secret: 128 bits, 22 URL-safe characters. */
export function generateInviteSecret() {
  return toBase64Url(rand(16));
}

function inviteToken(input) {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  const hash = text.lastIndexOf('#');
  if (hash !== -1) text = text.slice(hash + 1).trim();
  return INVITE_TOKEN_RE.exec(text);
}

/** Accepts a bare secret or a full invite link and returns the secret, or null when it is not valid. */
export function parseInvite(input) {
  const m = inviteToken(input);
  return m ? m[1] : null;
}

/** True when the invite link says the room is also protected by a passphrase. */
export function inviteNeedsPassphrase(input) {
  const m = inviteToken(input);
  return Boolean(m && m[2]);
}

/** What goes after the # in a link: the secret, plus ".p" when a passphrase is required. */
export function inviteFragment(secret, hasPassphrase) {
  return hasPassphrase ? `${secret}.p` : secret;
}

const ADJECTIVES = ['quiet', 'amber', 'brisk', 'cobalt', 'dusky', 'ember', 'frosty', 'gentle', 'hazy', 'ivory', 'jade', 'lunar', 'mellow', 'nimble', 'opal', 'quantum'];
const NOUNS = ['beacon', 'harbor', 'meadow', 'comet', 'lantern', 'orchard', 'canyon', 'ripple', 'summit', 'willow', 'ferry', 'glacier', 'island', 'pebble', 'tundra', 'violet'];

/** Friendly display name derived from the (public) room id. Same on every member's screen. */
export function roomSlug(roomId) {
  const b = (i) => parseInt(roomId.slice(i * 2, i * 2 + 2), 16);
  return `${ADJECTIVES[b(0) % 16]}-${NOUNS[b(1) % 16]}-${String(b(2) % 100).padStart(2, '0')}`;
}

// -------------------------------------------------------------------- engine

export class CryptoEngine {
  constructor() {
    this.roomId = null;
    this.authKey = null;     // HMAC key derived from the invite secret
    this.keyPair = null;     // ephemeral ECDH P-256 identity
    this.keyring = new Map(); // epoch -> { key: CryptoKey, raw: Uint8Array }
    this.epoch = -1;          // highest epoch we hold, -1 = no key yet
  }

  get hasKey() {
    return this.epoch >= 0;
  }

  /**
   * Derives the room id and the authentication key from the invite secret (and the optional passphrase,
   * which is stretched with PBKDF2 and mixed in, so it never leaves this browser). Returns the room id.
   */
  async setInvite(secret, passphrase = '') {
    if (!INVITE_RE.test(secret || '')) throw new Error('Invalid invite');
    let bytes = fromBase64Url(secret);
    if (bytes.length !== 16) throw new Error('Invalid invite');

    if (passphrase) {
      const base = await subtle().importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
      const stretched = new Uint8Array(await subtle().deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`zeroroom/pass|${secret}`), iterations: PBKDF2_ITERATIONS }, base, 256
      ));
      const mixed = new Uint8Array(bytes.length + stretched.length);
      mixed.set(bytes);
      mixed.set(stretched, bytes.length);
      bytes.fill(0);
      stretched.fill(0);
      bytes = mixed;
    }

    const ikm = await subtle().importKey('raw', bytes, 'HKDF', false, ['deriveBits']);
    const derive = (info, bits) =>
      subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: enc.encode(info) }, ikm, bits);

    this.roomId = toHex(new Uint8Array(await derive('room-id', 128)));
    this.authKey = await subtle().importKey(
      'raw', await derive('member-auth', 256), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
    );
    bytes.fill(0);
    return this.roomId;
  }

  /** Ephemeral ECDH P-256 identity for this session. Returns the raw public key, base64. */
  async initIdentity() {
    this.keyPair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const publicKey = await subtle().exportKey('raw', this.keyPair.publicKey);
    return bufferToBase64(publicKey);
  }

  // ----------------------------------------------------------- member proofs

  #proofInput(clientId, publicKeyB64) {
    return enc.encode(`zr2|member|${this.roomId}|${clientId}|${publicKeyB64}`);
  }

  /** Proves knowledge of the invite secret, bound to our public key and server-assigned id. */
  async makeProof(clientId, publicKeyB64) {
    const sig = await subtle().sign('HMAC', this.authKey, this.#proofInput(clientId, publicKeyB64));
    return bufferToBase64(sig);
  }

  async verifyProof(clientId, publicKeyB64, proofB64) {
    try {
      if (!this.authKey || typeof clientId !== 'string' || typeof publicKeyB64 !== 'string' || typeof proofB64 !== 'string') return false;
      return await subtle().verify('HMAC', this.authKey, base64ToBuffer(proofB64), this.#proofInput(clientId, publicKeyB64));
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------- room keys

  async #install(epoch, raw) {
    const key = await subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    this.keyring.set(epoch, { key, raw });
    if (epoch > this.epoch) this.epoch = epoch;
    for (const [e, entry] of [...this.keyring]) {
      if (e < this.epoch - KEYRING_DEPTH) {
        entry.raw.fill(0);
        this.keyring.delete(e);
      }
    }
  }

  /** Creator only: first room key (epoch 0). */
  async generateRoomKey() {
    await this.#install(0, rand(32));
    return this.epoch;
  }

  /** Fresh key under the next epoch: excludes anyone who left. */
  async rotateRoomKey() {
    if (!this.hasKey) throw new Error('No room key');
    await this.#install(this.epoch + 1, rand(32));
    return this.epoch;
  }

  async #wrapKeyFor(peerPublicKeyB64, fromId, toId) {
    const peerKey = await subtle().importKey(
      'raw', base64ToBuffer(peerPublicKeyB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    const bits = await subtle().deriveBits({ name: 'ECDH', public: peerKey }, this.keyPair.privateKey, 256);
    const ikm = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const info = `zr2|wrap|${this.roomId}|${fromId}|${toId}`;
    const key = await subtle().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: enc.encode(info) },
      ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    return { key, aad: enc.encode(info) };
  }

  /** Wraps our current room key for one verified peer. */
  async wrapCurrentKey(peerPublicKeyB64, myId, peerId) {
    if (!this.hasKey) throw new Error('No room key');
    const { key: wrapKey, aad } = await this.#wrapKeyFor(peerPublicKeyB64, myId, peerId);
    const { raw } = this.keyring.get(this.epoch);

    const plain = new Uint8Array(4 + raw.length);
    new DataView(plain.buffer).setUint32(0, this.epoch);
    plain.set(raw, 4);

    const iv = rand(12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad }, wrapKey, plain);
    plain.fill(0);
    return { iv: bufferToBase64(iv), ciphertext: bufferToBase64(ct) };
  }

  /**
   * Unwraps a key sent by a verified peer. Only a newer epoch is adopted.
   * Returns 'accepted', 'stale' (we already have this epoch or a newer one) or 'invalid'.
   */
  async acceptWrappedKey(peerPublicKeyB64, fromId, myId, payload) {
    try {
      const { key: wrapKey, aad } = await this.#wrapKeyFor(peerPublicKeyB64, fromId, myId);
      const plain = new Uint8Array(await subtle().decrypt(
        { name: 'AES-GCM', iv: base64ToBuffer(payload.iv), additionalData: aad },
        wrapKey, base64ToBuffer(payload.ciphertext)
      ));
      if (plain.length !== 36) return 'invalid';
      const epoch = new DataView(plain.buffer).getUint32(0);
      if (epoch > MAX_EPOCH) return 'invalid';
      if (epoch <= this.epoch) return 'stale';
      await this.#install(epoch, plain.slice(4));
      plain.fill(0);
      return 'accepted';
    } catch {
      return 'invalid';
    }
  }

  /**
   * Short code for one specific pair of people ("is this really you?"). Both sides compute the same ten
   * digits from the two public keys; read it out over a call or in person.
   */
  async pairCode(myPublicKeyB64, peerPublicKeyB64) {
    const [a, b] = [myPublicKeyB64, peerPublicKeyB64].sort();
    const data = enc.encode(`zr2|pair|${this.roomId}|${a}|${b}`);
    const hash = new Uint8Array(await subtle().digest('SHA-256', data));
    let n = 0n;
    for (let i = 0; i < 6; i++) n = (n << 8n) | BigInt(hash[i]);
    const digits = String(n % 10_000_000_000n).padStart(10, '0');
    return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  }

  /** 96-bit safety number of the current room key, as 6 groups of 4 hex digits. */
  async fingerprint() {
    if (!this.hasKey) return null;
    const { raw } = this.keyring.get(this.epoch);
    const head = enc.encode(`zr2|fp|${this.roomId}|${this.epoch}|`);
    const data = new Uint8Array(head.length + raw.length);
    data.set(head);
    data.set(raw, head.length);
    const hash = new Uint8Array(await subtle().digest('SHA-256', data));
    data.fill(0);
    return toHex(hash.slice(0, 12)).toUpperCase().match(/.{4}/g).join('-');
  }

  // --------------------------------------------------------------- messages

  #padding(envelopeLength) {
    // Hide the exact length of short messages by rounding up to a multiple of 128 bytes.
    if (envelopeLength > 8192) return '';
    const pad = (128 - (envelopeLength % 128)) % 128;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const r = rand(pad);
    let out = '';
    for (let i = 0; i < pad; i++) out += chars[r[i] % chars.length];
    return out;
  }

  #messageAad(senderId, kind, epoch) {
    return enc.encode(`zr2|msg|${this.roomId}|${senderId}|${kind}|${epoch}`);
  }

  /** Returns `v2.<epoch>.<iv>.<ciphertext>`. Our own server-assigned id is bound as the sender. */
  async encryptMessage(plaintext, { senderId, kind = 'text', meta = null }) {
    if (!this.hasKey) throw new Error('Room key not ready');
    const { key } = this.keyring.get(this.epoch);

    const body = meta ? { t: plaintext, m: meta } : { t: plaintext };
    const base = JSON.stringify({ ...body, p: '' });
    const envelope = JSON.stringify({ ...body, p: this.#padding(enc.encode(base).length) });

    const iv = rand(12);
    const ct = await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: this.#messageAad(senderId, kind, this.epoch) },
      key, enc.encode(envelope)
    );
    return `v2.${this.epoch}.${bufferToBase64(iv)}.${bufferToBase64(ct)}`;
  }

  /** Shared by text and binary messages: parses the wire format, picks the epoch key and decrypts. */
  async #open(wire, senderId, kind) {
    try {
      if (typeof wire !== 'string') return { status: 'failed' };
      const parts = wire.split('.');
      if (parts.length !== 4 || parts[0] !== 'v2' || !/^\d{1,7}$/.test(parts[1])) return { status: 'failed' };
      const epoch = Number(parts[1]);

      const entry = this.keyring.get(epoch);
      if (!entry) return { status: epoch > this.epoch ? 'pending' : 'failed' };

      const plain = new Uint8Array(await subtle().decrypt(
        { name: 'AES-GCM', iv: base64ToBuffer(parts[2]), additionalData: this.#messageAad(senderId, kind, epoch) },
        entry.key, base64ToBuffer(parts[3])
      ));
      return { status: 'ok', plain };
    } catch {
      return { status: 'failed' };
    }
  }

  /**
   * Returns { status: 'ok', text, meta } | { status: 'pending' } (key for that epoch not here yet)
   * | { status: 'failed' }.
   */
  async decryptMessage(wire, { senderId, kind = 'text' }) {
    const opened = await this.#open(wire, senderId, kind);
    if (opened.status !== 'ok') return opened;
    try {
      const envelope = JSON.parse(dec.decode(opened.plain));
      if (!envelope || typeof envelope.t !== 'string') return { status: 'failed' };
      const meta = envelope.m && typeof envelope.m === 'object' && !Array.isArray(envelope.m) ? envelope.m : null;
      return { status: 'ok', text: envelope.t, meta };
    } catch {
      return { status: 'failed' };
    }
  }

  /**
   * Binary payloads (file and voice-note chunks) skip the JSON/base64 envelope:
   * plaintext = [2-byte meta length][meta JSON][raw bytes]. Same key, same AAD rules.
   */
  async encryptBinary(bytes, { senderId, kind = 'file', meta = {} }) {
    if (!this.hasKey) throw new Error('Room key not ready');
    const { key } = this.keyring.get(this.epoch);
    const metaBytes = enc.encode(JSON.stringify(meta));
    if (metaBytes.length > 1024) throw new Error('Metadata too large');

    const plain = new Uint8Array(2 + metaBytes.length + bytes.length);
    new DataView(plain.buffer).setUint16(0, metaBytes.length);
    plain.set(metaBytes, 2);
    plain.set(bytes, 2 + metaBytes.length);

    const iv = rand(12);
    const ct = await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: this.#messageAad(senderId, kind, this.epoch) }, key, plain
    );
    plain.fill(0);
    return `v2.${this.epoch}.${bufferToBase64(iv)}.${bufferToBase64(ct)}`;
  }

  async decryptBinary(wire, { senderId, kind = 'file' }) {
    const opened = await this.#open(wire, senderId, kind);
    if (opened.status !== 'ok') return opened;
    try {
      const { plain } = opened;
      if (plain.length < 2) return { status: 'failed' };
      const metaLen = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint16(0);
      if (metaLen > 1024 || 2 + metaLen > plain.length) return { status: 'failed' };
      const meta = JSON.parse(dec.decode(plain.subarray(2, 2 + metaLen)));
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { status: 'failed' };
      return { status: 'ok', meta, bytes: plain.slice(2 + metaLen) };
    } catch {
      return { status: 'failed' };
    }
  }

  /** Wipes every key from memory. */
  purge() {
    for (const entry of this.keyring.values()) entry.raw.fill(0);
    this.keyring.clear();
    this.epoch = -1;
    this.keyPair = null;
    this.authKey = null;
    this.roomId = null;
  }
}
