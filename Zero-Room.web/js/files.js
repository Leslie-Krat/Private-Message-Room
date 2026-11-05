/**
 * File and voice-note helpers: limits, safe names, chunk reassembly and the voice recorder.
 * Everything here is untrusted-input aware: files come from other people, so names are cleaned, sizes and
 * chunk order are checked, and the mime type is reduced to a short allow-list before anything is rendered.
 */
export const FILE_CHUNK_BYTES = 256 * 1024;                  // raw bytes per encrypted chunk (fits the relay's 400 KB frame budget)
export const MAX_FILE_BYTES = 2 * 1024 * 1024;               // keeps the burst a slow phone has to absorb small
export const MAX_VOICE_SECONDS = 120;
export const MAX_CHUNKS = Math.ceil(MAX_FILE_BYTES / FILE_CHUNK_BYTES);

const SAFE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const SAFE_AUDIO = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac']);
const FID_RE = /^[A-Za-z0-9_-]{12}$/;

const baseMime = (mime) => String(mime || '').split(';')[0].trim().toLowerCase();
export const isSafeImageMime = (mime) => SAFE_IMAGE.has(baseMime(mime));
export const isSafeAudioMime = (mime) => SAFE_AUDIO.has(baseMime(mime));

const STRIP_RE = new RegExp(
  '[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]]
    .map(([a, b]) => String.fromCodePoint(a) + '-' + String.fromCodePoint(b)).join('') + ']', 'g');

