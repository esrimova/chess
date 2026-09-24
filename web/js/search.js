/**
 * The built-in opponent's thinking.
 *
 * An alpha-beta search over movegen.js's positions with a hand-tuned
 * evaluation: material, piece placement, pawn structure, the bishop pair,
 * rooks on open files. It is a real engine — it looks ahead, sees tactics,
 * finds mates — so the difficulty levels are levels of *how much* it is
 * allowed to think and how carefully, not of how much it is made to blunder.
 *
 * The low levels are limited by depth (they cannot see a trap that is three
 * moves deep) and jittered by noise (they sometimes prefer a worse move they
 * could not tell was worse), which is how a weak human loses, as opposed to
 * a random one. The high levels get time instead of a fixed depth.
 *
 * No DOM and no chess.js: it runs in a worker, and under Node for the tests.
 */

import {
  Position, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE,
  FLAG_CAPTURE, FLAG_EP, moveFrom, moveTo, movePromo, moveToUci,
} from './movegen.js';

/* --------------------------------------------------------------- levels */

/**
 * Six levels. `depth` is the deepest the search goes; `timeMs` is the most it
 * may spend (0 = no clock, the depth alone decides); `noise` is the standard
 * deviation, in centipawns, of the jitter added to each candidate move;
 * `quiescence` is whether it keeps looking through captures at the horizon
 * (without it, a piece it just took can be lost to a recapture it never saw);
 * `bookPlies` is how far into a game it may still follow the opening book.
 */
export const LEVELS = [
  { id: 'beginner', name: 'Beginner', depth: 1, timeMs: 0, noise: 240, quiescence: false, bookPlies: 0,
    blurb: 'Knows how the pieces move. Looks one move ahead and often misses that its own piece can be taken.' },
  { id: 'casual', name: 'Casual', depth: 2, timeMs: 0, noise: 120, quiescence: false, bookPlies: 4,
    blurb: 'Sees a capture and its recapture. Falls for anything a move or two deeper.' },
  { id: 'club', name: 'Club player', depth: 3, timeMs: 0, noise: 50, quiescence: true, bookPlies: 8,
    blurb: 'Solid at simple tactics, checks and captures. Occasionally plays a slightly worse move.' },
  { id: 'advanced', name: 'Advanced', depth: 7, timeMs: 1500, noise: 15, quiescence: true, bookPlies: 14,
    blurb: 'Calculates several moves ahead. Rarely gives anything away.' },
  { id: 'expert', name: 'Expert', depth: 9, timeMs: 3000, noise: 0, quiescence: true, bookPlies: 24,
    blurb: 'Thinks for a few seconds a move and plays the best line it finds.' },
  { id: 'master', name: 'Master', depth: 20, timeMs: 7000, noise: 0, quiescence: true, bookPlies: 999,
    blurb: 'Uses everything it has, every move. Expect to be punished for mistakes.' },
];

/** Older saved settings used three names; map them onto the nearest new level. */
const LEGACY = { easy: 'beginner', medium: 'club', hard: 'advanced' };

export function findLevel(id) {
  const wanted = LEGACY[id] || id;
  return LEVELS.find((l) => l.id === wanted) || LEVELS[2];
}

/* ----------------------------------------------------------- evaluation */

const MATE = 30000;
const INF = 32000;

const VALUE = [0, 100, 320, 330, 500, 900, 0];

