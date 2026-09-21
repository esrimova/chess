/**
 * Wiring.
 *
 * This is the only file that knows about both halves of the application. The
 * rules layer speaks square names; the renderer speaks meshes and positions;
 * they meet here and nowhere else. Keeping that true is what lets a theme or
 * an opponent be swapped without anything else noticing.
 *
 * The turn loop is the core of it, and it is short on purpose: ask whoever is
 * to move, validate the answer, show it, repeat.
 */

import * as THREE from './vendor/three.module.js';
import { Stage } from './scene.js';
import { Board } from './board.js';
import { CameraRig } from './camera.js';
import { Animator } from './animate.js';
import { Picker } from './picker.js';
import { Game } from './game.js';
import { Hud } from './hud.js';
import { makePiece, PIECE_HEIGHTS } from './pieces.js';
import { loadThemes, themeList, findTheme, defaultThemeId, createMaterials, applyTheme } from './themes.js';
import { HumanEngine, RemoteEngine, EngineError, probeOpponents } from './engines.js';
import { squareToWorld } from './coords.js';

class App {
  constructor() {
    this.hud = new Hud();
    this.game = new Game();
    this.animator = new Animator();

    this.pieceMeshes = [];           // live array the picker raycasts
    this.meshBySquare = new Map();   // square -> mesh
    this.engines = { w: null, b: null };
    this.settings = null;
    this.selected = null;
    this.legalForSelected = [];
    this.lastMove = null;
    this.abort = null;
    this.playing = false;
    this.busy = false;
  }

  /* ----------------------------------------------------------------- boot */

