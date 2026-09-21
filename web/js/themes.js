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
      w: standard(theme.pieces.w),
      b: standard(theme.pieces.b),
    },
    highlight: {},
  };
  updateHighlightColours(materials, theme);
  return materials;
}

function updateHighlightColours(materials, theme) {
  materials.highlightColors = {
    select: new THREE.Color(theme.highlight.select),
    move: new THREE.Color(theme.highlight.move),
    capture: new THREE.Color(theme.highlight.capture),
    check: new THREE.Color(theme.highlight.check),
    last: new THREE.Color(theme.highlight.last),
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