// Piece-square tables, written the way a board is drawn: the first row is
// rank 8 from White's side. Michniewski's "simplified evaluation function".
const PST_PAWN = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];
const PST_KNIGHT = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];
const PST_BISHOP = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 10, 10, 5, 0, -10,
  -10, 5, 5, 10, 10, 5, 5, -10,
  -10, 0, 10, 10, 10, 10, 0, -10,
  -10, 10, 10, 10, 10, 10, 10, -10,
  -10, 5, 0, 0, 0, 0, 5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
];
const PST_ROOK = [
  0, 0, 0, 0, 0, 0, 0, 0,
  5, 10, 10, 10, 10, 10, 10, 5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  0, 0, 0, 5, 5, 0, 0, 0,
];
const PST_QUEEN = [
  -20, -10, -10, -5, -5, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 5, 5, 5, 0, -10,
  -5, 0, 5, 5, 5, 5, 0, -5,
  0, 0, 5, 5, 5, 5, 0, -5,
  -10, 5, 5, 5, 5, 5, 0, -10,
  -10, 0, 5, 0, 0, 0, 0, -10,
  -20, -10, -10, -5, -5, -10, -10, -20,
];
const PST_KING_MID = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20,
  20, 30, 10, 0, 0, 10, 30, 20,
];
const PST_KING_END = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10, 0, 0, -10, -20, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
];

// Flatten to per-colour, per-0x88-square lookups so the evaluation never does
// index arithmetic. PST[color][type][sq].
const PST = [[], []];
const PST_END = [[], []];
{
  const tables = [null, PST_PAWN, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN, PST_KING_MID];
  for (let color = 0; color < 2; color++) {
    for (let type = 1; type <= 6; type++) {
      PST[color][type] = new Int16Array(128);
      PST_END[color][type] = new Int16Array(128);
      for (let sq = 0; sq < 128; sq++) {
        if (sq & 0x88) continue;
        const rank = sq >> 4;
        const file = sq & 7;
        const row = color === WHITE ? 7 - rank : rank;
        const idx = row * 8 + file;
        PST[color][type][sq] = tables[type][idx];
        PST_END[color][type][sq] = type === KING ? PST_KING_END[idx] : tables[type][idx];
      }
    }
  }
}

const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0];
const PHASE_TOTAL = 24;

// Scratch space for pawn structure, reused so evaluating allocates nothing.
const pawnCount = [new Int8Array(8), new Int8Array(8)];
const pawnLow = [new Int8Array(8), new Int8Array(8)];   // lowest rank of that colour's pawns on the file
const pawnHigh = [new Int8Array(8), new Int8Array(8)];  // highest rank

/** Static score in centipawns, from the side to move's point of view. */
export function evaluate(pos) {
  const b = pos.board;
  const mg = [0, 0];
  const eg = [0, 0];
  let phase = 0;
  const bishops = [0, 0];
  let minors = 0;
  let majors = 0;
  let pawns = 0;

  for (let c = 0; c < 2; c++) {
    pawnCount[c].fill(0);
    pawnLow[c].fill(8);
    pawnHigh[c].fill(-1);
  }

  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const p = b[sq];
    if (!p) continue;
    const type = p & 7;
    const color = p >> 3;
    mg[color] += VALUE[type] + PST[color][type][sq];
    eg[color] += VALUE[type] + PST_END[color][type][sq];
    phase += PHASE_WEIGHT[type];
    if (type === PAWN) {
      pawns++;
      const file = sq & 7;
      const rank = sq >> 4;
      pawnCount[color][file]++;
      if (rank < pawnLow[color][file]) pawnLow[color][file] = rank;
      if (rank > pawnHigh[color][file]) pawnHigh[color][file] = rank;
    } else if (type === BISHOP) {
      bishops[color]++;
      minors++;
    } else if (type === KNIGHT) {
      minors++;
    } else if (type === ROOK || type === QUEEN) {
      majors++;
    }
  }

  // Nobody can mate with a lone minor piece.
  if (pawns === 0 && majors === 0 && minors <= 1) return 0;

  // Structure and placement, added to both phases equally.
  const extra = [0, 0];
  for (let c = 0; c < 2; c++) {
    const enemy = c ^ 1;
    if (bishops[c] >= 2) extra[c] += 30;
    for (let f = 0; f < 8; f++) {
      const n = pawnCount[c][f];
      if (n > 1) extra[c] -= 12 * (n - 1);
      if (n > 0) {
        const left = f > 0 ? pawnCount[c][f - 1] : 0;
        const right = f < 7 ? pawnCount[c][f + 1] : 0;
        if (!left && !right) extra[c] -= 14;

        // Passed: no enemy pawn ahead of it on its file or either neighbour.
        let passed = true;
        for (let g = Math.max(0, f - 1); g <= Math.min(7, f + 1); g++) {
          if (!pawnCount[enemy][g]) continue;
          if (c === WHITE ? pawnHigh[enemy][g] > pawnLow[c][f] : pawnLow[enemy][g] < pawnHigh[c][f]) {
            passed = false;
            break;
          }
        }
        if (passed) {
          const advanced = c === WHITE ? pawnHigh[c][f] : 7 - pawnLow[c][f];
          extra[c] += 8 + advanced * advanced * 3;
        }
      }
    }
  }

  // Rooks like a file with no pawn of their own on it.
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const p = b[sq];
    if ((p & 7) !== ROOK) continue;
    const color = p >> 3;
    const f = sq & 7;
    if (!pawnCount[color][f]) extra[color] += pawnCount[color ^ 1][f] ? 8 : 16;
  }

  if (phase > PHASE_TOTAL) phase = PHASE_TOTAL;
  const w = phase / PHASE_TOTAL;
  const white = (mg[0] + extra[0]) * w + (eg[0] + extra[0]) * (1 - w);
  const black = (mg[1] + extra[1]) * w + (eg[1] + extra[1]) * (1 - w);
  const score = Math.round(white - black) + (pos.side === WHITE ? 10 : -10);
  return pos.side === WHITE ? score : -score;
}

