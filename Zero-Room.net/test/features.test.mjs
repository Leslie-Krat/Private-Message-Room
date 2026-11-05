import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { WebSocket } from 'ws';
import { leadingZeroBits, PowGate } from '../src/pow.js';

const NET = path.resolve(import.meta.dirname, '..');
const PORT = 18891;
const POW_PORT = 18892;
const spawnRelay = (port, extra = {}) => spawn('node', ['src/server.js'], {
  cwd: NET, stdio: 'ignore',
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', MAX_CONN_PER_IP: '50', MAX_ROOMS_PER_IP: '100', ...extra },
});
const procs = [spawnRelay(PORT, { POW_BASE_BITS: '0' }), spawnRelay(POW_PORT, { POW_BASE_BITS: '8' })];
await new Promise((r) => setTimeout(r, 1200));

const PK = (c) => c.repeat(87) + '=';
const PROOF = (c) => c.repeat(43) + '=';
const RID = (c) => c.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(port = PORT) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    const q = [];
    ws.on('message', (d) => q.push(JSON.parse(d.toString())));
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws, q,
      send: (o) => ws.send(JSON.stringify(o)),
      async waitFor(pred, ms = 1500) {
        const t = Date.now();
        while (Date.now() - t < ms) { const i = q.findIndex(pred); if (i >= 0) return q.splice(i, 1)[0]; await sleep(15); }
        return null;
      },
      type: (t, ms) => this_wait(q, t, ms),
    }));
  });
}
function this_wait(q, type, ms = 1500) {
  return (async () => {
    const t = Date.now();
    while (Date.now() - t < ms) { const i = q.findIndex((m) => m.type === type); if (i >= 0) return q.splice(i, 1)[0]; await sleep(15); }
    return null;
  })();
}

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '-', e.message); } }

const close = (...cs) => cs.forEach((c) => c.ws.close());
async function host(opts = {}, rid = RID('1')) {
  const c = await connect(); await c.type('welcome');
  c.send({ action: 'create', roomId: rid, nickname: 'Host', publicKey: PK('A'), proof: PROOF('B'), expiryMinutes: 60, ...opts });
  const created = await c.type('created');
  assert.ok(created, 'room created');
  return { c, created };
}
async function guest(rid, name = 'Guest') {
  const c = await connect(); await c.type('welcome');
  c.send({ action: 'join', roomId: rid, nickname: name, publicKey: PK('C'), proof: PROOF('D') });
  return c;
}

await t('proof of work: pure helpers behave', () => {
  assert.equal(leadingZeroBits(Buffer.from([0, 0, 0x10])), 19);
  assert.equal(leadingZeroBits(Buffer.from([0xff])), 0);
  const gate = new PowGate({ baseBits: 10, maxExtraBits: 3, stepEvery: 2 });
  assert.equal(gate.bits(), 10);
  for (let i = 0; i < 4; i++) gate.recordCreate();
  assert.equal(gate.bits(), 12);
  for (let i = 0; i < 100; i++) gate.recordCreate();
  assert.equal(gate.bits(), 13);
  const ch = { seed: 'aa', bits: 8, issuedAt: Date.now() };
  assert.equal(gate.verify(ch, RID('a'), 'zzzz'), crypto.createHash('sha256').update('aa:' + RID('a') + ':zzzz').digest()[0] === 0);
  assert.equal(gate.verify(ch, RID('a'), '../x'), false);
  assert.equal(gate.verify({ ...ch, issuedAt: Date.now() - 11 * 60000 }, RID('a'), '1'), false);
  assert.equal(new PowGate({ baseBits: 0 }).bits(), 0);
});

await t('proof of work: relay refuses unsolved or foreign solutions and accepts a real one', async () => {
  const c = await connect(POW_PORT);
  const w = await c.type('welcome');
  assert.equal(w.pow.bits, 8); assert.match(w.pow.seed, /^[a-f0-9]{24}$/);
  const base = { action: 'create', roomId: RID('7'), nickname: 'x', publicKey: PK('A'), proof: PROOF('B'), expiryMinutes: 60 };
  c.send(base);
  const e1 = await c.type('error'); assert.equal(e1.code, 'POW_FAILED'); assert.ok(e1.pow.seed);
  // solve for a different room id, then replay it on ours
  const solve = (seed, rid) => { for (let n = 0; ; n++) { const s = n.toString(36); if (leadingZeroBits(crypto.createHash('sha256').update(`${seed}:${rid}:${s}`).digest()) >= 8) return s; } };
  const other = solve(e1.pow.seed, RID('8'));
  c.send({ ...base, nonce: other });
  const e2 = await c.type('error'); assert.equal(e2.code, 'POW_FAILED');
  c.send({ ...base, nonce: solve(e2.pow.seed, RID('7')) });
  assert.ok(await c.type('created'));
  close(c);
});

