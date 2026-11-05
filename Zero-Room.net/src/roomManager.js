import crypto from 'node:crypto';
import { BoundedRingBuffer } from './ringBuffer.js';
import { TokenBucketRateLimiter } from './rateLimiter.js';
import { CONFIG } from './config.js';
import { cleanDisappear } from './validate.js';

const OPEN = 1; // WebSocket.OPEN
const PENDING_TTL_MS = 90_000;
const MAX_PENDING = 5;
const MAX_LIFETIME_MIN = 1440;
const EXTEND_CHOICES = new Set([15, 60]);

/**
 * RoomManager - in-memory lifecycle manager for ephemeral rooms.
 * Nothing here is ever written to disk. The server NEVER sees room keys or the invite
 * secret: room ids are opaque hashes chosen by the clients.
 *
 * Identity model: every socket gets a server-assigned clientId. Members authenticate
 * to the room with a server-issued resume token, never with a client-chosen id.
 *
 * Roles: the creator is the room's host. If the host leaves, the longest-present member becomes host.
 * Only the host can remove people, lock the room, require approval, change the disappearing-message
 * timer, extend the lifetime, or approve people who ask to join.
 */
export class RoomManager {
  constructor() {
    this.rooms = new Map();         // roomId -> room
    this.clientToRoom = new Map();  // ws -> { roomId, clientId }
    this.pendingByWs = new Map();   // ws -> { roomId, clientId } for people waiting for approval
    this.roomsByIp = new Map();     // ipKey -> number of live rooms created from that IP

    this.reaperInterval = setInterval(() => this.reapExpiredRooms(), CONFIG.REAPER_INTERVAL_MS);
    this.reaperInterval.unref?.();
  }

  // ---------------------------------------------------------------- helpers

  static newToken() {
    return crypto.randomBytes(24).toString('base64url'); // 32 chars
  }

  getMembership(ws) {
    const mapping = this.clientToRoom.get(ws);
    if (!mapping) return null;
    const room = this.rooms.get(mapping.roomId);
    if (!room) return null;
    const member = room.clients.get(mapping.clientId);
    if (!member || member.ws !== ws) return null;
    return { room, member };
  }

