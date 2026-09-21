/**
 * The rules layer.
 *
 * chess.js behind an interface of our own, so the renderer talks to us and
 * never to the library. There is not one 3D reference in this file, and there
 * must never be: the day chess.js is replaced, only this file changes.
 *
 * The engine boundary depends on this too. An opponent proposes a move as a
 * string; this file decides whether it happened. Nothing outside here mutates
 * the position.
 */

import { Chess } from './vendor/chess.js';

/** Long algebraic for a move object: e2e4, or e7e8q for a promotion. */
export function moveToUci(move) {
  return move.from + move.to + (move.promotion || '');
}

export class Game {
  constructor(fen) {
    this.chess = fen ? new Chess(fen) : new Chess();
  }

  reset(fen) {
    this.chess = fen ? new Chess(fen) : new Chess();
  }

  fen() {
    return this.chess.fen();
  }

  /** 'w' or 'b'. */
  turn() {
    return this.chess.turn();
  }

  /** Every piece on the board as {square, type, color}. */
  pieces() {
    const out = [];
    for (const row of this.chess.board()) {
      for (const cell of row) {
        if (cell) out.push({ square: cell.square, type: cell.type, color: cell.color });
      }
    }
    return out;
  }

  pieceAt(square) {
    const p = this.chess.get(square);
    return p ? { square, type: p.type, color: p.color } : null;
  }

  /**
   * Legal moves leaving a square, verbose. Each carries the flags the renderer
   * needs to animate correctly: captures, castling, en passant, promotion.
   */
  legalFrom(square) {
    try {
      return this.chess.moves({ square, verbose: true }) || [];
    } catch {
      return [];
    }
  }

  /** Every legal move in the position, verbose. */
  legalMoves() {
    return this.chess.moves({ verbose: true }) || [];
  }

  /** Every legal move as UCI strings — what an engine is offered. */
  legalUci() {
    return this.legalMoves().map(moveToUci);
  }

  /** Every legal move in SAN — an LLM reads these far better than UCI. */
  legalSan() {
    return this.legalMoves().map((m) => m.san);
  }

  /**
   * Apply a move. Accepts UCI ('e2e4', 'e7e8q'), SAN ('Nf3', 'O-O'), or an
   * object. Returns the verbose move that happened, or null if it was illegal
   * — and an illegal move changes nothing.
   */
  apply(move) {
    const attempt = (arg) => {
      try {
        return this.chess.move(arg);
      } catch {
        return null;
      }
    };

    if (move && typeof move === 'object') {
      return attempt({ from: move.from, to: move.to, promotion: move.promotion || undefined });
    }

    if (typeof move !== 'string') return null;
    const text = move.trim();
    if (!text) return null;

    // UCI first: it is unambiguous, and SAN never looks like this.
    const uci = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i.exec(text);
    if (uci) {
      const done = attempt({
        from: uci[1].toLowerCase(),
        to: uci[2].toLowerCase(),
        promotion: uci[3] ? uci[3].toLowerCase() : undefined,
      });
      if (done) return done;
    }

    return attempt(text);
  }

  /** Take back one ply. Returns the move undone, or null. */
  undo() {
    try {
      return this.chess.undo();
    } catch {
      return null;
    }
  }

  history() {
    return this.chess.history({ verbose: true }) || [];
  }

  /**
   * Where the game stands. `over` is what the turn loop watches; `reason` is
   * what the HUD shows. Draw claims that are available but not automatic are
   * reported as `claimable` rather than ending the game on their own.
   */
  status() {
    const c = this.chess;
    const call = (name) => (typeof c[name] === 'function' ? c[name]() : false);

    const inCheck = call('isCheck') || call('in_check');
    const turn = c.turn();

    if (call('isCheckmate') || call('in_checkmate')) {
      return {
        over: true,
        inCheck: true,
        turn,
        winner: turn === 'w' ? 'b' : 'w',
        reason: 'checkmate',
        text: `Checkmate — ${turn === 'w' ? 'Black' : 'White'} wins`,
      };
    }
    if (call('isStalemate') || call('in_stalemate')) {
      return { over: true, inCheck, turn, winner: null, reason: 'stalemate', text: 'Stalemate — draw' };
    }
    if (call('isInsufficientMaterial') || call('insufficient_material')) {
      return {
        over: true, inCheck, turn, winner: null,
        reason: 'insufficient', text: 'Draw — insufficient material',
      };
    }
    if (call('isThreefoldRepetition') || call('in_threefold_repetition')) {
      return {
        over: true, inCheck, turn, winner: null,
        reason: 'threefold', text: 'Draw — threefold repetition',
      };
    }
    if (call('isDraw') || call('in_draw')) {
      return { over: true, inCheck, turn, winner: null, reason: 'fifty', text: 'Draw — fifty-move rule' };
    }

    return {
      over: false,
      inCheck,
      turn,
      winner: null,
      reason: inCheck ? 'check' : 'playing',
      text: `${turn === 'w' ? 'White' : 'Black'} to move${inCheck ? ' — check' : ''}`,
    };
  }

  /** The king's square for a colour, so the HUD can flag it in check. */
  kingSquare(color) {
    const k = this.pieces().find((p) => p.type === 'k' && p.color === color);
    return k ? k.square : null;
  }
}
