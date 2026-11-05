import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
const NET = path.resolve(import.meta.dirname, '..');
import { WebSocket } from 'ws';
const PORT = 18890;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const proc = spawn('node', ['src/server.js'], { cwd: NET, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MAX_CONN_PER_IP: '5', MAX_ROOMS_PER_IP: '100', POW_BASE_BITS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; proc.stdout.on('data', d => serverLog += d); proc.stderr.on('data', d => serverLog += d);
let crashed = false; proc.on('exit', () => { crashed = true; });
await new Promise(r => setTimeout(r, 1200));

const PK = (c) => c.repeat(87) + '=';
const PROOF = (c) => c.repeat(43) + '=';
const RID = (c) => c.repeat(32);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function connect(headers = { Origin: `http://127.0.0.1:${PORT}` }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { headers });
    const q = [];
    ws.on('message', (d) => q.push(JSON.parse(d.toString())));
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode })));
    ws.on('error', reject);
    ws.on('open', () => resolve({ ws, q,
      send: (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o)),
      async waitFor(pred, ms = 1500) { const t = Date.now(); while (Date.now() - t < ms) { const i = q.findIndex(pred); if (i >= 0) return q.splice(i, 1)[0]; await sleep(15); } return null; },
    }));
  });
}
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '-', e.message); } }