/** A file name that is safe to display and to hand to the browser's download dialog. */
export function sanitizeFileName(name) {
  let clean = String(name ?? '').replace(STRIP_RE, '').replace(/[\\/:*?"<>|]+/g, '_').trim().replace(/^\.+/, '');
  clean = Array.from(clean).slice(0, 80).join('');
  return clean || 'file';
}

const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac' };

/** Adds a matching extension when a saved name has none, so the operating system knows how to open it. */
export function withExtension(name, mime) {
  const ext = EXT_BY_MIME[baseMime(mime)];
  if (!ext || /\.[A-Za-z0-9]{1,6}$/.test(name)) return name;
  return `${name}.${ext}`;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Random 12-character id for one upload. */
export function newFileId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_'); // 12 chars, no padding
}

/** Splits bytes into relay-sized chunks. */
export function* chunkBytes(bytes) {
  for (let off = 0; off < bytes.length; off += FILE_CHUNK_BYTES) yield bytes.subarray(off, off + FILE_CHUNK_BYTES);
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/**
 * Collects decrypted chunks into files. A sender must deliver chunks in order (the relay keeps per-socket
 * order); anything that does not fit the declared header is dropped and the whole transfer is forgotten.
 */
export class FileAssembler {
  constructor({ maxPerSender = 4, maxTotal = 12, maxAgeMs = 3 * 60_000 } = {}) {
    this.transfers = new Map();
    this.maxPerSender = maxPerSender;
    this.maxTotal = maxTotal;
    this.maxAgeMs = maxAgeMs;
  }

  /** Returns { status: 'drop' } or { status: 'start' | 'chunk' | 'done', transfer }. */
  accept(senderId, seq, meta, bytes, now = Date.now()) {
    this.prune(now);
    if (!meta || !FID_RE.test(meta.f) || !isInt(meta.n, 1, MAX_CHUNKS) || !isInt(meta.i, 0, meta.n - 1)) return { status: 'drop' };
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > FILE_CHUNK_BYTES) return { status: 'drop' };
    const key = `${senderId}:${meta.f}`;

    if (meta.i === 0) {
      if (this.transfers.has(key)) return { status: 'drop' };
      let mine = 0;
      for (const t of this.transfers.values()) if (t.senderId === senderId) mine += 1;
      if (mine >= this.maxPerSender || this.transfers.size >= this.maxTotal) return { status: 'drop' };
      if (!isInt(meta.size, 1, MAX_FILE_BYTES) || Math.ceil(meta.size / FILE_CHUNK_BYTES) !== meta.n) return { status: 'drop' };
      const wantsVoice = meta.v === true && isSafeAudioMime(meta.mime);
      const transfer = {
        key, senderId, seq, lastSeq: seq,
        name: sanitizeFileName(meta.name),
        size: meta.size,
        mime: wantsVoice ? baseMime(meta.mime) : isSafeImageMime(meta.mime) ? baseMime(meta.mime) : 'application/octet-stream',
        voice: wantsVoice,
        duration: wantsVoice && typeof meta.d === 'number' && meta.d >= 0 && meta.d <= MAX_VOICE_SECONDS + 5 ? meta.d : 0,
        replySeq: Number.isSafeInteger(meta.r) && meta.r >= 0 ? meta.r : null,
        n: meta.n, next: 0, parts: [], received: 0, startedAt: now,
      };
      this.transfers.set(key, transfer);
    }

    const t = this.transfers.get(key);
    if (!t) return { status: 'drop' };
    const lastChunk = meta.i === t.n - 1;
    if (meta.i !== t.next || meta.n !== t.n || (!lastChunk && bytes.length !== FILE_CHUNK_BYTES)) {
      this.transfers.delete(key);
      return { status: 'fail', transfer: t };
    }

    t.parts.push(bytes);
    t.received += bytes.length;
    t.next += 1;
    t.lastSeq = seq;
    if (t.received > t.size) { this.transfers.delete(key); return { status: 'fail', transfer: t }; }

    if (t.next < t.n) return { status: meta.i === 0 ? 'start' : 'chunk', transfer: t };

    this.transfers.delete(key);
    if (t.received !== t.size) return { status: 'fail', transfer: t };
    t.blob = new Blob(t.parts, { type: t.mime });
    t.parts = [];
    return { status: 'done', transfer: t, first: meta.i === 0 };
  }

  prune(now = Date.now()) {
    for (const [key, t] of this.transfers) if (now - t.startedAt > this.maxAgeMs) this.transfers.delete(key);
  }

  clear() {
    this.transfers.clear();
  }
}

// ------------------------------------------------------------------ voice notes

export function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return '';
}

export const voiceSupported = () =>
  Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined' && pickRecorderMime() !== '';

/** Records a short voice note at a low bitrate (24 kbps is plenty for speech and keeps 2 minutes under 400 KB). */
export class VoiceRecorder {
  constructor({ onTick, onLimit }) {
    this.onTick = onTick;
    this.onLimit = onLimit;
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.startedAt = 0;
    this.timer = null;
    this.cancelled = false;
  }

  get active() {
    return Boolean(this.recorder);
  }

  async start() {
    const mimeType = pickRecorderMime();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.recorder = new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 24_000 });
    this.chunks = [];
    this.cancelled = false;
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.start(500);
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      const seconds = (Date.now() - this.startedAt) / 1000;
      this.onTick?.(seconds);
      if (seconds >= MAX_VOICE_SECONDS) this.onLimit?.();
    }, 250);
  }

  #release() {
    clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }

  /** Stops and returns { blob, seconds, mime }. */
  stop() {
    return new Promise((resolve, reject) => {
      const recorder = this.recorder;
      if (!recorder) return reject(new Error('Not recording'));
      const seconds = (Date.now() - this.startedAt) / 1000;
      recorder.onstop = () => {
        const mime = baseMime(recorder.mimeType) || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mime });
        this.chunks = [];
        this.#release();
        if (this.cancelled) reject(new Error('cancelled'));
        else resolve({ blob, seconds, mime });
      };
      try { recorder.stop(); } catch (err) { this.#release(); reject(err); }
    });
  }

  cancel() {
    this.cancelled = true;
    if (this.recorder) {
      try { this.recorder.onstop = () => { this.chunks = []; this.#release(); }; this.recorder.stop(); } catch { this.#release(); }
    }
  }
}
