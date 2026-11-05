import {
  CryptoEngine, generateInviteSecret, parseInvite, inviteNeedsPassphrase, inviteFragment, roomSlug,
} from './crypto.js?v=6.2';
import { SocketClient } from './socket.js?v=6.2';
import { UIController, sounds, REACTIONS, DISAPPEAR_LABELS } from './ui.js?v=6.2';
import { solvePow } from './pow.js?v=6.2';
import {
  FileAssembler, MAX_FILE_BYTES, MAX_VOICE_SECONDS, chunkBytes, newFileId, sanitizeFileName, formatBytes,
  VoiceRecorder, voiceSupported,
} from './files.js?v=6.2';

const MAX_TEXT_BYTES = 16000;          // plaintext bytes per text message (the relay enforces a ciphertext cap)
const MAX_IMAGE_DATA_URL = 1_500_000;  // keeps the encrypted image under the relay's 2 MB frame limit
const MAX_PENDING = 100;               // messages held while waiting for a key we have not received yet
const PANIC_WINDOW_MS = 600;
const BASE_TITLE = 'ZEROROOM';
const KINDS = ['text', 'image', 'file', 'ctl'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);

class ZeroRoomApp {
  constructor() {
    this.crypto = new CryptoEngine();
    this.socket = new SocketClient();
    this.ui = new UIController();
    this.files = new FileAssembler();

    this.nickname = '';
    this.currentRoomId = null;
    this.roomName = '';
    this.inviteSecret = null;
    this.hasPassphrase = false;
    this.myPublicKey = null;
    this.roomState = null;      // { hostId, locked, approval, disappearSec, createdAt, expiryMinutes }
    this.members = new Map();   // verified peers: clientId -> { nickname, publicKey, proof }
    this.order = [];            // verified client ids (incl. ours) in join order; the first one rotates keys
    this.requests = new Map();  // join requests waiting for us (host only): clientId -> { nickname, publicKey, proof }
    this.verified = new Set();  // peers whose pair code we compared
    this.store = new Map();     // seq -> message record (for replies, reactions, deletes, expiry)
    this.pending = [];          // messages for an epoch whose key has not arrived yet
    this.unverified = new Set();
    this.fingerprint = null;
    this.busy = false;
    this.waitingApproval = false;
    this.createArgs = null;
    this.createTries = 0;
    this.queue = Promise.resolve();
    this.ackQueue = new Map();
    this.ackTimer = null;
    this.typingTimeout = null;
    this.lastTypingSent = 0;
    this.lastDecryptNotice = 0;
    this.replyTo = null;        // { seq, nickname, snippet }
    this.uploading = false;
    this.recorder = null;
    this.verifyTarget = null;
    this.unread = 0;
    this.blurEnabled = true;
    this.lastEsc = 0;
    this.sweepTimer = null;
    this.installEvent = null;

    this.init();
  }

  async init() {
    this.setupEventListeners();
    this.setupSidebarActions();
    this.setupRoomControls();
    this.setupSocketEvents();
    this.setupAttachments();
    this.setupPrivacy();
    this.setupPwa();
    this.setupUiHandlers();

    // Invite links look like https://host/#<secret> (or #<secret>.p when a passphrase is also needed).
    // The fragment never leaves this browser.
    const invite = parseInvite(window.location.hash);
    if (invite) {
      $('join-room-input').value = window.location.hash.slice(1);
      this.togglePassphraseField();
    } else if (new URLSearchParams(window.location.search).has('room')) {
      this.ui.showLaunchpadNotice('This link uses an old format and cannot be opened. Ask for a new invite link.', true);
    }
    if (window.location.hash || window.location.search) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    this.generateRandomNickname();
    this.socket.connect();
  }

  generateRandomNickname() {
    const prefixes = ['Ghost', 'Shadow', 'Cipher', 'Vapor', 'Echo', 'Neon', 'Stealth', 'Nexus'];
    const r = globalThis.crypto.getRandomValues(new Uint8Array(2));
    const nick = `${prefixes[r[0] % prefixes.length]}_${10 + (r[1] % 90)}`;
    const nickInput = $('nickname-input');
    if (nickInput) {
      nickInput.value = nick;
      this.nickname = nick;
    }
  }

  get isHost() {
    return Boolean(this.roomState && this.roomState.hostId === this.socket.clientId);
  }

  togglePassphraseField() {
    const needs = inviteNeedsPassphrase($('join-room-input')?.value || '');
    $('join-passphrase-wrap')?.classList.toggle('hidden', !needs);
  }

  setupEventListeners() {
    $('btn-random-nick')?.addEventListener('click', () => this.generateRandomNickname());
    $('btn-create-room')?.addEventListener('click', () => this.handleCreateRoom());
    $('btn-join-room')?.addEventListener('click', () => this.handleJoinRoom());
    $('join-room-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.handleJoinRoom(); });
    $('join-passphrase')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.handleJoinRoom(); });
    $('join-room-input')?.addEventListener('input', () => this.togglePassphraseField());

