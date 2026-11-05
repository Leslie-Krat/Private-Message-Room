# ZeroRoom

**A private chat room that forgets.** No account, no login, no database. Someone creates a room, shares a
link, and everyone in it chats with end-to-end encryption. When the room ends, everything is gone: the
messages only ever lived in memory and the keys only ever lived in the browsers.

```
  Create a room  ->  share the invite link  ->  chat (encrypted in the browser)  ->  the room expires, nothing is left
```

## What this project is

ZeroRoom is a small, self-hosted web app made of two parts:

- **A static web client** (plain HTML, CSS and JavaScript, no build step) that does all the cryptography in
  the browser.
- **A tiny Node.js relay** that only passes encrypted messages between the people in a room. It keeps rooms
  in RAM, writes no logs for the chat, and never sees a message in readable form.

It is meant for quick, throwaway conversations: sharing something sensitive with a friend, a short group
chat, or moving a link or file between two devices, without leaving an account or a history behind.

## Features

**Rooms**
- Create a room in one click. It lasts 15 minutes, 1 hour or 24 hours, and the host can add time
  (+15 min or +1 h, never more than 24 h in total).
- Invite by link, copy/paste code, QR code, or the phone's share sheet.
- Optional passphrase: the link alone is then useless, so you can send the link and the passphrase through
  different channels.
- Up to 20 people per room by default.

**Messages**
- Text with links, bold and `code`, replies with a quote, and six quick reactions.
- Delete for everyone (only the author can).
- Disappearing messages: off, 30 seconds, 5 minutes, 1 hour or 24 hours.
- Pictures (shrunk in the browser), files up to 2 MB, and voice notes up to 2 minutes. Everything is
  encrypted in 256 KB chunks and never stored by the relay.
- Typing indicator, read ticks, and a friendly "people here" list.

**Host controls**
- Remove a person, lock the room, require approval for new joiners.
- If the host leaves, the longest-present member becomes the host.

**Privacy on your device**
- Pair codes: every person has a 10-digit code you can read out loud to confirm who you are talking to.
- Panic key: press `Esc` twice (or use the Panic button) to wipe the screen and the keys and leave.
- Blur when you look away: the conversation is blurred while the window is not in focus.
- Notifications and the tab title show only a count, never message text.

**Built to be small and robust**
- Anti-spam proof-of-work puzzle (about half a second) when creating a room.
- Per-address connection and room limits, per-socket rate limits, and automatic reconnection that
  keeps host status and room settings.
- Installable as an app (PWA) that caches only public static files.
- English interface, light "warm paper" design, works on phones and desktops.

## What it looks like in use

1. **Alice** opens the site, types a name (or shuffles a random one such as `Quiet Otter`), picks
   *Room lasts 1 hour* and presses **Create a new room**.
2. She presses **Copy link** and sends it to a friend:

   ```text
   https://chat.example.com/#Q3rV8k1bX0pN2mTq7LwZ4A          <- link only
   https://chat.example.com/#Q3rV8k1bX0pN2mTq7LwZ4A.p        <- link, needs a passphrase too
   ```

   Everything after the `#` stays in the browser. It is never sent to any server.
3. **Bob** opens the link, picks a name, and joins. Both see the same *safety code* in the sidebar.
4. They chat, send a photo, record a voice note, react with a thumbs up. If Alice enabled *approve each
   person who joins*, she sees a request and lets Bob in.
5. When the timer reaches zero (or the host presses **Destroy room**, or someone presses `Esc` twice), the
   room disappears. Nothing is stored anywhere to recover.

## How it works

1. **The invite secret.** The browser makes a random 128-bit secret and puts it in the link after the `#`.
2. **The relay sees a hash.** The room id sent to the relay is derived from the secret with HKDF. The relay
   cannot turn it back into the secret.
3. **Proving you were invited.** Each member signs its public key (HMAC, key derived from the secret) and
   everyone verifies it. A visitor who only knows the room id, or a relay trying to impersonate someone,
   cannot get the room key.
4. **The room key.** The room creator makes an AES-256 key and sends it to each verified member, wrapped with
   ECDH (P-256) + HKDF + AES-GCM. When a member leaves, the oldest remaining member rotates the key.
5. **Messages** are AES-256-GCM, bound to the room, the sender and the key epoch. The relay forwards
   ciphertext and nothing else.

### What it protects, and what it does not

It protects message content, pictures, files and voice notes from the server, the network and uninvited
visitors. It does **not** hide that you are connected: the relay still sees who is connected, when, how much
they send, and IP addresses. The invite link is the key, so anyone you send it to can read the room. And as
with every browser-based end-to-end encrypted app, if you do not trust the server that delivers the page you
cannot fully trust the page's code either. The security design is documented in more detail in
[`Zero-Room.net/README.md`](Zero-Room.net/README.md).

## Project layout

```
.
├── Zero-Room.net/    Node.js 22 WebSocket relay (in memory only, sees ciphertext only) + tests
├── Zero-Room.web/    Static browser client (end-to-end encryption in the browser)
├── deploy/           nginx, systemd and step-by-step server instructions (deploy/DEPLOY.md)
├── run-local.mjs     One command to run relay + web locally
└── run-local.bat     Windows shortcut for the same
```

**Built with:** Node.js 22 and the [`ws`](https://github.com/websockets/ws) library on the server; the Web
Crypto API, ES modules, a service worker and plain CSS in the browser. No framework, no bundler, no database.

## Run it locally

You need [Node.js 22 or newer](https://nodejs.org/).

```bash
cd Zero-Room.net && npm install && cd ..
node run-local.mjs            # or double-click run-local.bat on Windows
```

Open <http://localhost:3000> in two browser windows (one normal, one private). Create a room in one, paste
the invite link into the other.

## Configuration

The relay is configured with environment variables, all optional (see
[`Zero-Room.net/.env.example`](Zero-Room.net/.env.example)):

```bash
PORT=8888                # relay port
HOST=127.0.0.1           # keep it on loopback, only the reverse proxy should reach it
MAX_PEERS_PER_ROOM=20    # people per room
MAX_ROOMS=2000           # rooms at the same time
MAX_CONN_PER_IP=30       # connections per address
POW_BASE_BITS=14         # room-creation puzzle difficulty, 0 turns it off
ALLOWED_ORIGINS=https://chat.example.com
```

## Tests

```bash
cd Zero-Room.net && npm install && npm test        # protocol, rooms, files, crypto, proof-of-work
```

A load test for sizing a server is available with `npm run loadtest`.

## Deploying to your own server

ZeroRoom is built to run behind nginx on a small VPS (Ubuntu, Node.js 22, Let's Encrypt). The configuration
files in [`deploy/`](deploy/) use `chat.example.com` as a placeholder hostname; replace it with your own
domain. Follow [`deploy/DEPLOY.md`](deploy/DEPLOY.md) for the full steps, including the security headers
(a strict Content-Security-Policy with no inline scripts and no third-party hosts), rate limiting and the
systemd service.

## Contributing and security reports

Issues and pull requests are welcome. If you find a security problem, please report it privately instead of
opening a public issue.

## License

The relay is MIT licensed (see `Zero-Room.net/package.json`). Third-party code and fonts keep their own
licenses, listed in [`Zero-Room.web/vendor/LICENSES.txt`](Zero-Room.web/vendor/LICENSES.txt).
