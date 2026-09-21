/**
 * Backend tests for the layers that have no DOM: the coordinate contract,
 * the rules wrapper, and the generated geometry.
 *
 * These run against the real modules the browser loads — same files, same
 * imports, nothing substituted. `node tests/logic.test.mjs`.
 */

import assert from 'node:assert/strict';

import {
  ALL_SQUARES, FILES, RANKS,
  squareToIndex, indexToSquare, squareToWorld, worldToSquare, isDarkSquare,
} from '../web/js/coords.js';
import { Game } from '../web/js/game.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message.split('\n')[0]}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------- the coordinate contract */

section('coords — the one contract everything else depends on');

test('there are exactly 64 squares', () => {
  assert.equal(ALL_SQUARES.length, 64);
  assert.equal(new Set(ALL_SQUARES).size, 64);
});

test('every square round-trips through world space', () => {
  for (const square of ALL_SQUARES) {
    const world = squareToWorld(square);
    assert.ok(world, `no world position for ${square}`);
    assert.equal(worldToSquare(world), square, `${square} did not round-trip`);
  }
});

test('a point anywhere inside a square resolves to that square', () => {
  // The corners matter: rounding at the boundary is where this breaks.
  for (const square of ALL_SQUARES) {
    const c = squareToWorld(square);
    for (const [dx, dz] of [[0.45, 0.45], [-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45]]) {
      assert.equal(
        worldToSquare({ x: c.x + dx, z: c.z + dz }),
        square,
        `${square} + (${dx}, ${dz})`
      );
    }
  }
});

test('points off the board resolve to null, not to an edge square', () => {
  assert.equal(worldToSquare({ x: 4.6, z: 0 }), null);
  assert.equal(worldToSquare({ x: -4.6, z: 0 }), null);
  assert.equal(worldToSquare({ x: 0, z: 4.6 }), null);
  assert.equal(worldToSquare({ x: 0, z: -4.6 }), null);
});

test('a1 is dark and h1 is light, as on a real board', () => {
  assert.equal(isDarkSquare('a1'), true);
  assert.equal(isDarkSquare('h1'), false);
  assert.equal(isDarkSquare('a8'), false);
  assert.equal(isDarkSquare('h8'), true);
});

test('white is nearest the camera and a-file is on the left', () => {
  // Default camera sits on +Z looking at the origin.
  assert.ok(squareToWorld('a1').z > squareToWorld('a8').z, 'rank 1 should be nearer');
  assert.ok(squareToWorld('a1').x < squareToWorld('h1').x, 'a-file should be left');
});

test('bad input is rejected rather than guessed at', () => {
  assert.equal(squareToIndex('z9'), null);
  assert.equal(squareToIndex('e'), null);
  assert.equal(squareToIndex(''), null);
  assert.equal(squareToIndex(null), null);
  assert.equal(indexToSquare(8, 0), null);
  assert.equal(indexToSquare(-1, 0), null);
  assert.equal(squareToWorld('zz'), null);
});

/* ------------------------------------------------------------ rules layer */

section('game — rules');

test('a new game has 20 legal moves and white to play', () => {
  const game = new Game();
  assert.equal(game.turn(), 'w');
  assert.equal(game.legalMoves().length, 20);
  assert.equal(game.pieces().length, 32);
});

test('an illegal move changes nothing at all', () => {
  const game = new Game();
  const before = game.fen();
  assert.equal(game.apply('e2e5'), null);
  assert.equal(game.apply('Kxe7'), null);
  assert.equal(game.apply('nonsense'), null);
  assert.equal(game.apply(''), null);
  assert.equal(game.apply(null), null);
  assert.equal(game.fen(), before, 'the position moved after an illegal move');
});

test('UCI and SAN both work', () => {
  const a = new Game();
  assert.ok(a.apply('e2e4'));
  const b = new Game();
  assert.ok(b.apply('e4'));
  assert.equal(a.fen(), b.fen());
});

