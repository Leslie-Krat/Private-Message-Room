import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CONFIG } from './config.js';
import { RoomManager } from './roomManager.js';
import { HeartbeatManager } from './heartbeat.js';
import { TokenBucketRateLimiter, IPConnectionTracker } from './rateLimiter.js';
import { getClientIp, ipKey, isLoopback } from './netutil.js';
import { PowGate } from './pow.js';
import {
  isPlainObject, isRoomId, isPublicKey, isProof, isClientId, isResumeToken, isKeyPayload,
  cleanNickname, cleanExpiry, cleanSeq, cleanDisappear, isBool, MESSAGE_KINDS,
} from './validate.js';

// Never let a stray error take every room down, and never log user data.
process.on('uncaughtException', (err) => {
  console.error('[Zero-Room.net] fatal error:', err?.name || 'Error');
  process.exit(1); // systemd restarts the service
});
process.on('unhandledRejection', (reason) => {
  console.error('[Zero-Room.net] unhandled rejection:', reason?.name || typeof reason);
});

const roomManager = new RoomManager();
const ipTracker = new IPConnectionTracker(CONFIG.MAX_CONN_PER_IP);
const powGate = new PowGate({ baseBits: CONFIG.POW_BASE_BITS, maxExtraBits: CONFIG.POW_MAX_EXTRA_BITS });

/** The puzzle a socket must solve before it can create a room. */
function newChallenge(ws) {
  ws.pow = powGate.issue();
  return { seed: ws.pow.seed, bits: ws.pow.bits };
}

/** True when this socket is already in a room or waiting at the door of one. */
const isBusy = (ws) => roomManager.clientToRoom.has(ws) || roomManager.pendingByWs.has(ws);

// 1. HTTP server (Slowloris mitigation). Only the local health probe is served.
const server = http.createServer({
  headersTimeout: 4000,
  requestTimeout: 10000,
  maxHeaderSize: 16 * 1024,
}, (req, res) => {
  const direct = isLoopback(req.socket.remoteAddress) && !req.headers['x-real-ip'] && !req.headers['x-forwarded-for'];

  if (req.method === 'GET' && direct && (req.url === '/health' || req.url === '/metrics')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'healthy', timestamp: Date.now(), ...roomManager.getTelemetry() }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end('Not found\n');
});
server.on('clientError', (_err, socket) => socket.destroy());

// 2. WebSocket server: no compression (saves RAM, and is useless on ciphertext).
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: CONFIG.MAX_PAYLOAD_BYTES,
  perMessageDeflate: false,
});
const heartbeat = new HeartbeatManager(wss, CONFIG.HEARTBEAT_INTERVAL_MS);

/** Browsers always send Origin on WebSocket handshakes; this blocks cross-site hijacking. */
function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return !CONFIG.REQUIRE_ORIGIN;
  if (CONFIG.ALLOWED_ORIGINS.includes(origin)) return true;

  let url;
  try { url = new URL(origin); } catch { return false; }

  // Local development pages (only for direct connections, never through the reverse proxy).
  const viaProxy = Boolean(request.headers['x-real-ip']);
  if (!viaProxy && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;

  // Same-site: the page was served from the very host the socket is opened against.
  const host = String(request.headers.host || '').toLowerCase();
  return host !== '' && url.host.toLowerCase() === host;
}

server.on('upgrade', (request, socket, head) => {
  socket.on('error', () => socket.destroy());

  const reject = (code, text) => {
    try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* ignore */ }
    socket.destroy();
  };

  let pathname;
  try { pathname = new URL(request.url, 'http://localhost').pathname; } catch { return reject(400, 'Bad Request'); }
  if (pathname !== '/ws' && pathname !== '/') return reject(404, 'Not Found');
  if (!originAllowed(request)) return reject(403, 'Forbidden');
  if (wss.clients.size >= CONFIG.MAX_CONNECTIONS) return reject(503, 'Service Unavailable');

  const ip = getClientIp(request);
  const key = ipKey(ip);
  if (!ipTracker.canConnect(key)) return reject(429, 'Too Many Requests');

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.ipKey = key;
    ipTracker.increment(key);
    wss.emit('connection', ws, request);
  });
});

// ------------------------------------------------------------------ helpers

function sendJson(ws, payload) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* socket is closing */ }
}

