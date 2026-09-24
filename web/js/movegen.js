/**
 * A chess position built for searching.
 *
 * chess.js is the rules layer the page trusts, and it is right, but it builds
 * an object per move and a string per position — fine for a human's click,
 * far too slow for a search that visits a million positions. This is the other
 * half of that trade: a flat 0x88 board, integer moves, make and unmake in
 * place. It is verified against known perft counts in tests/logic.test.mjs,
 * and the page still validates whatever it proposes with chess.js.
 *
 * No DOM and no imports, so it runs the same in a worker and under Node.
 */

export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const WHITE = 0;
export const BLACK = 1;

// Castling rights bits.
const WK = 1;
const WQ = 2;
const BK = 4;
const BQ = 8;

// A move is one integer: from (7 bits), to (7 bits), promotion type (3 bits),
// then flags. Squares are 0x88 indices, rank * 16 + file, rank 0 being rank 1.
export const FLAG_CAPTURE = 1 << 17;
export const FLAG_EP = 1 << 18;
export const FLAG_CASTLE = 1 << 19;

export const moveFrom = (m) => m & 0x7f;
export const moveTo = (m) => (m >> 7) & 0x7f;
export const movePromo = (m) => (m >> 14) & 7;

const KNIGHT_STEPS = [-33, -31, -18, -14, 14, 18, 31, 33];
const KING_STEPS = [-17, -16, -15, -1, 1, 15, 16, 17];
const BISHOP_STEPS = [-17, -15, 15, 17];
const ROOK_STEPS = [-16, -1, 1, 16];

const PIECE_CHARS = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };
const TYPE_CHARS = ['', 'p', 'n', 'b', 'r', 'q', 'k'];

export const makePiece = (color, type) => type | (color << 3);
export const pieceType = (p) => p & 7;
export const pieceColor = (p) => p >> 3;

/* -------------------------------------------------------------- zobrist */

// Two independent 32-bit keys per feature. One is used to pick a table slot,
// the other to confirm a hit, which makes a false hit vanishingly rare without
// needing 64-bit integers.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s | 0;
  };
}

const rng = makeRng(0x9e3779b9);
const Z_PIECE_LO = new Int32Array(16 * 128);
const Z_PIECE_HI = new Int32Array(16 * 128);
for (let i = 0; i < Z_PIECE_LO.length; i++) {
  Z_PIECE_LO[i] = rng();
  Z_PIECE_HI[i] = rng();
}
const Z_SIDE_LO = rng();
const Z_SIDE_HI = rng();
const Z_CASTLE_LO = Int32Array.from({ length: 16 }, rng);
const Z_CASTLE_HI = Int32Array.from({ length: 16 }, rng);
const Z_EP_LO = Int32Array.from({ length: 128 }, rng);
const Z_EP_HI = Int32Array.from({ length: 128 }, rng);

/* ------------------------------------------------------------- squares */

export function squareIndex(name) {
  return (name.charCodeAt(1) - 49) * 16 + (name.charCodeAt(0) - 97);
}

export function squareName(sq) {
  return String.fromCharCode(97 + (sq & 7)) + String.fromCharCode(49 + (sq >> 4));
}

export function moveToUci(m) {
  const promo = movePromo(m);
  return squareName(moveFrom(m)) + squareName(moveTo(m)) + (promo ? TYPE_CHARS[promo] : '');
}

// Which castling rights survive a move touching a given square.
const CASTLE_MASK = new Uint8Array(128).fill(15);
CASTLE_MASK[squareIndex('a1')] = 15 & ~WQ;
CASTLE_MASK[squareIndex('h1')] = 15 & ~WK;
CASTLE_MASK[squareIndex('e1')] = 15 & ~(WK | WQ);
CASTLE_MASK[squareIndex('a8')] = 15 & ~BQ;
CASTLE_MASK[squareIndex('h8')] = 15 & ~BK;
CASTLE_MASK[squareIndex('e8')] = 15 & ~(BK | BQ);

