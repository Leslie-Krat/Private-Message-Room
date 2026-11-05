import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256, leadingZeroBits, solve } from '../../Zero-Room.web/js/pow-core.js';
import { PowGate } from '../src/pow.js';

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '-', e.stack.split('\n').slice(0, 3).join(' | ')); } };

await t('browser SHA-256 matches Node for many lengths (block-boundary cases included)', () => {
  for (const len of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 200, 1000]) {
    const data = crypto.randomBytes(len);
    assert.equal(Buffer.from(sha256(data)).toString('hex'), crypto.createHash('sha256').update(data).digest('hex'), 'len ' + len);
  }
  assert.equal(Buffer.from(sha256(new TextEncoder().encode('abc'))).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

await t('solver output is accepted by the relay gate; shared searches (start/step) find valid nonces', () => {
  const gate = new PowGate({ baseBits: 12 });
  const challenge = gate.issue();
  const roomId = 'ab'.repeat(16);
  const nonce = solve({ seed: challenge.seed, roomId, bits: challenge.bits });
  assert.equal(gate.verify(challenge, roomId, nonce), true);
  assert.equal(gate.verify(challenge, 'cd'.repeat(16), nonce), challenge.bits === 0);
  for (const start of [0, 1, 2, 3]) {
    const n = solve({ seed: challenge.seed, roomId, bits: 10, start, step: 4 });
    assert.ok(leadingZeroBits(crypto.createHash('sha256').update(`${challenge.seed}:${roomId}:${n}`).digest()) >= 10);
  }
});

await t('speed: 16-bit puzzle is solved quickly', () => {
  const t0 = Date.now();
  solve({ seed: 'x'.repeat(24), roomId: 'ef'.repeat(16), bits: 16 });
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