/* --------------------------------------------------------------- search */

const TT_BITS = 18;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

const MAX_SEARCH_PLY = 96;

// Most-valuable-victim, least-valuable-attacker: take big things with small ones first.
const MVV = [0, 100, 320, 330, 500, 900, 2000];
const LVA = [0, 6, 5, 4, 3, 2, 1];

class Stopped extends Error {}

export class Searcher {
  constructor() {
    this.ttLo = new Int32Array(TT_SIZE);
    this.ttHi = new Int32Array(TT_SIZE);
    this.ttMove = new Int32Array(TT_SIZE);
    this.ttScore = new Int16Array(TT_SIZE);
    this.ttDepth = new Int8Array(TT_SIZE).fill(-1);
    this.ttFlag = new Int8Array(TT_SIZE);

    this.killers = Array.from({ length: MAX_SEARCH_PLY }, () => new Int32Array(2));
    this.history = new Int32Array(2 * 128 * 128);
    this.lists = Array.from({ length: MAX_SEARCH_PLY + 4 }, () => []);
    this.scores = Array.from({ length: MAX_SEARCH_PLY + 4 }, () => []);

    this.nodes = 0;
    this.deadline = 0;
    this.stopped = false;
    this.useQuiescence = true;
    this.rootPly = 0;
  }

  clear() {
    this.ttDepth.fill(-1);
    this.history.fill(0);
    for (const k of this.killers) k.fill(0);
  }

  /* ------------------------------------------------------------- clock */

  _tick() {
    if ((this.nodes & 2047) === 0 && this.deadline && performance.now() >= this.deadline) {
      this.stopped = true;
    }
    return this.stopped;
  }

  /* --------------------------------------------------------- ordering */