const MAX_PLY = 1024;

export class Position {
  constructor() {
    this.board = new Int8Array(128);
    this.side = WHITE;
    this.castling = 0;
    this.ep = -1;            // the square a pawn may capture onto, or -1
    this.halfmove = 0;
    this.fullmove = 1;
    this.kings = [-1, -1];
    this.hashLo = 0;
    this.hashHi = 0;

    // Undo stack, one slot per ply made.
    this.n = 0;
    this.uMove = new Int32Array(MAX_PLY);
    this.uCaptured = new Int8Array(MAX_PLY);
    this.uCastling = new Int8Array(MAX_PLY);
    this.uEp = new Int16Array(MAX_PLY);
    this.uHalf = new Int16Array(MAX_PLY);
    this.uHashLo = new Int32Array(MAX_PLY);
    this.uHashHi = new Int32Array(MAX_PLY);
  }

  static fromFen(fen) {
    const pos = new Position();
    const [placement, side, castling, ep, half, full] = fen.trim().split(/\s+/);
    let rank = 7;
    let file = 0;
    for (const ch of placement) {
      if (ch === '/') {
        rank--;
        file = 0;
      } else if (ch >= '1' && ch <= '8') {
        file += Number(ch);
      } else {
        const lower = ch.toLowerCase();
        const type = PIECE_CHARS[lower];
        if (!type) throw new Error(`bad FEN piece: ${ch}`);
        const color = ch === lower ? BLACK : WHITE;
        const sq = rank * 16 + file;
        pos.board[sq] = makePiece(color, type);
        if (type === KING) pos.kings[color] = sq;
        file++;
      }
    }
    if (pos.kings[0] < 0 || pos.kings[1] < 0) throw new Error('FEN needs both kings');
    pos.side = side === 'b' ? BLACK : WHITE;
    pos.castling = 0;
    for (const ch of castling || '-') {
      if (ch === 'K') pos.castling |= WK;
      else if (ch === 'Q') pos.castling |= WQ;
      else if (ch === 'k') pos.castling |= BK;
      else if (ch === 'q') pos.castling |= BQ;
    }
    pos.ep = ep && ep !== '-' ? squareIndex(ep) : -1;
    pos.halfmove = Number(half) || 0;
    pos.fullmove = Number(full) || 1;
    pos.computeHash();
    return pos;
  }

