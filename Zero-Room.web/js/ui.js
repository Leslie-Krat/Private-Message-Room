/**
 * Zero-Room UI controller.
 * Builds the conversation, the room side panel, the message menu and the modals with the DOM API only:
 * text from other people is never inserted as HTML.
 */
import { formatBytes, formatDuration, withExtension } from './files.js?v=6.2';

class SoundEffects {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  ensureContext() {
    if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  #blip(type, from, to, seconds, volume) {
    if (!this.enabled) return;
    try {
      this.ensureContext();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(to, this.ctx.currentTime + seconds);
      gain.gain.setValueAtTime(volume, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.001, this.ctx.currentTime + seconds);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + seconds);
    } catch { /* audio is optional */ }
  }

  playPop() { this.#blip('sine', 440, 880, 0.06, 0.04); }
  playBurn() { this.#blip('triangle', 320, 110, 0.35, 0.08); }
}

const IMAGE_PREFIX = '__ZERO_IMG__::';
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
export const DISAPPEAR_LABELS = { 0: 'Off', 30: '30 seconds', 300: '5 minutes', 3600: '1 hour', 86400: '24 hours' };

export const sounds = new SoundEffects();

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const $ = (id) => document.getElementById(id);

export class UIController {
  constructor() {
    this.handlers = {};          // set by the app: onMenu, onReact, onKick, ...
    this.launchpadView = $('launchpad-view');
    this.chatView = $('chat-view');
    this.messageList = $('message-list');
    this.typingIndicator = $('typing-indicator');
    this.pingDisplay = $('ping-display');
    this.roomTitle = $('room-title');
    this.roomSubtitle = $('room-status-subtitle');
    this.fingerprintPill = $('fingerprint-pill');
    this.countdownTimer = $('countdown-timer');
    this.emojiPopover = $('emoji-popover');
    this.soundIcon = $('sound-icon');

    this.roomSidebar = $('room-sidebar');
    this.sidebarBackdrop = $('sidebar-backdrop');
    this.btnToggleSidebar = $('btn-toggle-sidebar');
    this.btnCloseSidebar = $('btn-close-sidebar');
    this.sidebarPeersList = $('sidebar-peers-list');
    this.sidebarPeerCount = $('sidebar-peer-count');
    this.navPeerCount = $('nav-peer-count');
    this.sidebarCountdown = $('sidebar-countdown');
    this.countdownProgress = $('countdown-progress');
    this.sidebarFingerprintBadge = $('sidebar-fingerprint-badge');
    this.sidebarRoomName = $('sidebar-room-name');

    this.rows = new Map();       // seq -> { row, bubble, body, reactions }
    this.timerInterval = null;
    this.menuSeq = null;

    this.setupModalDismissal();
    this.setupCategorizedEmojiDrawer();
    this.setupSoundToggle();
    this.setupSidebar();
    this.setupMessageMenu();
  }

  // ------------------------------------------------------------------ chrome

  setupSidebar() {
    this.btnToggleSidebar?.addEventListener('click', () => {
      if (window.innerWidth < 1024) {
        this.roomSidebar?.classList.toggle('open');
        this.sidebarBackdrop?.classList.toggle('hidden');
      } else {
        this.roomSidebar?.classList.toggle('collapsed');
      }
    });
    const closeMobileSidebar = () => {
      this.roomSidebar?.classList.remove('open');
      this.sidebarBackdrop?.classList.add('hidden');
    };
    this.btnCloseSidebar?.addEventListener('click', closeMobileSidebar);
    this.sidebarBackdrop?.addEventListener('click', closeMobileSidebar);
  }

  setupSoundToggle() {
    const btn = $('btn-toggle-sound');
    btn?.addEventListener('click', () => {
      const isEnabled = sounds.toggle();
      btn.classList.toggle('muted', !isEnabled);
      btn.title = isEnabled ? 'Sound is on (click to mute)' : 'Sound is muted (click to unmute)';
    });
  }

  setupModalDismissal() {
    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.classList.add('hidden');
      });
    });
    document.querySelectorAll('.modal-backdrop [data-close]').forEach((btn) => {
      btn.addEventListener('click', () => btn.closest('.modal-backdrop')?.classList.add('hidden'));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
      this.emojiPopover?.classList.add('hidden');
      this.hideMessageMenu();
    });
  }

  setupCategorizedEmojiDrawer() {
    const toggleBtn = $('btn-toggle-emoji');
    const input = $('chat-input');

    const emojiData = {
      reactions: ['👍', '👎', '❤️', '🔥', '👏', '🎉', '💯', '👀', '🚀', '✨', '🙏', '⚡', '🏆', '🎯', '💥', '⭐', '💎', '💡'],
      faces: ['😀', '😂', '🤣', '🥹', '😎', '🤔', '🤫', '😴', '🤯', '🥳', '💀', '😇', '🤠', '🤖', '😍', '🤩', '😬', '🫡', '🧐', '😏', '😌', '🫠', '🙃', '👽'],
      gestures: ['👋', '🤝', '✌️', '🤞', '🤙', '👊', '🖐️', '✍️', '💅', '🦾', '💪', '🫶', '👐', '🙌', '👌', '🤌', '👈', '👉'],
      tech: ['🔒', '🔑', '💻', '⚡', '🛡️', '🌐', '📡', '🎯', '⏱️', '📦', '🏷️', '🚨', '💬', '👁️', '⚙️', '📂', '🧪', '💡', '🔋', '💾', '🛰️', '🕹️', '📟', '🧱'],
    };

    Object.keys(emojiData).forEach((category) => {
      const grid = $(`emoji-grid-${category}`);
      if (!grid) return;
      grid.replaceChildren();
      emojiData[category].forEach((emoji) => {
        const btn = el('button', 'emoji-btn', emoji);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          if (input) { input.value += emoji; input.focus(); }
          this.emojiPopover?.classList.add('hidden');
        });
        grid.appendChild(btn);
      });
    });

    const tabButtons = document.querySelectorAll('.emoji-tab-btn');
    tabButtons.forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        tabButtons.forEach((b) => b.classList.remove('active'));
        tabBtn.classList.add('active');
        document.querySelectorAll('.emoji-category-grid').forEach((grid) => grid.classList.add('hidden'));
        $(`emoji-grid-${tabBtn.getAttribute('data-tab')}`)?.classList.remove('hidden');
      });
    });

    toggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.emojiPopover?.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!this.emojiPopover?.contains(e.target) && e.target !== toggleBtn) this.emojiPopover?.classList.add('hidden');
    });
  }

  switchScreen(screen) {
    const footerEl = document.querySelector('footer');
    if (screen === 'chat') {
      document.body.classList.add('in-chat');
      this.launchpadView.classList.add('hidden');
      this.chatView.classList.remove('hidden');
      $('nav-room-details')?.classList.remove('hidden');
      $('nav-room-actions')?.classList.remove('hidden');
      footerEl?.classList.add('hidden');
      $('chat-input')?.focus();
    } else {
      document.body.classList.remove('in-chat');
      this.chatView.classList.add('hidden');
      this.launchpadView.classList.remove('hidden');
      $('nav-room-details')?.classList.add('hidden');
      $('nav-room-actions')?.classList.add('hidden');
      footerEl?.classList.remove('hidden');
      this.roomSidebar?.classList.remove('open');
      this.sidebarBackdrop?.classList.add('hidden');
      this.clearMessages();
      this.hideMessageMenu();
      this.setReply(null);
      this.setRecording(false);
      this.stopCountdown();
    }
  }

  /** Avatar colour class: the person themself is ribbon blue, everyone else gets one of four soft colours. */
  getAvatarGradient(nickname, isMe) {
    if (isMe) return 'me';
    const colors = ['a1', 'a2', 'a3', 'a4'];
    let hash = 0;
    for (let i = 0; i < (nickname || '').length; i++) hash = nickname.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  /** Up to two letters for an avatar: first letters of two words, else the first two letters. */
  initials(nickname) {
    const words = String(nickname || 'U').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const chars = words.length > 1 ? [words[0], words[1]].map((w) => Array.from(w)[0]) : Array.from(words[0] || 'U').slice(0, 2);
    return chars.join('').toUpperCase();
  }

  updateWelcomeCardFingerprint(fingerprint) {
    const node = $('card-fingerprint');
    if (node) node.textContent = fingerprint;
  }

  // ---------------------------------------------------------------- messages

  /**
   * Adds one message row. `kind` is text | image | file. Use the seq to update it later.
   * `quote` is { nickname, snippet, seq } for replies (built by the app from its own copy of the original).
   */
  renderMessage({ seq, senderId, isMe, nickname, text = '', kind, timestamp, quote = null, file = null, ephemeral = false }) {
    const row = el('div', `msg-row ${isMe ? 'mine' : 'theirs'} message-anim`);
    row.dataset.seq = String(seq);
    if (senderId) row.dataset.sender = senderId;

    const col = el('div', 'msg-col');

    const meta = el('div', 'msg-meta');
    if (!isMe) meta.append(el('span', 'msg-name', nickname));
    meta.appendChild(el('span', 'msg-time', new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    if (ephemeral) {
      const mark = el('span', 'ephemeral-mark', 'disappearing');
      mark.title = 'This message will disappear';
      meta.appendChild(mark);
    }

    const line = el('div', 'msg-line');
    const bubble = el('div', isMe ? 'bubble-user' : 'bubble-peer');

    if (quote) bubble.appendChild(this.buildQuote(quote));
    const body = el('div', 'msg-body');
    bubble.appendChild(body);

    if (kind === 'file' && file) {
      this.buildFilePlaceholder(body, file);
    } else if (kind === 'image' && text.startsWith(IMAGE_PREFIX)) {
      this.renderImageInto(body, text.substring(IMAGE_PREFIX.length).trim());
    } else if (text.startsWith('```') && text.endsWith('```') && text.length >= 6) {
      const pre = el('pre', 'code-block');
      pre.appendChild(el('code', '', text.slice(3, -3).trim()));
      body.appendChild(pre);
    } else {
      this.renderRichText(body, text);
    }

    if (isMe) {
      const receipt = el('span', 'receipt', '\u2713');
      receipt.dataset.seq = String(seq);
      receipt.title = 'Delivered';
      meta.appendChild(receipt);
    }

    const more = el('button', 'msg-more', '\u22EF');
    more.type = 'button';
    more.title = 'Reply, react or delete';
    more.setAttribute('aria-label', 'Message actions');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlers.onMenu?.(seq, more);
    });

    const reactions = el('div', 'reactions');

    line.append(bubble, more);
    col.append(meta, line, reactions);
    row.append(col);
    this.messageList.appendChild(row);
    this.rows.set(seq, { row, bubble, body, reactions, col });
    this.scrollToBottom();

    if (!isMe) sounds.playPop();
  }

  buildQuote(quote) {
    const box = el('button', 'reply-quote');
    box.type = 'button';
    box.append(
      el('span', 'rq-name', quote.nickname || 'Message'),
      el('span', 'rq-text', quote.snippet || 'Earlier message'),
    );
    if (quote.seq !== undefined && quote.seq !== null) {
      box.dataset.seq = String(quote.seq);
      box.addEventListener('click', () => this.scrollToMessage(quote.seq));
    }
    return box;
  }

  scrollToMessage(seq) {
    const entry = this.rows.get(seq);
    if (!entry) return;
    entry.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    entry.bubble.classList.add('flash');
    setTimeout(() => entry.bubble.classList.remove('flash'), 1200);
  }

  has(seq) {
    return this.rows.has(seq);
  }

  removeMessage(seq) {
    const entry = this.rows.get(seq);
    if (!entry) return;
    entry.row.remove();
    this.rows.delete(seq);
  }

  /** Delete-for-everyone: the bubble stays, the content goes. */
  markDeleted(seq) {
    const entry = this.rows.get(seq);
    if (!entry) return;
    entry.bubble.querySelector('.reply-quote')?.remove();
    entry.body.replaceChildren(el('span', 'msg-deleted', 'This message was deleted'));
    entry.bubble.classList.add('deleted');
    entry.reactions.replaceChildren();
    entry.row.querySelector('.msg-more')?.remove();
    // Replies elsewhere must not keep showing what was deleted.
    this.messageList.querySelectorAll(`.reply-quote[data-seq="${seq}"]`).forEach((q) => {
      q.replaceChildren(el('span', 'msg-deleted-quote', 'Original message deleted'));
      q.removeAttribute('data-seq');
    });
  }

  /** reactionMap: Map(emoji -> Set(senderId)). */
  renderReactions(seq, reactionMap, myId) {
    const entry = this.rows.get(seq);
    if (!entry) return;
    entry.reactions.replaceChildren();
    for (const [emoji, who] of reactionMap) {
      if (!who.size) continue;
      const mine = who.has(myId);
      const chip = el('button', `reaction-chip ${mine ? 'mine' : ''}`);
      chip.type = 'button';
      chip.title = mine ? 'Remove your reaction' : 'React';
      chip.append(el('span', '', emoji), el('span', 'reaction-count', String(who.size)));
      chip.addEventListener('click', () => this.handlers.onReact?.(seq, emoji, !mine));
      entry.reactions.appendChild(chip);
    }
  }

  /** Validated data-URL image. Anything that is not a plain base64 raster image is refused. */
  renderImageInto(container, dataUrl) {
    const valid = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl);
    if (!valid) {
      container.appendChild(el('span', 'msg-error', 'This image failed the security check and was not shown.'));
      return;
    }
    const box = el('div', 'img-box');
    const img = el('img', 'img-thumb');
    img.src = dataUrl;
    img.alt = 'Ephemeral image';
    box.append(img, el('span', 'img-hint', 'Tap to view or save'));
    box.addEventListener('click', () => this.openViewer(dataUrl, 'zeroroom-image.jpg'));
    container.appendChild(box);
  }

  /** Shows a picture inside the page (no new tab, so it works in every browser and installed app) with a Save button. */
  openViewer(url, name) {
    const modal = $('view-modal');
    if (!modal) return;
    $('view-img').src = url;
    const save = $('view-save');
    save.href = url;
    save.download = name;
    modal.classList.remove('hidden');
  }

  // -------------------------------------------------------- files and voice

  buildFilePlaceholder(body, file) {
    const card = el('div', 'file-card');
    card.appendChild(el('div', 'file-ico', file.voice ? 'Audio' : 'File'));
    const info = el('div', 'file-info');
    info.append(
      el('div', 'file-name', file.voice ? 'Voice note' : file.name),
      el('div', 'file-status', `${formatBytes(file.size)} · receiving…`),
    );
    const bar = el('div', 'file-bar');
    const fill = el('div', 'file-progress');
    fill.style.width = '0%';
    bar.appendChild(fill);
    info.appendChild(bar);
    card.appendChild(info);
    body.appendChild(card);
  }

  updateFileProgress(seq, fraction) {
    const bar = this.rows.get(seq)?.body.querySelector('.file-progress');
    if (bar) bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  }

  failFile(seq) {
    const entry = this.rows.get(seq);
    if (entry) entry.body.replaceChildren(el('span', 'msg-error', 'This file could not be received.'));
  }

  /** Swaps the progress card for the finished file: player, image or download button. */
  completeFile(seq, transfer, url) {
    const entry = this.rows.get(seq);
    if (!entry) return;
    entry.body.replaceChildren();

    if (transfer.voice) {
      const audio = el('audio', 'voice-player');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = url;
      const label = el('div', 'voice-label', `Voice note${transfer.duration ? ' · ' + formatDuration(transfer.duration) : ''}`);
      const save = el('a', 'voice-save', 'Save');
      save.href = url;
      save.download = withExtension('voice-note', transfer.mime);
      save.rel = 'noopener';
      const foot = el('div', 'voice-foot');
      foot.append(label, save);
      entry.body.append(audio, foot);
      return;
    }

    if (transfer.mime.startsWith('image/')) {
      const img = el('img', 'img-thumb img-box');
      img.src = url;
      img.alt = transfer.name;
      img.addEventListener('click', () => this.openViewer(url, withExtension(transfer.name, transfer.mime)));
      entry.body.appendChild(img);
    }

    const card = el('div', 'file-row');
    const info = el('div', 'file-info');
    info.append(el('div', 'file-name', transfer.name), el('div', 'file-status', formatBytes(transfer.size)));
    const download = el('a', 'download-link', 'Save');
    download.href = url;
    download.download = withExtension(transfer.name, transfer.mime);
    download.rel = 'noopener';
    card.append(el('div', 'file-ico', 'File'), info, download);
    entry.body.appendChild(card);
  }

  // ---------------------------------------------------------- message menu

  setupMessageMenu() {
    this.menu = $('msg-menu');
    if (!this.menu) return;
    const quick = $('msg-menu-reactions');
    for (const emoji of REACTIONS) {
      const b = el('button', 'menu-react', emoji);
      b.type = 'button';
      b.dataset.emoji = emoji;
      b.addEventListener('click', () => {
        const seq = this.menuSeq;
        const on = b.dataset.on !== '1';
        this.hideMessageMenu();
        if (seq !== null) this.handlers.onReact?.(seq, emoji, on);
      });
      quick?.appendChild(b);
    }
    const bind = (id, handler) => $(id)?.addEventListener('click', () => {
      const seq = this.menuSeq;
      this.hideMessageMenu();
      if (seq !== null) this.handlers[handler]?.(seq);
    });
    bind('msg-menu-reply', 'onReply');
    bind('msg-menu-copy', 'onCopy');
    bind('msg-menu-delete', 'onDelete');
    document.addEventListener('click', (e) => { if (!this.menu.contains(e.target)) this.hideMessageMenu(); });
    $('chat-scroll-container')?.addEventListener('scroll', () => this.hideMessageMenu(), { passive: true });
    window.addEventListener('resize', () => this.hideMessageMenu());
  }

  /** ctx: { canCopy, canDelete, mine: Set(emoji I already used) } */
  showMessageMenu(seq, anchor, ctx) {
    if (!this.menu) return;
    this.menuSeq = seq;
    $('msg-menu-copy')?.classList.toggle('hidden', !ctx.canCopy);
    $('msg-menu-delete')?.classList.toggle('hidden', !ctx.canDelete);
    $('msg-menu-reactions')?.querySelectorAll('button').forEach((b) => {
      const on = ctx.mine.has(b.dataset.emoji);
      b.dataset.on = on ? '1' : '0';
      b.classList.toggle('on', on);
    });

    this.menu.classList.remove('hidden');
    const rect = anchor.getBoundingClientRect();
    const w = this.menu.offsetWidth;
    const h = this.menu.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    let top = rect.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
    this.menu.style.left = `${left}px`;
    this.menu.style.top = `${top}px`;
  }

  hideMessageMenu() {
    this.menuSeq = null;
    this.menu?.classList.add('hidden');
  }

  // ------------------------------------------------------------------ reply

  setReply(info) {
    const bar = $('reply-bar');
    if (!bar) return;
    bar.classList.toggle('hidden', !info);
    if (!info) return;
    $('reply-bar-name').textContent = info.nickname;
    $('reply-bar-text').textContent = info.snippet;
    $('chat-input')?.focus();
  }

  // ------------------------------------------------------------- voice bar

  setRecording(on, seconds = 0) {
    $('recording-bar')?.classList.toggle('hidden', !on);
    $('chat-form')?.classList.toggle('hidden', on);
    const timer = $('rec-timer');
    if (timer) timer.textContent = formatDuration(seconds);
    $('btn-voice')?.classList.toggle('recording', on);
  }

  // ------------------------------------------------------------ rich text

  markDelivered(seq) {
    document.querySelectorAll('.receipt').forEach((node) => {
      if (Number(node.dataset.seq) <= seq && node.textContent !== '✓✓') {
        node.textContent = '✓✓';
        node.className = 'receipt done';
      }
    });
  }

  /** Safe URL for a link, or null. Only http(s) is ever linked. */
  safeLink(raw) {
    try {
      const url = new URL(raw);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  renderRichText(container, text) {
    const tokenRe = /(`[^`\n]+`)|(https?:\/\/[^\s<>"'`]+)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;
    let last = 0;
    let m;
    while ((m = tokenRe.exec(text)) !== null) {
      let token = m[0];
      let trailing = '';
      if (m[2]) {
        const trimmed = token.replace(/[.,;:!?)\]]+$/, '');
        trailing = token.slice(trimmed.length);
        token = trimmed;
      }
      if (m.index > last) container.append(text.slice(last, m.index));

      if (m[1]) {
        container.appendChild(el('code', 'inline-code', token.slice(1, -1)));
      } else if (m[2]) {
        const href = this.safeLink(token);
        if (href) {
          const a = el('a', 'msg-link', token);
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          container.appendChild(a);
        } else {
          container.append(token);
        }
        if (trailing) container.append(trailing);
      } else if (m[3]) {
        container.appendChild(el('strong', '', token.slice(2, -2)));
      } else {
        container.appendChild(el('em', '', token.slice(1, -1)));
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) container.append(text.slice(last));
  }

  renderSystemNotice(text, isWarning = false) {
    const notice = el('div', 'notice-row message-anim');
    notice.appendChild(el('div', `notice-pill${isWarning ? ' warn' : ''}`, text));
    this.messageList.appendChild(notice);
    this.scrollToBottom();
  }

  showLaunchpadNotice(text, isError = false) {
    const node = $('launchpad-notice');
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('hidden', !text);
    node.classList.toggle('error', Boolean(isError));
  }

  setTyping(nickname, isTyping) {
    clearTimeout(this.typingClear);
    if (isTyping) {
      this.typingIndicator.textContent = `${nickname} is typing`;
      this.typingIndicator.classList.remove('idle');
      this.typingClear = setTimeout(() => this.typingIndicator.classList.add('idle'), 5000);
    } else {
      this.typingIndicator.classList.add('idle');
    }
  }

  /** The host can always burn; anybody else only when they are alone. */
  updateBurnButtonVisibility(canBurn) {
    $('btn-burn-room')?.classList.toggle('hidden', !canBurn);
    $('btn-sidebar-burn')?.parentElement?.classList.toggle('hidden', !canBurn);
  }

  updateTelemetry({ latency, peerCount, roomId, fingerprint }) {
    if (latency !== undefined && this.pingDisplay) this.pingDisplay.textContent = `${latency}ms`;
    if (peerCount !== undefined) {
      if (this.roomSubtitle) this.roomSubtitle.textContent = `${peerCount} ${peerCount === 1 ? 'person' : 'people'} here`;
      if (this.sidebarPeerCount) this.sidebarPeerCount.textContent = `${peerCount} online`;
      if (this.navPeerCount) this.navPeerCount.textContent = String(peerCount);
    }
    if (roomId) {
      if (this.roomTitle) this.roomTitle.textContent = `room/${roomId}`;
      if (this.sidebarRoomName) this.sidebarRoomName.textContent = `room/${roomId}`;
    }
    if (fingerprint) {
      if (this.fingerprintPill) this.fingerprintPill.textContent = `${fingerprint.split('-').slice(0, 2).join('-')}…`;
      if (this.sidebarFingerprintBadge) this.sidebarFingerprintBadge.textContent = fingerprint;
    }
  }

  // ---------------------------------------------------------- people panel

  /**
   * ctx: { myId, hostId, isHost, verified: Set(clientId) }.  peers: [{ clientId, nickname }].
   * Callbacks come from this.handlers.onVerify(clientId) / onKick(clientId).
   */
  renderPeersList(myNickname, peersList, ctx = {}) {
    if (!this.sidebarPeersList) return;
    this.sidebarPeersList.replaceChildren();

    const makeCard = ({ clientId, nickname, isSelf }) => {
      const isHostCard = clientId && clientId === ctx.hostId;
      const card = el('div', isSelf ? 'peer-card me' : 'peer-card');
      const top = el('div', 'peer-top');
      const avatar = el('div', `avatar ${this.getAvatarGradient(nickname, isSelf)}`);
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = this.initials(nickname);

      const body = el('div', 'peer-body');
      const nameRow = el('div', 'peer-name-row');
      nameRow.appendChild(el('span', 'peer-name', isSelf ? `${nickname} (you)` : nickname));
      if (isHostCard) nameRow.appendChild(el('span', 'host-badge', 'Host'));
      const verified = !isSelf && ctx.verified?.has(clientId);
      const label = isSelf ? 'Active session' : verified ? 'Verified by you' : 'Invite verified';
      body.append(nameRow, el('span', verified ? 'peer-label ok' : 'peer-label', label));

      top.append(avatar, body, el('span', 'peer-dot'));
      card.appendChild(top);

      if (!isSelf) {
        const actions = el('div', 'peer-actions');
        const verify = el('button', 'peer-action', 'Verify');
        verify.type = 'button';
        verify.addEventListener('click', () => this.handlers.onVerify?.(clientId));
        actions.appendChild(verify);
        if (ctx.isHost) {
          const kick = el('button', 'peer-action danger', 'Remove');
          kick.type = 'button';
          kick.addEventListener('click', () => this.handlers.onKick?.(clientId));
          actions.appendChild(kick);
        }
        card.appendChild(actions);
      }
      return card;
    };

    this.sidebarPeersList.appendChild(makeCard({ clientId: ctx.myId, nickname: myNickname || 'Anonymous', isSelf: true }));
    for (const peer of peersList || []) {
      this.sidebarPeersList.appendChild(makeCard({ clientId: peer.clientId, nickname: peer.nickname || 'Anonymous', isSelf: false }));
    }
  }

  /** Join requests waiting for the host. */
  renderRequests(requests) {
    const panel = $('requests-panel');
    const list = $('requests-list');
    if (!panel || !list) return;
    list.replaceChildren();
    panel.classList.toggle('hidden', requests.length === 0);
    for (const req of requests) {
      const card = el('div', 'req-card');
      card.appendChild(el('div', 'req-title', `${req.nickname} wants to join`));
      const actions = el('div', 'peer-actions');
      const ok = el('button', 'peer-action ok', 'Let in');
      ok.type = 'button';
      ok.addEventListener('click', () => this.handlers.onApprove?.(req.clientId));
      const no = el('button', 'peer-action danger', 'Decline');
      no.type = 'button';
      no.addEventListener('click', () => this.handlers.onDeny?.(req.clientId));
      actions.append(ok, no);
      card.appendChild(actions);
      list.appendChild(card);
    }
  }

  /** Mirrors the room settings into the side panel. Host gets controls, everyone else a read-only summary. */
  renderRoomState(state, isHost) {
    $('settings-host-controls')?.classList.toggle('hidden', !isHost);
    $('settings-readonly')?.classList.toggle('hidden', isHost);
    if (!state) return;
    const lock = $('opt-lock'); if (lock) lock.checked = Boolean(state.locked);
    const approval = $('opt-approval'); if (approval) approval.checked = Boolean(state.approval);
    const dis = $('opt-disappear'); if (dis) dis.value = String(state.disappearSec || 0);
    const summary = $('settings-readonly');
    if (summary) {
      const parts = [
        state.locked ? 'Locked: no new people can join' : 'Open to anyone with the link',
        state.approval ? 'The host approves new people' : null,
        state.disappearSec ? `Messages disappear after ${DISAPPEAR_LABELS[state.disappearSec] || state.disappearSec + 's'}` : 'Messages stay until the room ends',
      ].filter(Boolean);
      summary.replaceChildren(...parts.map((p) => el('div', '', p)));
    }
    const maxed = state.expiryMinutes >= 1440;
    $('btn-extend-15')?.toggleAttribute('disabled', maxed);
    $('btn-extend-60')?.toggleAttribute('disabled', maxed);
  }

  showVerifyModal({ nickname, code, verified }) {
    $('verify-name').textContent = nickname;
    $('verify-code').textContent = code;
    $('btn-verify-mark').textContent = verified ? 'Remove verified mark' : 'They match: mark as verified';
    $('verify-modal')?.classList.remove('hidden');
  }

  hideVerifyModal() {
    $('verify-modal')?.classList.add('hidden');
  }

  // --------------------------------------------------------------- countdown

  startCountdown(createdAt, expiryMinutes, onExpire) {
    this.stopCountdown();
    if (!createdAt || !expiryMinutes) return;

    const totalDurationMs = expiryMinutes * 60000;
    const expiryTime = createdAt + totalDurationMs;

    const tick = () => {
      const remainingMs = expiryTime - Date.now();
      if (remainingMs <= 0) {
        if (this.countdownTimer) this.countdownTimer.textContent = '00:00';
        if (this.sidebarCountdown) this.sidebarCountdown.textContent = '00:00';
        if (this.countdownProgress) this.countdownProgress.style.width = '0%';
        this.stopCountdown();
        onExpire?.();
        return;
      }
      const totalSec = Math.floor(remainingMs / 1000);
      const hours = Math.floor(totalSec / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      const secs = totalSec % 60;
      const pad = (n) => String(n).padStart(2, '0');
      const formatted = hours ? `${hours}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;

      if (this.countdownTimer) {
        this.countdownTimer.textContent = formatted;
        this.countdownTimer.classList.toggle('urgent', totalSec < 120);
      }
      if (this.sidebarCountdown) {
        this.sidebarCountdown.textContent = formatted;
        this.sidebarCountdown.classList.toggle('urgent', totalSec < 120);
      }
      if (this.countdownProgress) {
        this.countdownProgress.style.width = `${Math.max(0, Math.min(100, (remainingMs / totalDurationMs) * 100))}%`;
      }
    };

    tick();
    this.timerInterval = setInterval(tick, 1000);
  }

  stopCountdown() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  showQRCode(url) {
    const modal = $('qr-modal');
    const qrContainer = $('qrcode-canvas-container');
    if (!modal || !qrContainer) return;

    qrContainer.replaceChildren();
    if (typeof window.qrcode === 'function') {
      const qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      const cell = Math.max(2, Math.floor(180 / qr.getModuleCount()));
      const size = cell * qr.getModuleCount();
      const img = document.createElement('img');
      img.src = qr.createDataURL(cell, 0);
      img.alt = 'Invite QR code';
      img.width = size;
      img.height = size;
      img.style.imageRendering = 'pixelated';
      img.style.display = 'block';
      qrContainer.appendChild(img);
    }
    modal.classList.remove('hidden');
  }

  clearMessages() {
    this.messageList?.replaceChildren();
    this.rows.clear();
  }

  scrollToBottom() {
    const container = $('chat-scroll-container');
    if (container) container.scrollTop = container.scrollHeight;
  }
}
