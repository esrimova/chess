/**
 * The default piece set, generated in code.
 *
 * Five of the six shapes are surfaces of revolution — which is what a real
 * turned Staunton piece is, so a lathe profile is not an approximation here,
 * it is the honest construction. The knight is the exception and the only one
 * that needs a silhouette.
 *
 * Geometry is built once per type and shared by every piece of that type;
 * colour lives entirely in the material, so a set is six meshes' worth of
 * geometry no matter how many pieces are on the board.
 *
 * One square is one world unit. Pieces are sized against that.
 */

import * as THREE from './vendor/three.module.js';
import { boxRaycast } from './models.js';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';

export const PIECE_TYPES = ['p', 'r', 'n', 'b', 'q', 'k'];

export const PIECE_NAMES = {
  p: 'Pawn', r: 'Rook', n: 'Knight', b: 'Bishop', q: 'Queen', k: 'King',
};

const LATHE_SEGMENTS = 48;

// The set is modelled at a convenient scale and then sized against the board
// as one piece. On a real set a king is close to twice the width of its
// square and the base fills about three quarters of it; modelled smaller,
// the pieces read as counters sitting in the middle of large empty squares.
const SET_SCALE = 1.45;

/* ---------------------------------------------------------------- helpers */

/** Points along an arc, for the curved parts of a profile. */
function arc(cx, cy, radius, fromDeg, toDeg, steps = 10) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = THREE.MathUtils.degToRad(fromDeg + ((toDeg - fromDeg) * i) / steps);
    out.push(new THREE.Vector2(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius));
  }
  return out;
}

function pts(pairs) {
  return pairs.map(([x, y]) => new THREE.Vector2(x, y));
}

/** A lathe from a profile, capped so it is a closed solid. */
function lathe(profile) {
  const p = profile.slice();
  // Close the bottom and the top on the axis so the solid has no holes.
  if (p[0].x > 1e-4) p.unshift(new THREE.Vector2(0, p[0].y));
  const last = p[p.length - 1];
  if (last.x > 1e-4) p.push(new THREE.Vector2(0, last.y));
  const g = new THREE.LatheGeometry(p, LATHE_SEGMENTS);
  g.computeVertexNormals();
  return g;
}

/**
 * Merge parts into one geometry.
 *
 * Lathes and boxes come back indexed, extrusions do not, and mergeGeometries
 * refuses to mix the two. Dropping every part to non-indexed first is the
 * cheapest way to make the set uniform — these are small geometries and the
 * duplicated vertices cost nothing next to a broken knight.
 */
function merge(parts) {
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(flat, false);
  if (!merged) throw new Error('piece geometry parts could not be merged');
  merged.computeVertexNormals();
  return merged;
}

function box(w, h, d, x = 0, y = 0, z = 0, rotY = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

function ball(r, x, y, z, detail = 16) {
  const g = new THREE.SphereGeometry(r, detail, detail / 2);
  g.translate(x, y, z);
  return g;
}

function cylinder(rTop, rBottom, h, x, y, z, seg = 24) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
  g.translate(x, y, z);
  return g;
}

/** Ring of copies of a geometry around the Y axis. */
function ring(makeGeometry, count, radius, y) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const g = makeGeometry(i);
    g.translate(Math.cos(a) * radius, y, Math.sin(a) * radius);
    parts.push(g);
  }
  return parts;
}

/** The base every piece stands on — the same foot across the set. */
function foot(r = 0.225) {
  return [
    [0.0, 0.0],
    [r, 0.0],
    [r, 0.022],
    [r * 0.97, 0.045],
    ...arc(r * 0.62, 0.075, r * 0.36, -88, 8, 8).map((v) => [v.x, v.y]),
    [r * 0.6, 0.095],
  ];
}

/* ------------------------------------------------------------ the shapes */

function pawnGeometry() {
  const profile = pts([
    ...foot(0.2),
    [0.108, 0.13],
    [0.09, 0.20],
    [0.086, 0.27],
    [0.118, 0.30],
    [0.132, 0.325],
    [0.128, 0.345],
    [0.095, 0.365],
    [0.086, 0.385],
    ...arc(0, 0.478, 0.114, -75, 90, 14).map((v) => [v.x, v.y]),
  ]);
  return lathe(profile);
}

