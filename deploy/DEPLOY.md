# Deploying Zero-Room (v2) to the VPS

Ubuntu 22.04, nginx, Node.js 22, Let's Encrypt. Everything below is run on the VPS unless it says
"on Windows". The relay restarts during the update, so **every open room ends** — pick a quiet moment.
Old invite links (`?room=...`) stop working; the new links look like `https://host/#<secret>`.

## 0. Back up what is there

```bash
sudo cp -a /etc/nginx /etc/nginx.bak-$(date +%F)
sudo cp -a /etc/systemd/system/zeroroom.service /root/zeroroom.service.bak
# find where the current Zero-Room nginx files live (you will overwrite them in place)
sudo grep -rln "zeroroom" /etc/nginx/
```

## 1. Copy the new files up

On Windows (PowerShell), from the `Zero-Room` folder:

```powershell
tar --exclude=node_modules -czf zeroroom.tgz Zero-Room.net Zero-Room.web deploy
scp zeroroom.tgz YOUR_USER@YOUR_VPS:/tmp/
```

On the VPS:

```bash
rm -rf /tmp/zr && mkdir /tmp/zr && tar -xzf /tmp/zeroroom.tgz -C /tmp/zr

# a dedicated, login-less user for the relay; code stays owned by root so the relay cannot rewrite it
sudo useradd --system --no-create-home --shell /usr/sbin/nologin zeroroom 2>/dev/null || true
sudo mkdir -p /opt/zeroroom /var/www/zeroroom

sudo rsync -a --delete --exclude node_modules /tmp/zr/Zero-Room.net/ /opt/zeroroom/Zero-Room.net/
sudo rsync -a --delete --exclude package.json --exclude README.md \
     /tmp/zr/Zero-Room.web/ /var/www/zeroroom/web/

cd /opt/zeroroom/Zero-Room.net && sudo npm ci --omit=dev
sudo chown -R root:root /opt/zeroroom /var/www/zeroroom
sudo chmod -R a+rX /opt/zeroroom /var/www/zeroroom
```

(The old copy under `/root/Zero-Room` can stay until you have checked that everything works.)

## 2. nginx

```bash
# http{}-level settings: put it where your current zeroroom_rate_limit.conf is (often /etc/nginx/conf.d/)
sudo cp /tmp/zr/deploy/zeroroom_rate_limit.conf       /etc/nginx/conf.d/zeroroom_rate_limit.conf
sudo cp /tmp/zr/deploy/zeroroom_security_headers.conf /etc/nginx/snippets/
sudo cp /tmp/zr/deploy/zeroroom_locations.conf        /etc/nginx/snippets/
# the site file: overwrite the current one (path from the grep in step 0)
sudo cp /tmp/zr/deploy/zeroroom.conf /etc/nginx/sites-available/zeroroom.conf

sudo nginx -t && sudo systemctl reload nginx
```

If your current rate-limit file is in another place, overwrite that one instead (never keep two copies:
nginx refuses duplicate `zone` names). `zeroroom.conf` keeps the certbot `ssl_*` lines for your hostname (replace `chat.example.com` first);
if certbot changed them on your server, keep your own `ssl_*` lines.

What changed: the relay's `/health` is no longer public, the WebSocket location checks the `Origin`,
limits connections per address, overwrites `X-Forwarded-For` instead of appending to it, drops idle
connections after 2 minutes, does not log WebSocket requests, hides the nginx version, only allows GET/HEAD,
and the Content-Security-Policy now forbids inline scripts and every third-party host.

## 3. The relay service

```bash
sudo cp /tmp/zr/deploy/zeroroom.service /etc/systemd/system/zeroroom.service
sudo systemctl daemon-reload
sudo systemctl restart zeroroom
systemctl status zeroroom --no-pager
journalctl -u zeroroom -n 20 --no-pager
curl -s http://127.0.0.1:8888/health          # works only from the server itself
```

The unit runs as the `zeroroom` user inside a sandbox, with memory and task ceilings, and restarts only
after a crash. If the service will not start, `journalctl -u zeroroom -n 50` says why. To check
the sandbox score: `systemd-analyze security zeroroom`.

## 4. Check it

```bash
# new CSP, no unsafe-inline, no cdn
curl -sI https://chat.example.com/ | grep -i -E "content-security|server:"
# /health is gone from the internet
curl -s -o /dev/null -w "%{http_code}\n" https://chat.example.com/health        # 404
# a page from another site cannot open the socket
curl -s -o /dev/null -w "%{http_code}\n" https://chat.example.com/ws \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" -H "Origin: https://evil.example"          # 403
```

Then open the site in two different browsers: create a room in one, open the invite link in the other,
send text and an image, and compare the safety fingerprint (it must be identical).
Hard-refresh (Ctrl+F5) once on each device so the old scripts leave the cache.

## 4b. Sizing for a 2 GB / 1 vCPU server (about 5,000 people online at once)

I measured this with the real relay behind a real nginx with TLS and 5,000 open connections
(rooms of 10, each person sending one short message every 10 seconds, which is busy for a chat site).
Your VPS CPU is probably slower than my test machine, so read the CPU numbers as "roughly 1.5 to 2 times
this".

| | Memory | CPU of the one core |
|---|---|---|
| Relay (Node.js) | about 150 MB | about 10% (about 30% if everyone sends a message every 3 s) |
| nginx with TLS | about 220 MB | about 10% |
| Linux itself | about 200 MB | idle |
| Total | about 600 MB of 2 GB | about 20% busy, 60 to 70% if very chatty |