function sendError(ws, code, message) {
  sendJson(ws, { type: 'error', code, message });
}

function strike(ws, code, message) {
  ws.strikes += 1;
  sendJson(ws, { type: 'warning', code, message });
  if (ws.strikes > CONFIG.MAX_STRIKES) ws.close(1008, 'Rate limit exceeded');
}

// ------------------------------------------------------------- connections

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.strikes = 0;
  ws.failedLookups = 0;
  // The server, not the client, decides who a socket is.
  ws.clientId = 'p_' + crypto.randomBytes(8).toString('hex');
  ws.msgBucket = new TokenBucketRateLimiter(CONFIG.MSG_BUCKET_CAPACITY, CONFIG.MSG_BUCKET_REFILL_PER_SEC);
  ws.lightBucket = new TokenBucketRateLimiter(CONFIG.LIGHT_BUCKET_CAPACITY, CONFIG.LIGHT_BUCKET_REFILL_PER_SEC);
  ws.byteBucket = new TokenBucketRateLimiter(CONFIG.BYTE_BUCKET_CAPACITY, CONFIG.BYTE_BUCKET_REFILL_PER_SEC);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    try {
      if (!ws.byteBucket.allow(raw.length)) {
        strike(ws, 'RATE_BYTES', 'You are sending too much data. Please slow down.');
        return;
      }

      let data;
      try { data = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!isPlainObject(data) || typeof data.action !== 'string') return;

      // Typing indicators and acks have their own, cheaper bucket - but they are never free.
      const light = data.action === 'typing' || data.action === 'ack';
      if (!(light ? ws.lightBucket : ws.msgBucket).allow()) {
        if (light) ws.strikes += 1;
        else strike(ws, 'RATE_MSGS', 'You are sending too fast. Please slow down.');
        if (ws.strikes > CONFIG.MAX_STRIKES) ws.close(1008, 'Rate limit exceeded');
        return;
      }

      handleClientAction(ws, data);
    } catch (err) {
      console.error('[Zero-Room.net] handler error:', err?.name || 'Error');
      sendError(ws, 'INTERNAL', 'Request failed');
    }
  });

  ws.on('close', (code) => {
    ipTracker.decrement(ws.ipKey);
    // 1000/1001/1005 = the user left on purpose (button, tab closed). Anything else keeps the seat briefly.
    roomManager.detachClient(ws, code === 1000 || code === 1001 || code === 1005);
  });

  ws.on('error', () => ws.terminate());

  sendJson(ws, { type: 'welcome', clientId: ws.clientId, pow: newChallenge(ws) });
});

function lookupFailed(ws) {
  ws.failedLookups += 1;
  if (ws.failedLookups > 20) ws.close(1008, 'Too many failed attempts');
}

/** Tells the new member about the room and everybody else that they arrived. */
function announceJoin(result) {
  sendJson(result.member.ws, {
    type: 'joined',
    roomId: result.roomId,
    clientId: result.clientId,
    resumeToken: result.resumeToken,
    peers: result.peers,
    createdAt: result.createdAt,
    expiryMinutes: result.expiryMinutes,
    creatorId: result.creatorId,
    state: result.state,
  });
  roomManager.broadcast(result.room, {
    type: 'peer_joined',
    clientId: result.clientId,
    nickname: result.member.nickname,
    publicKey: result.member.publicKey,
    proof: result.member.proof,
  }, result.clientId);
}

