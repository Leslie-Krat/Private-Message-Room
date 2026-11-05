import net from 'node:net';

export function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Real client IP. X-Real-IP is only trusted when the TCP peer is the local reverse proxy,
 * and the proxy must OVERWRITE it (proxy_set_header X-Real-IP $remote_addr).
 * X-Forwarded-For is never used: its first element is attacker-controlled.
 */
export function getClientIp(request) {
  const remote = request.socket.remoteAddress || '';
  if (isLoopback(remote)) {
    const real = request.headers['x-real-ip'];
    if (typeof real === 'string' && net.isIP(real.trim())) return real.trim();
  }
  return remote || '0.0.0.0';
}

/** Rate-limit key: IPv4 as-is, IPv6 collapsed to its /64 (one subscriber owns billions of addresses). */
export function ipKey(ip) {
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return v4mapped[1];
  if (!ip.includes(':')) return ip;
  const [headPart, tailPart] = ip.split('%')[0].toLowerCase().split('::');
  const head = headPart ? headPart.split(':') : [];
  const tail = tailPart ? tailPart.split(':') : [];
  const fill = Math.max(0, 8 - head.length - tail.length);
  const full = [...head, ...Array(fill).fill('0'), ...tail];
  return full.slice(0, 4).map((h) => h.padStart(4, '0')).join(':') + '::/64';
}