function rookGeometry() {
  const profile = pts([
    ...foot(0.225),
    [0.15, 0.13],
    [0.138, 0.22],
    [0.138, 0.34],
    [0.152, 0.38],
    [0.195, 0.42],
    [0.205, 0.47],
    [0.205, 0.56],
    [0.155, 0.56],
    [0.155, 0.50],
  ]);
  // Crenellations: four blocks standing on the rim, the gaps between them
  // reading as the notches. Cutting real notches needs CSG we do not have.
  const parts = [lathe(profile)];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const g = box(0.12, 0.1, 0.08);
    g.rotateY(-a);
    g.translate(Math.cos(a) * 0.15, 0.605, Math.sin(a) * 0.15);
    parts.push(g);
  }
  return merge(parts);
}

function bishopGeometry() {
  const profile = pts([
    ...foot(0.205),
    [0.12, 0.13],
    [0.1, 0.19],
    [0.145, 0.235],
    [0.152, 0.26],
    [0.115, 0.285],
    [0.1, 0.31],
    ...arc(0, 0.46, 0.15, -72, 62, 14).map((v) => [v.x, v.y]),
    [0.055, 0.63],
    [0.072, 0.658],
    [0.05, 0.686],
    ...arc(0, 0.73, 0.052, -60, 90, 8).map((v) => [v.x, v.y]),
  ]);
  const parts = [lathe(profile)];
  // The mitre's slit. A groove needs subtraction, so this is a thin blade of
  // the dark trim material standing just proud of the surface — at playing
  // distance it reads as the cut.
  const slit = box(0.013, 0.1, 0.19, 0, 0.5, 0.0);
  parts.push(slit);
  return merge(parts);
}

function queenGeometry() {
  const profile = pts([
    ...foot(0.235),
    [0.15, 0.14],
    [0.125, 0.22],
    [0.112, 0.32],
    [0.125, 0.40],
    [0.15, 0.46],
    [0.128, 0.50],
    [0.115, 0.53],
    [0.175, 0.58],
    [0.2, 0.65],
    [0.2, 0.71],
    [0.155, 0.69],
    [0.155, 0.62],
  ]);
  const parts = [lathe(profile)];
  // The coronet: points around the rim, and the orb above.
  parts.push(...ring(() => ball(0.043, 0, 0, 0, 12), 8, 0.185, 0.72));
  parts.push(ball(0.062, 0, 0.80, 0, 18));
  parts.push(cylinder(0.03, 0.03, 0.05, 0, 0.755, 0, 16));
  return merge(parts);
}

function kingGeometry() {
  const profile = pts([
    ...foot(0.24),
    [0.155, 0.14],
    [0.13, 0.24],
    [0.118, 0.36],
    [0.132, 0.44],
    [0.158, 0.51],
    [0.132, 0.55],
    [0.12, 0.585],
    [0.182, 0.64],
    [0.205, 0.70],
    [0.205, 0.755],
    [0.16, 0.735],
    [0.16, 0.67],
  ]);
  const parts = [lathe(profile)];
  // Crown collar, then the cross. Both are deliberately chunky: a finely
  // modelled cross is invisible on a white piece at the size a king actually
  // appears on screen, and the cross is the whole silhouette of the piece.
  parts.push(cylinder(0.075, 0.1, 0.055, 0, 0.775, 0, 20));
  parts.push(box(0.082, 0.205, 0.082, 0, 0.885, 0));
  parts.push(box(0.2, 0.078, 0.078, 0, 0.9, 0));
  return merge(parts);
}

/**
 * The knight. The one piece that is not a surface of revolution, so it is an
 * extruded silhouette on a turned foot — which is also how a real carved
 * knight is made.
 *
 * The outline is traced facing +X; the piece is rotated to face the enemy
 * when it is placed.
 */
