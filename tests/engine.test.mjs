/**
 * Tests for the built-in opponent: that its move generator is correct, that
 * it finds what any engine must find, and that the difficulty levels are
 * genuinely different strengths rather than labels.
 *
 *     node tests/engine.test.mjs
 *
 * They run the same modules the browser's worker loads.
 */

import assert from 'node:assert/strict';
import { Position, perft, moveToUci } from '../web/js/movegen.js';
import { Searcher, LEVELS, findLevel, chooseMove, positionFor, evaluate } from '../web/js/search.js';
import { Chess } from '../web/js/vendor/chess.js';

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

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/* ------------------------------------------------------------ generation */

section('movegen — verified against published perft counts');

const PERFT = [
  ['the starting position', START, 4, 197281],
  ['kiwipete (castling, en passant, pins)', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 3, 97862],
  ['a rook endgame with en passant checks', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 5, 674624],
  ['promotions and castling out of check', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 4, 422333],
  ['a promotion that gives check', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 3, 62379],
];
for (const [name, fen, depth, expected] of PERFT) {
  test(`${name}: perft(${depth}) = ${expected}`, () => {
    assert.equal(perft(Position.fromFen(fen), depth), expected);
  });
}

test('make then unmake restores the position exactly, hash included', () => {
  const pos = Position.fromFen(PERFT[1][1]);
  const before = { lo: pos.hashLo, hi: pos.hashHi, board: Array.from(pos.board) };
  for (const m of pos.generate([])) {
    pos.make(m);
    pos.unmake();
    assert.equal(pos.hashLo, before.lo);
    assert.equal(pos.hashHi, before.hi);
    assert.deepEqual(Array.from(pos.board), before.board);
  }
});

test('the incremental hash matches one computed from scratch', () => {
  const pos = Position.fromFen(PERFT[1][1]);
  for (const m of pos.legalMoves()) {
    pos.make(m);
    const { hashLo, hashHi } = pos;
    pos.computeHash();
    assert.equal(pos.hashLo, hashLo, moveToUci(m));
    assert.equal(pos.hashHi, hashHi, moveToUci(m));
    pos.unmake();
  }
});

/* ---------------------------------------------------------------- search */

section('search — what any engine has to find');

const expert = (over) => ({ timeMs: 1500, ...over });

test('it plays mate in one', () => {
  const r = chooseMove('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', null, 'expert', expert());
  assert.equal(r.uci, 'a1a8');
});

test('it plays mate in one at every level from Casual up', () => {
  for (const level of LEVELS.filter((l) => l.id !== 'beginner')) {
    const r = chooseMove('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', null, level.id, expert({ timeMs: 800 }));
    assert.equal(r.uci, 'a1a8', level.id);
  }
});

test('it finds a mate in two', () => {
  // Ra7 takes the seventh rank; Kg8 is forced, and Ra8 is mate.
  const r = chooseMove('7k/8/5K2/8/8/8/8/R7 w - - 0 1', null, 'expert', expert());
  const pos = Position.fromFen('7k/8/5K2/8/8/8/8/R7 w - - 0 1');
  assert.ok(pos.parseUci(r.uci), 'returned an illegal move');
  assert.ok(r.score > 29000, `expected a mate score, got ${r.score}`);
});

test('it takes a free queen', () => {
  // The knight on c3 attacks the undefended queen on d5.
  const r = chooseMove('rnb1kbnr/pppp1ppp/8/3qp3/8/2N5/PPPPPPPP/R1BQKBNR w KQkq - 0 1', null, 'club', undefined);
  assert.equal(r.uci, 'c3d5');
});

test('it does not hang its queen to a pawn', () => {
  // Black's pawn on d5 attacks e4 and c4; the white queen on e4 is attacked.
  const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4Q3/8/PPPP1PPP/RNB1KBNR w KQkq - 0 1';
  const r = chooseMove(fen, null, 'club', undefined);
  const pos = Position.fromFen(fen);
  pos.make(pos.parseUci(r.uci));
  const reply = new Searcher().think(pos, findLevel('expert'), { timeMs: 200 });
  pos.make(reply.move);
  assert.ok(evaluate(pos) > -200, 'white lost material it could have saved');
});

test('a lone king against a lone king is a draw', () => {
  assert.equal(evaluate(Position.fromFen('8/8/8/4k3/8/8/3K4/8 w - - 0 1')), 0);
});