  _orderScores(pos, moves, ply, ttMove) {
    const scores = this.scores[ply];
    scores.length = moves.length;
    const b = pos.board;
    const side = pos.side;
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      let s = 0;
      if (m === ttMove) {
        s = 1e7;
      } else if (m & FLAG_CAPTURE) {
        const victim = m & FLAG_EP ? PAWN : b[moveTo(m)] & 7;
        s = 1e6 + MVV[victim] * 10 + LVA[b[moveFrom(m)] & 7];
      } else if (movePromo(m)) {
        s = 9e5 + movePromo(m);
      } else if (m === this.killers[ply][0]) {
        s = 8e5;
      } else if (m === this.killers[ply][1]) {
        s = 7e5;
      } else {
        s = this.history[(side * 128 + moveFrom(m)) * 128 + moveTo(m)];
      }
      scores[i] = s;
    }
  }

  /** Bring the best-scored remaining move to slot `i`. */
  _pick(moves, scores, i) {
    let best = i;
    for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[best]) best = j;
    if (best !== i) {
      const m = moves[i]; moves[i] = moves[best]; moves[best] = m;
      const s = scores[i]; scores[i] = scores[best]; scores[best] = s;
    }
    return moves[i];
  }

  /* ---------------------------------------------------------- repeats */

  _repeated(pos) {
    if (pos.halfmove >= 100) return true;
    const limit = Math.max(0, pos.n - pos.halfmove);
    for (let i = pos.n - 2; i >= limit; i -= 2) {
      if (pos.uHashLo[i] === pos.hashLo && pos.uHashHi[i] === pos.hashHi) return true;
    }
    return false;
  }

  /* -------------------------------------------------------- quiescence */

  _quiesce(pos, alpha, beta, ply) {
    this.nodes++;
    if (this._tick()) return 0;

    const standPat = evaluate(pos);
    if (ply >= MAX_SEARCH_PLY - 1) return standPat;
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;

    const moves = pos.generate(this.lists[ply], true);
    this._orderScores(pos, moves, ply, 0);
    const b = pos.board;

    for (let i = 0; i < moves.length; i++) {
      const m = this._pick(moves, this.scores[ply], i);
      // Delta pruning: a capture that cannot lift the score back up is skipped.
      if (!movePromo(m)) {
        const gain = m & FLAG_EP ? 100 : VALUE[b[moveTo(m)] & 7];
        if (standPat + gain + 200 < alpha) continue;
      }
      const legal = pos.make(m);
      if (!legal) {
        pos.unmake();
        continue;
      }
      const score = -this._quiesce(pos, -beta, -alpha, ply + 1);
      pos.unmake();
      if (this.stopped) return 0;
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  /* ------------------------------------------------------------ search */

  _negamax(pos, depth, alpha, beta, ply, allowNull) {
    this.nodes++;
    if (this._tick()) return 0;

    if (ply > 0 && this._repeated(pos)) return 0;
    if (ply >= MAX_SEARCH_PLY - 1) return evaluate(pos);

    const inCheck = pos.inCheck();
    if (inCheck) depth++;
    if (depth <= 0) {
      return this.useQuiescence ? this._quiesce(pos, alpha, beta, ply) : evaluate(pos);
    }

    // Prefer the faster mate and the slower loss.
    alpha = Math.max(alpha, -MATE + ply);
    beta = Math.min(beta, MATE - ply - 1);
    if (alpha >= beta) return alpha;

    const isPv = beta - alpha > 1;
    const slot = pos.hashLo & TT_MASK;
    let ttMove = 0;
    if (this.ttDepth[slot] >= 0 && this.ttLo[slot] === pos.hashLo && this.ttHi[slot] === pos.hashHi) {
      ttMove = this.ttMove[slot];
      if (!isPv && this.ttDepth[slot] >= depth) {
        let s = this.ttScore[slot];
        if (s > MATE - 200) s -= ply;
        else if (s < -MATE + 200) s += ply;
        const flag = this.ttFlag[slot];
        if (flag === TT_EXACT) return s;
        if (flag === TT_LOWER && s >= beta) return s;
        if (flag === TT_UPPER && s <= alpha) return s;
      }
    }

    // Null move: if passing the turn still holds the position, it is good enough.
    if (allowNull && !isPv && !inCheck && depth >= 3 && this._hasPieces(pos)) {
      pos.makeNull();
      const reduction = 2 + (depth > 6 ? 1 : 0);
      const score = -this._negamax(pos, depth - 1 - reduction, -beta, -beta + 1, ply + 1, false);
      pos.unmakeNull();
      if (this.stopped) return 0;
      if (score >= beta) return score >= MATE - 200 ? beta : score;
    }

    const moves = pos.generate(this.lists[ply]);
    this._orderScores(pos, moves, ply, ttMove);
    const scores = this.scores[ply];

    const originalAlpha = alpha;
    let best = -INF;
    let bestMove = 0;
    let legalCount = 0;

    for (let i = 0; i < moves.length; i++) {
      const m = this._pick(moves, scores, i);
      const quiet = !(m & FLAG_CAPTURE) && !movePromo(m);
      if (!pos.make(m)) {
        pos.unmake();
        continue;
      }
      legalCount++;

      let score;
      const givesCheck = pos.inCheck();
      if (legalCount === 1) {
        score = -this._negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        // Late quiet moves are probably not the best: look at them shallowly first.
        let reduce = 0;
        if (depth >= 3 && legalCount > 4 && quiet && !inCheck && !givesCheck) {
          reduce = legalCount > 10 ? 2 : 1;
        }
        score = -this._negamax(pos, depth - 1 - reduce, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && (reduce || score < beta)) {
          score = -this._negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
        }
      }
      pos.unmake();
      if (this.stopped) return 0;

      if (score > best) {
        best = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) {
            if (quiet) {
              const k = this.killers[ply];
              if (k[0] !== m) {
                k[1] = k[0];
                k[0] = m;
              }
              this.history[(pos.side * 128 + moveFrom(m)) * 128 + moveTo(m)] += depth * depth;
            }
            break;
          }
        }
      }
    }

    if (legalCount === 0) return inCheck ? -MATE + ply : 0;

    let stored = best;
    if (stored > MATE - 200) stored += ply;
    else if (stored < -MATE + 200) stored -= ply;
    // Keep deeper results already in this slot unless this one is the same
    // position (a newer answer for it) or at least as deep.
    if (this.ttDepth[slot] <= depth || this.ttLo[slot] === pos.hashLo) {
      this.ttLo[slot] = pos.hashLo;
      this.ttHi[slot] = pos.hashHi;
      this.ttMove[slot] = bestMove;
      this.ttScore[slot] = stored;
      this.ttDepth[slot] = depth;
      this.ttFlag[slot] = best <= originalAlpha ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
    }
    return best;
  }

  /** Null-move search is unsound with only king and pawns left (zugzwang). */
  _hasPieces(pos) {
    const b = pos.board;
    const bits = pos.side << 3;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) {
        sq += 7;
        continue;
      }
      const p = b[sq];
      if (p && (p & 8) === bits) {
        const t = p & 7;
        if (t !== PAWN && t !== KING) return true;
      }
    }
    return false;
  }

  /**
   * Pick a move. `level` is an entry of LEVELS; `override` may set depth or
   * timeMs, which is how the tests keep strong levels fast.
   */
  think(pos, level, override = {}) {
    const depthCap = override.depth || level.depth;
    const timeMs = override.timeMs !== undefined ? override.timeMs : level.timeMs;
    const noise = override.noise !== undefined ? override.noise : level.noise;
    this.useQuiescence = level.quiescence;
    this.nodes = 0;
    this.stopped = false;
    this.deadline = timeMs ? performance.now() + timeMs : 0;
    const startedAt = performance.now();

    const root = pos.legalMoves();
    if (root.length === 0) return null;
    if (root.length === 1) {
      return { move: root[0], uci: moveToUci(root[0]), score: 0, depth: 0, nodes: 1, forced: true };
    }

    let result;
    if (noise > 0) {
      result = this._thinkNoisy(pos, root, depthCap, noise);
    } else {
      result = this._thinkDeep(pos, root, depthCap);
    }
    result.uci = moveToUci(result.move);
    result.nodes = this.nodes;
    result.ms = Math.round(performance.now() - startedAt);
    return result;
  }

  /** Iterative deepening: each depth's answer is kept until a deeper one finishes. */
  _thinkDeep(pos, root, depthCap) {
    let best = { move: root[0], score: 0, depth: 0 };

    for (let depth = 1; depth <= depthCap; depth++) {
      let alpha = -INF;
      let iterBest = 0;
      let iterScore = -INF;

      // Last iteration's best first: searching it with the full window gives
      // every other move a real bar to beat.
      const first = best.move;
      root.sort((a, b) => (b === first) - (a === first));

      for (let i = 0; i < root.length; i++) {
        const m = root[i];
        pos.make(m);
        let score;
        if (i === 0) {
          score = -this._negamax(pos, depth - 1, -INF, -alpha, 1, true);
        } else {
          score = -this._negamax(pos, depth - 1, -alpha - 1, -alpha, 1, true);
          if (score > alpha && !this.stopped) {
            score = -this._negamax(pos, depth - 1, -INF, -alpha, 1, true);
          }
        }
        pos.unmake();
        if (this.stopped) break;
        if (score > iterScore) {
          iterScore = score;
          iterBest = m;
          if (score > alpha) alpha = score;
        }
      }

      // A half-finished iteration may still have found something better than
      // last time's answer, but only if it searched the previous best first —
      // which it always does — so it is safe to trust when it improved.
      if (this.stopped) {
        if (iterBest && iterScore > best.score) best = { move: iterBest, score: iterScore, depth };
        break;
      }
      best = { move: iterBest, score: iterScore, depth };
      if (Math.abs(iterScore) > MATE - 100) break;   // a forced mate: no need to look further
    }
    return best;
  }

  /**
   * Score the root moves, jitter each, take the best.
   *
   * Every move is searched to the same depth, but with a window that starts
   * three noise-widths below the best score found so far: anything that far
   * behind cannot be chosen once the jitter is added, so it only needs to be
   * proven bad, not measured. That is what lets Advanced reach depth 5.
   */
  _thinkNoisy(pos, root, depthCap, noise) {
    let scored = null;
    let order = root.slice();
    for (let depth = 1; depth <= depthCap; depth++) {
      const pass = [];
      let top = -INF;
      for (const m of order) {
        const floor = top === -INF ? -INF : top - Math.ceil(noise * 3) - 1;
        pos.make(m);
        const score = -this._negamax(pos, depth - 1, -INF, -floor, 1, true);
        pos.unmake();
        if (this.stopped) break;
        pass.push({ move: m, score });
        if (score > top) top = score;
      }
      if (this.stopped) break;
      scored = { depth, pass };
      // Best first next time, so the window closes on the real leader early.
      order = pass.slice().sort((x, y) => y.score - x.score).map((e) => e.move);
    }
    // Out of time before even depth 1 finished: take the first move.
    if (!scored) return { move: root[0], score: 0, depth: 0 };

    let best = null;
    let bestValue = -Infinity;
    for (const { move, score } of scored.pass) {
      // A mate is a mate; noise must not talk the engine out of it.
      const jitter = Math.abs(score) > MATE - 100 ? 0 : gaussian() * noise;
      const value = score + jitter;
      if (value > bestValue) {
        bestValue = value;
        best = { move, score };
      }
    }
    return { move: best.move, score: best.score, depth: scored.depth };
  }
}

function gaussian() {
  let u = 0;
  while (u === 0) u = Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ api */

/**
 * Replay the game from its start so the search knows which positions have
 * already occurred — otherwise it would walk into a threefold repetition, or
 * miss the chance to force one. If the history does not lead to `fen` (or is
 * absent) it is ignored and the position stands alone.
 */
export function positionFor(fen, history) {
  if (Array.isArray(history) && history.length) {
    try {
      const pos = Position.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
      let ok = true;
      for (const uci of history) {
        const m = pos.parseUci(uci);
        if (!m) { ok = false; break; }
        pos.make(m);
      }
      const target = Position.fromFen(fen);
      if (ok && pos.hashLo === target.hashLo && pos.hashHi === target.hashHi && pos.side === target.side) {
        return pos;
      }
    } catch { /* fall through to the bare position */ }
  }
  return Position.fromFen(fen);
}

let shared = null;

/** One searcher per worker, so its table carries from move to move. */
export function chooseMove(fen, history, levelId, override) {
  if (!shared) shared = new Searcher();
  const level = findLevel(levelId);
  const pos = positionFor(fen, history);
  return shared.think(pos, level, override);
}