That leaves roughly 1.4 GB free. Connecting is the expensive moment: 5,000 TLS handshakes took about 6 s of
CPU in nginx, so if the relay restarts, everyone reconnects within a few seconds and the core runs hot for about
10 s. Clients spread their retries out, so this is fine.

**A. nginx main settings.** In `/etc/nginx/nginx.conf`, at the top level and inside `events {}`. Without these,
nginx stops accepting connections at about 500 people (each proxied user costs two connections):

```nginx
worker_processes 1;
worker_rlimit_nofile 30000;
events {
    worker_connections 16384;
}
```

**B. Kernel settings and a safety swap file.**

```bash
sudo cp /tmp/zr/deploy/sysctl-zeroroom.conf /etc/sysctl.d/90-zeroroom.conf && sudo sysctl --system
# a small swap file is a safety net so a surprise never makes the server freeze (skip if you already have swap)
swapon --show | grep -q . || { sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab; }
```

**C. Already included** in the files you copy: the relay allows 6,000 connections and 3,000 rooms, is capped at
512 MB of RAM (so it can never take the whole server), and nginx uses small per-connection buffers.
Cheaper TLS (optional): ask certbot for an ECDSA certificate (`--key-type ecdsa`), which makes handshakes
several times cheaper than RSA.

**D. Check it on the real server.** Run it while the site is idle, never during peak time:

```bash
cd /opt/zeroroom/Zero-Room.net && sudo -u zeroroom bash -c 'ulimit -n 20000 && N=5000 npm run loadtest'
free -m                      # "available" should stay above 1000 MB
```

**E. Things that can eat the headroom.** Another app on the same server (a database-backed app can use 1 GB or more by
itself; check with `ps aux --sort=-rss | head`). If it must stay on this server, 5,000 users here is tight. Also, many people
behind one shared address (a school or mobile carrier) hit the per-address limit of 30 connections; raise
`MAX_CONN_PER_IP` and `limit_conn zeroroom_conn` together if you expect that.

Past about 15,000 to 20,000 people online on this server, the single core becomes the limit. The next step then
is a second vCPU (the relay is single-threaded, so run a second relay behind nginx and spread rooms by room ID)
rather than more RAM.

## 4c. What changed in v2.1 (read before deploying)

- **The browser and relay must be updated together.** The new protocol (welcome carries a proof-of-work puzzle,
  new message kinds) is not compatible with the previous client, and the previous client is not compatible with the
  new relay. Copy `Zero-Room.web` and `Zero-Room.net` in the same step, then restart the relay.
- **Restarting the relay ends every running room** (rooms only exist in memory). Do it when the site is quiet.
- **nginx headers changed**: `zeroroom_security_headers.conf` now allows the microphone for your own origin
  (`microphone=(self)`, for voice notes) and adds `media-src blob:`, `worker-src 'self'` and `manifest-src 'self'`
  to the CSP. Copy the file to `/etc/nginx/snippets/`, then `sudo nginx -t && sudo systemctl reload nginx`.
- **Cache**: pages are served with `Cache-Control: no-cache`, so visitors get the new files on their next load; the
  `?v=6.2` suffix on scripts forces a refresh of anything cached. People with an old tab open should reload it.
- **New files to copy** (inside `Zero-Room.web`): `js/files.js`, `js/pow.js`, `js/pow-core.js`, `js/pow-worker.js`,
  `sw.js`, `manifest.webmanifest`, and the `icons/` folder. `Zero-Room.net/src` gains `pow.js`.
- nginx must serve `.webmanifest` as `application/manifest+json` (the default `mime.types` already does) and `.js`
  as JavaScript (module workers need that).
- Optional: `POW_BASE_BITS` (default 14) in `/etc/systemd/system/zeroroom.service` as `Environment=POW_BASE_BITS=14`.
  Check with `sudo systemctl show zeroroom -p Environment`. Use `0` to switch the puzzle off.
- Quick check after deploying:
  ```bash
  curl -sI https://YOUR-DOMAIN/manifest.webmanifest | head -5     # 200, application/manifest+json
  curl -sI https://YOUR-DOMAIN/sw.js | grep -i cache-control      # no-cache
  curl -sI https://YOUR-DOMAIN/ | grep -i -E 'permissions-policy|content-security'
  ```

## 5. Roll back (if needed)

```bash
sudo rsync -a --delete /etc/nginx.bak-YYYY-MM-DD/ /etc/nginx/ && sudo nginx -t && sudo systemctl reload nginx
sudo cp /root/zeroroom.service.bak /etc/systemd/system/zeroroom.service && sudo systemctl daemon-reload && sudo systemctl restart zeroroom
```

(The old code is still in `/root/Zero-Room` if you did not delete it.)

## Optional extras

- Firewall: only 22, 80 and 443 need to be open (`sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable`).
  The relay listens on 127.0.0.1 only.
- If you add a domain, add it to `zeroroom_rate_limit.conf` (the `map` block), `zeroroom_security_headers.conf`
  (`connect-src`) and the site file.
- Tuning knobs (room and connection limits) are listed in `Zero-Room.net/README.md`.
- The web client has no build step: after editing CSS or JS, bump the `?v=` number in `index.html` and `sw.js`.
