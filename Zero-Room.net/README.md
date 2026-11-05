# Zero-Room.net (relay)

A small WebSocket relay for ephemeral rooms. It stores nothing on disk, never sees keys or plaintext,
and forgets a room the moment the last member leaves or the room reaches its lifetime.

## What it does

- Keeps rooms in a `Map` in memory. A room is deleted when it is empty, when it expires (absolute
  lifetime 15 min / 1 h / 24 h chosen at creation), or when it is burned.
- Gives every socket a **server-assigned id** and checks membership on every action. Clients cannot pick
  or spoof an id. A dropped member can come back within 3 minutes with a secret *resume token*.
- Relays ciphertext. Only short text messages are kept (last 50, at most 512 KB per room) so a client
  that briefly loses its connection can catch up. Images are relayed to people online and not stored.
- Limits abuse: per-socket token buckets (messages, light actions, bytes), a per-room byte budget,
  per-IP connection and room quotas, global caps, strikes for repeat offenders, backpressure
  (a client that cannot keep up is dropped), 2 MB frame limit, input validation on every field,
  Origin check against cross-site hijacking, and a crash handler (systemd restarts it).
- Uses the real client address only from nginx's `X-Real-IP`, and only if the TCP peer is loopback.
  `X-Forwarded-For` is ignored. IPv6 clients are limited per /64.
- `/health` and `/metrics` answer only to direct requests from localhost (not through nginx).

## Run

```bash
npm install
npm start          # listens on 127.0.0.1:8888
npm test           # unit + end-to-end tests (spawns the server on test ports)
npm run loadtest   # Linux: opens 5,000 fake users and reports memory and CPU (needs `ulimit -n 20000`)
```

Requires Node.js 22 or newer.

## Settings (environment variables)

All are optional; see `.env.example`. The relay does not load `.env` by itself: set them in the systemd
unit (`Environment=`) or in your shell.

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `8888`, `127.0.0.1` | Listen address. Keep `127.0.0.1` behind nginx. |
| `ALLOWED_ORIGINS` | *(empty)* | Extra allowed page origins, comma separated. Same-host pages are always allowed. |
| `REQUIRE_ORIGIN` | on | Handshakes without an `Origin` header are rejected. Set `REQUIRE_ORIGIN=0` to allow non-browser clients. |
| `MAX_ROOMS`, `MAX_ROOMS_PER_IP` | `2000`, `10` | Live rooms in total / created from one address. |
| `MAX_PEERS_PER_ROOM` | `20` | Members per room. |
| `MAX_CONNECTIONS`, `MAX_CONN_PER_IP` | `4000`, `30` | Sockets in total / per address. |
| `MAX_BUFFERED_BYTES` | `4194304` | A client that cannot drain this much queued data is disconnected. |
| `RING_CAPACITY`, `RING_MAX_BYTES` | `50`, `524288` | Replay buffer per room. |
| `RESUME_GRACE_MS` | `180000` | How long a dropped member keeps its seat. |
| `POW_BASE_BITS` | `14` | Proof-of-work difficulty for creating a room (0 turns it off, max 22). Adds up to 6 bits when many rooms are created per minute. |

## Protocol (v2)

Client to relay (JSON): `create` (with a proof-of-work `nonce`, optional `approval`, `disappearSec`), `join`,
`resume`, `leave`, `msg` (`kind`: `text`, `image`, `file`, `ctl`), `typing`, `ack`, `key_exchange`, `key_rotate`,
`burn`, and host-only `approve`, `deny`, `kick`, `room_options`, `extend`. Relay to client: `welcome` (with the
puzzle), `created`, `joined`, `join_pending`, `join_request`, `join_request_cancelled`, `join_denied`,
`room_state`, `kicked`, `resumed`, `left`, `msg`, `peer_joined`, `peer_resumed`, `peer_left`, `typing`, `ack`,
`key_exchange`, `key_rotate`, `burned`, `notice`, `warning`, `error` (with a `code`).

Message kinds: `ctl` (reactions, deletes) is small and kept for reconnect replay like text; `file` carries one
encrypted chunk (at most about 400 KB on the wire) and, like `image`, is relayed but never stored. The relay
enforces host-only actions, the 24 h lifetime cap and the approval queue; what is *inside* messages (replies,
file names, reactions) is end-to-end encrypted and invisible to it. A hostile relay could still ignore the host's
approval or lock settings, since those are not cryptographic: the invite secret (and passphrase) are. Room ids are 32 hex characters, public keys are
65-byte P-256 points in base64, proofs are 32-byte HMACs in base64. Anything else is rejected.

## Deploy

See `../deploy/DEPLOY.md`. The service unit is `../deploy/zeroroom.service`.