function knightGeometry() {
  const shape = new THREE.Shape();
  const outline = [
    [-0.125, 0.10],   // back of the chest, at the foot
    [-0.15, 0.24],
    [-0.158, 0.38],
    [-0.14, 0.50],
    [-0.112, 0.575],  // top of the neck
    [-0.085, 0.64],   // mane, cut in two steps so it is not a smooth curve
    [-0.048, 0.645],
    [-0.038, 0.70],
    [-0.005, 0.705],
    [0.012, 0.755],   // ear, a real notch rather than a bump
    [0.042, 0.815],
    [0.062, 0.745],
    [0.098, 0.762],   // forelock
    [0.128, 0.722],
    [0.168, 0.692],   // brow
    [0.212, 0.632],   // bridge of the nose
    [0.245, 0.568],
    [0.254, 0.512],   // muzzle
    [0.232, 0.478],
    [0.178, 0.468],   // mouth
    [0.142, 0.492],   // the underside of the jaw, undercut
    [0.098, 0.478],
    [0.072, 0.432],
    [0.05, 0.35],     // throat
    [0.062, 0.26],
    [0.098, 0.17],
    [0.125, 0.10],    // front of the chest
  ];
  shape.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i][0], outline[i][1]);
  shape.lineTo(outline[0][0], outline[0][1]);

  const head = new THREE.ExtrudeGeometry(shape, {
    depth: 0.17,
    bevelEnabled: true,
    bevelThickness: 0.022,
    bevelSize: 0.026,
    bevelSegments: 4,
    curveSegments: 6,
  });
  // A Staunton knight stands below the bishop. Scale about the collar where
  // the head meets its foot, so the join stays put while the head comes down.
  const KNIGHT_SCALE = 0.87;
  head.translate(0, -0.10, 0);
  head.scale(KNIGHT_SCALE, KNIGHT_SCALE, KNIGHT_SCALE);
  head.translate(0, 0.10, -0.085 * KNIGHT_SCALE);
  head.computeVertexNormals();

  const base = lathe(pts([
    ...foot(0.215),
    [0.13, 0.125],
    [0.122, 0.16],
  ]));

  return merge([base, head]);
}

/* --------------------------------------------------------------- the set */

const BUILDERS = {
  p: pawnGeometry,
  r: rookGeometry,
  n: knightGeometry,
  b: bishopGeometry,
  q: queenGeometry,
  k: kingGeometry,
};

/** Nominal heights, used for the lift height during a move and for framing. */
export const PIECE_HEIGHTS = Object.fromEntries(
  Object.entries({ p: 0.59, r: 0.66, n: 0.74, b: 0.78, q: 0.86, k: 0.97 })
    .map(([type, height]) => [type, +(height * SET_SCALE).toFixed(3)])
);

let cache = null;

// A themed set of models, when one is chosen. Anything it does not supply is
// made from the classic geometry, so a set can be partial and never leaves a
// hole in the board.
let modelSet = null;

// A piece with its own baked-in texture (see models.js's `textures`, and
// STATUS.md for how it got there) can't use the two shared faction
// materials — those are one flat colour times AO for the whole army, and a
// textured piece needs its own image instead. Cloned lazily, one per
// type/colour actually textured, and kept in step with theme changes by
// `refreshTextureMaterials` rather than being rebuilt from scratch.
let textureMaterials = new Map(); // "w:b" -> THREE.MeshStandardMaterial

export function setModelSet(set) {
  modelSet = set || null;
  for (const mat of textureMaterials.values()) mat.dispose();
  textureMaterials.clear();
}

// A theme's roughness/metalness/envMapIntensity are tuned for a flat
// sculpted piece (turned wood, cast metal, polished stone) catching studio
// light as a single uniform colour. A photo already has its own lighting
// and highlights baked into its pixels — inheriting a theme's reflectivity
// on top of that doubles the shine and is what reads as "metallic" instead
// of "painted". A textured piece is a miniature with a matte paint job, not
// a metal or stone piece, regardless of theme, so its finish is fixed here
// rather than following the theme the way colour, geometry and emissive
// glow still do.
const TEXTURED_ROUGHNESS = 0.92;
const TEXTURED_METALNESS = 0.0;
const TEXTURED_ENV_INTENSITY = 0.18;

/**
 * A textured piece's own material, cloned from the faction material the
 * first time it's needed. `.map` carries the piece's real painted colour,
 * so `.color` is left white rather than the faction's uniform tint — the
 * point of a texture is that it stops being one flat colour per side.
 * `.vertexColors` stays on, so the AO baked into the mesh still darkens it.
 */
