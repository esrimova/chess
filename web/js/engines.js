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

/**
 * @typedef {Object} Engine
 * @property {string} id
 * @property {string} name
 * @property {(fen: string, legal: string[], signal: AbortSignal) => Promise<string>} getMove
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: config || {} }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
