/**
 * The coordinate contract.
 *
 * Two functions, and nothing else in the application is allowed to do this
 * conversion by hand. Every other module speaks square names ('e4') and asks
 * here when it needs a position in the world.
 *
 * Board layout: one square is one world unit, the board is centred on the
 * origin, and the default camera sits on +Z. So white's first rank is nearest
 * the camera and file 'a' is on the left.
 */

export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
export const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'];

export const SQUARE_SIZE = 1;
const HALF = 3.5; // (8 - 1) / 2

/** All 64 square names, a1 first, in file-major order. */
export const ALL_SQUARES = (() => {
  const out = [];
  for (const f of FILES) for (const r of RANKS) out.push(f + r);
  return out;
})();

/** 'e4' -> {file: 4, rank: 3}, both 0-based. Null if not a square. */
export function squareToIndex(square) {
  if (typeof square !== 'string' || square.length !== 2) return null;
  const file = FILES.indexOf(square[0]);
  const rank = RANKS.indexOf(square[1]);
  if (file < 0 || rank < 0) return null;
  return { file, rank };
}

/** {file, rank} -> 'e4'. Null if either index is off the board. */
export function indexToSquare(file, rank) {
  if (!Number.isInteger(file) || !Number.isInteger(rank)) return null;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return FILES[file] + RANKS[rank];
}

/** 'e4' -> {x, y, z} at the centre of that square, on the board surface. */
export function squareToWorld(square, y = 0) {
  const idx = squareToIndex(square);
  if (!idx) return null;
  return {
    x: idx.file - HALF,
    y,
    z: HALF - idx.rank,
  };
}

/** A world point -> the square containing it, or null if it is off the board. */
export function worldToSquare(point) {
  const file = Math.round(point.x + HALF);
  const rank = Math.round(HALF - point.z);
  return indexToSquare(file, rank);
}

/** True when the square is a dark one. a1 is dark, as it must be. */
export function isDarkSquare(square) {
  const idx = squareToIndex(square);
  if (!idx) return false;
  return (idx.file + idx.rank) % 2 === 0;
}