  computeHash() {
    let lo = 0;
    let hi = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const p = this.board[sq];
      if (p) {
        lo ^= Z_PIECE_LO[p * 128 + sq];
        hi ^= Z_PIECE_HI[p * 128 + sq];
      }
    }
    if (this.side === BLACK) {
      lo ^= Z_SIDE_LO;
      hi ^= Z_SIDE_HI;
    }
    lo ^= Z_CASTLE_LO[this.castling];
    hi ^= Z_CASTLE_HI[this.castling];
    if (this.ep >= 0) {
      lo ^= Z_EP_LO[this.ep];
      hi ^= Z_EP_HI[this.ep];
    }
    this.hashLo = lo;
    this.hashHi = hi;
  }

  /* ----------------------------------------------------------- attacks */

  /** Is `sq` attacked by any piece of `by`? */
  attacked(sq, by) {
    const b = this.board;
    const colorBits = by << 3;

    // Pawns: a white pawn attacks up the board, so it sits below its target.
    const pawn = PAWN | colorBits;
    const back = by === WHITE ? -16 : 16;
    let s = sq + back - 1;
    if (!(s & 0x88) && b[s] === pawn) return true;
    s = sq + back + 1;
    if (!(s & 0x88) && b[s] === pawn) return true;

    const knight = KNIGHT | colorBits;
    for (let i = 0; i < 8; i++) {
      s = sq + KNIGHT_STEPS[i];
      if (!(s & 0x88) && b[s] === knight) return true;
    }

    const king = KING | colorBits;
    for (let i = 0; i < 8; i++) {
      s = sq + KING_STEPS[i];
      if (!(s & 0x88) && b[s] === king) return true;
    }

    const bishop = BISHOP | colorBits;
    const rook = ROOK | colorBits;
    const queen = QUEEN | colorBits;
    for (let i = 0; i < 4; i++) {
      const step = BISHOP_STEPS[i];
      s = sq + step;
      while (!(s & 0x88)) {
        const p = b[s];
        if (p) {
          if (p === bishop || p === queen) return true;
          break;
        }
        s += step;
      }
    }
    for (let i = 0; i < 4; i++) {
      const step = ROOK_STEPS[i];
      s = sq + step;
      while (!(s & 0x88)) {
        const p = b[s];
        if (p) {
          if (p === rook || p === queen) return true;
          break;
        }
        s += step;
      }
    }
    return false;
  }

  inCheck(color = this.side) {
    return this.attacked(this.kings[color], color ^ 1);
  }

  /* -------------------------------------------------------- generation */

  /**
   * Pseudo-legal moves for the side to move: they obey how pieces move but may
   * leave the king in check, which `make` reports. `capturesOnly` keeps
   * captures and promotions, which is what quiescence search wants.
   */
  generate(out = [], capturesOnly = false) {
    const b = this.board;
    const us = this.side;
    const them = us ^ 1;
    const usBits = us << 3;
    out.length = 0;

    for (let from = 0; from < 128; from++) {
      if (from & 0x88) {
        from += 7;
        continue;
      }
      const piece = b[from];
      if (!piece || (piece & 8) !== usBits) continue;
      const type = piece & 7;

      if (type === PAWN) {
        const up = us === WHITE ? 16 : -16;
        const startRank = us === WHITE ? 1 : 6;
        const lastRank = us === WHITE ? 7 : 0;
        const one = from + up;

        if (!b[one]) {
          if ((one >> 4) === lastRank) {
            for (let promo = QUEEN; promo >= KNIGHT; promo--) {
              out.push(from | (one << 7) | (promo << 14));
            }
          } else if (!capturesOnly) {
            out.push(from | (one << 7));
            const two = one + up;
            if ((from >> 4) === startRank && !b[two]) out.push(from | (two << 7));
          }
        }
        for (let d = -1; d <= 1; d += 2) {
          const to = one + d;
          if (to & 0x88) continue;
          const target = b[to];
          if (target && (target & 8) === (them << 3)) {
            if ((to >> 4) === lastRank) {
              for (let promo = QUEEN; promo >= KNIGHT; promo--) {
                out.push(from | (to << 7) | (promo << 14) | FLAG_CAPTURE);
              }
            } else {
              out.push(from | (to << 7) | FLAG_CAPTURE);
            }
          } else if (to === this.ep) {
            out.push(from | (to << 7) | FLAG_CAPTURE | FLAG_EP);
          }
        }
        continue;
      }

      if (type === KNIGHT || type === KING) {
        const steps = type === KNIGHT ? KNIGHT_STEPS : KING_STEPS;
        for (let i = 0; i < 8; i++) {
          const to = from + steps[i];
          if (to & 0x88) continue;
          const target = b[to];
          if (!target) {
            if (!capturesOnly) out.push(from | (to << 7));
          } else if ((target & 8) !== usBits) {
            out.push(from | (to << 7) | FLAG_CAPTURE);
          }
        }
        if (type === KING && !capturesOnly) this._castles(from, out);
        continue;
      }

      const steps = type === BISHOP ? BISHOP_STEPS : type === ROOK ? ROOK_STEPS : KING_STEPS;
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        let to = from + step;
        while (!(to & 0x88)) {
          const target = b[to];
          if (!target) {
            if (!capturesOnly) out.push(from | (to << 7));
          } else {
            if ((target & 8) !== usBits) out.push(from | (to << 7) | FLAG_CAPTURE);
            break;
          }
          to += step;
        }
      }
    }
    return out;
  }

  _castles(from, out) {
    const us = this.side;
    const b = this.board;
    const them = us ^ 1;
    const home = us === WHITE ? 0 : 0x70;
    if (from !== home + 4) return;
    const kingSide = us === WHITE ? WK : BK;
    const queenSide = us === WHITE ? WQ : BQ;
    if (!(this.castling & (kingSide | queenSide))) return;
    if (this.attacked(from, them)) return;

    if ((this.castling & kingSide) && !b[home + 5] && !b[home + 6]
        && b[home + 7] === makePiece(us, ROOK)
        && !this.attacked(home + 5, them) && !this.attacked(home + 6, them)) {
      out.push(from | ((home + 6) << 7) | FLAG_CASTLE);
    }
    if ((this.castling & queenSide) && !b[home + 3] && !b[home + 2] && !b[home + 1]
        && b[home] === makePiece(us, ROOK)
        && !this.attacked(home + 3, them) && !this.attacked(home + 2, them)) {
      out.push(from | ((home + 2) << 7) | FLAG_CASTLE);
    }
  }

  /* --------------------------------------------------------- make/unmake */

  /**
   * Play a move. Returns false if it leaves the mover's own king in check —
   * the move is still made, and the caller must `unmake` either way.
   */
  make(move) {
    const b = this.board;
    const from = move & 0x7f;
    const to = (move >> 7) & 0x7f;
    const promo = (move >> 14) & 7;
    const us = this.side;
    const piece = b[from];

    const n = this.n++;
    this.uMove[n] = move;
    this.uCastling[n] = this.castling;
    this.uEp[n] = this.ep;
    this.uHalf[n] = this.halfmove;
    this.uHashLo[n] = this.hashLo;
    this.uHashHi[n] = this.hashHi;

    let lo = this.hashLo;
    let hi = this.hashHi;

    if (this.ep >= 0) {
      lo ^= Z_EP_LO[this.ep];
      hi ^= Z_EP_HI[this.ep];
    }
    lo ^= Z_CASTLE_LO[this.castling];
    hi ^= Z_CASTLE_HI[this.castling];

    let captured = 0;
    if (move & FLAG_EP) {
      const capSq = to + (us === WHITE ? -16 : 16);
      captured = b[capSq];
      b[capSq] = 0;
      lo ^= Z_PIECE_LO[captured * 128 + capSq];
      hi ^= Z_PIECE_HI[captured * 128 + capSq];
    } else if (move & FLAG_CAPTURE) {
      captured = b[to];
      lo ^= Z_PIECE_LO[captured * 128 + to];
      hi ^= Z_PIECE_HI[captured * 128 + to];
    }
    this.uCaptured[n] = captured;

    b[from] = 0;
    lo ^= Z_PIECE_LO[piece * 128 + from];
    hi ^= Z_PIECE_HI[piece * 128 + from];
    const placed = promo ? makePiece(us, promo) : piece;
    b[to] = placed;
    lo ^= Z_PIECE_LO[placed * 128 + to];
    hi ^= Z_PIECE_HI[placed * 128 + to];

    if ((piece & 7) === KING) this.kings[us] = to;

    if (move & FLAG_CASTLE) {
      const kingSide = to > from;
      const rookFrom = kingSide ? from + 3 : from - 4;
      const rookTo = kingSide ? from + 1 : from - 1;
      const rook = b[rookFrom];
      b[rookFrom] = 0;
      b[rookTo] = rook;
      lo ^= Z_PIECE_LO[rook * 128 + rookFrom] ^ Z_PIECE_LO[rook * 128 + rookTo];
      hi ^= Z_PIECE_HI[rook * 128 + rookFrom] ^ Z_PIECE_HI[rook * 128 + rookTo];
    }

    this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
    lo ^= Z_CASTLE_LO[this.castling];
    hi ^= Z_CASTLE_HI[this.castling];

    this.ep = -1;
    if ((piece & 7) === PAWN && (to - from === 32 || from - to === 32)) {
      this.ep = (from + to) >> 1;
      lo ^= Z_EP_LO[this.ep];
      hi ^= Z_EP_HI[this.ep];
    }

    this.halfmove = (piece & 7) === PAWN || captured ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.side = us ^ 1;
    lo ^= Z_SIDE_LO;
    hi ^= Z_SIDE_HI;
    this.hashLo = lo;
    this.hashHi = hi;

    return !this.attacked(this.kings[us], us ^ 1);
  }

  unmake() {
    const n = --this.n;
    const move = this.uMove[n];
    const b = this.board;
    const from = move & 0x7f;
    const to = (move >> 7) & 0x7f;
    const promo = (move >> 14) & 7;
    const us = this.side ^ 1;
    this.side = us;
    if (us === BLACK) this.fullmove--;

    const captured = this.uCaptured[n];
    const moved = promo ? makePiece(us, PAWN) : b[to];
    b[from] = moved;
    if (move & FLAG_EP) {
      b[to] = 0;
      b[to + (us === WHITE ? -16 : 16)] = captured;
    } else {
      b[to] = captured;
    }
    if ((moved & 7) === KING) this.kings[us] = from;

    if (move & FLAG_CASTLE) {
      const kingSide = to > from;
      const rookFrom = kingSide ? from + 3 : from - 4;
      const rookTo = kingSide ? from + 1 : from - 1;
      b[rookFrom] = b[rookTo];
      b[rookTo] = 0;
    }

    this.castling = this.uCastling[n];
    this.ep = this.uEp[n];
    this.halfmove = this.uHalf[n];
    this.hashLo = this.uHashLo[n];
    this.hashHi = this.uHashHi[n];
  }

  /** A null move: pass the turn. Used by the search, never by the game. */
  makeNull() {
    const n = this.n++;
    this.uMove[n] = 0;
    this.uEp[n] = this.ep;
    this.uHalf[n] = this.halfmove;
    this.uHashLo[n] = this.hashLo;
    this.uHashHi[n] = this.hashHi;
    if (this.ep >= 0) {
      this.hashLo ^= Z_EP_LO[this.ep];
      this.hashHi ^= Z_EP_HI[this.ep];
    }
    this.ep = -1;
    this.side ^= 1;
    this.hashLo ^= Z_SIDE_LO;
    this.hashHi ^= Z_SIDE_HI;
    this.halfmove++;
  }

  unmakeNull() {
    const n = --this.n;
    this.side ^= 1;
    this.ep = this.uEp[n];
    this.halfmove = this.uHalf[n];
    this.hashLo = this.uHashLo[n];
    this.hashHi = this.uHashHi[n];
  }

  /** Fully legal moves. Slow path, for the root and for tests. */
  legalMoves() {
    const legal = [];
    const pseudo = this.generate([]);
    for (const m of pseudo) {
      if (this.make(m)) legal.push(m);
      this.unmake();
    }
    return legal;
  }

  /** Find the legal move a UCI string names, or 0. */
  parseUci(uci) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return 0;
    const from = squareIndex(uci.slice(0, 2));
    const to = squareIndex(uci.slice(2, 4));
    const promo = uci[4] ? PIECE_CHARS[uci[4]] : 0;
    for (const m of this.legalMoves()) {
      if (moveFrom(m) === from && moveTo(m) === to && movePromo(m) === promo) return m;
    }
    return 0;
  }
}

/** Count leaf nodes to a depth — the standard check that generation is right. */
export function perft(pos, depth) {
  if (depth === 0) return 1;
  let total = 0;
  const moves = pos.generate([]);
  for (const m of moves) {
    if (pos.make(m)) total += depth === 1 ? 1 : perft(pos, depth - 1);
    pos.unmake();
  }
  return total;
}
