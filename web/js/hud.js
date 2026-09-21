/**
 * The 2D chrome: setup, status, move list, dialogs, errors.
 *
 * Deliberately plain DOM in one file. The board is WebGL and the framework
 * would never touch a frame of it, so the only thing a framework could manage
 * here is these few controls — not worth a build step. If this grows into
 * something that genuinely wants one, it is this file that gets replaced, and
 * nothing in the 3D has to know.
 */

const SYMBOLS = {
  w: { p: '♙', r: '♖', n: '♘', b: '♗', q: '♕', k: '♔' },
  b: { p: '♟', r: '♜', n: '♞', b: '♝', q: '♛', k: '♚' },
};

const STORE_KEY = 'chess3d.settings.v1';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      loader: $('loader'),
      setup: $('setup'),
      topbar: $('topbar'),
      controls: $('controls'),
      panel: $('panel'),
      promotion: $('promotion'),
      gameover: $('gameover'),
      gameoverText: $('gameover-text'),
      toast: $('toast'),
      hintBar: $('hint-bar'),

      opponent: $('opponent'),
      opponentHint: $('opponent-hint'),
      httpConfig: $('http-config'),
      httpUrl: $('http-url'),
      httpModel: $('http-model'),
      httpKey: $('http-key'),
      relayConfig: $('relay-config'),
      relayAddress: $('relay-address'),
      relayState: $('relay-state'),
      copyRelay: $('copy-relay'),
      difficulty: $('difficulty'),
      side: $('side'),
      theme: $('theme'),
      themeLive: $('theme-live'),
      start: $('start'),
      testConnection: $('test-connection'),
      setupStatus: $('setup-status'),

      statusText: $('status-text'),
      turnDot: $('turn-dot'),
      thinking: $('thinking'),
      thinkingText: $('thinking-text'),
      cancelThink: $('cancel-think'),
      moves: $('moves'),
      captured: $('captured'),
      panelToggle: $('panel-toggle'),
      panelTitle: $('panel-title'),
      menu: $('menu'),

      btnFlip: $('btn-flip'),
      btnSpin: $('btn-spin'),
      btnResetView: $('btn-reset-view'),
      btnUndo: $('btn-undo'),
      btnNew: $('btn-new'),
      aiStatus: $('ai-status'),
      aiStatusText: $('ai-status-text'),
      gameoverNew: $('gameover-new'),
      gameoverReview: $('gameover-review'),
    };

    this._promotionResolve = null;
    this._toastTimer = null;
    // On a phone the open move list costs a third of the screen, which the
    // board needs more than the list does. The header stays, so it is one tap
    // away rather than hidden.
    this._panelOpen = !matchMedia('(max-width: 760px)').matches;

    this._wireStatic();
    this._applyPanelState();
  }

  _applyPanelState() {
    this.el.moves.hidden = !this._panelOpen;
    this.el.captured.hidden = !this._panelOpen;
    this.el.panelToggle.textContent = this._panelOpen ? 'Hide' : 'Show';
  }

  _wireStatic() {
    this.el.opponent.addEventListener('change', () => this.syncOpponentFields());

    this.el.panelToggle.addEventListener('click', () => {
      this._panelOpen = !this._panelOpen;
      this._applyPanelState();
    });

    this.el.copyRelay.addEventListener('click', async () => {
      const text = this.el.relayAddress.textContent;
      try {
        await navigator.clipboard.writeText(text);
        this.el.copyRelay.textContent = 'Copied';
      } catch {
        // Clipboard access can be refused; select it so it can be copied by hand.
        const range = document.createRange();
        range.selectNodeContents(this.el.relayAddress);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        this.el.copyRelay.textContent = 'Select all + copy';
      }
      setTimeout(() => { this.el.copyRelay.textContent = 'Copy'; }, 2200);
    });

    this.el.promotion.querySelectorAll('[data-piece]').forEach((button) => {
      button.addEventListener('click', () => {
        const choice = button.dataset.piece;
        this.el.promotion.hidden = true;
        if (this._promotionResolve) {
          const done = this._promotionResolve;
          this._promotionResolve = null;
          done(choice);
        }
      });
    });
  }

  /* ---------------------------------------------------------- the screens */

  hideLoader() {
    this.el.loader.classList.add('gone');
    setTimeout(() => { this.el.loader.hidden = true; }, 520);
  }

  showSetup(show) {
    this.el.setup.hidden = !show;
    const inGame = !show;
    this.el.topbar.hidden = !inGame;
    this.el.controls.hidden = !inGame;
    this.el.panel.hidden = !inGame;
  }

  fillThemes(themes, selectedId) {
    for (const select of [this.el.theme, this.el.themeLive]) {
      select.innerHTML = '';
      for (const theme of themes) {
        const option = document.createElement('option');
        option.value = theme.id;
        option.textContent = theme.name;
        if (theme.id === selectedId) option.selected = true;
        select.appendChild(option);
      }
    }
  }

  syncOpponentFields() {
    const kind = this.el.opponent.value;
    this.el.httpConfig.hidden = kind !== 'http';
    this.el.relayConfig.hidden = kind !== 'relay';
    this.el.testConnection.hidden = kind === 'relay';

    const hints = {
      memory: 'Not an AI. It plays a memorised opening book, then falls back to taking '
        + 'whatever is worth most. No search, no thinking, no setup.',
      http: 'An AI reached over HTTP. Your own machine or anywhere you can reach it.',
      relay: 'The app waits on a port; your AI connects to it and plays. One '
        + 'session for the whole game, so it remembers what it is doing.',
    };
    this.el.opponentHint.textContent = hints[kind] || '';
    this.setSetupStatus('');
  }

  setSetupStatus(text, kind) {
    const el = this.el.setupStatus;
    el.textContent = text || '';
    el.className = 'status-line' + (kind ? ` ${kind}` : '');
  }

  /* ------------------------------------------------------------ settings */

  readSettings() {
    return {
      opponent: this.el.opponent.value,
      difficulty: this.el.difficulty.value,
      side: this.el.side.value,
      theme: this.el.theme.value,
      http: {
        url: this.el.httpUrl.value.trim(),
        model: this.el.httpModel.value.trim(),
        apiKey: this.el.httpKey.value,
      },
    };
  }

  writeSettings(settings) {
    if (!settings) return;
    if (settings.opponent) {
      // A setting saved under an opponent that no longer exists would leave the
      // dropdown on no value at all, so fall back to the first one.
      this.el.opponent.value = settings.opponent;
      if (!this.el.opponent.value) this.el.opponent.selectedIndex = 0;
    }
    if (settings.difficulty) this.el.difficulty.value = settings.difficulty;
    if (settings.side) this.el.side.value = settings.side;
    if (settings.http) {
      if (settings.http.url) this.el.httpUrl.value = settings.http.url;
      if (settings.http.model) this.el.httpModel.value = settings.http.model;
      if (settings.http.apiKey) this.el.httpKey.value = settings.http.apiKey;
    }
    this.syncOpponentFields();
  }

  /** Browser storage can be unavailable or throw; a lost preference is not an error. */
  saveSettings(settings) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch { /* private window, blocked storage — carry on */ }
  }

  loadSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /* -------------------------------------------------------------- status */

  setStatus(status, opponentName) {
    this.el.statusText.textContent = status.text;
    this.el.turnDot.className = 'dot' + (status.turn === 'b' ? ' black' : '') + (status.inCheck ? ' check' : '');
    if (opponentName) this.el.thinkingText.textContent = `${opponentName} is thinking`;
  }

  setThinking(on) {
    this.el.thinking.hidden = !on;
  }

  /**
   * The AI's connection, shown while the game is running.
   *
   * `state` is one of 'live', 'busy', 'down' or 'idle'; anything else hides the
   * indicator, which is what memory gets — there is no connection to report.
   */
  setAiStatus(state, text) {
    const el = this.el.aiStatus;
    if (!state) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.className = `ai-status ${state === 'idle' ? '' : state}`.trim();
    el.title = text;
    this.el.aiStatusText.textContent = text;
  }

  /** The one thing the player hands over. The contract lives behind it. */
  setRelayAddress(url) {
    this.el.relayAddress.textContent = url;
  }

  /** Report whether anything has connected to the relay. */
  setRelayState(status) {
    const el = this.el.relayState;
    if (!status) {
      el.textContent = 'Could not reach the gateway.';
      el.className = 'relay-state';
      return;
    }
    if (status.connected) {
      const who = status.agent ? ` (${status.agent.split('/')[0]})` : '';
      el.textContent = status.waiting_for_move
        ? `Connected${who} — it is your AI's move`
        : `Connected${who} — ready`;
      el.className = 'relay-state live';
    } else {
      el.textContent = 'Nothing connected yet. Start the game, then give your AI the address.';
      el.className = 'relay-state';
    }
  }

  /** Name the opening while memory is still following a line it knows. */
  setOpening(name) {
    this.el.panelTitle.textContent = name ? `Moves · ${name}` : 'Moves';
  }

  /* ---------------------------------------------------------- move lists */

  renderMoves(history) {
    const list = this.el.moves;
    list.innerHTML = '';
    for (let i = 0; i < history.length; i += 2) {
      const num = document.createElement('li');
      num.className = 'num';
      num.textContent = `${i / 2 + 1}.`;
      list.appendChild(num);

      for (let j = 0; j < 2; j++) {
        const move = history[i + j];
        const cell = document.createElement('li');
        cell.className = 'ply' + (i + j === history.length - 1 ? ' latest' : '');
        cell.textContent = move ? move.san : '';
        list.appendChild(cell);
      }
    }
    list.scrollTop = list.scrollHeight;
  }

  renderCaptured(history) {
    const taken = { w: [], b: [] };
    for (const move of history) {
      if (!move.captured) continue;
      // `move.color` is who moved, so the captured piece is the other colour.
      const victim = move.color === 'w' ? 'b' : 'w';
      taken[victim].push(SYMBOLS[victim][move.captured]);
    }
    this.el.captured.innerHTML = '';
    for (const colour of ['w', 'b']) {
      if (!taken[colour].length) continue;
      const row = document.createElement('div');
      row.className = colour === 'w' ? 'row-w' : 'row-b';
      row.textContent = taken[colour].join(' ');
      this.el.captured.appendChild(row);
    }
  }

  /* ------------------------------------------------------------- dialogs */

  askPromotion() {
    this.el.promotion.hidden = false;
    return new Promise((resolve) => { this._promotionResolve = resolve; });
  }

  showGameOver(text) {
    this.el.gameoverText.textContent = text;
    this.el.gameover.hidden = false;
  }

  hideGameOver() {
    this.el.gameover.hidden = true;
  }

  /* --------------------------------------------------------------- toast */

  toast(message, { detail = null, bad = false, ms = 7000 } = {}) {
    const el = this.el.toast;
    el.innerHTML = '';
    el.className = bad ? 'bad' : '';
    el.append(document.createTextNode(message));
    if (detail) {
      const pre = document.createElement('span');
      pre.className = 'detail';
      pre.textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1);
      el.appendChild(pre);
    }
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  hideToast() {
    clearTimeout(this._toastTimer);
    this.el.toast.hidden = true;
  }

  /** The control hint, shown once at the start of the first game. */
  showHint(touch) {
    const bar = this.el.hintBar;
    bar.textContent = touch
      ? 'Tap a piece, then its square · two fingers to turn, pinch to zoom'
      : 'Ctrl-drag to turn the board · scroll to zoom';
    bar.hidden = false;
    bar.classList.remove('fade');
    setTimeout(() => bar.classList.add('fade'), 5200);
    setTimeout(() => { bar.hidden = true; }, 6200);
  }
}
