# Zero-Room.web (browser client)

Static files, no build step needed to *run* it. Everything is served from your own domain: scripts,
styles, fonts and the QR-code library are local, so no request goes to any third party.

## Security notes

- The invite link is `https://host/#<secret>`. The secret lives in the URL fragment, which browsers
  never send to a server. The address bar is cleaned right after the page loads.
- Keys exist only in the page's memory. Nothing is written to cookies, localStorage, sessionStorage or
  disk. Refreshing the page ends your session (the invite link is needed to join again).
- Message text is only ever inserted as text (`textContent`), links are limited to `http(s)`, and the
  Content-Security-Policy (see `../deploy/zeroroom_security_headers.conf`) forbids inline scripts.
- The safety fingerprint (6 groups of 4 hex digits, 96 bits) is derived from the current room key.
  Everyone in a room sees the same value; compare it over another channel if you want proof.
- Connection loss: the client reconnects, resumes its seat and fetches missed *text* messages and
  reactions/deletes. Images, files and voice notes sent while you were offline are not recovered.
- Received files are never opened by the page: the name is cleaned, the size and chunk order are checked, only
  a short list of image and audio types is previewed, and everything else is a plain download
  (`application/octet-stream`). SVG and HTML are never rendered.
- Replies show the quote from the receiver's own copy of the original, never text supplied by the sender, and
  only the author of a message can delete it. When a message is deleted, quotes of it elsewhere are blanked too.
- Passphrase: stretched with PBKDF2-SHA256 (250k rounds) and mixed into the HKDF input, so a wrong passphrase
  produces a different room id ("room not found"). It never leaves the browser.
- Proof-of-work: `js/pow-core.js` (SHA-256 puzzle, runs in `js/pow-worker.js`, with a main-thread fallback).
- The service worker (`sw.js`) caches only static files and never touches WebSocket traffic.

## Files

v2.2 is the "warm paper" redesign: a cream page, a blue ribbon, apricot message bubbles, Fraunces for headings,
Figtree for text and DM Mono for codes. It is plain CSS: there is no build step any more.

```
index.html          page
css/styles.css      the whole design: tokens, layout, components, @font-face (self-hosted fonts)
js/crypto.js        invite secret, member proofs, key wrapping, message encryption
js/socket.js        WebSocket client (backoff, resume)
js/app.js           application logic
js/ui.js            DOM rendering
js/files.js         file/voice helpers and chunk reassembly
js/pow.js, pow-core.js, pow-worker.js   proof-of-work for room creation
sw.js, manifest.webmanifest, icons/     installable app (PWA)
vendor/qrcode.js    qrcode-generator (MIT)
fonts/              Fraunces, Figtree, DM Mono (SIL OFL 1.1)
```

Colours and fonts are CSS variables at the top of `css/styles.css` (`--paper`, `--ribbon`, `--apricot`, ...).
After you change a CSS or JS file, bump the `?v=` number on the links in `index.html` (and in `sw.js`) so
browsers fetch the new files.

## Run locally

```bash
python -m http.server 3000     # with the relay running on port 8888
```
