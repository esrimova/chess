/**
 * Tests for player colours: that they change colour and nothing else, so a
 * texture stays itself however it is painted.
 *
 *     node tests/look.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveTheme, baseColors, inkFor, COLOR_SLOTS } from '../web/js/themes.js';

const catalogue = JSON.parse(readFileSync(new URL('../web/themes.json', import.meta.url), 'utf8'));
const textures = catalogue.themes;

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

const hexToLum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};

console.log('\nlook — player colours sit on top of a texture');

const EVERYTHING = {
  background: '#cc2244', light: '#33aa55', dark: '#2244aa',
  white: '#ffee00', black: '#aa00ff', buttons: '#ff8800',
};

test('every texture defines a button colour and every slot has a starting colour', () => {
  for (const t of textures) {
    const base = baseColors(t);
    for (const slot of COLOR_SLOTS) {
      assert.match(base[slot.id], /^#[0-9a-f]{6}$/i, `${t.id}/${slot.id}`);
    }
    assert.ok(t.ui && t.ui.button, `${t.id} has no ui.button`);
  }
});

test('with no changes, a texture resolves to itself (plus its button ink)', () => {
  for (const t of textures) {
    const r = resolveTheme(t, {});
    assert.deepEqual(r.board, t.board);
    assert.deepEqual(r.pieces, t.pieces);
    assert.deepEqual(r.background, t.background);
    assert.deepEqual(r.lighting, t.lighting);
    assert.equal(r.ui.button, t.ui.button);
  }
});

test('the catalogue entry is never modified', () => {
  for (const t of textures) {
    const before = JSON.stringify(t);
    resolveTheme(t, EVERYTHING);
    assert.equal(JSON.stringify(t), before);
  }
});

test('the picked colours land where they were meant to', () => {
  for (const t of textures) {
    const r = resolveTheme(t, EVERYTHING);
    assert.equal(r.board.light.color, EVERYTHING.light);
    assert.equal(r.board.dark.color, EVERYTHING.dark);
    assert.equal(r.pieces.w.color, EVERYTHING.white);
    assert.equal(r.pieces.b.color, EVERYTHING.black);
    assert.equal(r.background.top, EVERYTHING.background);
    assert.equal(r.ui.button, EVERYTHING.buttons);
  }
});

test('only colour changes: gloss, metal, glow strength, fog distance and lighting stay', () => {
  for (const t of textures) {
    const r = resolveTheme(t, EVERYTHING);
    for (const [group, key] of [['board', 'light'], ['board', 'dark'], ['pieces', 'w'], ['pieces', 'b']]) {
      const was = t[group][key];
      const now = r[group][key];
      assert.equal(now.roughness, was.roughness, `${t.id} ${key} roughness`);
      assert.equal(now.metalness, was.metalness, `${t.id} ${key} metalness`);
      assert.equal(now.envMapIntensity, was.envMapIntensity, `${t.id} ${key} env`);
      assert.equal(now.emissiveIntensity, was.emissiveIntensity, `${t.id} ${key} glow strength`);
      assert.equal(!!now.emissive, !!was.emissive, `${t.id} ${key} still glows (or still does not)`);
    }
    assert.deepEqual(r.lighting, t.lighting);
    assert.equal(r.fog.near, t.fog.near);
    assert.equal(r.fog.far, t.fog.far);
  }
});

test('the same colours on different textures do not make the textures the same', () => {
  const painted = textures.map((t) => resolveTheme(t, EVERYTHING));
  const signature = (r) => JSON.stringify([
    r.board.light.roughness, r.board.light.metalness, r.pieces.w.roughness,
    r.pieces.w.envMapIntensity, r.lighting, r.fog.near, !!r.pieces.w.emissive,
  ]);
  assert.equal(new Set(painted.map(signature)).size, textures.length);
});

test('a glowing texture keeps glowing, in the new colour', () => {
  const neon = textures.find((t) => t.id === 'neon');
  const r = resolveTheme(neon, { white: '#ff0000' });
  assert.ok(r.pieces.w.emissive, 'lost its glow');
  assert.notEqual(r.pieces.w.emissive, neon.pieces.w.emissive);
  const n = parseInt(r.pieces.w.emissive.slice(1), 16);
  assert.ok(((n >> 16) & 255) > ((n >> 8) & 255), 'the glow is not red');
});

test('the frame follows the dark squares, and its labels stay readable', () => {
  for (const t of textures) {
    const r = resolveTheme(t, { dark: '#e8e8e8' });
    assert.notEqual(r.board.frame.color, t.board.frame.color);
    assert.ok(Math.abs(hexToLum(r.board.label) - hexToLum(r.board.frame.color)) >= 0.25,
      `${t.id}: label ${r.board.label} on frame ${r.board.frame.color}`);
  }
});

test('the background moves the sky and the fog together', () => {
  for (const t of textures) {
    const r = resolveTheme(t, { background: '#1144cc' });
    assert.equal(r.background.top, '#1144cc');
    assert.notEqual(r.background.bottom, t.background.bottom);
    assert.notEqual(r.fog.color, t.fog.color);
  }
});

test('button text is always legible on its button', () => {
  for (const button of ['#000000', '#ffffff', '#ffe08a', '#12100e', '#808080', '#2244aa', '#eceae4']) {
    const ink = inkFor(button);
    const gap = Math.abs(hexToLum(button) - hexToLum(ink));
    assert.ok(gap > 0.3, `${button} with ${ink}`);
    assert.equal(resolveTheme(textures[0], { buttons: button }).ui.ink, ink);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const { name, error } of failures) console.log(`\n--- ${name}\n${error.stack}`);
  process.exit(1);
}
