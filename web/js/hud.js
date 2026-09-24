/**
 * The 2D chrome: setup, status, move list, dialogs, errors.
 *
 * Deliberately plain DOM in one file. The board is WebGL and the framework
 * would never touch a frame of it, so the only thing a framework could manage
 * here is these few controls — not worth a build step. If this grows into
 * something that genuinely wants one, it is this file that gets replaced, and
 * nothing in the 3D has to know.
 */

import { LEVELS, findLevel } from './search.js';

const SYMBOLS = {
  w: { p: '♙', r: '♖', n: '♘', b: '♗', q: '♕', k: '♔' },
  b: { p: '♟', r: '♜', n: '♞', b: '♝', q: '♛', k: '♚' },
};

const STORE_KEY = 'chess3d.settings.v1';
// Colours and the button-text switch live apart from the setup choices, so
// starting a game (which rewrites those) can never wipe them.
const LOOK_KEY = 'chess3d.look.v1';

const $ = (id) => document.getElementById(id);

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

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
      difficultyHint: $('difficulty-hint'),
      side: $('side'),
      theme: $('theme'),
      themeLive: $('theme-live'),
      set: $('set'),
      setLook: $('set-look'),
      setHint: $('set-hint'),
      btnLook: $('btn-look'),
      btnLookSetup: $('btn-look-setup'),
      look: $('look'),
      lookNote: $('look-note'),
      lookList: $('look-list'),
      lookRemember: $('look-remember'),
      lookLabels: $('look-labels'),
      lookReset: $('look-reset'),
      lookClose: $('look-close'),
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
      btnCameraHelp: $('btn-camera-help'),
      cameraHelp: $('camera-help'),
      cameraHelpKeys: $('camera-help-keys'),
      cameraHelpNote: $('camera-help-note'),
      cameraHelpClose: $('camera-help-close'),
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

    this.fillDifficulty();
    this._wireStatic();
    this._applyPanelState();
  }

  /** The levels come from the engine that defines them, so the two cannot drift apart. */
  fillDifficulty() {
    const select = this.el.difficulty;
    select.innerHTML = '';
    LEVELS.forEach((level, i) => {
      const option = document.createElement('option');
      option.value = level.id;
      option.textContent = `${i + 1} · ${level.name}`;
      select.appendChild(option);
    });
    select.value = 'club';
    this.syncDifficultyHint();
  }

  syncDifficultyHint() {
    const level = findLevel(this.el.difficulty.value);
    this.el.difficultyHint.textContent = this.el.opponent.value === 'memory'
      ? level.blurb
      : 'Sent to the AI as an instruction. How closely it plays to it is up to the model.';
  }

  _applyPanelState() {
    this.el.moves.hidden = !this._panelOpen;
    this.el.captured.hidden = !this._panelOpen;
    this.el.panelToggle.textContent = this._panelOpen ? 'Hide' : 'Show';
  }

  _wireStatic() {
    this.el.opponent.addEventListener('change', () => this.syncOpponentFields());
    this.el.difficulty.addEventListener('change', () => this.syncDifficultyHint());

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
    // The strip only has a height once it is showing.
    if (inGame) this.trackControlsHeight();
  }

  /* --------------------------------------------------------- colours panel */

  /** One picker per colour slot. `onChange(slot, hex)` fires as the player drags. */
  buildLookPanel(slots, onChange) {
    this._pickers = new Map();
    this.el.lookList.innerHTML = '';
    for (const slot of slots) {
      const row = document.createElement('label');
      row.className = 'look-row';
      const name = document.createElement('span');
      name.textContent = `${slot.label} `;
      const code = document.createElement('code');
      name.appendChild(code);
      const input = document.createElement('input');
      input.type = 'color';
      input.setAttribute('aria-label', slot.label);
      input.addEventListener('input', () => {
        code.textContent = input.value;
        onChange(slot.id, input.value);
      });
      row.append(name, input);
      this.el.lookList.appendChild(row);
      this._pickers.set(slot.id, { input, code, name });
    }
  }

  /** Show what the current texture, plus the player's changes, looks like. */
  syncLookPanel(colors, textureName, remembered) {
    for (const [id, { input, code }] of this._pickers) {
      const hex = (colors[id] || '#000000').toLowerCase();
      input.value = hex;
      code.textContent = hex;
    }
    this.el.lookNote.textContent =
      `${textureName} — colours sit on top of the texture; its gloss, glow and lighting stay.`;
    this.el.lookRemember.checked = !!remembered;
  }

  showLook(show) {
    this.el.look.hidden = !show;
  }

  /** Text beside the button glyphs, or the plain glyphs as before. */
  setButtonText(on) {
    this.el.controls.classList.toggle('labelled', !!on);
    this.el.lookLabels.checked = !!on;
    this.trackControlsHeight();
  }

  /**
   * The buttons take their colour from the texture. Text is chosen for
   * contrast, so a pale button never ends up with pale text.
   */
  applyButtonTheme(ui) {
    if (!ui) return;
    const root = document.documentElement.style;
    const [r, g, b] = hexToRgb(ui.button);
    const [ir, ig, ib] = hexToRgb(ui.ink);
    root.setProperty('--btn-bg', `rgba(${r}, ${g}, ${b}, 0.86)`);
    // Hover moves the button a little toward its own text colour.
    const mix = (a, c) => Math.round(a + (c - a) * 0.16);
    root.setProperty('--btn-hover', `rgba(${mix(r, ir)}, ${mix(g, ig)}, ${mix(b, ib)}, 0.94)`);
    root.setProperty('--btn-ink', ui.ink);
    root.setProperty('--btn-line', `rgba(${ir}, ${ig}, ${ib}, 0.18)`);
  }

  /**
   * Publish how tall the control strip is. On a phone it wraps, and the panel
   * and the hint sit above it, so they need the real height and not a guess.
   */
  trackControlsHeight() {
    const publish = () => {
      const h = this.el.controls.offsetHeight;
      if (h) document.documentElement.style.setProperty('--controls-h', `${h}px`);
    };
    if (!this._controlsObserver && typeof ResizeObserver !== 'undefined') {
      this._controlsObserver = new ResizeObserver(publish);
      this._controlsObserver.observe(this.el.controls);
    }
    publish();
  }

  saveLook(look) {
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify(look));
    } catch { /* storage unavailable: the colours last for this visit only */ }
  }

  loadLook() {
    try {
      const raw = JSON.parse(localStorage.getItem(LOOK_KEY));
      if (raw && typeof raw === 'object') {
        return {
          labels: raw.labels !== false,
          custom: raw.custom && typeof raw.custom === 'object' ? raw.custom : {},
        };
      }
    } catch { /* fall through */ }
    return { labels: true, custom: {} };
  }

  /** The piece sets, in both the setup screen and the Colours panel. */
  fillSets(sets, selectedId) {
    this._sets = sets;
    for (const select of [this.el.set, this.el.setLook]) {
      select.innerHTML = '';
      for (const set of sets) {
        const option = document.createElement('option');
        option.value = set.id;
        option.textContent = set.name;
        select.appendChild(option);
      }
      select.value = selectedId;
    }
    this.syncSetHint(selectedId);
  }

  syncSetHint(id) {
    const set = (this._sets || []).find((s) => s.id === id);
    this.el.setHint.textContent = set ? set.summary || '' : '';
    for (const select of [this.el.set, this.el.setLook]) select.value = id;
  }

  /** Name the two sides after who they are in the current set. */
  setSideNames(sides) {
    const labels = { white: sides.w, black: sides.b };
    for (const [slot, name] of Object.entries(labels)) {
      const picker = this._pickers && this._pickers.get(slot);
      if (picker) picker.name.firstChild.nodeValue = `${name} `;
    }
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
      memory: 'Not an AI. It plays a memorised opening book, then searches the position '
        + 'for the best move it can find. Runs entirely in this page — no setup.',
      http: 'An AI reached over HTTP. Your own machine or anywhere you can reach it.',
      relay: 'The app waits on a port; your AI connects to it and plays. One '
        + 'session for the whole game, so it remembers what it is doing.',
    };
    this.el.opponentHint.textContent = hints[kind] || '';
    this.syncDifficultyHint();
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
    if (settings.difficulty) {
      // Settings saved before there were six levels used easy, medium and
      // hard; findLevel maps them onto the nearest new one.
      this.el.difficulty.value = findLevel(settings.difficulty).id;
    }
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

  /**
   * The camera instructions.
   *
   * Written from whichever set of gestures this device actually has, rather
   * than listing both and asking the reader to work out which half applies.
   */
  showCameraHelp(touch) {
    const rows = touch
      ? [
          [['Two fingers'], 'Turn the board, a full circle and round again'],
          [['Three fingers'], 'Slide the board across the view'],
          [['Pinch'], 'Zoom in and out'],
          [['One finger'], 'Belongs to the pieces — tap one, then tap its square'],
        ]
      : [
          [['Ctrl', 'drag'], 'Turn the board, a full circle and round again'],
          [['Shift', 'drag'], 'Slide the board across the view'],
          [['Scroll'], 'Zoom in and out'],
          [['Click'], 'Belongs to the pieces — click one, then click its square'],
        ];

    const list = this.el.cameraHelpKeys;
    list.innerHTML = '';
    for (const [keys, meaning] of rows) {
      const dt = document.createElement('dt');
      keys.forEach((key, i) => {
        if (i > 0) {
          const plus = document.createElement('span');
          plus.className = 'plus';
          plus.textContent = '+';
          dt.appendChild(plus);
        }
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        dt.appendChild(kbd);
      });
      const dd = document.createElement('dd');
      dd.textContent = meaning;
      list.append(dt, dd);
    }

    this.el.cameraHelpNote.textContent =
      'The buttons flip the board to the other side, spin it, and put the view '
      + 'back where it started.';

    this.el.cameraHelp.hidden = false;
  }

  hideCameraHelp() {
    this.el.cameraHelp.hidden = true;
  }

  /** The control hint: what the gestures do. */
  showHint(touch) {
    const bar = this.el.hintBar;
    bar.textContent = touch
      ? 'Tap a piece, then its square · two fingers turn, three slide, pinch zooms'
      : 'Ctrl-drag turns the board · Shift-drag slides it · scroll to zoom';
    bar.hidden = false;
    bar.classList.remove('fade');
    setTimeout(() => bar.classList.add('fade'), 5200);
    setTimeout(() => { bar.hidden = true; }, 6200);
  }
}
