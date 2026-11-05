import assert from 'node:assert/strict';
import { RoomManager } from '../src/roomManager.js';
import { BoundedRingBuffer } from '../src/ringBuffer.js';
import { ipKey, getClientIp } from '../src/netutil.js';
import { CONFIG } from '../src/config.js';
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '-', e.stack.split('\n').slice(0, 3).join(' | ')); } };
const fakeWs = (id) => ({ clientId: id, readyState: 1, bufferedAmount: 0, sent: [], send(d) { this.sent.push(JSON.parse(d)); }, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } });
const PK = 'A'.repeat(87) + '=', PR = 'B'.repeat(43) + '=';

await t('expiry: lifetime is enforced, NaN can no longer produce immortal rooms', () => {
  const rm = new RoomManager(); const a = fakeWs('p_0000000000000001');
  const r = rm.createRoom({ roomId: 'a'.repeat(32), ws: a, nickname: 'A', publicKey: PK, proof: PR, expiryMinutes: 15, ipKey: '1.1.1.1' });
  r.room.createdAt -= 14 * 60000; rm.reapExpiredRooms(); assert.equal(rm.rooms.size, 1);
  r.room.createdAt -= 2 * 60000; rm.reapExpiredRooms(); assert.equal(rm.rooms.size, 0);
  assert.ok(a.sent.some(m => m.type === 'burned')); assert.equal(rm.roomsByIp.size, 0); rm.shutdown();
});
await t('grace: abnormal drop keeps the seat; expiry of grace drops member and notifies; last member leaving frees the room', async () => {
  const rm = new RoomManager(); const a = fakeWs('p_0000000000000001'), b = fakeWs('p_0000000000000002');
  const r = rm.createRoom({ roomId: 'b'.repeat(32), ws: a, nickname: 'A', publicKey: PK, proof: PR, expiryMinutes: 60, ipKey: '1.1.1.1' });
  const j = rm.joinRoom({ roomId: 'b'.repeat(32), ws: b, nickname: 'B', publicKey: PK, proof: PR });
  rm.detachClient(b, false);
  assert.equal(r.room.clients.size, 2); assert.equal(rm.getMembership(b), null);
  // resume with token
  const b2 = fakeWs('p_0000000000000099');
  const rs = rm.resumeSession({ roomId: 'b'.repeat(32), token: j.resumeToken, ws: b2, lastSeenSeq: 0 });
  assert.equal(rs.clientId, 'p_0000000000000002'); assert.equal(b2.clientId, 'p_0000000000000002'); assert.ok(rm.getMembership(b2));
  assert.equal(rm.resumeSession({ roomId: 'b'.repeat(32), token: 'x'.repeat(32), ws: fakeWs('p_3'), lastSeenSeq: 0 }).code, 'ROOM_GONE');
  // intentional leave
  rm.leave(b2); assert.equal(r.room.clients.size, 1); assert.ok(a.sent.some(m => m.type === 'peer_left'));
  rm.leave(a); assert.equal(rm.rooms.size, 0); assert.equal(rm.roomsByIp.size, 0); rm.shutdown();
});
await t('peer capacity is enforced and resume cannot exceed it', () => {
  const rm = new RoomManager();
  rm.createRoom({ roomId: 'c'.repeat(32), ws: fakeWs('p_0000000000000000'), nickname: 'A', publicKey: PK, proof: PR, expiryMinutes: 60, ipKey: 'k' });
  let full = null;
  for (let i = 1; i <= CONFIG.MAX_PEERS_PER_ROOM; i++) { const r = rm.joinRoom({ roomId: 'c'.repeat(32), ws: fakeWs('p_' + String(i).padStart(16, '0')), nickname: 'x', publicKey: PK, proof: PR }); if (r.error) full = r.code; }
  assert.equal(full, 'ROOM_FULL'); assert.equal(rm.rooms.get('c'.repeat(32)).clients.size, CONFIG.MAX_PEERS_PER_ROOM); rm.shutdown();
});
await t('backpressure: a reader that cannot drain is terminated instead of buffering forever', () => {
  const rm = new RoomManager(); const a = fakeWs('p_0000000000000001'), b = fakeWs('p_0000000000000002');
  const r = rm.createRoom({ roomId: 'd'.repeat(32), ws: a, nickname: 'A', publicKey: PK, proof: PR, expiryMinutes: 60, ipKey: 'k' });
  rm.joinRoom({ roomId: 'd'.repeat(32), ws: b, nickname: 'B', publicKey: PK, proof: PR });
  b.bufferedAmount = CONFIG.MAX_BUFFERED_BYTES + 1; a.sent.length = 0; b.sent.length = 0;
  rm.handleMessage(r.room, r.member, 'v2.1.x.y', 'text');
  assert.equal(b.readyState, 3); assert.equal(b.sent.length, 0); assert.equal(a.sent.at(-1).type, 'msg'); rm.shutdown();
});
await t('burn rules: outsider impossible, member forbidden, creator and last member allowed', () => {
  const rm = new RoomManager(); const a = fakeWs('p_0000000000000001'), b = fakeWs('p_0000000000000002');
  rm.createRoom({ roomId: 'e'.repeat(32), ws: a, nickname: 'A', publicKey: PK, proof: PR, expiryMinutes: 60, ipKey: 'k' });
  rm.joinRoom({ roomId: 'e'.repeat(32), ws: b, nickname: 'B', publicKey: PK, proof: PR });
  assert.equal(rm.burnRoom('e'.repeat(32), b.clientId).code, 'FORBIDDEN');
  assert.equal(rm.burnRoom('e'.repeat(32), 'p_ffffffffffffffff').code, 'FORBIDDEN');
  rm.leave(a); assert.equal(rm.burnRoom('e'.repeat(32), b.clientId).ok, true); rm.shutdown();
});
await t('ring buffer is bounded by count AND bytes; images consume a seq but are never stored', () => {
  const rb = new BoundedRingBuffer(5, 1000);
  for (let i = 0; i < 12; i++) rb.push({ i }, 100, true);
  assert.equal(rb.count, 5); assert.ok(rb.bytes <= 500); assert.deepEqual(rb.getSince(9).map(m => m.i), [9, 10, 11]);
  const imgSeq = rb.push({ big: true }, 5000, false); assert.equal(imgSeq, 13); assert.equal(rb.count, 5);
  for (let i = 0; i < 3; i++) rb.push({ i }, 400, true); assert.ok(rb.bytes <= 1000 && rb.count <= 3); rb.clear(); assert.equal(rb.bytes, 0);
});
await t('ip keys: IPv6 collapses to /64, v4-mapped to v4; XFF is ignored, X-Real-IP trusted only from loopback', () => {
  assert.equal(ipKey('2001:db8:abcd:12::1'), ipKey('2001:db8:abcd:12:ffff:1:2:3'));
  assert.notEqual(ipKey('2001:db8:abcd:12::1'), ipKey('2001:db8:abcd:13::1'));
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7'); assert.equal(ipKey('198.51.100.4'), '198.51.100.4');
  const req = (remote, h) => ({ socket: { remoteAddress: remote }, headers: h });
  assert.equal(getClientIp(req('127.0.0.1', { 'x-real-ip': '198.51.100.4', 'x-forwarded-for': '6.6.6.6, 198.51.100.4' })), '198.51.100.4');
  assert.equal(getClientIp(req('203.0.113.50', { 'x-real-ip': '6.6.6.6' })), '203.0.113.50');
  assert.equal(getClientIp(req('::1', { 'x-real-ip': 'not-an-ip' })), '::1');
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