    $('chat-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSendMessage();
    });
    $('chat-input')?.addEventListener('input', () => this.handleTyping());

    $('brand-link')?.addEventListener('click', (e) => {
      if (this.currentRoomId) {
        e.preventDefault();
        if (confirm('Leave this channel and return to the home screen?')) this.resetToLaunchpad();
      }
    });

    $('btn-copy-invite')?.addEventListener('click', () => this.copyInviteLink());
    $('btn-show-qr')?.addEventListener('click', () => this.ui.showQRCode(this.getInviteUrl()));
    $('btn-close-qr-modal')?.addEventListener('click', () => $('qr-modal')?.classList.add('hidden'));

    $('btn-leave-room')?.addEventListener('click', () => {
      if (confirm('Leave this channel and return to the home screen?')) this.resetToLaunchpad();
    });
    $('btn-burn-room')?.addEventListener('click', () => this.handleBurnRoom());
    $('btn-panic')?.addEventListener('click', () => this.panic());

    $('fingerprint-pill')?.addEventListener('click', () => this.showSafetyModal());
    $('btn-close-modal')?.addEventListener('click', () => $('safety-modal')?.classList.add('hidden'));

    $('btn-cancel-reply')?.addEventListener('click', () => this.setReply(null));
    $('btn-close-verify')?.addEventListener('click', () => this.ui.hideVerifyModal());
    $('btn-verify-mark')?.addEventListener('click', () => this.toggleVerified());
  }

  setupSidebarActions() {
    $('btn-sidebar-copy-link')?.addEventListener('click', () => this.copyInviteLink());
    $('btn-sidebar-qr')?.addEventListener('click', () => this.ui.showQRCode(this.getInviteUrl()));
    $('btn-sidebar-burn')?.addEventListener('click', () => this.handleBurnRoom());
    $('btn-sidebar-share')?.addEventListener('click', () => this.shareInvite());
    $('btn-share')?.addEventListener('click', () => this.shareInvite());
    $('btn-sidebar-panic')?.addEventListener('click', () => this.panic());
    if (!navigator.share) {
      $('btn-share')?.remove();
      $('btn-sidebar-share')?.remove();
    }

    $('btn-copy-sidebar-fingerprint')?.addEventListener('click', async () => {
      const fp = $('sidebar-fingerprint-badge')?.textContent?.trim();
      if (!fp) return;
      try {
        await navigator.clipboard.writeText(fp);
        this.ui.renderSystemNotice('Safety fingerprint copied to clipboard.');
      } catch {
        this.ui.renderSystemNotice(`Fingerprint: ${fp}`);
      }
    });
  }

  setupUiHandlers() {
    Object.assign(this.ui.handlers, {
      onMenu: (seq, anchor) => this.openMenu(seq, anchor),
      onReact: (seq, emoji, on) => this.sendReaction(seq, emoji, on),
      onReply: (seq) => this.startReply(seq),
      onCopy: (seq) => this.copyMessage(seq),
      onDelete: (seq) => this.deleteMessage(seq),
      onKick: (id) => this.kickMember(id),
      onVerify: (id) => this.openVerify(id),
      onApprove: (id) => this.decideRequest(id, true),
      onDeny: (id) => this.decideRequest(id, false),
    });
  }

  /** Host-only room settings. */
  setupRoomControls() {
    $('opt-lock')?.addEventListener('change', (e) => this.socket.send({ action: 'room_options', locked: e.target.checked }));
    $('opt-approval')?.addEventListener('change', (e) => this.socket.send({ action: 'room_options', approval: e.target.checked }));
    $('opt-disappear')?.addEventListener('change', (e) => this.socket.send({ action: 'room_options', disappearSec: Number(e.target.value) }));
    $('btn-extend-15')?.addEventListener('click', () => this.socket.send({ action: 'extend', minutes: 15 }));
    $('btn-extend-60')?.addEventListener('click', () => this.socket.send({ action: 'extend', minutes: 60 }));
  }

  // ------------------------------------------------------- attachments, voice

  setupAttachments() {
    const fileInput = $('file-input');
    $('btn-attach')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) this.handleFile(file);
      fileInput.value = '';
    });

    document.addEventListener('paste', (e) => {
      if (!this.currentRoomId) return;
      for (const item of e.clipboardData?.items || []) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) { e.preventDefault(); this.handleFile(blob); break; }
        }
      }
    });

    const dropzone = $('dropzone-overlay');
    if (dropzone) {
      let dragCounter = 0;
      window.addEventListener('dragenter', (e) => {
        if (!this.currentRoomId) return;
        if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
          dragCounter++;
          dropzone.classList.remove('hidden');
        }
      });
      window.addEventListener('dragleave', () => {
        if (!this.currentRoomId) return;
        dragCounter--;
        if (dragCounter <= 0) { dragCounter = 0; dropzone.classList.add('hidden'); }
      });
      window.addEventListener('dragover', (e) => { if (this.currentRoomId) e.preventDefault(); });
      window.addEventListener('drop', (e) => {
        if (!this.currentRoomId) return;
        e.preventDefault();
        dragCounter = 0;
        dropzone.classList.add('hidden');
        const file = e.dataTransfer?.files?.[0];
        if (file) this.handleFile(file);
      });
    }

    const voiceBtn = $('btn-voice');
    if (voiceBtn && !voiceSupported()) voiceBtn.classList.add('hidden');
    voiceBtn?.addEventListener('click', () => this.startVoice());
    $('btn-rec-cancel')?.addEventListener('click', () => this.cancelVoice());
    $('btn-rec-send')?.addEventListener('click', () => this.finishVoice());
  }

  /** Pictures are shrunk and sent inline; everything else goes out as an encrypted file transfer. */
  handleFile(file) {
    if (file.type.startsWith('image/')) return this.processAndSendImage(file);
    return this.sendFile(file, { name: file.name, mime: file.type });
  }

  async startVoice() {
    if (!this.currentRoomId || !this.crypto.hasKey) {
      this.ui.renderSystemNotice('Waiting for the room key. Try again in a moment.', true);
      return;
    }
    if (this.recorder?.active || this.uploading) return;
    this.recorder = new VoiceRecorder({
      onTick: (seconds) => this.ui.setRecording(true, seconds),
      onLimit: () => this.finishVoice(),
    });
    try {
      await this.recorder.start();
      this.ui.setRecording(true, 0);
    } catch {
      this.recorder = null;
      this.ui.renderSystemNotice('The microphone is not available. Check the browser permission and try again.', true);
    }
  }

  cancelVoice() {
    this.recorder?.cancel();
    this.recorder = null;
    this.ui.setRecording(false);
  }

  async finishVoice() {
    const recorder = this.recorder;
    if (!recorder?.active) return;
    this.recorder = null;
    this.ui.setRecording(false);
    try {
      const { blob, seconds, mime } = await recorder.stop();
      if (seconds < 0.4 || blob.size === 0) return;
      await this.sendFile(blob, { name: 'voice-note', mime, voice: true, duration: Math.min(seconds, MAX_VOICE_SECONDS) });
    } catch {
      this.ui.renderSystemNotice('The voice note could not be recorded.', true);
    }
  }

  // ----------------------------------------------------------------- privacy

  setupPrivacy() {
    const blurToggle = $('opt-blur');
    blurToggle?.addEventListener('change', (e) => {
      this.blurEnabled = e.target.checked;
      if (!this.blurEnabled) this.setBlur(false);
    });

    // The blur follows the real state of the window. Events arrive in bursts when a tab is switched back
    // (blur, visibilitychange, focus), so the decision is made once, after the burst, instead of on each event.
    let settle = 0;
    const syncAway = () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        const away = document.visibilityState === 'hidden' || !document.hasFocus();
        this.setBlur(away);
        if (!away) this.clearUnread();
        this.fitViewport();
      }, 60);
    };
    document.addEventListener('visibilitychange', syncAway);
    window.addEventListener('blur', syncAway);
    window.addEventListener('focus', syncAway);
    window.addEventListener('pageshow', syncAway);

    // The visible height is measured in script: browsers report a stale 100dvh after a tab switch or when the
    // on-screen keyboard moves, which used to push the message box out of view.
    this.fitViewport();
    window.addEventListener('resize', () => this.fitViewport());
    window.visualViewport?.addEventListener('resize', () => this.fitViewport());
    window.addEventListener('orientationchange', () => setTimeout(() => this.fitViewport(), 200));

    // Panic key: Esc twice, quickly.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.currentRoomId) return;
      const now = Date.now();
      if (now - this.lastEsc < PANIC_WINDOW_MS) { this.lastEsc = 0; this.panic(); } else { this.lastEsc = now; }
    });

    const notify = $('btn-notify');
    if (notify) {
      if (typeof Notification === 'undefined') {
        notify.remove();
      } else {
        this.refreshNotifyLabel();
        notify.addEventListener('click', async () => {
          if (Notification.permission === 'default') await Notification.requestPermission();
          this.refreshNotifyLabel();
        });
      }
    }
  }

  fitViewport() {
    const h = Math.round(window.visualViewport?.height || window.innerHeight);
    if (h > 0) document.documentElement.style.setProperty('--app-h', `${h}px`);
    if (document.body.classList.contains('in-chat') && window.scrollY) window.scrollTo(0, 0);
  }

  setBlur(on) {
    document.body.classList.toggle('privacy-blur', Boolean(on && this.blurEnabled && this.currentRoomId));
  }

  refreshNotifyLabel() {
    const notify = $('btn-notify');
    if (!notify) return;
    const labels = { granted: 'Alerts on', denied: 'Blocked', default: 'Alerts' };
    const target = $('notify-label') || notify;
    target.textContent = labels[Notification.permission] || labels.default;
    notify.toggleAttribute('disabled', Notification.permission !== 'default');
  }

  /** Counts messages that arrive while the tab is not in front and shows it in the tab title. */
  noteIncoming() {
    if (!document.hidden && document.hasFocus()) return;
    this.unread += 1;
    document.title = `(${this.unread}) ${BASE_TITLE}`;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(BASE_TITLE, { body: 'New message in your room', tag: 'zr-msg', silent: true }); } catch { /* not allowed here */ }
    }
  }

  clearUnread() {
    this.unread = 0;
    document.title = BASE_TITLE;
  }

  /** Wipes the screen and the keys right now. Others see you leave; nothing about you stays here. */
  panic() {
    if (!this.currentRoomId) return;
    this.ui.clearMessages();
    this.resetToLaunchpad();
    this.ui.showLaunchpadNotice('');
  }

  // --------------------------------------------------------------------- PWA

  setupPwa() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
    }
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installEvent = e;
      $('btn-install-app')?.classList.remove('hidden');
    });
    $('btn-install-app')?.addEventListener('click', async () => {
      if (!this.installEvent) return;
      this.installEvent.prompt();
      await this.installEvent.userChoice.catch(() => null);
      this.installEvent = null;
      $('btn-install-app')?.classList.add('hidden');
    });
    window.addEventListener('appinstalled', () => $('btn-install-app')?.classList.add('hidden'));
  }

  // ------------------------------------------------------------------ socket

  setupSocketEvents() {
    this.socket.on('connected', ({ latency }) => this.ui.updateTelemetry({ latency }));

    this.socket.on('reconnecting', ({ attempt, delayMs }) => {
      if (this.currentRoomId) {
        this.ui.renderSystemNotice(`Connection interrupted. Reconnecting in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt})...`, true);
      }
    });

    this.socket.on('disconnected', ({ code }) => {
      if (code === 1008 && this.currentRoomId) {
        this.ui.showLaunchpadNotice('You were disconnected for sending too much data.', true);
        this.resetToLaunchpad();
      }
    });

    // Handle relay messages strictly one at a time: key exchange depends on peer state being up to date.
    this.socket.on('message', (data) => {
      this.queue = this.queue
        .then(() => this.onServerMessage(data))
        .catch((err) => console.error('Message handler failed:', err?.name || 'Error'));
    });
  }

  enterRoom(data, peerCount) {
    this.busy = false;
    this.waitingApproval = false;
    this.createArgs = null;
    this.ui.showLaunchpadNotice('');
    this.currentRoomId = data.roomId;
    this.roomName = roomSlug(data.roomId);
    this.ui.switchScreen('chat');
    this.ui.updateTelemetry({ roomId: this.roomName, peerCount });
    this.applyRoomState(data.state, false);
    clearInterval(this.sweepTimer);
    this.sweepTimer = setInterval(() => this.sweepExpired(), 1000);
  }

  async onServerMessage(data) {
    switch (data.type) {
      case 'created': {
        this.members.clear();
        this.order = [this.socket.clientId];
        this.enterRoom(data, 1);
        await this.refreshFingerprint();
        this.ui.renderSystemNotice('Room created. Anyone who has the invite link can join, so share it only with people you trust.');
        break;
      }

      case 'joined': {
        this.members.clear();
        this.unverified.clear();
        await this.verifyAndAddPeers(data.peers);
        if ((data.peers || []).length > 0 && this.members.size === 0) {
          this.abortJoin('Nobody in that room could be verified. If the room has a passphrase, check it and try again.');
          break;
        }
        this.order = [...this.members.keys(), this.socket.clientId];
        this.enterRoom(data, this.members.size + 1);
        this.refreshPeers();
        this.ui.renderSystemNotice('Joined. Waiting for the room key from a member...');
        break;
      }

      case 'join_pending':
        this.waitingApproval = true;
        this.ui.showLaunchpadNotice('Waiting for the host to let you in…');
        break;

      case 'join_denied': {
        this.busy = false;
        this.waitingApproval = false;
        this.crypto.purge();
        this.ui.showLaunchpadNotice(data.message || 'The host did not let you in.', true);
        break;
      }

      case 'join_request': {
        if (!this.isHost || !data.clientId) break;
        const request = { clientId: data.clientId, nickname: String(data.nickname || 'Someone').slice(0, 20), publicKey: data.publicKey, proof: data.proof };
        if (!(await this.verifyPeer(request))) {
          this.socket.send({ action: 'deny', targetClientId: request.clientId });
          this.ui.renderSystemNotice('Someone without a valid invite or passphrase asked to join and was declined.', true);
          break;
        }
        this.requests.set(request.clientId, request);
        this.ui.renderRequests([...this.requests.values()]);
        this.ui.renderSystemNotice(`${request.nickname} is asking to join. Open the people panel to let them in.`);
        sounds.playPop();
        this.noteIncoming();
        break;
      }

      case 'join_request_cancelled':
        this.requests.delete(data.clientId);
        this.ui.renderRequests([...this.requests.values()]);
        break;

      case 'room_state':
        this.applyRoomState(data.state, true);
        break;

      case 'kicked':
        this.ui.showLaunchpadNotice('The host removed you from the room.', true);
        this.resetToLaunchpad();
        break;

      case 'peer_joined': {
        if (this.members.has(data.clientId)) break;
        if (!(await this.verifyPeer(data))) {
          this.noteUnverified(data.clientId);
          break;
        }
        this.members.set(data.clientId, { nickname: data.nickname, publicKey: data.publicKey, proof: data.proof });
        this.order.push(data.clientId);
        this.requests.delete(data.clientId);
        this.ui.renderRequests([...this.requests.values()]);
        this.refreshPeers();
        this.ui.renderSystemNotice(`${data.nickname} joined the room.`);
        await this.sendKeyTo(data.clientId, 'key_exchange');
        break;
      }

      case 'peer_resumed': {
        // A member came back after a network drop and may have missed a key rotation.
        if (this.members.has(data.clientId)) await this.sendKeyTo(data.clientId, 'key_exchange');
        break;
      }

      case 'key_exchange':
      case 'key_rotate': {
        const sender = this.members.get(data.fromClientId);
        if (!sender || !data.encryptedPayload) break; // only verified members can give us keys
        const result = await this.crypto.acceptWrappedKey(
          sender.publicKey, data.fromClientId, this.socket.clientId, data.encryptedPayload
        );
        if (result === 'accepted') {
          const first = !this.fingerprint;
          await this.refreshFingerprint();
          this.ui.renderSystemNotice(first
            ? `End-to-end encryption active (${this.fingerprint}).`
            : `Security ratchet: room key rotated (${this.fingerprint}).`);
          await this.flushPending();
        } else if (result === 'invalid') {
          this.ui.renderSystemNotice(`A key from ${sender.nickname} was rejected.`, true);
        }
        break;
      }

      case 'msg':
        await this.deliverMessage(data, true);
        break;

      case 'ack':
        this.ui.markDelivered(data.seq);
        break;

      case 'typing':
        if (this.members.has(data.senderId)) this.ui.setTyping(this.members.get(data.senderId).nickname, data.isTyping);
        break;

      case 'resumed':
        await this.onResumed(data);
        break;

      case 'peer_left': {
        const left = this.members.get(data.clientId);
        this.unverified.delete(data.clientId);
        if (!left) break;
        this.members.delete(data.clientId);
        this.verified.delete(data.clientId);
        this.order = this.order.filter((id) => id !== data.clientId);
        this.ui.setTyping(left.nickname, false);
        this.refreshPeers();
        this.ui.renderSystemNotice(`${left.nickname} disconnected.`);
        await this.rotateIfLeader();
        break;
      }

      case 'burned': {
        sounds.playBurn();
        this.ui.showLaunchpadNotice(data.reason || 'This room has been destroyed and erased from memory.');
        this.resetToLaunchpad();
        break;
      }

      case 'notice':
      case 'warning':
        this.ui.renderSystemNotice(data.message || 'Server notice', true);
        break;

      case 'left':
        break;

      case 'error':
        await this.onServerError(data);
        break;
    }
  }

  async onServerError(data) {
    if ((data.code === 'POW_FAILED' || data.code === 'POW_STALE') && this.createArgs && this.createTries < 3) {
      await this.submitCreate();   // the relay already sent a fresh puzzle
      return;
    }
    this.busy = false;
    this.waitingApproval = false;
    const message = data.message || 'Something went wrong.';
    if (data.code === 'ROOM_GONE') {
      this.ui.showLaunchpadNotice('The room ended while you were offline.', true);
      this.resetToLaunchpad();
    } else if (!this.currentRoomId) {
      const hint = data.code === 'ROOM_NOT_FOUND' && this.hasPassphrase
        ? 'Room not found. If it needs a passphrase, check that you typed it exactly as it was given to you.'
        : message;
      this.crypto.purge();
      this.ui.showLaunchpadNotice(hint, true);
    } else {
      this.ui.renderSystemNotice(message, true);
    }
  }

  /** Gives up on a join that turned out to be unusable (wrong passphrase, forged room) and starts clean. */
  abortJoin(message) {
    this.crypto.purge();
    this.members.clear();
    this.unverified.clear();
    this.busy = false;
    this.waitingApproval = false;
    this.socket.leaveAndReset();
    this.ui.showLaunchpadNotice(message, true);
  }

  // -------------------------------------------------------------- room state

  /** Applies the host's room settings and tells people what changed. */
  applyRoomState(state, announce) {
    if (!state) return;
    const prev = this.roomState;
    this.roomState = state;

    if (announce && prev) {
      if (prev.hostId !== state.hostId) {
        this.ui.renderSystemNotice(state.hostId === this.socket.clientId
          ? 'You are now the host of this room.'
          : `${this.members.get(state.hostId)?.nickname || 'Someone'} is now the host.`);
      }
      if (prev.locked !== state.locked) this.ui.renderSystemNotice(state.locked ? 'The host locked the room. No one new can join.' : 'The host unlocked the room.');
      if (prev.approval !== state.approval) this.ui.renderSystemNotice(state.approval ? 'New people now need the host\'s approval.' : 'New people no longer need approval.');
      if (prev.disappearSec !== state.disappearSec) {
        this.ui.renderSystemNotice(state.disappearSec
          ? `Disappearing messages: ${DISAPPEAR_LABELS[state.disappearSec]}.`
          : 'Disappearing messages are off.');
      }
      if (prev.expiryMinutes !== state.expiryMinutes) {
        this.ui.renderSystemNotice(`The host extended the room. It now lasts ${state.expiryMinutes >= 120 ? `${(state.expiryMinutes / 60).toFixed(state.expiryMinutes % 60 ? 1 : 0)} hours` : `${state.expiryMinutes} minutes`} in total.`);
      }
    }

    if (!prev || prev.expiryMinutes !== state.expiryMinutes) {
      this.ui.startCountdown(state.createdAt, state.expiryMinutes, () => this.onCountdownEnd());
    }
    if (!this.isHost) {
      this.requests.clear();
      this.ui.renderRequests([]);
    }
    if (!prev || prev.disappearSec !== state.disappearSec) this.applyDisappear();
    this.refreshPeers();
    this.ui.renderRoomState(state, this.isHost);
  }

  async onResumed(data) {
    const before = new Set(this.members.keys());
    this.members.clear();
    this.unverified.clear();
    await this.verifyAndAddPeers(data.peers);

    // Keep our place in the join order; add newcomers at the end.
    const present = new Set(this.members.keys());
    this.order = this.order.filter((id) => id === this.socket.clientId || present.has(id));
    for (const id of present) if (!this.order.includes(id)) this.order.push(id);
    for (const id of [...this.verified]) if (!present.has(id)) this.verified.delete(id);

    if (typeof data.latestSeq === 'number' && data.latestSeq > this.socket.lastSeenSeq) {
      this.socket.lastSeenSeq = data.latestSeq;
    }
    this.applyRoomState(data.state, true);

    this.requests.clear();
    for (const req of data.pendingRequests || []) {
      if (await this.verifyPeer(req)) this.requests.set(req.clientId, req);
    }
    this.ui.renderRequests([...this.requests.values()]);
    this.refreshPeers();
    this.ui.renderSystemNotice(`Session resumed. Recovered ${data.missedMessages?.length || 0} missed messages.`);

    for (const msg of data.missedMessages || []) await this.deliverMessage(msg, false);

    const someoneLeft = [...before].some((id) => !present.has(id));
    if (someoneLeft && (await this.rotateIfLeader())) return;
    // Anyone who joined while we were away may still be waiting for a key.
    for (const id of present) await this.sendKeyTo(id, 'key_exchange');
  }

  // ------------------------------------------------------------ verification

  async verifyPeer(peer) {
    return this.crypto.verifyProof(peer.clientId, peer.publicKey, peer.proof);
  }

  async verifyAndAddPeers(peers) {
    for (const peer of peers || []) {
      if (!peer || peer.clientId === this.socket.clientId) continue;
      if (await this.verifyPeer(peer)) {
        this.members.set(peer.clientId, { nickname: String(peer.nickname || 'Peer').slice(0, 20), publicKey: peer.publicKey, proof: peer.proof });
      } else {
        this.noteUnverified(peer.clientId);
      }
    }
  }

  noteUnverified(clientId) {
    if (this.unverified.has(clientId)) return;
    this.unverified.add(clientId);
    if (this.currentRoomId) {
      this.ui.renderSystemNotice('Someone without a valid invite connected to this room. They are ignored and cannot read anything.', true);
    }
  }

  async openVerify(clientId) {
    const peer = this.members.get(clientId);
    if (!peer || !this.myPublicKey) return;
    this.verifyTarget = clientId;
    const code = await this.crypto.pairCode(this.myPublicKey, peer.publicKey);
    this.ui.showVerifyModal({ nickname: peer.nickname, code, verified: this.verified.has(clientId) });
  }

  toggleVerified() {
    const id = this.verifyTarget;
    if (!id || !this.members.has(id)) return;
    if (this.verified.has(id)) this.verified.delete(id); else this.verified.add(id);
    this.ui.hideVerifyModal();
    this.refreshPeers();
  }

  // -------------------------------------------------------------------- keys

  async sendKeyTo(peerId, action) {
    const peer = this.members.get(peerId);
    if (!peer || !this.crypto.hasKey) return;
    try {
      const encryptedPayload = await this.crypto.wrapCurrentKey(peer.publicKey, this.socket.clientId, peerId);
      this.socket.send({ action, targetClientId: peerId, encryptedPayload });
    } catch {
      // The peer sent a key we cannot use; it will simply not receive the room key.
    }
  }

  /** The oldest verified member rotates the room key whenever someone leaves. Returns true if it rotated. */
  async rotateIfLeader() {
    if (this.order[0] !== this.socket.clientId || this.members.size === 0 || !this.crypto.hasKey) return false;
    await this.crypto.rotateRoomKey();
    await this.refreshFingerprint();
    this.ui.renderSystemNotice(`Security ratchet: key rotated to exclude departed members (${this.fingerprint}).`);
    for (const id of this.members.keys()) await this.sendKeyTo(id, 'key_rotate');
    return true;
  }

  async refreshFingerprint() {
    this.fingerprint = await this.crypto.fingerprint();
    if (this.fingerprint) {
      this.ui.updateTelemetry({ fingerprint: this.fingerprint });
      this.ui.updateWelcomeCardFingerprint(this.fingerprint);
    }
  }

  refreshPeers() {
    this.ui.updateTelemetry({ peerCount: this.members.size + 1 });
    this.ui.updateBurnButtonVisibility(this.isHost || this.members.size === 0);
    this.ui.renderPeersList(this.nickname, [...this.members].map(([clientId, m]) => ({ clientId, nickname: m.nickname })), {
      myId: this.socket.clientId, hostId: this.roomState?.hostId, isHost: this.isHost, verified: this.verified,
    });
  }

  // ---------------------------------------------------------------- messages

  nameOf(senderId) {
    return senderId === this.socket.clientId ? this.nickname : (this.members.get(senderId)?.nickname || 'Peer');
  }

  snippet(entry) {
    if (entry.kind === 'image') return 'Image';
    if (entry.kind === 'file') return entry.file?.voice ? 'Voice note' : (entry.file?.name || 'File');
    return Array.from(entry.text || '').slice(0, 100).join('');
  }

  /** The quote shown above a reply. It comes from our own copy of the original, never from the sender. */
  quoteFor(replySeq) {
    if (replySeq === null || replySeq === undefined) return null;
    const original = this.store.get(replySeq);
    if (!original || original.deleted) return { nickname: '', snippet: 'Earlier message', seq: null };
    return { nickname: this.nameOf(original.senderId), snippet: this.snippet(original), seq: replySeq };
  }

  /** When a message disappears (ms since epoch), or 0 if the room keeps messages. */
  expiryFor(timestamp) {
    const sec = this.roomState?.disappearSec || 0;
    if (!sec) return 0;
    const age = Math.min(Math.max(0, Date.now() - timestamp), sec * 1000);
    return Date.now() + sec * 1000 - age;
  }

  addToStore(entry) {
    entry.reactions = new Map();
    entry.deleted = false;
    entry.expiresAt = this.expiryFor(entry.timestamp);
    this.store.set(entry.seq, entry);
    return entry;
  }

  sweepExpired() {
    const now = Date.now();
    for (const [seq, entry] of this.store) {
      if (entry.expiresAt && entry.expiresAt <= now) this.forget(seq);
    }
  }

  forget(seq) {
    const entry = this.store.get(seq);
    if (!entry) return;
    if (entry.url) URL.revokeObjectURL(entry.url);
    this.store.delete(seq);
    this.ui.removeMessage(seq);
  }

  /** The host changed the timer: re-time what is on screen. */
  applyDisappear() {
    for (const entry of this.store.values()) entry.expiresAt = this.expiryFor(entry.timestamp);
    document.querySelectorAll('.ephemeral-mark').forEach((n) => n.remove());
    this.sweepExpired();
  }

  async deliverMessage(msg, live) {
    if (!msg || typeof msg.ciphertext !== 'string' || typeof msg.senderId !== 'string' || !Number.isSafeInteger(msg.seq)) return;
    const kind = KINDS.includes(msg.kind) ? msg.kind : 'text';
    const result = kind === 'file'
      ? await this.crypto.decryptBinary(msg.ciphertext, { senderId: msg.senderId, kind })
      : await this.crypto.decryptMessage(msg.ciphertext, { senderId: msg.senderId, kind });

    if (result.status === 'pending') {
      if (this.pending.length < MAX_PENDING) this.pending.push({ msg, live });
      return;
    }
    if (result.status === 'failed') {
      // Not encrypted with a key we hold: wrong sender, tampering, or someone without the invite.
      const now = Date.now();
      if (now - this.lastDecryptNotice > 10000) {
        this.lastDecryptNotice = now;
        this.ui.renderSystemNotice('A message could not be decrypted and was dropped.', true);
      }
      return;
    }

    const isMe = msg.senderId === this.socket.clientId;
    if (kind === 'ctl') {
      this.handleControl(msg.senderId, result.meta);
      return;
    }
    if (kind === 'file') {
      this.handleFileChunk(msg, result, isMe, live);
      return;
    }

    if (this.expiryFor(msg.timestamp) && this.expiryFor(msg.timestamp) <= Date.now()) return; // already gone
    const replySeq = Number.isSafeInteger(result.meta?.r) && result.meta.r >= 0 ? result.meta.r : null;
    const entry = this.addToStore({ seq: msg.seq, senderId: msg.senderId, isMe, kind, text: result.text, timestamp: msg.timestamp });
    this.ui.renderMessage({
      seq: msg.seq, senderId: msg.senderId, isMe, nickname: this.nameOf(msg.senderId), text: result.text, kind,
      timestamp: msg.timestamp, quote: this.quoteFor(replySeq), ephemeral: Boolean(entry.expiresAt),
    });
    if (live && !isMe) { this.queueAck(msg.senderId, msg.seq); this.noteIncoming(); }
  }

  handleFileChunk(msg, result, isMe, live) {
    const out = this.files.accept(msg.senderId, msg.seq, result.meta, result.bytes);
    const t = out.transfer;
    if (out.status === 'drop') return;
    if (out.status === 'fail') {
      if (t && this.ui.rows.has(t.seq)) this.ui.failFile(t.seq);
      return;
    }

    if (out.status === 'start' || (out.status === 'done' && out.first)) {
      const entry = this.addToStore({
        seq: t.seq, senderId: msg.senderId, isMe, kind: 'file', text: '', timestamp: msg.timestamp,
        file: { name: t.name, size: t.size, voice: t.voice },
      });
      this.ui.renderMessage({
        seq: t.seq, senderId: msg.senderId, isMe, nickname: this.nameOf(msg.senderId), kind: 'file', timestamp: msg.timestamp,
        file: entry.file, quote: this.quoteFor(t.replySeq), ephemeral: Boolean(entry.expiresAt),
      });
    }
    if (out.status === 'start' || out.status === 'chunk') {
      this.ui.updateFileProgress(t.seq, t.next / t.n);
      return;
    }

    // done
    const entry = this.store.get(t.seq);
    if (!entry) return;                       // expired or deleted while it was arriving
    entry.url = URL.createObjectURL(t.blob);
    this.ui.completeFile(t.seq, t, entry.url);
    if (live && !isMe) { this.queueAck(msg.senderId, t.lastSeq); this.noteIncoming(); }
  }

  /** Encrypted control messages: reactions and delete-for-everyone. */
  handleControl(senderId, meta) {
    if (!meta || !Number.isSafeInteger(meta.s)) return;
    const target = this.store.get(meta.s);
    if (!target || target.deleted) return;

    if (meta.op === 'react') {
      if (!REACTIONS.includes(meta.e) || typeof meta.on !== 'boolean') return;
      const who = target.reactions.get(meta.e) || new Set();
      if (meta.on) who.add(senderId); else who.delete(senderId);
      if (who.size) target.reactions.set(meta.e, who); else target.reactions.delete(meta.e);
      this.ui.renderReactions(target.seq, target.reactions, this.socket.clientId);
    } else if (meta.op === 'del') {
      if (target.senderId !== senderId) return; // only the author can delete
      target.deleted = true;
      target.text = '';
      if (target.url) { URL.revokeObjectURL(target.url); target.url = null; }
      this.ui.markDeleted(target.seq);
    }
  }

  async flushPending() {
    const waiting = this.pending;
    this.pending = [];
    for (const { msg, live } of waiting) await this.deliverMessage(msg, live);
  }

  /** Delivery receipts are batched: one ack per sender per 300 ms, covering everything up to that seq. */
  queueAck(targetId, seq) {
    if (!Number.isSafeInteger(seq)) return;
    this.ackQueue.set(targetId, Math.max(seq, this.ackQueue.get(targetId) || 0));
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      for (const [targetClientId, highest] of this.ackQueue) {
        this.socket.send({ action: 'ack', targetClientId, seq: highest });
      }
      this.ackQueue.clear();
    }, 300);
  }

  onCountdownEnd() {
    this.ui.renderSystemNotice('This room has reached its lifetime and will be destroyed any moment now.', true);
  }

  // ------------------------------------------------------------ user actions

  readNickname() {
    this.nickname = ($('nickname-input')?.value || '').trim().slice(0, 20) || 'Anonymous';
  }

  startBusy() {
    if (this.busy || this.waitingApproval) return false;
    this.busy = true;
    setTimeout(() => { if (!this.waitingApproval && !this.currentRoomId) this.busy = false; }, 60000);
    return true;
  }

  failStart(message) {
    this.busy = false;
    this.waitingApproval = false;
    this.createArgs = null;
    this.crypto.purge();
    this.ui.showLaunchpadNotice(message, true);
  }

  async handleCreateRoom() {
    if (!this.startBusy()) return;
    this.ui.showLaunchpadNotice('');
    this.readNickname();
    const expiryMinutes = parseInt($('expiry-select')?.value || '60', 10);
    const passphrase = $('create-passphrase')?.value || '';
    const approval = $('create-approval')?.checked === true;
    const disappearSec = Number($('create-disappear')?.value || 0);

    try {
      this.inviteSecret = generateInviteSecret();
      this.hasPassphrase = passphrase.length > 0;
      const roomId = await this.crypto.setInvite(this.inviteSecret, passphrase);
      this.myPublicKey = await this.crypto.initIdentity();
      await this.crypto.generateRoomKey();
      const myId = await this.socket.whenReady();
      const proof = await this.crypto.makeProof(myId, this.myPublicKey);
      this.createArgs = { roomId, nickname: this.nickname, publicKey: this.myPublicKey, proof, expiryMinutes, approval, disappearSec };
      this.createTries = 0;
      await this.submitCreate();
    } catch {
      this.failStart('Could not reach the relay. Check your connection and try again.');
    }
  }

  /** Solves the relay's anti-spam puzzle for this room id and sends the create request. */
  async submitCreate() {
    try {
      const args = this.createArgs;
      if (!args) return;
      this.createTries += 1;
      const pow = this.socket.pow;
      if (pow?.bits) this.ui.showLaunchpadNotice('Preparing your room (a quick anti-spam check)…');
      const nonce = pow ? await solvePow({ seed: pow.seed, roomId: args.roomId, bits: pow.bits }) : '0';
      if (!this.socket.send({ action: 'create', ...args, nonce })) throw new Error('not connected');
    } catch {
      this.failStart('Could not reach the relay. Check your connection and try again.');
    }
  }

  async handleJoinRoom() {
    const raw = $('join-room-input')?.value || '';
    const secret = parseInvite(raw);
    if (!secret) {
      this.ui.showLaunchpadNotice('That invite link or code is not valid. Ask for a new link.', true);
      return;
    }
    const needsPassphrase = inviteNeedsPassphrase(raw);
    const passphrase = $('join-passphrase')?.value || '';
    if (needsPassphrase && !passphrase) {
      this.ui.showLaunchpadNotice('This room is protected by a passphrase. Enter it first.', true);
      return;
    }
    if (!this.startBusy()) return;
    this.ui.showLaunchpadNotice('');
    this.readNickname();

    try {
      this.inviteSecret = secret;
      this.hasPassphrase = needsPassphrase;
      const roomId = await this.crypto.setInvite(secret, needsPassphrase ? passphrase : '');
      this.myPublicKey = await this.crypto.initIdentity();
      const myId = await this.socket.whenReady();
      const proof = await this.crypto.makeProof(myId, this.myPublicKey);

      if (!this.socket.send({ action: 'join', roomId, nickname: this.nickname, publicKey: this.myPublicKey, proof })) throw new Error('not connected');
    } catch {
      this.failStart('Could not reach the relay. Check your connection and try again.');
    }
  }

  async sendEnvelope(text, kind, meta) {
    const ciphertext = await this.crypto.encryptMessage(text, { senderId: this.socket.clientId, kind, meta });
    return this.socket.send({ action: 'msg', kind, ciphertext });
  }

  takeReply() {
    const reply = this.replyTo;
    this.setReply(null);
    return reply;
  }

  async handleSendMessage() {
    const input = $('chat-input');
    const text = input?.value.trim();
    if (!text || !this.currentRoomId) return;

    if (!this.crypto.hasKey) {
      this.ui.renderSystemNotice('Still waiting for the room key. Try again in a moment.', true);
      return;
    }
    if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
      this.ui.renderSystemNotice('That message is too long. Please split it up.', true);
      return;
    }

    const meta = this.replyTo ? { r: this.replyTo.seq } : null;
    if (await this.sendEnvelope(text, 'text', meta)) {
      input.value = '';
      this.setReply(null);
    } else {
      this.ui.renderSystemNotice('Not connected. Your message was not sent.', true);
    }
  }

  /**
   * Shrinks an image in the browser until it fits the relay's frame limit, then encrypts and sends it.
   * Images are relayed to people who are online right now; the relay does not keep them.
   */
  async processAndSendImage(file) {
    if (!this.currentRoomId || !this.crypto.hasKey) {
      this.ui.renderSystemNotice('Waiting for the room key. Try again in a moment.', true);
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      this.ui.renderSystemNotice('Images up to 30 MB can be sent.', true);
      return;
    }

    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      // Not a picture the browser can decode (or a disguised file): send it as a plain file instead.
      return this.sendFile(file, { name: file.name, mime: file.type });
    }

    let scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    let quality = 0.8;
    let dataUrl = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; // JPEG has no transparency
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length <= MAX_IMAGE_DATA_URL) break;
      scale *= 0.8;
      quality = Math.max(0.5, quality - 0.07);
    }
    bitmap.close?.();

    if (dataUrl.length > MAX_IMAGE_DATA_URL) {
      this.ui.renderSystemNotice('This image is too large to send, even after shrinking it.', true);
      return;
    }

    const reply = this.takeReply();
    const sent = await this.sendEnvelope(`__ZERO_IMG__::${dataUrl}`, 'image', reply ? { r: reply.seq } : null);
    if (!sent) this.ui.renderSystemNotice('Not connected. The image was not sent.', true);
  }

  /** Encrypts a file or voice note in 256 KB chunks and paces them so slow phones are not flooded. */
  async sendFile(blob, { name, mime, voice = false, duration = 0 }) {
    if (!this.currentRoomId || !this.crypto.hasKey) {
      this.ui.renderSystemNotice('Waiting for the room key. Try again in a moment.', true);
      return;
    }
    if (this.uploading) {
      this.ui.renderSystemNotice('Please wait for the current upload to finish.', true);
      return;
    }
    if (!blob.size || blob.size > MAX_FILE_BYTES) {
      this.ui.renderSystemNotice(`Files up to ${formatBytes(MAX_FILE_BYTES)} can be sent.`, true);
      return;
    }

    this.uploading = true;
    const reply = this.takeReply();
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const chunks = [...chunkBytes(bytes)];
      const f = newFileId();
      for (let i = 0; i < chunks.length; i++) {
        while (this.socket.buffered > 1_000_000) await sleep(50);
        const meta = { f, i, n: chunks.length };
        if (i === 0) {
          Object.assign(meta, {
            name: sanitizeFileName(name), mime: String(mime || 'application/octet-stream').slice(0, 100), size: bytes.length,
          });
          if (voice) { meta.v = true; meta.d = Math.round(duration * 10) / 10; }
          if (reply) meta.r = reply.seq;
        }
        const ciphertext = await this.crypto.encryptBinary(chunks[i], { senderId: this.socket.clientId, kind: 'file', meta });
        if (!this.socket.send({ action: 'msg', kind: 'file', ciphertext })) throw new Error('not connected');
        if (i < chunks.length - 1) await sleep(150);
      }
    } catch {
      this.ui.renderSystemNotice('The upload was interrupted and was not completed.', true);
    } finally {
      this.uploading = false;
    }
  }

  handleTyping() {
    if (!this.currentRoomId) return;

    const now = Date.now();
    if (now - this.lastTypingSent > 2000) {
      this.lastTypingSent = now;
      this.socket.send({ action: 'typing', isTyping: true });
    }

    clearTimeout(this.typingTimeout);
    this.typingTimeout = setTimeout(() => {
      this.lastTypingSent = 0;
      this.socket.send({ action: 'typing', isTyping: false });
    }, 2000);
  }

  // ----------------------------------------------- reply, react, copy, delete

  openMenu(seq, anchor) {
    const entry = this.store.get(seq);
    if (!entry || entry.deleted) return;
    const mine = new Set();
    for (const [emoji, who] of entry.reactions) if (who.has(this.socket.clientId)) mine.add(emoji);
    this.ui.showMessageMenu(seq, anchor, { canCopy: entry.kind === 'text', canDelete: entry.isMe, mine });
  }

  setReply(info) {
    this.replyTo = info;
    this.ui.setReply(info);
  }

  startReply(seq) {
    const entry = this.store.get(seq);
    if (!entry || entry.deleted) return;
    this.setReply({ seq, nickname: this.nameOf(entry.senderId), snippet: this.snippet(entry) });
  }

  async copyMessage(seq) {
    const entry = this.store.get(seq);
    if (!entry || entry.deleted || entry.kind !== 'text') return;
    try { await navigator.clipboard.writeText(entry.text); } catch { this.ui.renderSystemNotice('Could not access the clipboard.', true); }
  }

  async sendControl(meta) {
    try { await this.sendEnvelope('', 'ctl', meta); } catch { /* the room key may not be ready yet */ }
  }

  sendReaction(seq, emoji, on) {
    if (!this.store.has(seq) || !REACTIONS.includes(emoji)) return;
    return this.sendControl({ op: 'react', s: seq, e: emoji, on });
  }

  deleteMessage(seq) {
    const entry = this.store.get(seq);
    if (!entry || !entry.isMe || entry.deleted) return;
    return this.sendControl({ op: 'del', s: seq });
  }

  // -------------------------------------------------------------- moderation

  kickMember(clientId) {
    const peer = this.members.get(clientId);
    if (!peer || !this.isHost) return;
    if (confirm(`Remove ${peer.nickname} from the room? Everyone else gets a fresh key.`)) {
      this.socket.send({ action: 'kick', targetClientId: clientId });
    }
  }

  decideRequest(clientId, approve) {
    const request = this.requests.get(clientId);
    if (!request || !this.isHost) return;
    this.requests.delete(clientId);
    this.ui.renderRequests([...this.requests.values()]);
    this.socket.send({ action: approve ? 'approve' : 'deny', targetClientId: clientId });
  }

  handleBurnRoom() {
    if (!this.isHost && this.members.size > 0) {
      this.ui.renderSystemNotice('Only the host, or the last person in the room, can burn it.', true);
      return;
    }
    const question = this.members.size > 0
      ? 'Destroy this room for everyone? All messages and keys will be erased immediately.'
      : 'Destroy this room permanently? All messages and cryptographic keys will be erased immediately.';
    if (!confirm(question)) return;

    sounds.playBurn();
    this.socket.send({ action: 'burn' });
    this.resetToLaunchpad();
  }

  resetToLaunchpad() {
    this.recorder?.cancel();
    this.recorder = null;
    this.crypto.purge();
    for (const entry of this.store.values()) if (entry.url) URL.revokeObjectURL(entry.url);
    this.store.clear();
    this.files.clear();
    this.members.clear();
    this.requests.clear();
    this.verified.clear();
    this.order = [];
    this.pending = [];
    this.unverified.clear();
    this.ackQueue.clear();
    clearTimeout(this.ackTimer);
    this.ackTimer = null;
    clearTimeout(this.typingTimeout);
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.currentRoomId = null;
    this.roomName = '';
    this.roomState = null;
    this.inviteSecret = null;
    this.hasPassphrase = false;
    this.myPublicKey = null;
    this.createArgs = null;
    this.replyTo = null;
    this.uploading = false;
    this.fingerprint = null;
    this.busy = false;
    this.waitingApproval = false;
    this.setBlur(false);
    this.clearUnread();
    this.socket.leaveAndReset();
    this.ui.switchScreen('launchpad');
    this.ui.renderRequests([]);
    $('create-passphrase') && ($('create-passphrase').value = '');
    $('join-passphrase') && ($('join-passphrase').value = '');
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  getInviteUrl() {
    return `${window.location.origin}${window.location.pathname}#${inviteFragment(this.inviteSecret, this.hasPassphrase)}`;
  }

  copyInviteLink() {
    if (!this.inviteSecret) return;
    navigator.clipboard.writeText(this.getInviteUrl()).then(() => {
      const copyBtn = $('btn-copy-invite');
      if (copyBtn) {
        const saved = Array.from(copyBtn.childNodes).map((n) => n.cloneNode(true));
        const done = document.createElement('span');
        done.textContent = 'Copied';
        copyBtn.replaceChildren(done);
        setTimeout(() => copyBtn.replaceChildren(...saved), 2000);
      }
      this.ui.renderSystemNotice(this.hasPassphrase
        ? 'Invite link copied. Tell people the passphrase separately: it is not in the link.'
        : 'Invite link copied.');
    }).catch(() => {
      this.ui.renderSystemNotice('Could not access the clipboard. Copy the link from the QR dialog instead.', true);
    });
  }

  async shareInvite() {
    if (!this.inviteSecret || !navigator.share) return;
    try {
      await navigator.share({ title: 'ZEROROOM invite', text: this.hasPassphrase ? 'Join my private room (I will send the passphrase separately)' : 'Join my private room', url: this.getInviteUrl() });
    } catch { /* the person closed the share sheet */ }
  }

  showSafetyModal() {
    const modal = $('safety-modal');
    const hashSpan = $('modal-fingerprint');
    if (modal && hashSpan) {
      hashSpan.textContent = this.fingerprint || 'Pending key exchange';
      modal.classList.remove('hidden');
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new ZeroRoomApp();
});