test('kingside castling moves the king two squares', () => {
  const game = new Game('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
  const move = game.apply('O-O');
  assert.ok(move, 'castling was refused');
  assert.ok(move.flags.includes('k'));
  assert.equal(game.pieceAt('g1').type, 'k');
  assert.equal(game.pieceAt('f1').type, 'r');
  assert.equal(game.pieceAt('e1'), null);
  assert.equal(game.pieceAt('h1'), null);
});

test('queenside castling moves the rook to d-file', () => {
  const game = new Game('r3kbnr/pppqpppp/2npb3/8/8/2NPB3/PPPQPPPP/R3KBNR w KQkq - 6 6');
  const move = game.apply('O-O-O');
  assert.ok(move, 'castling was refused');
  assert.ok(move.flags.includes('q'));
  assert.equal(game.pieceAt('c1').type, 'k');
  assert.equal(game.pieceAt('d1').type, 'r');
});

test('en passant removes a pawn that is not on the destination square', () => {
  const game = new Game('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
  const move = game.apply('e5f6');
  assert.ok(move, 'en passant was refused');
  assert.ok(move.flags.includes('e'), 'not flagged as en passant');
  assert.equal(move.captured, 'p');
  assert.equal(game.pieceAt('f6').type, 'p', 'the capturing pawn should be on f6');
  assert.equal(game.pieceAt('f5'), null, 'the captured pawn should be gone from f5');
});

test('promotion produces the piece that was asked for', () => {
  for (const [promo, expected] of [['q', 'q'], ['r', 'r'], ['b', 'b'], ['n', 'n']]) {
    const game = new Game('8/P6k/8/8/8/8/6K1/8 w - - 0 1');
    const move = game.apply(`a7a8${promo}`);
    assert.ok(move, `promotion to ${promo} was refused`);
    assert.equal(move.promotion, promo);
    assert.equal(game.pieceAt('a8').type, expected);
  }
});

test('checkmate is reported, with the winner', () => {
  const game = new Game();
  for (const move of ['f3', 'e5', 'g4', 'Qh4']) assert.ok(game.apply(move), move);
  const status = game.status();
  assert.equal(status.over, true);
  assert.equal(status.reason, 'checkmate');
  assert.equal(status.winner, 'b');
});

test('stalemate is a draw, not a win', () => {
  const game = new Game('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  const status = game.status();
  assert.equal(status.over, true);
  assert.equal(status.reason, 'stalemate');
  assert.equal(status.winner, null);
});

test('insufficient material is a draw', () => {
  const game = new Game('8/8/4k3/8/8/4K3/8/8 w - - 0 1');
  assert.equal(game.status().reason, 'insufficient');
});

test('check is reported without ending the game', () => {
  // Black queen on e4 checks down the e-file; the king has four flight squares,
  // so this is check and nothing more.
  const game = new Game('4k3/8/8/8/4q3/8/8/4K3 w - - 0 1');
  const status = game.status();
  assert.equal(status.inCheck, true);
  assert.equal(status.over, false);
  assert.equal(status.reason, 'check');
  assert.ok(game.legalMoves().length > 0);
});

test('the fifty-move rule ends the game', () => {
  const game = new Game('7k/8/6K1/8/8/8/8/R7 w - - 99 100');
  assert.ok(game.apply('Ra2'));
  const status = game.status();
  assert.equal(status.over, true);
  assert.ok(['fifty', 'threefold'].includes(status.reason), `got ${status.reason}`);
});

test('undo restores the exact previous position', () => {
  const game = new Game();
  const start = game.fen();
  game.apply('e4');
  game.apply('e5');
  game.undo();
  game.undo();
  assert.equal(game.fen(), start);
});

test('the king square is found for both colours', () => {
  const game = new Game();
  assert.equal(game.kingSquare('w'), 'e1');
  assert.equal(game.kingSquare('b'), 'e8');
});

/* -------------------------------------------------------- the engine feed */

section('game — what an engine is given');

test('every legal move is offered as both UCI and SAN', () => {
  const game = new Game();
  const uci = game.legalUci();
  const san = game.legalSan();
  assert.equal(uci.length, 20);
  assert.equal(san.length, 20);
  assert.ok(uci.includes('e2e4'));
  assert.ok(san.includes('e4'));
  for (const move of uci) assert.match(move, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
});

test('every move the board offers is one the board will accept', () => {
  // The contract the engine boundary rests on: anything in the list is legal.
  const game = new Game('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
  for (const uci of game.legalUci()) {
    const probe = new Game(game.fen());
    assert.ok(probe.apply(uci), `the board refused its own legal move ${uci}`);
  }
});

test('promotion moves carry the promotion piece in their UCI', () => {
  const game = new Game('8/P6k/8/8/8/8/6K1/8 w - - 0 1');
  const promos = game.legalUci().filter((m) => m.startsWith('a7a8'));
  assert.equal(promos.length, 4);
  assert.deepEqual(promos.map((m) => m[4]).sort(), ['b', 'n', 'q', 'r']);
});

/* ----------------------------------------------------------------- perft */

section('game — perft, proving the rules layer counts what chess counts');

function perft(game, depth) {
  if (depth === 0) return 1;
  let nodes = 0;
  for (const move of game.legalMoves()) {
    const probe = new Game(game.fen());
    probe.apply(move.from + move.to + (move.promotion || ''));
    nodes += perft(probe, depth - 1);
  }
  return nodes;
}

test('start position: perft(1) = 20, perft(2) = 400, perft(3) = 8902', () => {
  assert.equal(perft(new Game(), 1), 20);
  assert.equal(perft(new Game(), 2), 400);
  assert.equal(perft(new Game(), 3), 8902);
});

test('kiwipete: perft(1) = 48, perft(2) = 2039', () => {
  const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  assert.equal(perft(new Game(fen), 1), 48);
  assert.equal(perft(new Game(fen), 2), 2039);
});

test('a position full of promotions: perft(1) = 24, perft(2) = 496', () => {
  const fen = 'n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1';
  assert.equal(perft(new Game(fen), 1), 24);
  assert.equal(perft(new Game(fen), 2), 496);
});

/* ------------------------------------------------------------- a full game */

section('game — a complete game, start to mate');

test('a full game plays through and ends in checkmate', () => {
  const game = new Game();
  const moves = [
    'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4', 'Bxb4', 'c3', 'Ba5',
    'd4', 'exd4', 'O-O', 'd3', 'Qb3', 'Qf6', 'e5', 'Qg6', 'Re1', 'Nge7',
    'Ba3', 'b5', 'Qxb5', 'Rb8', 'Qa4', 'Bb6', 'Nbd2', 'Bb7', 'Ne4', 'Qf5',
    'Bxd3', 'Qh5', 'Nf6+', 'gxf6', 'exf6', 'Rg8', 'Rad1', 'Qxf3', 'Rxe7+', 'Nxe7',
    'Qxd7+', 'Kxd7', 'Bf5+', 'Ke8', 'Bd7+', 'Kf8', 'Bxe7#',
  ];
  for (const move of moves) {
    assert.ok(game.apply(move), `the Evergreen Game stalled at ${move}`);
  }
  const status = game.status();
  assert.equal(status.over, true);
  assert.equal(status.reason, 'checkmate');
  assert.equal(status.winner, 'w');
  assert.equal(game.history().length, moves.length);
});

test('captures are recorded so the taken pieces can be shown', () => {
  const game = new Game();
  for (const move of ['e4', 'd5', 'exd5']) game.apply(move);
  const captures = game.history().filter((m) => m.captured);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].captured, 'p');
  assert.equal(captures[0].color, 'w');
});

/* ---------------------------------------------------------------- summary */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const { name, error } of failures) {
    console.log(`\n--- ${name}\n${error.stack}`);
  }
  process.exit(1);
}