await t('host moderation: only the host can kick, lock, set options, extend; kicked member loses its token', async () => {
  const { c: h, created } = await host({}, RID('2'));
  const g = await guest(RID('2')); const gj = await g.type('joined');
  assert.equal(gj.creatorId, created.clientId); assert.equal(gj.state.hostId, created.clientId);
  assert.ok(await h.type('peer_joined'));
  // guest tries everything
  for (const a of [{ action: 'kick', targetClientId: created.clientId }, { action: 'room_options', locked: true }, { action: 'extend', minutes: 15 }, { action: 'approve', targetClientId: created.clientId }]) {
    g.send(a); const e = await g.type('error'); assert.ok(['NOT_HOST', 'TARGET_NOT_FOUND'].includes(e?.code), JSON.stringify(a) + ' -> ' + e?.code);
  }
  g.send({ action: 'burn' }); assert.equal((await g.type('error')).code, 'FORBIDDEN');
  // host extends and changes options
  h.send({ action: 'extend', minutes: 60 });
  const st = await g.waitFor((m) => m.type === 'room_state' && m.state.expiryMinutes === 120); assert.ok(st);
  h.send({ action: 'extend', minutes: 7 }); assert.equal((await h.type('error')).code, 'BAD_REQUEST');
  h.send({ action: 'room_options', disappearSec: 300, locked: true });
  const st2 = await g.waitFor((m) => m.type === 'room_state' && m.state.disappearSec === 300 && m.state.locked); assert.ok(st2);
  h.send({ action: 'room_options', disappearSec: 7 });
  const st3 = await g.waitFor((m) => m.type === 'room_state' && m.state.disappearSec === 0); assert.ok(st3, 'invalid timer collapses to off');
  // locked room refuses newcomers
  const late = await guest(RID('2')); assert.equal((await late.type('error')).code, 'ROOM_LOCKED');
  // kick
  h.send({ action: 'kick', targetClientId: gj.clientId });
  assert.ok(await g.type('kicked')); assert.ok(await h.waitFor((m) => m.type === 'peer_left' && m.clientId === gj.clientId));
  const g2 = await connect(); await g2.type('welcome');
  g2.send({ action: 'resume', roomId: RID('2'), resumeToken: gj.resumeToken, lastSeenSeq: 0 });
  assert.equal((await g2.type('error')).code, 'ROOM_GONE');
  h.send({ action: 'kick', targetClientId: created.clientId }); assert.equal((await h.type('error')).code, 'BAD_REQUEST');
  close(h, g, g2, late);
});

await t('lifetime can never exceed 24 hours', async () => {
  const { c: h } = await host({ expiryMinutes: 1400 }, RID('3'));
  h.send({ action: 'extend', minutes: 60 });
  const st = await h.waitFor((m) => m.type === 'room_state' && m.state.expiryMinutes === 1440); assert.ok(st);
  h.send({ action: 'extend', minutes: 15 }); assert.equal((await h.type('error')).code, 'MAX_LIFETIME');
  close(h);
});

await t('join approval: request reaches only the host; approve admits, deny and timeout reject; waiting sockets cannot act', async () => {
  const { c: h, created } = await host({ approval: true }, RID('4'));
  const g = await guest(RID('4'), 'Eve');
  assert.ok(await g.type('join_pending'));
  const req = await h.type('join_request'); assert.equal(req.nickname, 'Eve'); assert.equal(req.publicKey, PK('C'));
  // a waiting socket has no powers
  for (const a of [{ action: 'msg', ciphertext: 'x' }, { action: 'kick', targetClientId: created.clientId }, { action: 'burn' }, { action: 'room_options', locked: true }]) {
    g.send(a); assert.equal((await g.type('error'))?.code, 'NOT_IN_ROOM');
  }
  g.send({ action: 'join', roomId: RID('4'), nickname: 'x', publicKey: PK('C'), proof: PROOF('D') });
  assert.equal((await g.type('error')).code, 'ALREADY_IN_ROOM');
  h.send({ action: 'approve', targetClientId: req.clientId });
  const joined = await g.type('joined'); assert.ok(joined); assert.equal(joined.peers.length, 1);
  assert.ok(await h.type('peer_joined'));
  // deny path
  const g2 = await guest(RID('4'), 'Mallory'); await g2.type('join_pending');
  const req2 = await h.type('join_request');
  h.send({ action: 'deny', targetClientId: req2.clientId });
  assert.equal((await g2.type('join_denied')).code, 'JOIN_DENIED');
  // cancelled by the requester closing
  const g3 = await guest(RID('4'), 'Gone'); await g3.type('join_pending'); const req3 = await h.type('join_request');
  g3.ws.close();
  const cancel = await h.type('join_request_cancelled'); assert.equal(cancel.clientId, req3.clientId);
  // pending queue is capped
  const many = [];
  for (let i = 0; i < 6; i++) { const x = await guest(RID('4'), 'n' + i); many.push(x); }
  await sleep(300);
  const codes = many.map((x) => x.q.find((m) => m.type === 'error')?.code).filter(Boolean);
  assert.deepEqual(codes, ['TOO_MANY_PENDING']);
  close(h, g, g2, g3, ...many);
});

