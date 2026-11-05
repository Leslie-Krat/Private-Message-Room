import { solve } from './pow-core.js?v=6.2';

/**
 * Solves the relay's room-creation puzzle. Uses up to 4 module workers so the page stays responsive;
 * falls back to short slices on the main thread when workers are unavailable.
 */
export function solvePow({ seed, roomId, bits }) {
  if (!bits) return Promise.resolve('0');

  const cores = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
  if (typeof Worker === 'function') {
    return new Promise((resolve, reject) => {
      const workers = [];
      let finished = false;
      const done = (fn, value) => {
        if (finished) return;
        finished = true;
        for (const w of workers) { try { w.postMessage('stop'); w.terminate(); } catch { /* gone */ } }
        fn(value);
      };
      try {
        for (let i = 0; i < cores; i++) {
          const w = new Worker(new URL('./pow-worker.js?v=6.2', import.meta.url), { type: 'module' });
          w.onmessage = (e) => (e.data && e.data.nonce ? done(resolve, e.data.nonce) : null);
          w.onerror = () => done(reject, new Error('worker failed'));
          workers.push(w);
          w.postMessage({ seed, roomId, bits, start: i, step: cores });
        }
      } catch (err) {
        done(reject, err);
      }
    }).catch(() => solveOnMainThread({ seed, roomId, bits }));
  }
  return solveOnMainThread({ seed, roomId, bits });
}

/** Workers unavailable: at 14-20 bits this is one second of work at most, so a plain loop is fine. */
function solveOnMainThread({ seed, roomId, bits }) {
  return new Promise((resolve) => setTimeout(() => resolve(solve({ seed, roomId, bits })), 0));
}