  async boot() {
    const catalogue = await loadThemes();
    this.themeId = defaultThemeId();

    const stored = this.hud.loadSettings();
    if (stored && stored.theme) this.themeId = stored.theme;
    const theme = findTheme(this.themeId);

    this.materials = createMaterials(theme);
    this.stage = new Stage(document.getElementById('view'));
    this.stage.applyTheme(theme);

    this.board = new Board(this.materials);
    this.board.retintLabels(theme);
    this.stage.add(this.board.group);

    this.rig = new CameraRig(this.stage.camera, this.stage.canvas);

    this.picker = new Picker({
      dom: this.stage.canvas,
      camera: this.stage.camera,
      board: this.board,
      pieceMeshes: this.pieceMeshes,
      cameraRig: this.rig,
    });
    this.picker.onPick = (square) => this.onPick(square);
    this.picker.onHover = (square) => this.onHover(square);
    this.picker.enabled = false;

    this.stage.onFrame((dt) => {
      this.rig.update(dt);
      this.animator.update(dt);
    });
    this.stage.start();

    this.setupPosition();
    this.frameBoard();

    this.hud.fillThemes(themeList(), this.themeId);
    this.hud.writeSettings(stored);
    if (this.hud.el.opponent.value === 'relay') this.onOpponentChanged();
    this.hud.el.theme.value = this.themeId;
    this.hud.el.themeLive.value = this.themeId;
    this.hud.syncOpponentFields();
    this._wire();

    // Let one frame render behind the loader so the board is already there
    // when it lifts, rather than appearing after it.
    //
    // Never wait on that frame indefinitely: a browser does not run animation
    // frames in a background tab, so a page opened in one — middle-clicked,
    // restored with a session, opened from a link — would sit on the loading
    // screen for as long as it stayed unfocused. Take the frame if it comes,
    // carry on without it if it does not.
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(done));
      setTimeout(done, 400);
    });
    this.hud.hideLoader();
    this.hud.showSetup(true);

    // Reframe on resize and on rotation: the horizontal field of view depends
    // on the shape of the window, so the right distance changes with it.
    let reframe;
    window.addEventListener('resize', () => {
      clearTimeout(reframe);
      reframe = setTimeout(() => this.frameBoard(), 120);
    });

    // A handle for the test harness and the console; not used by the app.
    window.chess3d = this;
  }

  /**
   * Frame the board in the space the interface actually leaves for it.
   *
   * The canvas fills the window but the chrome sits on top of it: a bar across
   * the top, and on a narrow screen a move panel and a row of controls across
   * the bottom. Framing against the whole canvas centres the board behind that
   * furniture, which on a phone left an empty band above the board and pushed
   * the board down against the panel. Measure what is free, centre there, and
   * fit to that height rather than the full one.
   */
  frameBoard() {
    const canvas = this.stage.canvas;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    const aspect = width / height;

    const free = this.freeBand(height);
    const centre = (free.top + free.bottom) / 2;
    const bandHeight = Math.max(120, free.bottom - free.top);

    // Solve the distance against an unshifted camera. The shift is a pure
    // translation, so a board that fits a band of this height about the canvas
    // centre still fits it about the band's centre — but measuring while the
    // shift is applied counts the offset as overflow and pulls the camera much
    // too far back.
    this.stage.setViewShift(0);
    this.rig.frame(this.board.framingPoints(PIECE_HEIGHTS.k + 0.3), {
      marginX: 0.9,
      marginY: 0.9 * (bandHeight / height),
      aspect,
    });
    this.stage.setViewShift(Math.round(height / 2 - centre));
  }

  /** The vertical band of canvas no piece of chrome is covering. */
  freeBand(height) {
    const visible = (el) => el && !el.hidden && el.getBoundingClientRect().height > 0;
    let top = 0;
    let bottom = height;

    const topbar = this.hud.el.topbar;
    if (visible(topbar)) top = Math.max(top, topbar.getBoundingClientRect().bottom);

    // Only the chrome that sits over the board counts. On a wide window the
    // panel and controls are in the corners with the board between them, so
    // they are only an obstruction once they span most of the width.
    for (const el of [this.hud.el.panel, this.hud.el.controls]) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < this.stage.canvas.clientWidth * 0.7) continue;
      bottom = Math.min(bottom, rect.top);
    }
    return { top, bottom };
  }

  _wire() {
    const hud = this.hud;

    hud.el.start.addEventListener('click', () => this.startGame());
    hud.el.menu.addEventListener('click', () => this.openSetup());
    hud.el.testConnection.addEventListener('click', () => this.testConnection());
    hud.el.opponent.addEventListener('change', () => this.onOpponentChanged());

    hud.el.theme.addEventListener('change', () => this.setTheme(hud.el.theme.value));
    hud.el.themeLive.addEventListener('change', () => this.setTheme(hud.el.themeLive.value));

    hud.el.btnFlip.addEventListener('click', () => this.rig.flip());
    hud.el.btnSpin.addEventListener('click', () => this.rig.spin());
    hud.el.btnResetView.addEventListener('click', () => this.rig.reset());
    hud.el.btnUndo.addEventListener('click', () => this.undo());
    hud.el.btnNew.addEventListener('click', () => this.confirmNewGame());

    hud.el.cancelThink.addEventListener('click', () => {
      if (this.abort) this.abort.abort();
    });

    hud.el.gameoverNew.addEventListener('click', () => {
      hud.hideGameOver();
      this.openSetup();
    });
    hud.el.gameoverReview.addEventListener('click', () => hud.hideGameOver());

    // Collapsing the move list frees a third of a phone screen, so reframe.
    hud.el.panelToggle.addEventListener('click', () => {
      requestAnimationFrame(() => this.frameBoard());
    });
  }

  /* ---------------------------------------------------------- the position */

  /** Rebuild every mesh from the current position. */
  setupPosition() {
    for (const mesh of this.pieceMeshes) this.stage.scene.remove(mesh);
    this.pieceMeshes.length = 0;
    this.meshBySquare.clear();

    for (const piece of this.game.pieces()) {
      this.addPieceMesh(piece.type, piece.color, piece.square);
    }
    this.board.clearHighlights();
    this.markCheck();
  }

  addPieceMesh(type, color, square) {
    const mesh = makePiece(type, color, this.materials.pieces);
    const p = squareToWorld(square);
    mesh.position.set(p.x, 0, p.z);
    mesh.userData.square = square;
    this.stage.scene.add(mesh);
    this.pieceMeshes.push(mesh);
    this.meshBySquare.set(square, mesh);
    return mesh;
  }

  removePieceMesh(mesh) {
    const index = this.pieceMeshes.indexOf(mesh);
    if (index >= 0) this.pieceMeshes.splice(index, 1);
    this.stage.scene.remove(mesh);
  }

  /* -------------------------------------------------------------- setup UI */

  openSetup() {
    if (this.abort) this.abort.abort();
    // Release anything blocked on the relay, or it holds the old position.
    fetch('./relay/cancel', { method: 'POST' }).catch(() => {});
    this.playing = false;
    this.picker.enabled = false;
    this.stopWatchingAi();
    this.hud.setAiStatus(null);
    this.idle();
    this.clearSelection();
    this.hud.hideToast();
    this.hud.showSetup(true);
  }

  buildEngines(settings) {
    const human = new HumanEngine();
    this.human = human;

    // 'builtin' is the name memory shipped under first; a saved setting from
    // then still selects it.
    const kinds = { memory: 'memory', builtin: 'memory', http: 'http', relay: 'relay' };
    const names = { memory: 'Memory', http: 'The AI endpoint', relay: 'The connected AI' };
    const kind = kinds[settings.opponent] || 'memory';

    const opponent = new RemoteEngine({
      kind,
      name: names[kind],
      difficulty: settings.difficulty,
      config: kind === 'http' ? settings.http : {},
    });

    return settings.side === 'b' ? { b: human, w: opponent } : { w: human, b: opponent };
  }

  /** Load the relay instructions and start watching for a connection. */
  onOpponentChanged() {
    const kind = this.hud.el.opponent.value;
    if (kind !== 'relay') {
      this.stopWatchingRelay();
      return;
    }
    // Only the address. Whatever connects to it reads the contract from there,
    // which is the point — the player hands over a door, not a manual.
    this.hud.setRelayAddress(new URL('relay', window.location.href).href);
    this.watchRelay();
  }

  /**
   * Report the AI's connection while the game runs.
   *
   * Only the relay has a connection to watch, and watching it is one cheap
   * local request. An endpoint is not polled — calling someone's model every
   * few seconds to ask if it is awake is rude, and its real state is whatever
   * the last move attempt did, which is reported from there instead.
   */
  watchAi(settings) {
    this.stopWatchingAi();
    if (settings.opponent === 'relay') {
      const tick = async () => {
        try {
          const status = await fetch('./relay/status', { cache: 'no-store' }).then((r) => r.json());
          if (status.waiting_for_move && status.connected) {
            this.hud.setAiStatus('busy', 'AI is on the move');
          } else if (status.connected) {
            const who = status.agent ? status.agent.split('/')[0] : 'AI';
            this.hud.setAiStatus('live', `${who} connected`);
          } else if (status.waiting_for_move) {
            this.hud.setAiStatus('down', 'Waiting for an AI to connect');
          } else {
            this.hud.setAiStatus('idle', 'No AI connected');
          }
        } catch {
          this.hud.setAiStatus('down', 'Gateway unreachable');
        }
      };
      this._aiTick = tick;
      tick();
      this._aiWatch = setInterval(tick, 3000);
      return;
    }
    if (settings.opponent === 'http') {
      this.hud.setAiStatus('idle', 'Endpoint — not contacted yet');
      return;
    }
    this.hud.setAiStatus(null);
  }

  stopWatchingAi() {
    if (this._aiWatch) clearInterval(this._aiWatch);
    this._aiWatch = null;
    this._aiTick = null;
  }

  /** Refresh the indicator now, rather than on the next poll. */
  refreshAiStatus() {
    if (this._aiTick) this._aiTick();
  }

  watchRelay() {
    this.stopWatchingRelay();
    const tick = async () => {
      try {
        const status = await fetch('./relay/status', { cache: 'no-store' }).then((r) => r.json());
        this.hud.setRelayState(status);
      } catch {
        this.hud.setRelayState(null);
      }
    };
    tick();
    this._relayWatch = setInterval(tick, 2500);
  }

  stopWatchingRelay() {
    if (this._relayWatch) clearInterval(this._relayWatch);
    this._relayWatch = null;
  }

  async testConnection() {
    const settings = this.hud.readSettings();
    this.hud.setSetupStatus('Checking…');
    const health = await probeOpponents({ http: settings.http, cli: settings.cli });
    if (!health) {
      this.hud.setSetupStatus('The gateway did not answer. Is server.py running?', 'bad');
      return;
    }
    if (settings.opponent === 'memory') {
      const positions = health.memory ? health.memory.positions : 0;
      this.hud.setSetupStatus(`Memory holds ${positions} book positions`, 'ok');
      return;
    }
    if (settings.opponent === 'http') {
      if (health.http.ok) {
        const model = health.http.model ? ` — ${health.http.model}` : '';
        this.hud.setSetupStatus(`Endpoint reachable${model}`, 'ok');
      } else {
        this.hud.setSetupStatus(`No answer from ${health.http.url}: ${health.http.error || 'unreachable'}`, 'bad');
      }
      return;
    }
    if (settings.opponent === 'cli') {
      if (health.cli.ok) this.hud.setSetupStatus('Command found', 'ok');
      else this.hud.setSetupStatus(health.cli.error || 'Command not found', 'bad');
    }
  }

  /* ---------------------------------------------------------- game control */

  /**
   * Drop anything left over from a move in flight.
   *
   * `busy` locks the board while a piece is travelling, so it must be cleared
   * whenever that travel is abandoned rather than finished — starting a new
   * game mid-animation, taking a move back, or walking out to the setup
   * screen. Left set, it silently ignores every click for the rest of the
   * session, and the board looks broken for no visible reason.
   */
  idle() {
    this.busy = false;
    this.animator.clear();
  }

  startGame() {
    const settings = this.hud.readSettings();
    this.settings = settings;
    this.hud.saveSettings(settings);

    // Release anything the previous game left blocked on the relay.
    fetch('./relay/cancel', { method: 'POST' }).catch(() => {});
    this.game.reset();
    this.idle();
    this.lastMove = null;
    this.setupPosition();
    this.hud.renderMoves([]);
    this.hud.renderCaptured([]);
    this.hud.setOpening(null);

    this.engines = this.buildEngines(settings);
    this.humanColor = settings.side;

    this.rig.setSide(settings.side === 'b' ? 'b' : 'w', true);
    this.hud.showSetup(false);
    this.hud.hideGameOver();
    this.playing = true;
    // The setup screen's watcher hands over to the in-game one; leaving both
    // running would poll the gateway twice for the same answer.
    this.stopWatchingRelay();
    this.watchAi(settings);

    this.hud.showHint(matchMedia('(pointer: coarse)').matches);
    // The chrome that appears with the game changes what space is free.
    this.frameBoard();
    this.loop();
  }

  /**
   * New game, same opponent and settings.
   *
   * A game in progress is worth a second press — losing one to a stray click
   * on a small control would be its own bug. The button asks in place rather
   * than opening a dialog over the board.
   */
  confirmNewGame() {
    const button = this.hud.el.btnNew;
    if (!this.playing || this.game.history().length === 0 || button.dataset.armed) {
      delete button.dataset.armed;
      button.textContent = '✚';
      button.title = 'New game';
      this.startGame();
      return;
    }
    button.dataset.armed = '1';
    button.textContent = '?';
    button.title = 'Press again to start a new game';
    clearTimeout(this._armTimer);
    this._armTimer = setTimeout(() => {
      delete button.dataset.armed;
      button.textContent = '✚';
      button.title = 'New game';
    }, 3000);
  }

  async undo() {
    if (!this.playing) return;
    if (this.abort) this.abort.abort();

    // Step back to the player's own turn: one ply against another human,
    // two against an opponent that answers by itself.
    const plies = this.humanColor ? 2 : 1;
    let undone = 0;
    for (let i = 0; i < plies; i++) {
      if (this.game.undo()) undone++;
    }
    if (!undone) return;

    this.idle();
    this.clearSelection();
    this.lastMove = null;
    this.setupPosition();
    this.hud.renderMoves(this.game.history());
    this.hud.renderCaptured(this.game.history());
    this.hud.hideGameOver();
    this.loop();
  }

  /* ------------------------------------------------------------- turn loop */

  async loop() {
    while (this.playing) {
      const status = this.game.status();
      this.hud.setStatus(status);
      this.markCheck();

      if (status.over) {
        this.picker.enabled = false;
        this.hud.setThinking(false);
        this.hud.showGameOver(status.text);
        this.playing = false;
        return;
      }

      const engine = this.engines[status.turn];
      if (!engine) return;

      const legal = this.legalPayload();
      this.abort = new AbortController();

      let uci = null;
      if (engine.isHuman) {
        this.picker.enabled = true;
        this.hud.setThinking(false);
        try {
          uci = await engine.getMove(this.game.fen(), legal, this.abort.signal);
        } catch {
          return; // aborted: a new game, an undo, or the setup screen
        }
        this.picker.enabled = false;
      } else {
        this.picker.enabled = false;
        this.hud.setStatus(status, engine.name);
        this.hud.setThinking(true);
        // The moment the board starts waiting is when the indicator matters
        // most, so do not leave it to the next poll three seconds away.
        this.refreshAiStatus();
        try {
          uci = await engine.getMove(this.game.fen(), legal, this.abort.signal);
        } catch (error) {
          this.hud.setThinking(false);
          if (error && error.name === 'AbortError') return;
          this.reportEngineFailure(engine, error);
          return;
        }
        this.hud.setThinking(false);
      }

      const move = this.game.apply(uci);
      if (!move) {
        // The rules layer refused it, so nothing happened to the board. This
        // is the guarantee that a confused opponent cannot corrupt a game.
        this.reportEngineFailure(engine, new EngineError(
          `${engine.isHuman ? 'That move' : engine.name + "'s move"} was not legal.`,
          `proposed: ${uci}`
        ));
        if (engine.isHuman) continue;
        return;
      }

      this.busy = true;
      await this.animateMove(move);
      this.busy = false;

      this.lastMove = move;
      // An endpoint has no connection to watch, so its answer is its status.
      if (this.settings && this.settings.opponent === 'http' && !engine.isHuman) {
        this.hud.setAiStatus('live', `${engine.name} answered`);
      }
      // Memory reports the line it is following once the move identifies one.
      if (!engine.isHuman && engine.lastDetail && engine.lastDetail.opening) {
        this.hud.setOpening(engine.lastDetail.opening);
      } else if (!engine.isHuman && engine.lastDetail && engine.lastDetail.source
                 && engine.lastDetail.source !== 'book') {
        this.hud.setOpening(null);
      }
      this.hud.renderMoves(this.game.history());
      this.hud.renderCaptured(this.game.history());
      this.showLastMove();
    }
  }

  /** What an engine is given: enough for a model to read, and for the
   *  built-in opponent to have taste, without either needing chess rules. */
  legalPayload() {
    return this.game.legalMoves().map((m) => ({
      uci: m.from + m.to + (m.promotion || ''),
      san: m.san,
      captured: m.captured || null,
      promotion: m.promotion || null,
      check: /[+#]/.test(m.san),
    }));
  }

  reportEngineFailure(engine, error) {
    if (this.settings && this.settings.opponent === 'http') {
      this.hud.setAiStatus('down', 'Endpoint failed');
    }
    const detail = error instanceof EngineError ? error.detail : (error && error.message);
    this.hud.toast(
      error.message || 'The opponent failed.',
      { detail, bad: true, ms: 14000 }
    );
    this.hud.setStatus({
      ...this.game.status(),
      text: 'Stopped — the opponent could not move',
    });
  }

  /* ------------------------------------------------------------- animation */

  async animateMove(move) {
    const mesh = this.meshBySquare.get(move.from);
    if (!mesh) {
      // Should not happen; rebuild rather than leave the board lying.
      this.setupPosition();
      return;
    }

    // The captured piece leaves first, so the square is clear on arrival.
    const captureSquare = move.flags.includes('e')
      ? move.to[0] + move.from[1]   // en passant: the pawn is beside, not under
      : move.to;
    const victim = move.captured ? this.meshBySquare.get(captureSquare) : null;
    if (victim) {
      this.meshBySquare.delete(captureSquare);
      this.animator.capturePiece(victim).then(() => this.removePieceMesh(victim));
    }

    this.meshBySquare.delete(move.from);
    this.meshBySquare.set(move.to, mesh);
    mesh.userData.square = move.to;

    const from = squareToWorld(move.from);
    const to = squareToWorld(move.to);
    const isKnight = move.piece === 'n';
    const travel = this.animator.movePiece(mesh, from, to, {
      lift: isKnight ? 0.95 : 0.5,
      duration: isKnight ? 0.5 : 0.42,
    });

    // Castling moves the rook in the same breath.
    const rookMove = castlingRook(move);
    if (rookMove) {
      const rook = this.meshBySquare.get(rookMove.from);
      if (rook) {
        this.meshBySquare.delete(rookMove.from);
        this.meshBySquare.set(rookMove.to, rook);
        rook.userData.square = rookMove.to;
        this.animator.movePiece(
          rook,
          squareToWorld(rookMove.from),
          squareToWorld(rookMove.to),
          { lift: 0.3, duration: 0.46 }
        );
      }
    }

    await travel;

    if (move.promotion) {
      this.removePieceMesh(mesh);
      const promoted = this.addPieceMesh(move.promotion, move.color, move.to);
      await this.animator.appearPiece(promoted);
    }
  }

  /* ------------------------------------------------------------- selection */

  onPick(square) {
    if (!this.playing || this.busy) return;
    const engine = this.engines[this.game.turn()];
    if (!engine || !engine.isHuman || !engine.waiting) return;

    if (!square) { this.clearSelection(); return; }

    // Completing a move.
    if (this.selected) {
      const move = this.legalForSelected.find((m) => m.to === square);
      if (move) {
        this.completeMove(move);
        return;
      }
    }

    const piece = this.game.pieceAt(square);
    if (piece && piece.color === this.game.turn()) {
      this.select(square);
    } else {
      this.clearSelection();
    }
  }

  select(square) {
    this.clearSelection();
    this.selected = square;
    this.legalForSelected = this.game.legalFrom(square);

    this.board.highlight(square, 'select');
    for (const move of this.legalForSelected) {
      this.board.highlight(move.to, move.captured ? 'capture' : 'move');
    }
    this.showLastMove(false);
    this.markCheck();

    const mesh = this.meshBySquare.get(square);
    if (mesh) this.animator.hover(mesh, true);
  }

  clearSelection() {
    if (this.selected) {
      const mesh = this.meshBySquare.get(this.selected);
      if (mesh) this.animator.hover(mesh, false);
    }
    this.selected = null;
    this.legalForSelected = [];
    this.board.clearHighlights();
    this.showLastMove(false);
    this.markCheck();
  }

  async completeMove(move) {
    const from = this.selected;
    const mesh = this.meshBySquare.get(from);
    if (mesh) this.animator.hover(mesh, false);
    this.clearSelection();

    let promotion = '';
    if (move.promotion) {
      this.picker.enabled = false;
      promotion = await this.hud.askPromotion();
    }

    const engine = this.engines[this.game.turn()];
    if (engine && engine.isHuman) engine.supply(move.from + move.to + promotion);
  }

  onHover(square) {
    if (!this.playing || this.busy || this.selected) return;
    const engine = this.engines[this.game.turn()];
    if (!engine || !engine.isHuman || !engine.waiting) return;

    document.body.style.cursor = 'default';
    if (!square) return;
    const piece = this.game.pieceAt(square);
    if (piece && piece.color === this.game.turn()) {
      document.body.style.cursor = 'pointer';
    }
  }

  /* --------------------------------------------------------- board marking */

  showLastMove(clearFirst = true) {
    if (clearFirst) this.board.clearHighlights();
    if (!this.lastMove || this.selected) return;
    this.board.highlight(this.lastMove.from, 'last');
    this.board.highlight(this.lastMove.to, 'last');
  }

  markCheck() {
    const status = this.game.status();
    if (!status.inCheck) return;
    const square = this.game.kingSquare(status.turn);
    if (square) this.board.highlight(square, 'check');
  }

  /* ------------------------------------------------------------------ theme */

  setTheme(id) {
    const theme = findTheme(id);
    if (!theme) return;
    this.themeId = id;

    // Nothing is rebuilt: the materials the meshes already point at are
    // repointed, which is why the position survives a theme change.
    applyTheme(this.materials, theme);
    this.stage.applyTheme(theme);
    this.board.retintLabels(theme);

    this.hud.el.theme.value = id;
    this.hud.el.themeLive.value = id;

    if (this.settings) {
      this.settings.theme = id;
      this.hud.saveSettings(this.settings);
    } else {
      const stored = this.hud.loadSettings() || {};
      stored.theme = id;
      this.hud.saveSettings(stored);
    }

    // Highlights carry theme colours, so repaint whatever is showing.
    this.board.clearHighlights();
    if (this.selected) {
      this.board.highlight(this.selected, 'select');
      for (const move of this.legalForSelected) {
        this.board.highlight(move.to, move.captured ? 'capture' : 'move');
      }
    } else {
      this.showLastMove(false);
    }
    this.markCheck();
  }
}

/** Where the rook goes when the king castles. */
function castlingRook(move) {
  if (!move.flags.includes('k') && !move.flags.includes('q')) return null;
  const rank = move.color === 'w' ? '1' : '8';
  return move.flags.includes('k')
    ? { from: `h${rank}`, to: `f${rank}` }
    : { from: `a${rank}`, to: `d${rank}` };
}

const app = new App();
app.boot().catch((error) => {
  console.error(error);
  const loader = document.getElementById('loader');
  if (loader) {
    loader.innerHTML = `<div class="sheet narrow"><h2>Could not start</h2>
      <p class="hint">${String(error && error.message ? error.message : error)}</p></div>`;
  }
});
