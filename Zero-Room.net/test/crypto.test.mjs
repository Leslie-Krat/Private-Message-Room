// Tests for the browser crypto module (protocol v2). Runs in Node 22 because the module only uses WebCrypto.
import assert from 'node:assert/strict';
import { CryptoEngine, generateInviteSecret, parseInvite, inviteNeedsPassphrase, inviteFragment, roomSlug } from '../../Zero-Room.web/js/crypto.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '-', e.stack.split('\n').slice(0, 3).join(' | ')); }
};

/** A member of a room: its own engine, a fake server-assigned id, public key and proof. */
async function member(secret, id) {
  const c = new CryptoEngine();
  await c.setInvite(secret);
  const publicKey = await c.initIdentity();
  const proof = await c.makeProof(id, publicKey);
  return { c, id, publicKey, proof };
}

const A = 'p_00000000000000a1', B = 'p_00000000000000b2', C = 'p_00000000000000c3';

await t('invite secrets: format, parsing links and codes', () => {
  const s = generateInviteSecret();
  assert.match(s, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(s, generateInviteSecret());
  assert.equal(parseInvite(s), s);
  assert.equal(parseInvite(`https://example.org/#${s}`), s);
  assert.equal(parseInvite(`  https://example.org/app/#${s}  `), s);
  assert.equal(parseInvite('quantum-beacon-42'), null);
  assert.equal(parseInvite(''), null);
  assert.equal(parseInvite(null), null);
  assert.equal(parseInvite(`https://example.org/?room=${s}`), null); // old format is not accepted
});

await t('room id: derived, stable, hides the secret, friendly slug is stable', async () => {
  const s = generateInviteSecret();
  const a = new CryptoEngine(), b = new CryptoEngine();
  const id1 = await a.setInvite(s), id2 = await b.setInvite(s);
  assert.equal(id1, id2);
  assert.match(id1, /^[a-f0-9]{32}$/);
  assert.ok(!id1.includes(s));
  assert.notEqual(id1, await new CryptoEngine().setInvite(generateInviteSecret()));
  assert.equal(roomSlug(id1), roomSlug(id2));
  assert.match(roomSlug(id1), /^[a-z]+-[a-z]+-\d\d$/);
  await assert.rejects(() => new CryptoEngine().setInvite('short'));
});

await t('public key and proof have the shapes the relay validates', async () => {
  const m = await member(generateInviteSecret(), A);
  assert.match(m.publicKey, /^[A-Za-z0-9+/]{87}=$/);
  assert.match(m.proof, /^[A-Za-z0-9+/]{43}=$/);
});

await t('proofs: valid only with the same secret, id and key', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A);
  const bob = await member(s, B);
  assert.equal(await bob.c.verifyProof(A, alice.publicKey, alice.proof), true);
  assert.equal(await bob.c.verifyProof(C, alice.publicKey, alice.proof), false);      // wrong id
  assert.equal(await bob.c.verifyProof(A, bob.publicKey, alice.proof), false);        // key swapped (relay MITM)
  const mallory = await member(generateInviteSecret(), C);                            // no invite
  assert.equal(await bob.c.verifyProof(C, mallory.publicKey, mallory.proof), false);
  assert.equal(await bob.c.verifyProof(A, alice.publicKey, 'not base64!'), false);
  assert.equal(await bob.c.verifyProof(A, alice.publicKey, undefined), false);
});

await t('key exchange: creator -> joiner, both end up with the same fingerprint', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A), bob = await member(s, B);
  await alice.c.generateRoomKey();
  assert.equal(bob.c.hasKey, false);
  const wrapped = await alice.c.wrapCurrentKey(bob.publicKey, A, B);
  assert.equal(await bob.c.acceptWrappedKey(alice.publicKey, A, B, wrapped), 'accepted');
  const fa = await alice.c.fingerprint(), fb = await bob.c.fingerprint();
  assert.equal(fa, fb);
  assert.match(fa, /^([0-9A-F]{4}-){5}[0-9A-F]{4}$/); // 96 bits
  assert.equal(await bob.c.acceptWrappedKey(alice.publicKey, A, B, wrapped), 'stale'); // same epoch again
});

