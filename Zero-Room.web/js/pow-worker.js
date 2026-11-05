import { solve } from './pow-core.js';

let stopped = false;
self.onmessage = (event) => {
  const msg = event.data;
  if (msg === 'stop') { stopped = true; return; }
  const nonce = solve({ ...msg, shouldStop: () => stopped });
  self.postMessage({ nonce });
};
