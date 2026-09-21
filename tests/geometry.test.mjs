/**
 * Backend tests for the generated piece set.
 *
 * Geometry cannot be judged correct by looking at numbers — that is what the
 * frontend pass is for. What can be checked here is everything that is not a
 * matter of taste: that all six shapes build at all, that they are solid, that
 * they are proportioned like a chess set, and that none of them is wider than
 * the square it has to stand on.
 *
 *     node tests/geometry.test.mjs
 */

import assert from 'node:assert/strict';
import { pieceGeometries, makePiece, PIECE_TYPES, PIECE_HEIGHTS } from '../web/js/pieces.js';
import * as THREE from '../web/js/vendor/three.module.js';

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

console.log('\npieces — the generated set');

const geometries = pieceGeometries();

test('all six pieces build', () => {
  for (const type of PIECE_TYPES) {
    assert.ok(geometries[type], `${type} did not build`);
    assert.ok(geometries[type].attributes.position.count > 0, `${type} has no vertices`);
  }
});

test('every piece has normals, or it will not catch the light', () => {
  for (const type of PIECE_TYPES) {
    const normal = geometries[type].attributes.normal;
    assert.ok(normal, `${type} has no normals`);
    assert.equal(normal.count, geometries[type].attributes.position.count);
  }
});

test('no piece contains a NaN — one is enough to erase the whole mesh', () => {
  for (const type of PIECE_TYPES) {
    const array = geometries[type].attributes.position.array;
    for (let i = 0; i < array.length; i++) {
      if (!Number.isFinite(array[i])) {
        throw new Error(`${type} has a non-finite coordinate at ${i}`);
      }
    }
  }
});

test('every piece stands on the board, not through it', () => {
  for (const type of PIECE_TYPES) {
    const box = geometries[type].boundingBox;
    assert.ok(box.min.y >= -0.001, `${type} sinks below the board (${box.min.y})`);
    assert.ok(box.min.y < 0.02, `${type} floats above the board (${box.min.y})`);
  }
});

test('no piece is wider than the square it stands on', () => {
  for (const type of PIECE_TYPES) {
    const box = geometries[type].boundingBox;
    const radius = Math.max(
      Math.abs(box.min.x), Math.abs(box.max.x),
      Math.abs(box.min.z), Math.abs(box.max.z)
    );
    assert.ok(radius < 0.5, `${type} is ${radius.toFixed(3)} wide and would spill into its neighbours`);
    assert.ok(radius > 0.28, `${type} is only ${radius.toFixed(3)} wide and floats in its square`);
  }
});

test('the set is proportioned like a chess set: p < r < n < b < q < k', () => {
  const heights = PIECE_TYPES.map((t) => geometries[t].boundingBox.max.y);
  const order = ['p', 'r', 'n', 'b', 'q', 'k'].map((t) => geometries[t].boundingBox.max.y);
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      order[i] > order[i - 1],
      `heights out of order at ${i}: ${order.map((h) => h.toFixed(3)).join(' ')}`
    );
  }
  // A tournament king is about 1.8x its square; taller than that and the
  // pieces start hiding each other at a playing camera angle.
  assert.ok(Math.max(...heights) < 1.8, 'the king towers over the board');
  assert.ok(Math.max(...heights) > 1.1, 'the set is undersized against the squares');
});

test('the declared heights match the geometry that was built', () => {
  for (const type of PIECE_TYPES) {
    const actual = geometries[type].boundingBox.max.y;
    const declared = PIECE_HEIGHTS[type];
    assert.ok(
      Math.abs(actual - declared) < 0.06,
      `${type}: declared ${declared}, built ${actual.toFixed(3)}`
    );
  }
});

test('the knight is the only piece that is not a surface of revolution', () => {
  // Measured above the foot: every piece has a round base, so the full
  // bounding box hides the difference. It is the body that must be asymmetric.
  const spanAbove = (geometry, minY) => {
    const a = geometry.attributes.position.array;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < a.length; i += 3) {
      if (a[i + 1] < minY) continue;
      minX = Math.min(minX, a[i]); maxX = Math.max(maxX, a[i]);
      minZ = Math.min(minZ, a[i + 2]); maxZ = Math.max(maxZ, a[i + 2]);
    }
    return { x: maxX - minX, z: maxZ - minZ };
  };

  for (const type of PIECE_TYPES) {
    const span = spanAbove(geometries[type], 0.4);
    const ratio = span.x / span.z;
    if (type === 'n') {
      assert.ok(ratio > 1.6, `the knight reads as symmetric (x/z = ${ratio.toFixed(2)}), so it has no silhouette`);
    } else {
      assert.ok(
        Math.abs(ratio - 1) < 0.12,
        `${type} should be a surface of revolution (x/z = ${ratio.toFixed(2)})`
      );
    }
  }
});

test('geometry is shared, not rebuilt per piece', () => {
  const materials = { w: new THREE.MeshStandardMaterial(), b: new THREE.MeshStandardMaterial() };
  const a = makePiece('p', 'w', materials);
  const b = makePiece('p', 'b', materials);
  assert.equal(a.geometry, b.geometry, 'two pawns should share one geometry');
  assert.notEqual(a.material, b.material, 'colour should come from the material');
});

test('a piece knows what it is, and the two knights face opposite ways', () => {
  const materials = { w: new THREE.MeshStandardMaterial(), b: new THREE.MeshStandardMaterial() };
  const white = makePiece('n', 'w', materials);
  const black = makePiece('n', 'b', materials);
  assert.deepEqual(white.userData.piece, { type: 'n', color: 'w' });
  assert.notEqual(white.rotation.y, black.rotation.y, 'both knights face the same way');
  // A half turn, so the silhouette stays in the same plane and both players
  // see a horse rather than a slab.
  assert.ok(Math.abs(Math.abs(white.rotation.y - black.rotation.y) - Math.PI) < 1e-6,
    'the knights are not a half turn apart, so one of them is edge-on');
  assert.ok(white.castShadow && white.receiveShadow);
});

test('a full set is 32 pieces from 6 geometries', () => {
  const materials = { w: new THREE.MeshStandardMaterial(), b: new THREE.MeshStandardMaterial() };
  const layout = { p: 8, r: 2, n: 2, b: 2, q: 1, k: 1 };
  const used = new Set();
  let count = 0;
  for (const colour of ['w', 'b']) {
    for (const [type, n] of Object.entries(layout)) {
      for (let i = 0; i < n; i++) {
        used.add(makePiece(type, colour, materials).geometry);
        count++;
      }
    }
  }
  assert.equal(count, 32);
  assert.equal(used.size, 6, `expected 6 shared geometries, got ${used.size}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const { name, error } of failures) console.log(`\n--- ${name}\n${error.stack}`);
  process.exit(1);
}