await t('key exchange: bound to sender and receiver (relay cannot redirect or replay it)', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A), bob = await member(s, B), carol = await member(s, C);
  await alice.c.generateRoomKey();
  const forBob = await alice.c.wrapCurrentKey(bob.publicKey, A, B);
  assert.equal(await carol.c.acceptWrappedKey(alice.publicKey, A, C, forBob), 'invalid'); // delivered to someone else
  assert.equal(await bob.c.acceptWrappedKey(alice.publicKey, C, B, forBob), 'invalid');   // relabelled sender
  assert.equal(await bob.c.acceptWrappedKey(carol.publicKey, A, B, forBob), 'invalid');   // wrong public key
  assert.equal(bob.c.hasKey, false);
});

await t('key exchange: rejects garbage payloads and never throws', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A), bob = await member(s, B);
  for (const bad of [{}, { iv: 'x', ciphertext: 'y' }, { iv: '', ciphertext: '' }, null, undefined, { iv: 5, ciphertext: [] }]) {
    assert.equal(await bob.c.acceptWrappedKey(alice.publicKey, A, B, bad), 'invalid');
  }
  assert.equal(await bob.c.acceptWrappedKey('AAAA', A, B, { iv: 'AAAA', ciphertext: 'AAAA' }), 'invalid');
});

await t('messages: round trip, padding hides length, unicode survives', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A), bob = await member(s, B);
  await alice.c.generateRoomKey();
  await bob.c.acceptWrappedKey(alice.publicKey, A, B, await alice.c.wrapCurrentKey(bob.publicKey, A, B));

  const w = await alice.c.encryptMessage('héllo wörld 👋', { senderId: A, kind: 'text' });
  assert.match(w, /^v2\.0\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
  assert.deepEqual(await bob.c.decryptMessage(w, { senderId: A, kind: 'text' }), { status: 'ok', text: 'héllo wörld 👋', meta: null });

  const short = await alice.c.encryptMessage('a', { senderId: A, kind: 'text' });
  const longer = await alice.c.encryptMessage('a'.repeat(60), { senderId: A, kind: 'text' });
  assert.equal(short.length, longer.length); // same 128-byte bucket
  const big = await alice.c.encryptMessage('z'.repeat(200000), { senderId: A, kind: 'image' });
  assert.equal((await bob.c.decryptMessage(big, { senderId: A, kind: 'image' })).text.length, 200000);
});

await t('messages: sender, kind and room are authenticated', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A), bob = await member(s, B);
  await alice.c.generateRoomKey();
  await bob.c.acceptWrappedKey(alice.publicKey, A, B, await alice.c.wrapCurrentKey(bob.publicKey, A, B));
  const w = await alice.c.encryptMessage('secret', { senderId: A, kind: 'text' });
  assert.equal((await bob.c.decryptMessage(w, { senderId: C, kind: 'text' })).status, 'failed');  // relay changed sender
  assert.equal((await bob.c.decryptMessage(w, { senderId: A, kind: 'image' })).status, 'failed'); // relay changed kind
  const tampered = w.slice(0, -6) + (w.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA');
  assert.equal((await bob.c.decryptMessage(tampered, { senderId: A, kind: 'text' })).status, 'failed');

  const other = await member(generateInviteSecret(), C);
  await other.c.generateRoomKey();
  assert.equal((await other.c.decryptMessage(w, { senderId: A, kind: 'text' })).status, 'failed'); // another room
});

await t('messages: malformed input is rejected without throwing', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A);
  await alice.c.generateRoomKey();
  for (const bad of ['', 'x', 'v2', 'v2.0.a', 'v1.0.a.b', 'v2.x.a.b', 'v2.0.%%%.%%%', null, undefined, 42, {}]) {
    assert.equal((await alice.c.decryptMessage(bad, { senderId: A, kind: 'text' })).status, 'failed');
  }
});

