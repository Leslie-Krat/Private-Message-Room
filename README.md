# Zero-Room

Disposable chat rooms with no accounts, no database and no stored messages. Everything lives in
memory and disappears when the room ends.

```
Zero-Room/
├── Zero-Room.net/    Node.js 22 WebSocket relay (in memory only, sees ciphertext only)
├── Zero-Room.web/    Static browser client (end-to-end encryption in the browser)
└── deploy/           nginx, systemd and step-by-step server instructions (see deploy/DEPLOY.md)
```

## How it works

1. **Create a room.** The browser makes a random 128-bit *invite secret* and shows it as an invite link:
   `https://your-site/#<secret>`. The part after `#` is never sent to any server.
2. **The relay only sees a hash.** The room id sent to the relay is derived from the secret with HKDF.
   The relay cannot get the secret back from it.
3. **Joining proves you have the invite.** Every member signs its public key (HMAC, key derived from the
   secret) and everyone verifies it. A visitor who only knows the room id, or a relay trying to
   impersonate someone, cannot get the room key.
4. **Room key.** The room creator makes an AES-256 key and sends it to each verified member, wrapped with
   ECDH (P-256) + HKDF + AES-GCM. When a member leaves, the oldest remaining member rotates the key.
5. **Messages** are AES-256-GCM, bound to room, sender and key epoch. The relay forwards ciphertext.

What this protects: message content and images from the server, the network and uninvited visitors.
What it does not: the invite link *is* the key, so anyone you send it to can read the room. The relay
still sees who is connected, when, how much they send, and IP addresses (nginx keeps a normal access
log for the static site; the WebSocket path is not logged). If you do not trust the web server that
delivers the page, you cannot trust the page's code either, as with every browser-based E2EE app.

## Features (v2.1)

- **Host controls.** The creator is the host (if they leave, the longest-present member takes over). The host can
  remove people, lock the room, require approval for new joiners, set disappearing messages, and add time
  (+15 min / +1 h, never more than 24 h in total).
- **Optional passphrase.** The link says `#<secret>.p` and the passphrase is mixed into the keys in the browser
  (PBKDF2, 250,000 rounds). The link alone is then useless; share the passphrase through another channel.
- **Messages.** Replies with a quote, six reactions, delete-for-everyone (author only), disappearing messages,
  images, files up to 2 MB and voice notes up to 2 minutes (all encrypted in 256 KB chunks; never stored by the relay).
- **Verification.** Each person has a 10-digit pair code (Verify button) that two people can compare out loud.
- **On your device.** Tab-title unread count, optional notifications that never contain message text, blur when
  you look away, and a panic key (press Esc twice, or the siren button) that wipes the screen and keys and leaves.
- **Anti-spam.** Creating a room needs a small proof-of-work puzzle solved in the browser (about half a second);
  the difficulty rises automatically if many rooms are created per minute.
- **Install as an app.** The site is a PWA (manifest + service worker that caches only the public static files).
- Web Share button on phones.

## Run it locally

```bash
cd Zero-Room.net && npm install && npm start        # relay on http://localhost:8888
cd Zero-Room.web && python -m http.server 3000      # in a second terminal
```

Open `http://localhost:3000` in two browser windows. Create a room in one, open the invite link in the other.

## Run the tests

```bash
cd Zero-Room.net && npm install && npm test
```

## Deploy

See [`deploy/DEPLOY.md`](deploy/DEPLOY.md).
