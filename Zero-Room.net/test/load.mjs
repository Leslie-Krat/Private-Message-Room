// Load test: starts the relay and opens N WebSocket users in rooms of 10, then measures memory and CPU.
// Linux only (reads /proc). Usage:  ulimit -n 20000 && npm run loadtest          (N=5000, one message / 10 s each)
//                                    N=2000 EVERY=3000 npm run loadtest          (smaller, chattier)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const NET = path.resolve(import.meta.dirname, '..');
const N = Number(process.env.N) || 5000;
const EVERY = Number(process.env.EVERY) || 10000;   // each user sends one message this often (ms)
const HOLD_S = Number(process.env.HOLD) || 40;
const ROOM = 10, PORT = 18999;

const relay = spawn('node', ['--max-old-space-size=320', 'src/server.js'], {
  cwd: NET, stdio: 'inherit',
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MAX_CONNECTIONS: String(N + 1000), MAX_ROOMS: String(N), MAX_ROOMS_PER_IP: '10', MAX_CONN_PER_IP: '30', RING_MAX_BYTES: '65536', POW_BASE_BITS: '0' },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[(Math.random() * 16) | 0]).join('');
const cpu = () => { const s = fs.readFileSync(`/proc/${relay.pid}/stat`, 'utf8').split(') ')[1].split(' '); return (+s[11] + +s[12]) / 100; };
const rss = () => Number(fs.readFileSync(`/proc/${relay.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024;

await sleep(1200);
const PK = 'A'.repeat(87) + '=', PR = 'B'.repeat(43) + '=';
const base = rss();
let recv = 0, errors = 0, seq = 0;

function user(roomId, creator) {
  return new Promise((resolve) => {
    // Pretend to be many different addresses (the relay trusts X-Real-IP from loopback only).
    const n = seq++, ip = `10.${(n / 20 / 250) | 0}.${((n / 20) | 0) % 250}.${(n % 20) + 1}`;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}`, 'X-Real-IP': ip } });
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'welcome') ws.send(JSON.stringify({ action: creator ? 'create' : 'join', roomId, nickname: 'u', publicKey: PK, proof: PR, expiryMinutes: 60 }));
      else if (m.type === 'created' || m.type === 'joined') resolve(ws);
      else if (m.type === 'msg') recv++;
      else if (m.type === 'error') errors++;
    });
    ws.on('error', () => { errors++; resolve(null); });
  });
}

const sockets = [];
for (let r = 0; r < N / ROOM; r++) {
  const id = hex(32);
  sockets.push(await user(id, true));
  sockets.push(...(await Promise.all(Array.from({ length: ROOM - 1 }, () => user(id, false)))));
}
const live = sockets.filter((s) => s && s.readyState === 1);
console.log(`connected ${live.length}/${N}; relay memory ${rss().toFixed(0)} MB (empty relay: ${base.toFixed(0)} MB), errors ${errors}`);

await sleep(3000);
const cpu0 = cpu(), t0 = Date.now(), recv0 = recv;
const timers = live.map((ws) => setInterval(() => {
  if (ws.readyState === 1) ws.send(JSON.stringify({ action: 'msg', kind: 'text', ciphertext: 'x'.repeat(400) }));
}, EVERY * (0.8 + Math.random() * 0.4)));
await sleep(HOLD_S * 1000);
const wall = (Date.now() - t0) / 1000;
console.log(`load: ${(live.length / (EVERY / 1000)).toFixed(0)} msg/s in, ${((recv - recv0) / wall).toFixed(0)} deliveries/s out`);
console.log(`relay CPU ${(((cpu() - cpu0) / wall) * 100).toFixed(1)}% of one core, memory ${rss().toFixed(0)} MB, errors ${errors}`);

timers.forEach(clearInterval);
live.forEach((s) => s.terminate());
relay.kill();
process.exit(0);