await t('rotation: new epoch for remaining members, departed member locked out', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A), bob = await member(s, B), carol = await member(s, C);
  await alice.c.generateRoomKey();
  for (const m of [bob, carol]) await m.c.acceptWrappedKey(alice.publicKey, A, m.id, await alice.c.wrapCurrentKey(m.publicKey, A, m.id));
  const fp0 = await alice.c.fingerprint();

  // Carol leaves; Alice (oldest) rotates and sends the new key to Bob only.
  assert.equal(await alice.c.rotateRoomKey(), 1);
  assert.notEqual(await alice.c.fingerprint(), fp0);
  const rot = await alice.c.wrapCurrentKey(bob.publicKey, A, B);
  assert.equal(await bob.c.acceptWrappedKey(alice.publicKey, A, B, rot), 'accepted');
  assert.equal(await bob.c.fingerprint(), await alice.c.fingerprint());

  const w = await alice.c.encryptMessage('after rotation', { senderId: A, kind: 'text' });
  assert.match(w, /^v2\.1\./);
  assert.equal((await bob.c.decryptMessage(w, { senderId: A, kind: 'text' })).text, 'after rotation');
  assert.equal((await carol.c.decryptMessage(w, { senderId: A, kind: 'text' })).status, 'pending'); // never got epoch 1
  // ...and an old key cannot be pushed back in over a newer one
  assert.equal(await bob.c.acceptWrappedKey(alice.publicKey, A, B, await (async () => {
    const x = new CryptoEngine(); await x.setInvite(s); return rot;
  })()), 'stale');
});

await t('rotation: messages in flight across a rotation still decrypt (keyring)', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A), bob = await member(s, B);
  await alice.c.generateRoomKey();
  await bob.c.acceptWrappedKey(alice.publicKey, A, B, await alice.c.wrapCurrentKey(bob.publicKey, A, B));
  const old = await alice.c.encryptMessage('sent before rotation', { senderId: A, kind: 'text' });
  await alice.c.rotateRoomKey();
  await bob.c.acceptWrappedKey(alice.publicKey, A, B, await alice.c.wrapCurrentKey(bob.publicKey, A, B));
  assert.equal((await bob.c.decryptMessage(old, { senderId: A, kind: 'text' })).text, 'sent before rotation');
});

await t('a message for a future epoch is reported as pending, then readable once the key arrives', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A), bob = await member(s, B);
  await alice.c.generateRoomKey();
  await bob.c.acceptWrappedKey(alice.publicKey, A, B, await alice.c.wrapCurrentKey(bob.publicKey, A, B));
  await alice.c.rotateRoomKey();
  const w = await alice.c.encryptMessage('hi', { senderId: A, kind: 'text' });
  assert.equal((await bob.c.decryptMessage(w, { senderId: A, kind: 'text' })).status, 'pending');
  await bob.c.acceptWrappedKey(alice.publicKey, A, B, await alice.c.wrapCurrentKey(bob.publicKey, A, B));
  assert.equal((await bob.c.decryptMessage(w, { senderId: A, kind: 'text' })).text, 'hi');
});

await t('absurd epoch numbers from a peer are refused', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A), bob = await member(s, B);
  await alice.c.generateRoomKey();
  // Forge an epoch of 4 billion by setting it internally on the sender.
  alice.c.keyring.set(4_000_000_000, alice.c.keyring.get(0));
  alice.c.epoch = 4_000_000_000;
  const wrapped = await alice.c.wrapCurrentKey(bob.publicKey, A, B);
  assert.equal(await bob.c.acceptWrappedKey(alice.publicKey, A, B, wrapped), 'invalid');
});

await t('purge wipes everything', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A);
  await alice.c.generateRoomKey();
  const raw = alice.c.keyring.get(0).raw;
  alice.c.purge();
  assert.equal(alice.c.hasKey, false);
  assert.equal(alice.c.keyPair, null);
  assert.ok(raw.every((b) => b === 0));
  assert.equal(await alice.c.fingerprint(), null);
  await assert.rejects(() => alice.c.encryptMessage('x', { senderId: A }));
});

await t('passphrase invites: ".p" flag parses, passphrase changes room id and proofs, wrong one is rejected', async () => {
  const s = generateInviteSecret();
  assert.equal(inviteFragment(s, true), `${s}.p`); assert.equal(inviteFragment(s, false), s);
  assert.equal(parseInvite(`https://x.org/#${s}.p`), s); assert.equal(inviteNeedsPassphrase(`https://x.org/#${s}.p`), true);
  assert.equal(inviteNeedsPassphrase(`https://x.org/#${s}`), false); assert.equal(parseInvite(`${s}.q`), null);
  const mk = async (pass, id) => { const c = new CryptoEngine(); await c.setInvite(s, pass); const pk = await c.initIdentity(); return { c, id, pk, proof: await c.makeProof(id, pk) }; };
  const plain = new CryptoEngine(); const plainId = await plain.setInvite(s);
  const a = await mk('correct horse', A), b = await mk('correct horse', B), w = await mk('wrong horse', C);
  assert.notEqual(a.c.roomId, plainId);
  assert.equal(a.c.roomId, b.c.roomId); assert.notEqual(a.c.roomId, w.c.roomId);
  assert.equal(await b.c.verifyProof(A, a.pk, a.proof), true);
  assert.equal(await b.c.verifyProof(C, w.pk, w.proof), false);
  assert.equal((await mk('correct horse', A)).c.roomId, a.c.roomId); // deterministic
});

