/**
 * Themes.
 *
 * A theme is a JSON entry, loaded at runtime. This file turns a descriptor
 * into the materials, lights and background the scene uses, and swaps them
 * without rebuilding anything — the geometry never changes, only what it is
 * made of, which is why a theme can change mid-game with the position intact.
 */

import * as THREE from './vendor/three.module.js';

let catalogue = null;

/** Load themes.json once. */
export async function loadThemes(url = './themes.json') {
  if (catalogue) return catalogue;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`themes.json: ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.themes) || data.themes.length === 0) {
    throw new Error('themes.json contains no themes');
  }
  catalogue = data;
  return catalogue;
}

export function themeList() {
  return catalogue ? catalogue.themes : [];
}

/** The classic set is always there: turned pieces, made in code, nothing to load. */
const CLASSIC_SET = {
  id: 'classic',
  name: 'Classic',
  summary: 'Turned Staunton pieces, made in code.',
  sides: { w: 'White', b: 'Black' },
};

/** Piece sets: Classic first, then whatever themes.json lists under `sets`. */
export function setList() {
  const listed = catalogue && Array.isArray(catalogue.sets) ? catalogue.sets : [];
  return [CLASSIC_SET, ...listed.filter((s) => s.id !== 'classic')];
}

export function findSet(id) {
  return setList().find((s) => s.id === id) || CLASSIC_SET;
}

export function findTheme(id) {
  if (!catalogue) return null;
  return catalogue.themes.find((t) => t.id === id) || catalogue.themes[0];
}

export function defaultThemeId() {
  if (!catalogue) return null;
  return catalogue.default || catalogue.themes[0].id;
}

/** Material properties a theme entry may set, and how to read each one. */
function applyMaterialSpec(material, spec) {
  if (!spec) return material;
  if (spec.color) material.color.set(spec.color);
  if (spec.roughness !== undefined) material.roughness = spec.roughness;
  if (spec.metalness !== undefined) material.metalness = spec.metalness;
  if (spec.emissive) material.emissive.set(spec.emissive);
  material.emissiveIntensity = spec.emissiveIntensity !== undefined ? spec.emissiveIntensity : 0;
  if (!spec.emissive) material.emissive.set('#000000');
  material.envMapIntensity = spec.envMapIntensity !== undefined ? spec.envMapIntensity : 1;
  material.needsUpdate = true;
  return material;
}

function standard(spec) {
  const m = new THREE.MeshStandardMaterial();
  return applyMaterialSpec(m, spec);
}

/**
 * The live set of materials the board and pieces share. Built once; a theme
 * change edits these in place so every mesh already pointing at them updates
 * with no rebuild.
 */
export function createMaterials(theme) {
  const materials = {
    board: {
      light: standard(theme.board.light),
      dark: standard(theme.board.dark),
      frame: standard(theme.board.frame),
    },
    pieces: {
      w: pieceMaterial(theme.pieces.w),
      b: pieceMaterial(theme.pieces.b),
    },
    highlight: {},
  };
  updateHighlightColours(materials, theme);
  return materials;
}

/**
 * A piece material multiplies its uniform colour by each vertex's own colour
 * — a themed model with baked ambient-occlusion (creases and folds darkened
 * from the geometry itself, since Hunyuan3D-2's generator has no paint stage
 * to bake real texture from) reads as shaded rather than flat, while a
 * classic turned piece, which has no per-vertex colour of its own, gets one
 * built in at (1,1,1) — white, a no-op multiply — so the very same material
 * instance still renders it exactly as before. See `pieceGeometries` in
 * pieces.js for where that neutral attribute is added.
 */
function pieceMaterial(spec) {
  const m = standard(spec);
  m.vertexColors = true;
  return m;
}

function updateHighlightColours(materials, theme) {
  materials.highlightColors = {
    select: new THREE.Color(theme.highlight.select),
    move: new THREE.Color(theme.highlight.move),
    capture: new THREE.Color(theme.highlight.capture),
    check: new THREE.Color(theme.highlight.check),
    last: new THREE.Color(theme.highlight.last),
    hover: new THREE.Color(theme.highlight.hover || theme.highlight.select),
  };
}

/** Repoint existing materials at a new theme. Nothing is rebuilt. */
export function applyTheme(materials, theme) {
  applyMaterialSpec(materials.board.light, theme.board.light);
  applyMaterialSpec(materials.board.dark, theme.board.dark);
  applyMaterialSpec(materials.board.frame, theme.board.frame);
  applyMaterialSpec(materials.pieces.w, theme.pieces.w);
  applyMaterialSpec(materials.pieces.b, theme.pieces.b);
  updateHighlightColours(materials, theme);
}

/** A vertical gradient for the sky, drawn once into a small canvas texture. */
export function backgroundTexture(theme) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, theme.background.top);
  grad.addColorStop(1, theme.background.bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------ player colours */

/**
 * The colours a player may change, in the order the panel lists them.
 *
 * A custom colour is applied *on top of* a texture and replaces only colour.
 * Roughness, metalness, glow, fog and lighting stay the texture's own, which is
 * why a red board in Marble still looks like polished stone and a red board in
 * Neon still looks like lit glass, instead of every texture converging on
 * whatever the player picked.
 */
export const COLOR_SLOTS = [
  { id: 'background', label: 'Background' },
  { id: 'light', label: 'Light squares' },
  { id: 'dark', label: 'Dark squares' },
  { id: 'white', label: 'White pieces' },
  { id: 'black', label: 'Black pieces' },
  { id: 'buttons', label: 'Buttons' },
];

const FALLBACK_BUTTON = '#12100e';

/** What each slot is in the texture as shipped. */
export function baseColors(theme) {
  return {
    background: theme.background.top,
    light: theme.board.light.color,
    dark: theme.board.dark.color,
    white: theme.pieces.w.color,
    black: theme.pieces.b.color,
    buttons: (theme.ui && theme.ui.button) || FALLBACK_BUTTON,
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const toHex = (c) => `#${c.getHexString()}`;

function hslOf(hex) {
  const out = {};
  new THREE.Color(hex).getHSL(out, THREE.SRGBColorSpace);
  return out;
}

function luminance(hex) {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/**
 * Move `follower` the way `ref` moved to `picked`: the same hue as the pick, and
 * the follower's own saturation and lightness carried along by however far the
 * pick differs from what it replaced. That keeps a texture's relationships — a
 * darker frame around the dark squares, a fog that matches the sky — when one
 * colour of the pair is changed.
 */
function follow(followerHex, refHex, pickedHex) {
  const f = hslOf(followerHex);
  const r = hslOf(refHex);
  const p = hslOf(pickedHex);
  const saturation = clamp01(f.s * Math.min(3, p.s / Math.max(r.s, 0.08)));
  const lightness = clamp01(f.l + (p.l - r.l));
  return toHex(new THREE.Color().setHSL(p.h, saturation, lightness, THREE.SRGBColorSpace));
}

/** A glowing material keeps glowing, in the new colour and in the same proportion. */
function glowFor(spec, pickedHex) {
  if (!spec.emissive) return undefined;
  const ratio = Math.min(1.2, luminance(spec.emissive) / Math.max(luminance(spec.color), 0.05));
  return toHex(new THREE.Color(pickedHex).multiplyScalar(ratio));
}

/** Text that reads on a button of this colour. */
export function inkFor(hex) {
  return luminance(hex) > 0.35 ? '#16120d' : '#f3efe8';
}

function recolour(spec, pickedHex) {
  const glow = glowFor(spec, pickedHex);
  spec.color = pickedHex;
  if (glow) spec.emissive = glow;
}

/**
 * The texture with the player's colours applied. Returns a new object; the
 * catalogue entry is never touched, so "reset" is just resolving with nothing.
 */
export function resolveTheme(theme, custom) {
  const t = JSON.parse(JSON.stringify(theme));
  const c = custom || {};

  if (c.background) {
    const ref = theme.background.top;
    t.background.top = c.background;
    t.background.bottom = follow(theme.background.bottom, ref, c.background);
    if (t.fog) t.fog.color = follow(theme.fog.color, ref, c.background);
  }
  if (c.light) recolour(t.board.light, c.light);
  if (c.dark) {
    recolour(t.board.dark, c.dark);
    t.board.frame.color = follow(theme.board.frame.color, theme.board.dark.color, c.dark);
    // The coordinates are written on the frame: keep them readable against it.
    const label = theme.board.label || '#ffffff';
    if (Math.abs(luminance(label) - luminance(t.board.frame.color)) < 0.25) {
      t.board.label = inkFor(t.board.frame.color);
    }
  }
  if (c.white) recolour(t.pieces.w, c.white);
  if (c.black) recolour(t.pieces.b, c.black);

  const button = c.buttons || (theme.ui && theme.ui.button) || FALLBACK_BUTTON;
  t.ui = { button, ink: inkFor(button) };
  return t;
}
