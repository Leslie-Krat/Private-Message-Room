/**
 * HeartbeatManager - purges ghost connections and keeps NAT/middlebox mappings alive.
 * Sends a Ping every interval; a socket that never answered the previous Ping is terminated.
 * Termination triggers the normal 'close' handler, which detaches the member from its room.
 */
export class HeartbeatManager {
  constructor(wss, intervalMs = 25000) {
    this.wss = wss;
    this.intervalMs = intervalMs;
    this.timer = setInterval(() => this.pingAll(), this.intervalMs);
    this.timer.unref?.();
  }

  pingAll() {
    for (const ws of this.wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}