await t('message metadata (replies, files, controls) travels inside the ciphertext and is authenticated', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A), bob = await member(s, B);
  await alice.c.generateRoomKey();
  await bob.c.acceptWrappedKey(alice.publicKey, A, B, await alice.c.wrapCurrentKey(bob.publicKey, A, B));
  const meta = { r: 12, fid: 'abc', i: 0, n: 3 };
  const wire = await alice.c.encryptMessage('hello', { senderId: A, kind: 'text', meta });
  assert.ok(!wire.includes('hello'));
  const out = await bob.c.decryptMessage(wire, { senderId: A, kind: 'text' });
  assert.equal(out.status, 'ok'); assert.equal(out.text, 'hello'); assert.deepEqual(out.meta, meta);
  assert.equal((await bob.c.decryptMessage(wire, { senderId: A, kind: 'ctl' })).status, 'failed');   // kind is bound
  assert.equal((await bob.c.decryptMessage(wire, { senderId: B, kind: 'text' })).status, 'failed');  // sender is bound
  const plainMsg = await alice.c.encryptMessage('x', { senderId: A });
  assert.equal((await bob.c.decryptMessage(plainMsg, { senderId: A })).meta, null);
});

await t('pair code: same on both sides, different for other pairs, tied to the room', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A), bob = await member(s, B), carol = await member(s, C);
  const ab = await alice.c.pairCode(alice.publicKey, bob.publicKey);
  assert.match(ab, /^\d{5} \d{5}$/);
  assert.equal(ab, await bob.c.pairCode(bob.publicKey, alice.publicKey));
  assert.notEqual(ab, await alice.c.pairCode(alice.publicKey, carol.publicKey));
  const other = await member(generateInviteSecret(), A);
  assert.notEqual(ab, await other.c.pairCode(alice.publicKey, bob.publicKey));
});

await t('binary messages: files round-trip without base64 inflation, metadata and bytes authenticated', async () => {
  const s = generateInviteSecret();
  const alice = await member(s, A), bob = await member(s, B);
  await alice.c.generateRoomKey();
  await bob.c.acceptWrappedKey(alice.publicKey, A, B, await alice.c.wrapCurrentKey(bob.publicKey, A, B));
  const bytes = new Uint8Array(256 * 1024); globalThis.crypto.getRandomValues(bytes.subarray(0, 65536));
  const meta = { f: 'abcdefabcdef', i: 0, n: 8, name: 'résumé.pdf', mime: 'application/pdf', size: 2097152 };
  const wire = await alice.c.encryptBinary(bytes, { senderId: A, kind: 'file', meta });
  assert.ok(wire.length < 400 * 1024, 'a 256 KB chunk fits the relay limit: ' + wire.length);
  const out = await bob.c.decryptBinary(wire, { senderId: A, kind: 'file' });
  assert.equal(out.status, 'ok'); assert.deepEqual(out.meta, meta); assert.deepEqual(out.bytes, bytes);
  assert.equal((await bob.c.decryptBinary(wire, { senderId: B, kind: 'file' })).status, 'failed');
  assert.equal((await bob.c.decryptBinary(wire, { senderId: A, kind: 'image' })).status, 'failed');
  assert.equal((await bob.c.decryptBinary('v2.0.AAAA.BBBB', { senderId: A })).status, 'failed');
  await assert.rejects(() => alice.c.encryptBinary(bytes, { senderId: A, meta: { x: 'y'.repeat(2000) } }));
  // a text message is not a valid binary message and vice versa
  const txt = await alice.c.encryptMessage('hi', { senderId: A, kind: 'file' });
  assert.equal((await bob.c.decryptBinary(txt, { senderId: A, kind: 'file' })).status, 'failed');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