await t('host leaves: longest-present member becomes host, pending requests move along, resume reports pending for the new host', async () => {
  const { c: h } = await host({ approval: true }, RID('5'));
  // first guest is approved
  const a = await guest(RID('5'), 'A'); await a.type('join_pending');
  const ra = await h.type('join_request'); h.send({ action: 'approve', targetClientId: ra.clientId });
  const aj = await a.type('joined');
  const b = await guest(RID('5'), 'B'); await b.type('join_pending'); await h.type('join_request');
  h.send({ action: 'leave' });
  const st = await a.waitFor((m) => m.type === 'room_state' && m.state.hostId === aj.clientId); assert.ok(st, 'A is host now');
  const moved = await a.type('join_request'); assert.equal(moved.nickname, 'B');
  // A drops abnormally and resumes: still host and still sees the pending request
  a.ws.terminate(); await sleep(100);
  const a2 = await connect(); await a2.type('welcome');
  a2.send({ action: 'resume', roomId: RID('5'), resumeToken: aj.resumeToken, lastSeenSeq: 0 });
  const rs = await a2.type('resumed'); assert.equal(rs.state.hostId, aj.clientId); assert.equal(rs.pendingRequests.length, 1);
  close(h, b, a2);
});

await t('message kinds: file and ctl accepted, ctl replayed after reconnect, file never stored, limits enforced, unknown kind refused', async () => {
  const { c: h } = await host({}, RID('6'));
  const g = await guest(RID('6')); const gj = await g.type('joined');
  g.ws.terminate(); await sleep(100);
  h.send({ action: 'msg', kind: 'file', ciphertext: 'v2.1.' + 'a'.repeat(300 * 1024) });
  h.send({ action: 'msg', kind: 'ctl', ciphertext: 'v2.1.aaaa.bbbb' });
  h.send({ action: 'msg', kind: 'text', ciphertext: 'v2.1.aaaa.cccc' });
  h.send({ action: 'msg', kind: 'file', ciphertext: 'x'.repeat(410 * 1024) });
  assert.equal((await h.type('error')).code, 'TOO_LARGE');
  h.send({ action: 'msg', kind: 'ctl', ciphertext: 'x'.repeat(9 * 1024) });
  assert.equal((await h.type('error')).code, 'TOO_LARGE');
  h.send({ action: 'msg', kind: 'exe', ciphertext: 'x' });
  assert.equal((await h.type('error')).code, 'BAD_REQUEST');
  await sleep(200);
  const g2 = await connect(); await g2.type('welcome');
  g2.send({ action: 'resume', roomId: RID('6'), resumeToken: gj.resumeToken, lastSeenSeq: 0 });
  const rs = await g2.type('resumed');
  assert.deepEqual(rs.missedMessages.map((m) => m.kind), ['ctl', 'text']);
  close(h, g2);
});

await t('disappearing timer is applied and messages inside the window are replayed', async () => {
  const { c: h } = await host({ disappearSec: 30 }, RID('9'));
  const g = await guest(RID('9')); const gj = await g.type('joined');
  assert.equal(gj.state.disappearSec, 30);
  g.ws.terminate(); await sleep(100);
  h.send({ action: 'msg', kind: 'text', ciphertext: 'v2.1.aaaa.dddd' }); await sleep(100);
  h.send({ action: 'room_options', disappearSec: 0 }); await sleep(50);
  const g2 = await connect(); await g2.type('welcome');
  g2.send({ action: 'resume', roomId: RID('9'), resumeToken: gj.resumeToken, lastSeenSeq: 0 });
  assert.equal((await g2.type('resumed')).missedMessages.length, 1);
  close(h, g2);
});

procs.forEach((p) => p.kill());
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
