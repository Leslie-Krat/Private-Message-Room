/**
 * BoundedRingBuffer - fixed-capacity circular queue of recent ENCRYPTED text messages.
 *
 * Bounded twice: at most `capacity` messages AND at most `maxBytes` of ciphertext.
 * Large payloads (images) are never stored; they only consume a sequence number so
 * clients can still detect the gap.
 */
export class BoundedRingBuffer {
  constructor(capacity = 50, maxBytes = 512 * 1024) {
    this.capacity = capacity;
    this.maxBytes = maxBytes;
    this.buffer = new Array(capacity).fill(null);
    this.sizes = new Array(capacity).fill(0);
    this.head = 0;
    this.count = 0;
    this.bytes = 0;
    this.latestSeq = 0;
  }

  /**
   * @param {Object} message payload to retain (ciphertext, sender, timestamp, ...)
   * @param {number} size   byte cost of the message
   * @param {boolean} store false = only assign a sequence number
   * @returns {number} the assigned monotonic sequence ID
   */
  push(message, size = 0, store = true) {
    this.latestSeq += 1;
    if (!store || size > this.maxBytes) return this.latestSeq;

    while (this.count > 0 && (this.count >= this.capacity || this.bytes + size > this.maxBytes)) {
      this.#evictOldest();
    }

    this.buffer[this.head] = { ...message, seq: this.latestSeq };
    this.sizes[this.head] = size;
    this.head = (this.head + 1) % this.capacity;
    this.count += 1;
    this.bytes += size;
    return this.latestSeq;
  }

  #evictOldest() {
    const idx = (this.head - this.count + this.capacity) % this.capacity;
    this.bytes -= this.sizes[idx];
    this.buffer[idx] = null;
    this.sizes[idx] = 0;
    this.count -= 1;
  }

  /** Drops stored messages older than `minTimestamp` (they are stored oldest first). */
  purgeBefore(minTimestamp) {
    while (this.count > 0) {
      const idx = (this.head - this.count + this.capacity) % this.capacity;
      if (this.buffer[idx].timestamp >= minTimestamp) break;
      this.#evictOldest();
    }
  }

  /** Messages with seq > lastSeenSeq, oldest first. */
  getSince(lastSeenSeq = 0) {
    if (this.count === 0 || lastSeenSeq >= this.latestSeq) return [];
    const missed = [];
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const msg = this.buffer[(start + i) % this.capacity];
      if (msg && msg.seq > lastSeenSeq) missed.push(msg);
    }
    return missed;
  }

  clear() {
    this.buffer.fill(null);
    this.sizes.fill(0);
    this.head = 0;
    this.count = 0;
    this.bytes = 0;
    this.latestSeq = 0;
  }
}