  #peerSummary(room, exceptClientId) {
    const peers = [];
    for (const m of room.clients.values()) {
      if (m.clientId === exceptClientId) continue;
      peers.push({ clientId: m.clientId, nickname: m.nickname, publicKey: m.publicKey, proof: m.proof });
    }
    return peers;
  }

  #send(client, data) {
    const ws = client.ws;
    if (!ws || ws.readyState !== OPEN) return;
    if (ws.bufferedAmount > CONFIG.MAX_BUFFERED_BYTES) {
      // Slow reader: dropping it protects server memory. It may resume within the grace period.
      ws.terminate();
      return;
    }
    try {
      ws.send(data);
    } catch {
      // pruned by heartbeat / close handler
    }
  }

  /** Sends a payload to every connected member (optionally skipping one client). */
  broadcast(room, payload, excludeClientId = null) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const member of room.clients.values()) {
      if (member.clientId === excludeClientId) continue;
      this.#send(member, data);
    }
  }

  /** Sends to one member of the room. Returns false if the target is unknown. */
  sendTo(room, targetClientId, payload) {
    const target = room.clients.get(targetClientId);
    if (!target) return false;
    this.#send(target, JSON.stringify(payload));
    return true;
  }

  /** The room settings every member needs to know about. */
  roomState(room) {
    return {
      hostId: room.hostId,
      locked: room.locked,
      approval: room.approval,
      disappearSec: room.disappearSec,
      createdAt: room.createdAt,
      expiryMinutes: room.expiryMinutes,
    };
  }

  broadcastState(room) {
    this.broadcast(room, { type: 'room_state', state: this.roomState(room) });
  }

  #newMember(room, ws, nickname, publicKey, proof) {
    const token = RoomManager.newToken();
    const member = {
      clientId: ws.clientId,
      ws,
      nickname,
      publicKey,
      proof,
      joinedAt: Date.now(),
      resumeToken: token,
      graceTimer: null,
    };
    room.clients.set(member.clientId, member);
    room.tokens.set(token, member.clientId);
    this.clientToRoom.set(ws, { roomId: room.id, clientId: member.clientId });
    return member;
  }

  #pendingList(room) {
    return [...room.pending.values()].map((r) => ({
      clientId: r.clientId, nickname: r.nickname, publicKey: r.publicKey, proof: r.proof,
    }));
  }

  #hostMember(room) {
    return room.clients.get(room.hostId) || null;
  }

  // ------------------------------------------------------------- lifecycle

  createRoom({ roomId, ws, nickname, publicKey, proof, expiryMinutes, ipKey, approval = false, disappearSec = 0 }) {
    if (this.rooms.has(roomId)) return { error: 'Room already exists', code: 'ROOM_EXISTS' };
    if (this.rooms.size >= CONFIG.MAX_ROOMS) return { error: 'Server is busy, try again later', code: 'SERVER_BUSY' };
    if ((this.roomsByIp.get(ipKey) || 0) >= CONFIG.MAX_ROOMS_PER_IP) {
      return { error: 'Too many active rooms from your network', code: 'TOO_MANY_ROOMS' };
    }

    const now = Date.now();
    const room = {
      id: roomId,
      creatorId: ws.clientId,
      hostId: ws.clientId,
      creatorIpKey: ipKey,
      clients: new Map(),   // clientId -> member (insertion order = join order)
      tokens: new Map(),    // resumeToken -> clientId
      pending: new Map(),   // clientId -> request waiting for the host's approval
      buffer: new BoundedRingBuffer(CONFIG.RING_CAPACITY, CONFIG.RING_MAX_BYTES),
      byteBucket: new TokenBucketRateLimiter(CONFIG.ROOM_BYTE_BUCKET_CAPACITY, CONFIG.ROOM_BYTE_BUCKET_REFILL_PER_SEC),
      createdAt: now,
      lastActivity: now,
      expiryMinutes,
      locked: false,
      approval: Boolean(approval),
      disappearSec: cleanDisappear(disappearSec),
    };

    this.rooms.set(roomId, room);
    this.roomsByIp.set(ipKey, (this.roomsByIp.get(ipKey) || 0) + 1);
    const member = this.#newMember(room, ws, nickname, publicKey, proof);

    return {
      room,
      member,
      roomId,
      clientId: member.clientId,
      resumeToken: member.resumeToken,
      createdAt: room.createdAt,
      expiryMinutes: room.expiryMinutes,
      state: this.roomState(room),
    };
  }

  #joinResult(room, member) {
    return {
      room,
      member,
      roomId: room.id,
      clientId: member.clientId,
      resumeToken: member.resumeToken,
      peers: this.#peerSummary(room, member.clientId),
      createdAt: room.createdAt,
      expiryMinutes: room.expiryMinutes,
      creatorId: room.creatorId,
      state: this.roomState(room),
    };
  }

  /**
   * Joins a room, or (when the host requires approval) parks the socket until the host decides.
   * Returns { error, code } | { pending: true, room, request } | the join result.
   */
  joinRoom({ roomId, ws, nickname, publicKey, proof }) {
    const room = this.rooms.get(roomId);
    if (!room) return { error: 'Room not found or has been destroyed', code: 'ROOM_NOT_FOUND' };
    if (room.locked) return { error: 'This room is locked by its host', code: 'ROOM_LOCKED' };
    if (room.clients.size >= CONFIG.MAX_PEERS_PER_ROOM) {
      return { error: `Room is at maximum capacity (${CONFIG.MAX_PEERS_PER_ROOM} peers)`, code: 'ROOM_FULL' };
    }
    if (room.clients.has(ws.clientId)) return { error: 'Already in this room', code: 'ALREADY_JOINED' };

    if (room.approval) {
      if (room.pending.size >= MAX_PENDING) {
        return { error: 'Too many people are waiting to join this room', code: 'TOO_MANY_PENDING' };
      }
      const request = { ws, clientId: ws.clientId, nickname, publicKey, proof, timer: null };
      request.timer = setTimeout(() => this.#expirePending(room, request), PENDING_TTL_MS);
      request.timer.unref?.();
      room.pending.set(request.clientId, request);
      this.pendingByWs.set(ws, { roomId, clientId: request.clientId });
      return { pending: true, room, request };
    }

    const member = this.#newMember(room, ws, nickname, publicKey, proof);
    room.lastActivity = Date.now();
    return this.#joinResult(room, member);
  }

  #removePending(room, request) {
    clearTimeout(request.timer);
    room.pending.delete(request.clientId);
    this.pendingByWs.delete(request.ws);
  }

  #expirePending(room, request) {
    if (room.pending.get(request.clientId) !== request) return;
    this.#removePending(room, request);
    this.#notifyPendingGone(request.ws, 'JOIN_TIMEOUT', 'The host did not respond in time');
    this.#toHost(room, { type: 'join_request_cancelled', clientId: request.clientId });
  }

  #notifyPendingGone(ws, code, message) {
    if (!ws || ws.readyState !== OPEN) return;
    try { ws.send(JSON.stringify({ type: 'join_denied', code, message })); } catch { /* closing */ }
  }

  #toHost(room, payload) {
    const host = this.#hostMember(room);
    if (host) this.#send(host, JSON.stringify(payload));
  }

  /** Host decision about someone waiting at the door. */
  resolvePending(room, requesterId, targetClientId, approve) {
    if (room.hostId !== requesterId) return { error: 'Only the host can do this', code: 'NOT_HOST' };
    const request = room.pending.get(targetClientId);
    if (!request) return { error: 'That request is no longer pending', code: 'TARGET_NOT_FOUND' };
    this.#removePending(room, request);

    if (!approve) {
      this.#notifyPendingGone(request.ws, 'JOIN_DENIED', 'The host declined your request');
      return { denied: true };
    }
    if (!request.ws || request.ws.readyState !== OPEN) return { error: 'That person left', code: 'TARGET_NOT_FOUND' };
    if (room.clients.size >= CONFIG.MAX_PEERS_PER_ROOM) {
      this.#notifyPendingGone(request.ws, 'ROOM_FULL', 'The room is full');
      return { error: 'Room is full', code: 'ROOM_FULL' };
    }
    const member = this.#newMember(room, request.ws, request.nickname, request.publicKey, request.proof);
    room.lastActivity = Date.now();
    return this.#joinResult(room, member);
  }

  /** Host: remove a member for good (their resume token dies with them). */
  kick(room, requesterId, targetClientId) {
    if (room.hostId !== requesterId) return { error: 'Only the host can remove people', code: 'NOT_HOST' };
    if (targetClientId === requesterId) return { error: 'You cannot remove yourself', code: 'BAD_REQUEST' };
    const member = room.clients.get(targetClientId);
    if (!member) return { error: 'That person is not in the room', code: 'TARGET_NOT_FOUND' };

    const ws = member.ws;
    if (ws && ws.readyState === OPEN) {
      try { ws.send(JSON.stringify({ type: 'kicked' })); } catch { /* closing */ }
    }
    this.#dropMember(room, member);
    try { ws?.close(1000, 'Removed'); } catch { /* already closed */ }
    return { ok: true };
  }

  /** Host: lock the room, require approval, or change the disappearing-message timer. */
  setOptions(room, requesterId, { locked, approval, disappearSec }) {
    if (room.hostId !== requesterId) return { error: 'Only the host can change room settings', code: 'NOT_HOST' };
    if (typeof locked === 'boolean') room.locked = locked;
    if (typeof approval === 'boolean') room.approval = approval;
    if (disappearSec !== undefined) {
      room.disappearSec = cleanDisappear(disappearSec);
      if (room.disappearSec) room.buffer.purgeBefore(Date.now() - room.disappearSec * 1000);
    }
    this.broadcastState(room);
    return { ok: true };
  }

  /** Host: add 15 or 60 minutes, never beyond 24 hours in total. */
  extend(room, requesterId, addMinutes) {
    if (room.hostId !== requesterId) return { error: 'Only the host can extend the room', code: 'NOT_HOST' };
    if (!EXTEND_CHOICES.has(addMinutes)) return { error: 'Invalid extension', code: 'BAD_REQUEST' };
    const next = Math.min(MAX_LIFETIME_MIN, room.expiryMinutes + addMinutes);
    if (next === room.expiryMinutes) return { error: 'This room already has the longest possible lifetime (24 hours)', code: 'MAX_LIFETIME' };
    room.expiryMinutes = next;
    this.broadcastState(room);
    return { ok: true };
  }

  /**
   * Stores an encrypted message and relays it to every member (including the sender,
   * so the sender gets the authoritative sequence number for delivery receipts).
   * Only small messages (text and control messages) are kept for reconnect replay;
   * images and file chunks are relayed and forgotten.
   */
  handleMessage(room, member, ciphertext, kind) {
    const size = ciphertext.length;
    const timestamp = Date.now();
    room.lastActivity = timestamp;
    if (room.disappearSec) room.buffer.purgeBefore(timestamp - room.disappearSec * 1000);

    const seq = room.buffer.push(
      { senderId: member.clientId, ciphertext, timestamp, kind },
      size,
      kind === 'text' || kind === 'ctl'
    );

    this.broadcast(room, { type: 'msg', seq, senderId: member.clientId, ciphertext, timestamp, kind });
    return seq;
  }

  /** Reattaches a disconnected member that proves possession of its resume token. */
  resumeSession({ roomId, token, ws, lastSeenSeq }) {
    const room = this.rooms.get(roomId);
    if (!room) return { error: 'Room expired during disconnect', code: 'ROOM_GONE' };

    const clientId = room.tokens.get(token);
    const member = clientId && room.clients.get(clientId);
    if (!member) return { error: 'Session can no longer be resumed', code: 'ROOM_GONE' };

    if (member.graceTimer) {
      clearTimeout(member.graceTimer);
      member.graceTimer = null;
    }

    const oldWs = member.ws;
    if (oldWs && oldWs !== ws) {
      this.clientToRoom.delete(oldWs);
      try { oldWs.terminate(); } catch { /* already gone */ }
    }

    member.ws = ws;
    ws.clientId = member.clientId;
    this.clientToRoom.set(ws, { roomId, clientId: member.clientId });
    room.lastActivity = Date.now();

    if (room.disappearSec) room.buffer.purgeBefore(Date.now() - room.disappearSec * 1000);

    return {
      room,
      member,
      clientId: member.clientId,
      latestSeq: room.buffer.latestSeq,
      missedMessages: room.buffer.getSince(lastSeenSeq),
      peers: this.#peerSummary(room, member.clientId),
      pendingRequests: member.clientId === room.hostId ? this.#pendingList(room) : [],
      createdAt: room.createdAt,
      expiryMinutes: room.expiryMinutes,
      creatorId: room.creatorId,
      state: this.roomState(room),
    };
  }

  /**
   * Socket closed. Intentional departures drop the member immediately; accidental ones
   * (network switch, sleeping phone) keep the seat for a short grace period.
   */
  detachClient(ws, intentional = false) {
    const waiting = this.pendingByWs.get(ws);
    if (waiting) {
      const room = this.rooms.get(waiting.roomId);
      const request = room?.pending.get(waiting.clientId);
      this.pendingByWs.delete(ws);
      if (room && request) {
        this.#removePending(room, request);
        this.#toHost(room, { type: 'join_request_cancelled', clientId: request.clientId });
      }
      return;
    }

    const mapping = this.clientToRoom.get(ws);
    if (!mapping) return;
    this.clientToRoom.delete(ws);

    const room = this.rooms.get(mapping.roomId);
    if (!room) return;
    const member = room.clients.get(mapping.clientId);
    if (!member || member.ws !== ws) return; // already replaced by a resume

    if (intentional) {
      this.#dropMember(room, member);
      return;
    }

    member.ws = null;
    if (member.graceTimer) clearTimeout(member.graceTimer);
    member.graceTimer = setTimeout(() => {
      const liveRoom = this.rooms.get(room.id);
      if (liveRoom && liveRoom.clients.get(member.clientId) === member && !member.ws) {
        this.#dropMember(liveRoom, member);
      }
    }, CONFIG.RESUME_GRACE_MS);
    member.graceTimer.unref?.();
  }

  #dropMember(room, member) {
    if (member.graceTimer) {
      clearTimeout(member.graceTimer);
      member.graceTimer = null;
    }
    room.clients.delete(member.clientId);
    room.tokens.delete(member.resumeToken);
    if (member.ws) this.clientToRoom.delete(member.ws);

    if (room.clients.size === 0) {
      // Nobody left to hold the room key: the room is dead, free it (and the creator's quota) now.
      this.#deleteRoom(room);
      return;
    }

    this.broadcast(room, { type: 'peer_left', clientId: member.clientId });
    if (room.hostId === member.clientId) {
      // The longest-present member takes over (Map keeps join order).
      room.hostId = room.clients.keys().next().value;
      this.broadcastState(room);
      // Requests that were waiting for the old host now go to the new one.
      for (const request of room.pending.values()) {
        this.#toHost(room, { type: 'join_request', clientId: request.clientId, nickname: request.nickname, publicKey: request.publicKey, proof: request.proof });
      }
    }
  }

  #deleteRoom(room) {
    for (const member of room.clients.values()) {
      if (member.graceTimer) clearTimeout(member.graceTimer);
      if (member.ws) this.clientToRoom.delete(member.ws);
    }
    for (const request of [...room.pending.values()]) {
      this.#removePending(room, request);
      this.#notifyPendingGone(request.ws, 'ROOM_GONE', 'The room no longer exists');
    }
    room.clients.clear();
    room.tokens.clear();
    room.buffer.clear();
    this.rooms.delete(room.id);

    const left = (this.roomsByIp.get(room.creatorIpKey) || 1) - 1;
    if (left <= 0) this.roomsByIp.delete(room.creatorIpKey);
    else this.roomsByIp.set(room.creatorIpKey, left);
  }

  /** Explicit leave: removes the member (or the waiting request) right now. */
  leave(ws) {
    this.detachClient(ws, true);
  }

  /**
   * Destroys a room. A participant may only burn when they are the host or the last
   * member; the system (expiry) may always burn.
   */
  burnRoom(roomId, requesterClientId = null, reason = 'The room was burned and destroyed by a participant.') {
    const room = this.rooms.get(roomId);
    if (!room) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' };

    if (requesterClientId !== null) {
      const isHost = room.hostId === requesterClientId;
      const isLastMember = room.clients.size === 1 && room.clients.has(requesterClientId);
      if (!isHost && !isLastMember) {
        return { error: 'Only the host or the last member can burn the room', code: 'FORBIDDEN' };
      }
    }

    this.broadcast(room, { type: 'burned', reason, initiator: requesterClientId || 'SYSTEM' });
    for (const member of room.clients.values()) {
      try { member.ws?.close(1000, 'Room Burned'); } catch { /* ignore */ }
    }
    this.#deleteRoom(room);
    return { ok: true };
  }

  reapExpiredRooms() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      if (room.clients.size === 0) {
        this.#deleteRoom(room);
        continue;
      }
      if ((now - room.createdAt) / 60000 >= room.expiryMinutes) {
        this.burnRoom(room.id, null, 'The room reached its lifetime and was destroyed.');
      }
    }
  }

  shutdown() {
    clearInterval(this.reaperInterval);
  }

  getTelemetry() {
    let connectedClients = 0;
    for (const room of this.rooms.values()) {
      for (const m of room.clients.values()) if (m.ws) connectedClients += 1;
    }
    return {
      activeRooms: this.rooms.size,
      connectedClients,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryRSS_MB: (process.memoryUsage().rss / (1024 * 1024)).toFixed(2),
    };
  }
}
