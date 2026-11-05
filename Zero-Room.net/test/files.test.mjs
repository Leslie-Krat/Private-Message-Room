import assert from 'node:assert/strict';
import { FileAssembler, sanitizeFileName, formatBytes, formatDuration, newFileId, chunkBytes, FILE_CHUNK_BYTES, MAX_FILE_BYTES, isSafeImageMime } from '../../Zero-Room.web/js/files.js';

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '-', e.stack.split('\n').slice(0, 3).join(' | ')); } };
const S = 'p_00000000000000a1';
const send = (asm, bytes, over = {}, sender = S) => {
  const f = over.f || newFileId(); const chunks = [...chunkBytes(bytes)]; let last, seq = over.seq || 10;
  chunks.forEach((c, i) => {
    const meta = { f, i, n: chunks.length, ...(i === 0 ? { name: 'a.txt', mime: 'text/plain', size: bytes.length, ...over.head } : {}) };
    last = asm.accept(sender, seq++, meta, c);
  });
  return last;
};

await t('names: control/bidi characters and path tricks are neutralised', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeFileName('evil\u202Egpj.exe'), 'evilgpj.exe');
  assert.equal(sanitizeFileName('a\u0000b\nc'), 'abc');
  assert.equal(sanitizeFileName('C:\\Windows\\x.dll'), 'C_Windows_x.dll');
  assert.equal(sanitizeFileName('....'), 'file'); assert.equal(sanitizeFileName(''), 'file'); assert.equal(sanitizeFileName(5), '5');
  assert.equal(Array.from(sanitizeFileName('é'.repeat(200))).length, 80);
  assert.match(newFileId(), /^[A-Za-z0-9_-]{12}$/);
  assert.equal(formatBytes(512), '512 B'); assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB'); assert.equal(formatDuration(75.4), '1:15');
});

await t('assembler: multi-chunk file arrives intact; mime is reduced to a safe set', () => {
  const asm = new FileAssembler();
  const bytes = new Uint8Array(FILE_CHUNK_BYTES * 2 + 1234).map((_, i) => i % 251);
  const r = send(asm, bytes, { head: { mime: 'text/html' } });
  assert.equal(r.status, 'done'); assert.equal(r.transfer.mime, 'application/octet-stream'); assert.equal(r.transfer.blob.size, bytes.length);
  assert.equal(r.transfer.seq, 10); assert.equal(r.transfer.lastSeq, 12);
  assert.equal(send(new FileAssembler(), new Uint8Array(10), { head: { mime: 'image/svg+xml' } }).transfer.mime, 'application/octet-stream');
  assert.equal(send(new FileAssembler(), new Uint8Array(10), { head: { mime: 'image/png' } }).transfer.mime, 'image/png');
  assert.equal(isSafeImageMime('image/PNG; x=y'), true); assert.equal(isSafeImageMime('image/svg+xml'), false);
  const v = send(new FileAssembler(), new Uint8Array(10), { head: { mime: 'audio/webm;codecs=opus', v: true, d: 12 } });
  assert.equal(v.transfer.voice, true); assert.equal(v.transfer.mime, 'audio/webm'); assert.equal(v.transfer.duration, 12);
  assert.equal(send(new FileAssembler(), new Uint8Array(10), { head: { mime: 'text/plain', v: true } }).transfer.voice, false);
});

await t('assembler: lies and abuse are dropped (size, order, count, duplicates, limits)', () => {
  const asm = new FileAssembler();
  const big = new Uint8Array(FILE_CHUNK_BYTES);
  assert.equal(asm.accept(S, 1, { f: newFileId(), i: 0, n: 2, name: 'x', mime: 'a/b', size: MAX_FILE_BYTES + 1 }, big).status, 'drop'); // too big
  assert.equal(asm.accept(S, 1, { f: newFileId(), i: 0, n: 9, name: 'x', mime: 'a/b', size: 100 }, big).status, 'drop');               // too many chunks
  assert.equal(asm.accept(S, 1, { f: newFileId(), i: 0, n: 1, name: 'x', mime: 'a/b', size: 5000 }, new Uint8Array(10)).status, 'fail'); // size mismatch at the end
  assert.equal(asm.accept(S, 1, { f: 'short', i: 0, n: 1, size: 1 }, new Uint8Array(1)).status, 'drop');
  assert.equal(asm.accept(S, 1, { f: newFileId(), i: 3, n: 4 }, new Uint8Array(1)).status, 'drop');                                       // no header seen
  assert.equal(asm.accept(S, 1, { f: newFileId(), i: 0, n: 1, size: 1 }, new Uint8Array(0)).status, 'drop');                              // empty chunk
  assert.equal(asm.accept(S, 1, { f: newFileId(), i: 0, n: 1, size: 1 }, new Uint8Array(FILE_CHUNK_BYTES + 1)).status, 'drop');           // oversized chunk
  const f = newFileId();
  assert.equal(asm.accept(S, 1, { f, i: 0, n: 2, name: 'x', mime: 'a/b', size: FILE_CHUNK_BYTES + 5 }, big).status, 'start');
  assert.equal(asm.accept(S, 2, { f, i: 0, n: 2, name: 'x', mime: 'a/b', size: FILE_CHUNK_BYTES + 5 }, big).status, 'drop');             // duplicate header
  assert.equal(asm.accept(S, 3, { f, i: 1, n: 2 }, new Uint8Array(5)).status, 'done');
  const g = newFileId();   // out of order
  asm.accept(S, 1, { f: g, i: 0, n: 3, name: 'x', mime: 'a/b', size: 2 * FILE_CHUNK_BYTES + 5 }, big);
  assert.equal(asm.accept(S, 2, { f: g, i: 2, n: 3 }, new Uint8Array(5)).status, 'fail');
  const h = newFileId();   // a middle chunk of the wrong length
  asm.accept(S, 1, { f: h, i: 0, n: 3, name: 'x', mime: 'a/b', size: 2 * FILE_CHUNK_BYTES + 5 }, big);
  assert.equal(asm.accept(S, 2, { f: h, i: 1, n: 3 }, new Uint8Array(77)).status, 'fail');
  // per-sender cap
  const cap = new FileAssembler({ maxPerSender: 2 });
  const hdr = (fid) => ({ f: fid, i: 0, n: 2, name: 'x', mime: 'a/b', size: FILE_CHUNK_BYTES + 5 });
  assert.equal(cap.accept(S, 1, hdr(newFileId()), big).status, 'start'); assert.equal(cap.accept(S, 2, hdr(newFileId()), big).status, 'start');
  assert.equal(cap.accept(S, 3, hdr(newFileId()), big).status, 'drop');
  assert.equal(cap.accept('p_00000000000000b2', 4, hdr(newFileId()), big).status, 'start');
  // stale transfers are pruned
  const old = new FileAssembler({ maxAgeMs: 1000 }); old.accept(S, 1, hdr(newFileId()), big, 0); old.prune(5000); assert.equal(old.transfers.size, 0);
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