function texturedMaterialFor(color, type, materials) {
  const texture = modelSet && modelSet.textures[color] && modelSet.textures[color][type];
  if (!texture) return null;
  const key = `${color}:${type}`;
  let mat = textureMaterials.get(key);
  if (!mat) {
    mat = materials[color].clone();
    mat.map = texture;
    mat.color.set(0xffffff);
    mat.vertexColors = true;
    mat.roughness = TEXTURED_ROUGHNESS;
    mat.metalness = TEXTURED_METALNESS;
    mat.envMapIntensity = TEXTURED_ENV_INTENSITY;
    textureMaterials.set(key, mat);
  }
  return mat;
}

/**
 * Called after a theme repaints the two shared faction materials in place
 * (see main.js's `paintTheme`), so every cloned per-piece texture material
 * picks up the new emissive glow too (a Neon piece should still glow) —
 * but *not* roughness/metalness/envMapIntensity, which stay fixed at the
 * matte values `texturedMaterialFor` set, regardless of theme. Colour was
 * already the texture's own job; finish is now too.
 */
export function refreshTextureMaterials(materials) {
  for (const [key, mat] of textureMaterials) {
    const color = key.split(':')[0];
    const base = materials[color];
    mat.emissive.copy(base.emissive);
    mat.emissiveIntensity = base.emissiveIntensity;
    mat.needsUpdate = true;
  }
}

export function activeModelSet() {
  return modelSet;
}

/** How tall a piece stands in the current set. */
export function pieceHeightOf(type) {
  return modelSet && modelSet.heights[type] ? modelSet.heights[type] : PIECE_HEIGHTS[type];
}

/** Build (once) and return the shared geometry for every piece type. */
export function pieceGeometries() {
  if (cache) return cache;
  cache = {};
  for (const type of PIECE_TYPES) {
    const g = BUILDERS[type]();
    if (!g) throw new Error(`piece geometry failed to build: ${type}`);

    // Sit the piece exactly on the board. The foot profile is shared but the
    // base radius is not, and at the wider radii the turned edge dips a few
    // thousandths below zero — enough to z-fight with the square it stands on.
    g.scale(SET_SCALE, SET_SCALE, SET_SCALE);
    g.computeBoundingBox();
    const drop = g.boundingBox.min.y;
    if (Math.abs(drop) > 1e-6) {
      g.translate(0, -drop, 0);
      g.computeBoundingBox();
    }
    g.computeBoundingSphere();
    // The piece material multiplies its colour by each vertex's own colour,
    // so a themed model's baked AO can darken its creases (see themes.js's
    // `pieceMaterial`). A classic piece has no such data of its own — every
    // vertex white, i.e. a no-op multiply — so it renders exactly as it did
    // before that material started expecting a colour attribute to exist.
    const count = g.attributes.position.count;
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
    cache[type] = g;
  }
  return cache;
}

/**
 * A piece, ready to place. Materials come from the theme, so this knows
 * nothing about how the set looks — only how it is shaped.
 */
export function makePiece(type, color, materials) {
  const modelled = modelSet && modelSet.geoms[color] && modelSet.geoms[color][type];
  if (modelled) {
    const material = texturedMaterialFor(color, type, materials) || materials[color];
    const mesh = new THREE.Mesh(modelled, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // A type/colour named in typeFacing (e.g. a knight posed side-on in its
    // own geometry) overrides the set's general per-colour facing.
    const override = modelSet.typeFacing[type];
    mesh.rotation.y = (override && override[color] !== undefined) ? override[color] : modelSet.facing[color];
    mesh.raycast = boxRaycast;
    mesh.userData.piece = { type, color };
    return mesh;
  }

  const geometries = pieceGeometries();
  const geometry = geometries[type];
  if (!geometry) throw new Error(`unknown piece type: ${type}`);

  const mesh = new THREE.Mesh(geometry, materials[color]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // The knight is the one piece with a silhouette, and a silhouette turned
  // edge-on is a blank slab. Face each side's knights out of the board towards
  // their own player, so the horse reads from the seat that owns it — and,
  // because a half turn keeps the outline in the same plane, from the other
  // seat as well. Facing the enemy, as a set on a table does, is the one
  // arrangement in which nobody can see what the piece is.
  if (type === 'n') mesh.rotation.y = color === 'w' ? 0 : Math.PI;
  mesh.userData.piece = { type, color };
  return mesh;
}

/** Free the shared geometry. Only needed when tearing the scene down. */
export function disposePieceGeometries() {
  if (!cache) return;
  for (const g of Object.values(cache)) g.dispose();
  cache = null;
}
