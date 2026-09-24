/**
 * The engine boundary.
 *
 * Everything that can take a turn implements one method. The human is an
 * engine. A language model behind an HTTP endpoint is an engine. A command
 * line program is an engine. The turn loop cannot tell them apart, which is
 * the entire point: adding an opponent later touches this file and nothing
 * else.
 *
 * An engine returns a string. It never touches the board. The rules layer
 * decides whether what it proposed actually happened.
 */

import { findLevel } from './search.js';

/**
 * @typedef {Object} Engine
 * @property {string} id
 * @property {string} name
 * @property {(fen: string, legal: string[], signal: AbortSignal, history?: string[]) => Promise<string>} getMove
 */

/** The player. Resolves when the board reports a completed move. */
export class HumanEngine {
  constructor(name = 'You') {
    this.id = 'human';
    this.name = name;
    this.isHuman = true;
    this._resolve = null;
    this._reject = null;
  }

  getMove(fen, legal, signal) {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      if (signal) {
        signal.addEventListener('abort', () => {
          this._resolve = null;
          this._reject = null;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }
    });
  }

  /** Called by the board when the player completes a move. */
  supply(uci) {
    if (!this._resolve) return false;
    const done = this._resolve;
    this._resolve = null;
    this._reject = null;
    done(uci);
    return true;
  }

  get waiting() {
    return this._resolve !== null;
  }
}

/* --------------------------------------------------------------- opening book */

let bookPromise = null;

/** The opening book, fetched once. A missing or broken book is not an error: the engine just searches. */
export function loadBook(url = './openings.json') {
  if (!bookPromise) {
    bookPromise = fetch(url, { cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data && data.positions) || {})
      .catch(() => ({}));
  }
  return bookPromise;
}

/** Placement, side to move, castling, en passant — no move counters, so transpositions are recognised. */
export function bookKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

/**
 * What the book knows from this position. It stores moves most-played first;
 * the main line is preferred but a sideline turns up now and then, so the
 * opening is not the identical game every time.
 */
export function bookMove(book, fen, legalUci) {
  const entry = book[bookKey(fen)];
  if (!entry) return null;
  const legal = new Set(legalUci);
  const known = (entry.moves || []).filter((m) => legal.has(m));
  if (known.length === 0) return null;
  let chosen = known[0];
  if (known.length > 1 && Math.random() < 0.25) {
    chosen = known[1 + Math.floor(Math.random() * (known.length - 1))];
  }
  // A name only when this move belongs to exactly one line.
  return { uci: chosen, opening: (entry.names || {})[chosen] || null };
}

/**
 * The built-in opponent. It lives entirely in the page: an opening book first,
 * then a real search in a worker. No gateway, no network, nothing to install —
 * which is why it is the default, and why it works with the server stopped.
 *
 * How hard it plays is the difficulty level (see LEVELS in search.js): how deep
 * it may look, how long it may think, how often it is shaken off the best move,
 * and how far into a game it still trusts its book.
 */
export class LocalEngine {
  constructor({ name = 'Memory', difficulty = 'club' } = {}) {
    this.id = 'memory';
    this.kind = 'memory';
    this.name = name;
    this.level = findLevel(difficulty);
    this.isHuman = false;
    this.lastDetail = null;
    this._worker = null;
    this._next = 1;
  }

  async getMove(fen, legal, signal, history = []) {
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    const legalUci = legal.map((m) => (typeof m === 'string' ? m : m.uci));

    if (history.length < this.level.bookPlies) {
      const book = await loadBook();
      if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
      const known = bookMove(book, fen, legalUci);
      if (known) {
        this.lastDetail = {
          source: 'book',
          opening: known.opening,
          note: known.opening ? `book: ${known.opening}` : 'book',
        };
        return known.uci;
      }
    }

    const reply = await this._search(fen, history, signal);
    if (!reply.uci) throw new EngineError('The opponent found no move to play.', null);
    this.lastDetail = {
      source: 'search',
      note: `${this.level.name}: depth ${reply.depth}, ${reply.nodes} positions`,
      depth: reply.depth,
      score: reply.score,
      nodes: reply.nodes,
      ms: reply.ms,
    };
    return reply.uci;
  }

  /** Run the search in a worker; if workers are unavailable, run it here. */
  _search(fen, history, signal) {
    const request = { fen, history, level: this.level.id };

    let worker = null;
    try {
      worker = this._worker || new Worker(new URL('./search.worker.js', import.meta.url), { type: 'module' });
    } catch {
      worker = null;
    }
    if (!worker) {
      return import('./search.js').then(({ chooseMove }) => {
        const r = chooseMove(fen, history, this.level.id);
        return r ? { ...r } : {};
      });
    }
    this._worker = worker;

    return new Promise((resolve, reject) => {
      const id = this._next++;
      const finish = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onMessage = (event) => {
        if (event.data.id !== id) return;
        finish();
        if (event.data.ok) resolve(event.data);
        else reject(new EngineError('The built-in opponent failed.', event.data.error));
      };
      const onError = (event) => {
        finish();
        this._drop();
        reject(new EngineError('The built-in opponent failed to start.', event.message || null));
      };
      const onAbort = () => {
        finish();
        // A search cannot be interrupted from outside, so end the worker; the
        // next move starts a fresh one.
        this._drop();
        reject(new DOMException('aborted', 'AbortError'));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({ id, ...request });
    });
  }

  _drop() {
    if (this._worker) this._worker.terminate();
    this._worker = null;
  }

  /** Release the worker when the game ends or the opponent changes. */
  dispose() {
    this._drop();
  }
}

/**
 * Anything the gateway can reach: the built-in random opponent, an
 * OpenAI-compatible endpoint, or a command line program. The page does not
 * know which — it sends a position and receives a move.
 */
export class RemoteEngine {
  constructor({ kind, name, config = {}, difficulty = 'medium', endpoint = '/move' }) {
    this.id = kind;
    this.kind = kind;
    this.name = name || kind;
    this.config = config;
    this.difficulty = difficulty;
    this.endpoint = endpoint;
    this.isHuman = false;
    this.lastDetail = null;
  }

  async getMove(fen, legal, signal) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      // A custom header cannot be set cross-origin without a preflight, and
      // the gateway answers none — so this marks the request as coming from
      // the game's own page, and nobody else's.
      headers: { 'Content-Type': 'application/json', 'X-Chess3D': '1' },
      body: JSON.stringify({
        kind: this.kind,
        fen,
        legal,
        difficulty: this.difficulty,
        config: this.config,
      }),
      signal,
    });

    let data;
    try {
      data = await res.json();
    } catch {
      throw new EngineError('The opponent returned something that was not JSON.', null);
    }

    if (!res.ok || data.error) {
      throw new EngineError(
        data.error || `The opponent failed (HTTP ${res.status}).`,
        data.detail || null
      );
    }
    if (!data.move) {
      throw new EngineError('The opponent returned no move.', data.detail || null);
    }

    this.lastDetail = data.detail || null;
    return data.move;
  }
}

/** A failure the player should see, with the detail that explains it. */
export class EngineError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'EngineError';
    this.detail = detail;
  }
}

/** Ask the gateway which opponents are actually reachable right now. */
export async function probeOpponents(config) {
  try {
    const res = await fetch('/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chess3D': '1' },
      body: JSON.stringify({ config: config || {} }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