function handleClientAction(ws, data) {
  switch (data.action) {
    case 'create': {
      if (isBusy(ws)) return sendError(ws, 'ALREADY_IN_ROOM', 'Leave your current room first');
      const { roomId, nickname, publicKey, proof, expiryMinutes, nonce } = data;
      if (!isRoomId(roomId) || !isPublicKey(publicKey) || !isProof(proof)) {
        return sendError(ws, 'BAD_REQUEST', 'Invalid request');
      }

      // Proof of work: cheap to check, costly to mass-produce. A puzzle issued before the load rose is stale.
      if (!ws.pow || ws.pow.bits < powGate.bits()) {
        lookupFailed(ws);
        return sendJson(ws, { type: 'error', code: 'POW_STALE', message: 'Please try again', pow: newChallenge(ws) });
      }
      if (!powGate.verify(ws.pow, roomId, nonce)) {
        lookupFailed(ws);
        return sendJson(ws, { type: 'error', code: 'POW_FAILED', message: 'Verification failed, please try again', pow: newChallenge(ws) });
      }

      const result = roomManager.createRoom({
        roomId, ws, nickname: cleanNickname(nickname), publicKey, proof,
        expiryMinutes: cleanExpiry(expiryMinutes), ipKey: ws.ipKey,
        approval: data.approval === true, disappearSec: cleanDisappear(data.disappearSec),
      });
      if (result.error) return sendError(ws, result.code, result.error);
      powGate.recordCreate();

      sendJson(ws, {
        type: 'created',
        roomId: result.roomId,
        clientId: result.clientId,
        resumeToken: result.resumeToken,
        createdAt: result.createdAt,
        expiryMinutes: result.expiryMinutes,
        state: result.state,
      });
      return;
    }

    case 'join': {
      if (isBusy(ws)) return sendError(ws, 'ALREADY_IN_ROOM', 'Leave your current room first');
      const { roomId, nickname, publicKey, proof } = data;
      if (!isRoomId(roomId) || !isPublicKey(publicKey) || !isProof(proof)) {
        return sendError(ws, 'BAD_REQUEST', 'Invalid request');
      }

      const result = roomManager.joinRoom({ roomId, ws, nickname: cleanNickname(nickname), publicKey, proof });
      if (result.error) {
        lookupFailed(ws);
        return sendError(ws, result.code, result.error);
      }

      if (result.pending) {
        // The host decides. The request carries the proof so the host's browser can check it too.
        sendJson(ws, { type: 'join_pending', timeoutMs: 90000 });
        roomManager.sendTo(result.room, result.room.hostId, {
          type: 'join_request',
          clientId: result.request.clientId,
          nickname: result.request.nickname,
          publicKey: result.request.publicKey,
          proof: result.request.proof,
        });
        return;
      }

      announceJoin(result);
      return;
    }

    case 'resume': {
      if (isBusy(ws)) return sendError(ws, 'ALREADY_IN_ROOM', 'Already in a room');
      const { roomId, resumeToken, lastSeenSeq } = data;
      if (!isRoomId(roomId) || !isResumeToken(resumeToken)) return sendError(ws, 'BAD_REQUEST', 'Invalid request');

      const result = roomManager.resumeSession({ roomId, token: resumeToken, ws, lastSeenSeq: cleanSeq(lastSeenSeq) });
      if (result.error) {
        lookupFailed(ws);
        return sendError(ws, result.code, result.error);
      }

      sendJson(ws, {
        type: 'resumed',
        clientId: result.clientId,
        latestSeq: result.latestSeq,
        missedMessages: result.missedMessages,
        peers: result.peers,
        pendingRequests: result.pendingRequests,
        createdAt: result.createdAt,
        expiryMinutes: result.expiryMinutes,
        creatorId: result.creatorId,
        state: result.state,
      });
      roomManager.broadcast(result.room, { type: 'peer_resumed', clientId: result.clientId }, result.clientId);
      return;
    }

    case 'leave': {
      roomManager.leave(ws);
      sendJson(ws, { type: 'left', pow: newChallenge(ws) });
      return;
    }

    // Everything below requires an established room membership.
    case 'msg': {
      const membership = roomManager.getMembership(ws);
      if (!membership) return sendError(ws, 'NOT_IN_ROOM', 'You are not in a room');
      const { ciphertext } = data;
      if (typeof ciphertext !== 'string' || ciphertext.length === 0) return;

      const kind = data.kind === undefined ? 'text' : data.kind;
      if (!MESSAGE_KINDS.includes(kind)) return sendError(ws, 'BAD_REQUEST', 'Invalid request');
      const limits = {
        text: CONFIG.MAX_TEXT_CIPHERTEXT_CHARS,
        image: CONFIG.MAX_IMAGE_CIPHERTEXT_CHARS,
        file: CONFIG.MAX_FILE_CIPHERTEXT_CHARS,
        ctl: CONFIG.MAX_CTL_CIPHERTEXT_CHARS,
      };
      if (ciphertext.length > limits[kind]) return sendError(ws, 'TOO_LARGE', 'Message is too large');

      if (!membership.room.byteBucket.allow(ciphertext.length)) {
        return strike(ws, 'ROOM_RATE', 'This room is receiving too much data. Please slow down.');
      }
      roomManager.handleMessage(membership.room, membership.member, ciphertext, kind);
      return;
    }

    case 'typing': {
      const membership = roomManager.getMembership(ws);
      if (!membership) return;
      roomManager.broadcast(membership.room, {
        type: 'typing',
        senderId: ws.clientId,
        nickname: membership.member.nickname,
        isTyping: data.isTyping === true,
      }, ws.clientId);
      return;
    }

    case 'ack': {
      const membership = roomManager.getMembership(ws);
      if (!membership) return;
      const { targetClientId, seq } = data;
      if (!isClientId(targetClientId) || !Number.isSafeInteger(seq) || seq < 0) return;
      roomManager.sendTo(membership.room, targetClientId, { type: 'ack', seq, fromClientId: ws.clientId });
      return;
    }

    case 'key_exchange':
    case 'key_rotate': {
      const membership = roomManager.getMembership(ws);
      if (!membership) return sendError(ws, 'NOT_IN_ROOM', 'You are not in a room');
      const { targetClientId, encryptedPayload } = data;
      if (!isClientId(targetClientId) || !isKeyPayload(encryptedPayload, CONFIG.MAX_KEY_PAYLOAD_CHARS)) return;
      roomManager.sendTo(membership.room, targetClientId, {
        type: data.action,
        fromClientId: ws.clientId,
        encryptedPayload: { iv: encryptedPayload.iv, ciphertext: encryptedPayload.ciphertext },
      });
      return;
    }

    case 'approve':
    case 'deny': {
      const membership = roomManager.getMembership(ws);
      if (!membership) return sendError(ws, 'NOT_IN_ROOM', 'You are not in a room');
      if (!isClientId(data.targetClientId)) return;
      const result = roomManager.resolvePending(membership.room, ws.clientId, data.targetClientId, data.action === 'approve');
      if (result.error) return sendError(ws, result.code, result.error);
      if (!result.denied) announceJoin(result);
      return;
    }

    case 'kick': {
      const membership = roomManager.getMembership(ws);
      if (!membership) return sendError(ws, 'NOT_IN_ROOM', 'You are not in a room');
      if (!isClientId(data.targetClientId)) return;
      const result = roomManager.kick(membership.room, ws.clientId, data.targetClientId);
      if (result.error) sendError(ws, result.code, result.error);
      return;
    }

    case 'room_options': {
      const membership = roomManager.getMembership(ws);
      if (!membership) return sendError(ws, 'NOT_IN_ROOM', 'You are not in a room');
      const options = {};
      if (isBool(data.locked)) options.locked = data.locked;
      if (isBool(data.approval)) options.approval = data.approval;
      if (data.disappearSec !== undefined) options.disappearSec = cleanDisappear(data.disappearSec);
      const result = roomManager.setOptions(membership.room, ws.clientId, options);
      if (result.error) sendError(ws, result.code, result.error);
      return;
    }

    case 'extend': {
      const membership = roomManager.getMembership(ws);
      if (!membership) return sendError(ws, 'NOT_IN_ROOM', 'You are not in a room');
      const result = roomManager.extend(membership.room, ws.clientId, data.minutes);
      if (result.error) sendError(ws, result.code, result.error);
      return;
    }

    case 'burn': {
      const membership = roomManager.getMembership(ws);
      if (!membership) return sendError(ws, 'NOT_IN_ROOM', 'You are not in a room');
      const result = roomManager.burnRoom(membership.room.id, ws.clientId);
      if (result.error) sendError(ws, result.code, result.error);
      return;
    }

    default:
      sendError(ws, 'UNKNOWN_ACTION', 'Unsupported action');
  }
}

// -------------------------------------------------------------------- start

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`[Zero-Room.net] Relay listening on ${CONFIG.HOST}:${CONFIG.PORT} (zero-persistence, in-memory)`);
});

// Graceful termination: tell clients first, so users see why their room ended.
const shutdown = () => {
  heartbeat.stop();
  roomManager.shutdown();
  for (const client of wss.clients) {
    sendJson(client, { type: 'notice', code: 'SERVER_RESTART', message: 'The server is restarting. Rooms are in memory only and will end.' });
    client.close(1001, 'Server shutting down');
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