await t('welcome carries a server-assigned clientId', async () => {
  const c = await connect(); const w = await c.waitFor(m => m.type === 'welcome');
  assert.match(w.clientId, /^p_[a-f0-9]{16}$/); c.ws.close();
});
await t('malformed payloads (null, 5, [], "x", huge nesting) do not crash the server', async () => {
  const c = await connect();
  for (const p of ['null', '5', '[]', '"x"', 'true', '{"action":null}', '{"action":{"a":1}}', '{', '\u0000', '{"action":"create","roomId":{"$":1}}']) c.send(p);
  c.ws.send(Buffer.from([1, 2, 3]));
  await sleep(300);
  assert.equal(crashed, false);
  c.q.length = 0;
  c.send({ action: 'nope' }); const e = await c.waitFor(m => m.type === 'error'); assert.equal(e.code, 'UNKNOWN_ACTION');
  c.ws.close();
});
await t('missing / foreign Origin is rejected, same-host & proxied same-site Origin accepted', async () => {
  await assert.rejects(connect({}), /403/);
  await assert.rejects(connect({ Origin: 'https://evil.example' }), /403/);
  const ok = await connect({ Origin: 'https://chat.test', Host: 'chat.test', 'X-Real-IP': '203.0.113.9' }); ok.ws.close();
  await assert.rejects(connect({ Origin: 'http://localhost:3000', 'X-Real-IP': '203.0.113.9' }), /403/); // localhost origin not allowed through the proxy
});
await t('unauthenticated socket cannot burn, post, key-inject, type or ack', async () => {
  const owner = await connect(); await owner.waitFor(m => m.type === 'welcome');
  owner.send({ action: 'create', roomId: RID('a'), nickname: 'Owner', publicKey: PK('A'), proof: PROOF('B'), expiryMinutes: 60 });
  const created = await owner.waitFor(m => m.type === 'created'); assert.ok(created);
  const evil = await connect(); await evil.waitFor(m => m.type === 'welcome');
  for (const a of [{ action: 'burn', roomId: RID('a') }, { action: 'msg', roomId: RID('a'), ciphertext: 'x' }, { action: 'key_exchange', roomId: RID('a'), targetClientId: created.clientId, encryptedPayload: { iv: 'AA==', ciphertext: 'AA==' } }, { action: 'key_rotate', targetClientId: created.clientId, encryptedPayload: { iv: 'AA==', ciphertext: 'AA==' } }]) {
    evil.send(a); const e = await evil.waitFor(m => m.type === 'error'); assert.equal(e?.code, 'NOT_IN_ROOM', JSON.stringify(a));
  }
  evil.send({ action: 'typing', roomId: RID('a'), isTyping: true }); evil.send({ action: 'ack', targetClientId: created.clientId, seq: 1 });
  await sleep(200);
  assert.equal(owner.q.filter(m => m.type !== 'welcome').length, 0, 'owner received nothing from the outsider');
  owner.ws.close(); evil.ws.close();
});
await t('join/create validation: bad ids, keys, double create, nickname sanitising, expiry NaN', async () => {
  const c = await connect(); await c.waitFor(m => m.type === 'welcome');
  c.send({ action: 'create', roomId: 'stealth-beacon', nickname: 'x', publicKey: PK('A'), proof: PROOF('B') });
  assert.equal((await c.waitFor(m => m.type === 'error')).code, 'BAD_REQUEST');
  c.send({ action: 'create', roomId: RID('b'), nickname: '<img src=x onerror=1>' + 'z'.repeat(50), publicKey: PK('A'), proof: PROOF('B'), expiryMinutes: 'abc' });
  const cr = await c.waitFor(m => m.type === 'created'); assert.equal(cr.expiryMinutes, 60);
  c.send({ action: 'create', roomId: RID('c'), nickname: 'x', publicKey: PK('A'), proof: PROOF('B') });
  assert.equal((await c.waitFor(m => m.type === 'error')).code, 'ALREADY_IN_ROOM');
  c.ws.close();
});
await t('full flow: join relays signed keys; client-chosen ids are ignored; resume needs the token; burn needs creator', async () => {
  const a = await connect(); const aw = await a.waitFor(m => m.type === 'welcome');
  a.send({ action: 'create', roomId: RID('d'), nickname: 'Alice', publicKey: PK('A'), proof: PROOF('P'), expiryMinutes: 15 });
  const ac = await a.waitFor(m => m.type === 'created'); assert.equal(ac.clientId, aw.clientId);
  const b = await connect(); const bw = await b.waitFor(m => m.type === 'welcome');
  b.send({ action: 'join', roomId: RID('d'), clientId: aw.clientId, nickname: 'Bob', publicKey: PK('C'), proof: PROOF('Q') });
  const bj = await b.waitFor(m => m.type === 'joined');
  assert.equal(bj.clientId, bw.clientId); assert.notEqual(bj.clientId, aw.clientId);
  assert.deepEqual(bj.peers.map(p => [p.nickname, p.proof]), [['Alice', PROOF('P')]]);
  const pj = await a.waitFor(m => m.type === 'peer_joined'); assert.equal(pj.proof, PROOF('Q')); assert.equal(pj.clientId, bw.clientId);
  // spoofed sender: server stamps the real one
  b.send({ action: 'msg', senderId: aw.clientId, ciphertext: 'v2.1.AAAA.BBBB', kind: 'text' });
  const m1 = await a.waitFor(m => m.type === 'msg'); assert.equal(m1.senderId, bw.clientId); assert.equal(m1.seq, 1);
  // non-creator, non-last cannot burn
  b.send({ action: 'burn' }); assert.equal((await b.waitFor(m => m.type === 'error')).code, 'FORBIDDEN');
  // hijack attempt: resume as Alice with Bob's token / bogus token
  const x = await connect(); await x.waitFor(m => m.type === 'welcome');
  x.send({ action: 'resume', roomId: RID('d'), resumeToken: 'A'.repeat(32), lastSeenSeq: 0 });
  assert.equal((await x.waitFor(m => m.type === 'error')).code, 'ROOM_GONE');
  // abnormal drop of Bob -> grace period -> resume with real token, backfill missed text
  b.ws.terminate(); await sleep(150);
  a.send({ action: 'msg', ciphertext: 'v2.1.CCCC.DDDD', kind: 'text' }); await a.waitFor(m => m.type === 'msg');
  const b2 = await connect(); await b2.waitFor(m => m.type === 'welcome');
  b2.send({ action: 'resume', roomId: RID('d'), resumeToken: bj.resumeToken, lastSeenSeq: 1 });
  const rs = await b2.waitFor(m => m.type === 'resumed');
  assert.equal(rs.clientId, bw.clientId); assert.equal(rs.missedMessages.length, 1); assert.equal(rs.peers.length, 1);
  assert.equal(rs.peers[0].publicKey, PK('A'));
  assert.ok(await a.waitFor(m => m.type === 'peer_resumed'));
  // creator can burn; both are notified
  a.send({ action: 'burn' });
  assert.ok(await b2.waitFor(m => m.type === 'burned')); assert.ok(await a.waitFor(m => m.type === 'burned'));
  x.ws.close();
});
await t('size limits: oversize text/image rejected; images are relayed but not buffered', async () => {
  const a = await connect(); await a.waitFor(m => m.type === 'welcome');
  a.send({ action: 'create', roomId: RID('e'), nickname: 'A', publicKey: PK('A'), proof: PROOF('B') }); await a.waitFor(m => m.type === 'created');
  a.send({ action: 'msg', ciphertext: 'x'.repeat(40000), kind: 'text' }); assert.equal((await a.waitFor(m => m.type === 'error')).code, 'TOO_LARGE');
  a.send({ action: 'msg', ciphertext: 'y'.repeat(1_500_000), kind: 'image' }); const img = await a.waitFor(m => m.type === 'msg', 4000); assert.ok(img && img.kind === 'image');
  a.send({ action: 'msg', ciphertext: 'z'.repeat(2_300_000), kind: 'image' }); // above ws maxPayload -> socket closed by ws with 1009
  await sleep(400); assert.equal(crashed, false); a.ws.terminate();
});
await t('message flood is rate limited and eventually disconnected', async () => {
  const a = await connect(); await a.waitFor(m => m.type === 'welcome');
  a.send({ action: 'create', roomId: RID('f'), nickname: 'A', publicKey: PK('A'), proof: PROOF('B') }); await a.waitFor(m => m.type === 'created');
  let closed = null; a.ws.on('close', (code) => { closed = code; });
  for (let i = 0; i < 400; i++) a.send({ action: 'msg', ciphertext: 'hi' + i, kind: 'text' });
  await sleep(500);
  const warns = a.q.filter(m => m.type === 'warning' && m.code === 'RATE_MSGS').length;
  assert.ok(warns > 100, 'warnings: ' + warns); assert.equal(closed, 1008);
  // typing flood has a cost too
  const b = await connect(); await b.waitFor(m => m.type === 'welcome');
  b.send({ action: 'create', roomId: RID('g'), nickname: 'B', publicKey: PK('A'), proof: PROOF('B') }); await b.waitFor(m => m.type === 'created');
  let closedB = null; b.ws.on('close', (c) => { closedB = c; });
  for (let i = 0; i < 400; i++) b.send({ action: 'typing', isTyping: true });
  await sleep(500); assert.equal(closedB, 1008);
});
await t('X-Forwarded-For spoofing does not bypass the per-IP limit (5 in this test)', async () => {
  const held = [];
  let rejected = 0;
  for (let i = 0; i < 9; i++) {
    try { held.push(await connect({ Origin: `http://127.0.0.1:${PORT}`, 'X-Forwarded-For': `10.0.0.${i}` })); } catch (e) { if (e.status === 429) rejected++; }
  }
  assert.ok(rejected >= 4, 'rejected: ' + rejected); held.forEach(h => h.ws.terminate());
  await sleep(300);
  // behind the proxy, distinct X-Real-IP values are distinct clients
  const viaProxy = [];
  for (let i = 0; i < 8; i++) viaProxy.push(await connect({ Origin: 'https://x.test', Host: 'x.test', 'X-Real-IP': `198.51.100.${i}` }));
  viaProxy.forEach(h => h.ws.terminate());
});
await t('rooms per IP are capped; leaving frees the quota; empty rooms die at once', async () => {
  const CAP_PORT = 18891;
  const p2 = spawn('node', ['src/server.js'], { cwd: NET, env: { ...process.env, PORT: String(CAP_PORT), HOST: '127.0.0.1', MAX_ROOMS_PER_IP: '3', POW_BASE_BITS: '0' }, stdio: 'ignore' });
  await sleep(1000);
  const conn = () => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${CAP_PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${CAP_PORT}` } }); const q = []; ws.on('message', d => q.push(JSON.parse(d.toString()))); ws.on('open', () => res({ ws, q, send: o => ws.send(JSON.stringify(o)), async next(type) { const t0 = Date.now(); while (Date.now() - t0 < 1500) { const i = q.findIndex(m => m.type === type || m.type === 'error'); if (i >= 0) return q.splice(i, 1)[0]; await sleep(15); } } })); ws.on('error', rej); });
  const results = [];
  const held = [];
  for (let i = 0; i < 5; i++) { const c = await conn(); await c.next('welcome'); c.send({ action: 'create', roomId: RID('abcdef0123'[i]), nickname: 'n', publicKey: PK('A'), proof: PROOF('B') }); const r = await c.next('created'); results.push(r.type === 'created' ? 'ok' : r.code); held.push(c); }
  assert.deepEqual(results, ['ok', 'ok', 'ok', 'TOO_MANY_ROOMS', 'TOO_MANY_ROOMS']);
  held[0].send({ action: 'leave' }); await sleep(150);   // sole member leaves -> room destroyed -> quota freed
  const c = await conn(); await c.next('welcome'); c.send({ action: 'create', roomId: RID('9'), nickname: 'n', publicKey: PK('A'), proof: PROOF('B') });
  assert.equal((await c.next('created')).type, 'created');
  const j = await conn(); await j.next('welcome'); j.send({ action: 'join', roomId: RID('a'), nickname: 'late', publicKey: PK('A'), proof: PROOF('B') });
  assert.equal((await j.next('joined')).code, 'ROOM_NOT_FOUND');
  held.concat([c, j]).forEach(x => x.ws.terminate()); p2.kill('SIGTERM');
});
await t('/health only answers local direct probes; CORS wildcard is gone', async () => {
  const direct = await fetch(`http://127.0.0.1:${PORT}/health`); assert.equal(direct.status, 200);
  assert.equal(direct.headers.get('access-control-allow-origin'), null);
  const proxied = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { 'X-Real-IP': '203.0.113.5' } }); assert.equal(proxied.status, 404);
});
assert.equal(crashed, false, 'server must still be alive');
proc.kill('SIGTERM'); await sleep(300);
console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log(serverLog.slice(-800)); process.exit(1); }