test('it returns null when there is nothing to play', () => {
  const r = chooseMove('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', null, 'club', undefined);
  assert.equal(r, null);
});

test('it always plays a legal move, at every level, through a whole game', () => {
  for (const level of LEVELS) {
    const chess = new Chess();
    const history = [];
    for (let ply = 0; ply < 24 && !chess.isGameOver(); ply++) {
      const r = chooseMove(chess.fen(), history, level.id, { timeMs: 60 });
      const legal = chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ''));
      assert.ok(legal.includes(r.uci), `${level.id} played ${r.uci} at ply ${ply}`);
      chess.move({ from: r.uci.slice(0, 2), to: r.uci.slice(2, 4), promotion: r.uci[4] });
      history.push(r.uci);
    }
  }
});

test('legacy difficulty names still map to a level', () => {
  assert.equal(findLevel('easy').id, 'beginner');
  assert.equal(findLevel('medium').id, 'club');
  assert.equal(findLevel('hard').id, 'advanced');
  assert.equal(findLevel('nonsense').id, 'club');
});

test('replaying the history lets the search see earlier positions', () => {
  const moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
  const chess = new Chess();
  for (const m of moves) chess.move({ from: m.slice(0, 2), to: m.slice(2, 4) });
  const pos = positionFor(chess.fen(), moves);
  assert.equal(pos.n, 4, 'history was not replayed');
  assert.equal(positionFor(chess.fen(), ['e2e4']).n, 0, 'a history that does not lead here must be ignored');
});

/* -------------------------------------------------------------- strength */

section('levels — they must be different strengths, not different labels');

/** Play two levels against each other; returns White's score: 1, 0.5 or 0. */
function play(whiteId, blackId, overrides) {
  const chess = new Chess();
  const history = [];
  const ids = { w: whiteId, b: blackId };
  // A short random opening, so the same pair does not repeat one game.
  for (let i = 0; i < 4; i++) {
    const moves = chess.moves({ verbose: true });
    const m = moves[Math.floor(Math.random() * moves.length)];
    chess.move(m);
    history.push(m.from + m.to + (m.promotion || ''));
  }
  for (let ply = 0; ply < 200 && !chess.isGameOver(); ply++) {
    const id = ids[chess.turn()];
    const r = chooseMove(chess.fen(), history, id, overrides[id]);
    chess.move({ from: r.uci.slice(0, 2), to: r.uci.slice(2, 4), promotion: r.uci[4] });
    history.push(r.uci);
  }
  if (chess.isCheckmate()) return chess.turn() === 'b' ? 1 : 0;
  // No result: call it by material, as a referee would for an unfinished game.
  const value = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let diff = 0;
  for (const row of chess.board()) {
    for (const c of row) if (c) diff += (c.color === 'w' ? 1 : -1) * value[c.type];
  }
  return diff >= 4 ? 1 : diff <= -4 ? 0 : 0.5;
}

/** How the stronger level scores over `games` games, colours alternating. */
function match(strong, weak, games, overrides) {
  let score = 0;
  for (let g = 0; g < games; g++) {
    if (g % 2 === 0) score += play(strong, weak, overrides);
    else score += 1 - play(weak, strong, overrides);
  }
  return score;
}

// The strong levels are given a fraction of their real clock so the suite is
// quick; the weak levels are left as they are, since depth alone limits them.
const QUICK = { advanced: { timeMs: 150 }, expert: { timeMs: 150 }, master: { timeMs: 150 } };

for (const [strong, weak, need] of [
  ['club', 'beginner', 5],
  ['advanced', 'casual', 5],
  ['master', 'club', 5],
]) {
  test(`${strong} beats ${weak}, at least ${need} points from 6 games`, () => {
    const score = match(strong, weak, 6, QUICK);
    assert.ok(score >= need, `${strong} scored only ${score} of 6 against ${weak}`);
  });
}

test('there are at least five levels, each with a distinct depth or clock', () => {
  assert.ok(LEVELS.length >= 5);
  const signatures = new Set(LEVELS.map((l) => `${l.depth}/${l.timeMs}/${l.noise}`));
  assert.equal(signatures.size, LEVELS.length);
  assert.equal(new Set(LEVELS.map((l) => l.id)).size, LEVELS.length);
});

/* ---------------------------------------------------------------- summary */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const { name, error } of failures) {
    console.log(`\n--- ${name}\n${error.stack}`);
  }
  process.exit(1);
}
