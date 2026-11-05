/**
 * Zero-Room WebSocket client.
 * - The relay assigns our client id ('welcome'); we never invent one.
 * - Reconnects with exponential backoff and jitter; resumes the room with the resume token.
 * - Tracks the last seen sequence number so missed text messages can be replayed.
 */
export class SocketClient {
  constructor(url) {
    this.url = url || this.detectDefaultServerUrl();
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.listeners = new Map();
    this.lastSeenSeq = 0;
    this.pingLatency = 0;
    this.clientId = null;     // assigned by the relay
    this.session = null;      // { roomId, resumeToken } while we are in a room
    this.readyWaiters = [];
    this.pow = null;          // { seed, bits } puzzle for creating a room, refreshed by the relay

    // Re-engage the connection when a mobile tab wakes up.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !this.ws) {
        this.reconnectAttempts = 0;
        this.connect();
      }
    });
  }

  detectDefaultServerUrl() {
    const loc = window.location;
    if (loc.protocol === 'file:') return 'ws://localhost:8888';
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    // Local dev servers on another port talk straight to the relay.
    if ((loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') && loc.port && loc.port !== '8888') {
      return `${proto}//${loc.hostname}:8888`;
    }
    return `${proto}//${loc.host}/ws`;
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    for (const cb of this.listeners.get(event) || []) cb(data);
  }

  /** Resolves with our client id once the relay has sent 'welcome' (rejects after the timeout). */
  whenReady(timeoutMs = 8000) {
    if (this.isConnected && this.clientId) return Promise.resolve(this.clientId);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        reject(new Error('Not connected'));
      }, timeoutMs);
      this.readyWaiters.push(waiter);
      if (!this.ws) this.connect();
    });
  }

  connect() {
    if (this.ws) return;
    clearTimeout(this.reconnectTimer);

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const startedAt = Date.now();

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.pingLatency = Date.now() - startedAt;
    };

    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!payload || typeof payload !== 'object') return;

      if (payload.type === 'welcome') {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        // While in a room our identity is the one the room knows; the resume below re-attaches it.
        if (!this.session) this.clientId = payload.clientId;
        this.pow = payload.pow || null;
        this.emit('connected', { latency: this.pingLatency });
        for (const w of this.readyWaiters.splice(0)) {
          clearTimeout(w.timer);
          w.resolve(this.clientId);
        }
        if (this.session) {
          this.send({
            action: 'resume',
            roomId: this.session.roomId,
            resumeToken: this.session.resumeToken,
            lastSeenSeq: this.lastSeenSeq,
          });
        }
        return;
      }

      if ((payload.type === 'created' || payload.type === 'joined') && payload.resumeToken) {
        this.clientId = payload.clientId;
        this.session = { roomId: payload.roomId, resumeToken: payload.resumeToken };
        this.lastSeenSeq = 0;
      }
      if ((payload.type === 'error' || payload.type === 'left') && payload.pow && typeof payload.pow.seed === 'string') {
        this.pow = payload.pow;
      }
      if (typeof payload.seq === 'number' && payload.seq > this.lastSeenSeq) {
        this.lastSeenSeq = payload.seq;
      }
      this.emit('message', payload);
    };

    ws.onclose = (event) => {
      if (ws !== this.ws) return; // an old socket we replaced on purpose
      this.ws = null;
      this.isConnected = false;
      this.emit('disconnected', { code: event.code, reason: event.reason });
      // 1000 = room burned, 1008 = we were rate limited / rejected: reconnecting would only repeat it.
      if (event.code !== 1000 && event.code !== 1008) this.scheduleReconnect();
    };

    ws.onerror = (err) => {
      if (ws === this.ws) this.emit('error', err);
    };
  }

  /** Exponential backoff with jitter, so a restarted relay is not hit by every client at once. */
  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectAttempts++;
    const backoff = Math.min(15000, 1000 * Math.pow(1.5, this.reconnectAttempts));
    const delay = backoff + Math.random() * 1500;
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delayMs: Math.round(delay) });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Bytes queued in the socket: used to pace file uploads so a slow link is never flooded. */
  get buffered() {
    return this.ws ? this.ws.bufferedAmount : 0;
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  /** Forget the room we were in (after leave, burn, expiry or a failed resume). */
  clearSession() {
    this.session = null;
    this.lastSeenSeq = 0;
  }

  /** Leave the room politely, then start over with a fresh connection and a fresh identity. */
  leaveAndReset() {
    if (this.session) this.send({ action: 'leave' });
    this.clearSession();
    const old = this.ws;
    this.ws = null;
    this.isConnected = false;
    this.clientId = null;
    clearTimeout(this.reconnectTimer);
    if (old) {
      try { old.close(1000, 'Left'); } catch { /* already closed */ }
    }
    this.reconnectAttempts = 0;
    this.connect();
  }
}
