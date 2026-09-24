/**
 * Piece sets made of models.
 *
 * The classic pieces are turned in code. A themed set is a folder of .glb
 * files, one character per piece type per side, described by an entry in the
 * `sets` list of themes.json. The models carry shape only — no colours, no
 * textures — so the theme's materials and the player's own colours paint them
 * exactly as they paint the classic pieces.
 *
 * Everything here is optional at every step: a missing or broken file is
 * reported and that piece falls back to the classic one, so a themed set can
 * never leave the board without a piece.
 */

import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

export const TYPES = ['p', 'n', 'b', 'r', 'q', 'k'];

/**
 * Stand a geometry on y = 0, centred over its own footprint, as tall as
 * `height` — but never wider than `maxWidth`, so a wide piece (a horse, wings)
 * still fits its square. Proportions are always kept. Returns the scale used.
 */
export function fitGeometry(geometry, height, maxWidth) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = Math.min(height / size.y, maxWidth / Math.max(size.x, size.z));
  geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return scale;
}

/** The first mesh in a parsed glTF, as { geometry, texture }: geometry with
 *  its own transform baked in, texture its baseColorTexture if the file
 *  carries one (a piece painted by project_texture2.py — see STATUS.md) or
 *  null for a piece that is shape-only, shaded by AO vertex colour alone. */
function firstMesh(gltf) {
  let found = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((node) => {
    if (!found && node.isMesh && node.geometry) {
      const geometry = node.geometry.clone();
      geometry.applyMatrix4(node.matrixWorld);
      const texture = (node.material && node.material.map) || null;
      found = { geometry, texture };
    }
  });
  return found;
}

/**
 * Load every model of a set. Resolves to
 *   { id, name, sides, heights, facing, geoms: { w: {p, n, ...}, b: {...} },
 *     textures: { w: {p, n, ...}, b: {...} }, missing: [...] }
 * `missing` names anything that could not be loaded; those pieces are simply
 * absent from `geoms`, and makePiece uses the classic one for them.
 * `textures` holds a piece's own baseColorTexture where one exists — most
 * entries will be `undefined`, which is fine, not an error.
 */
export async function loadModelSet(def, base = './') {
  const loader = new GLTFLoader();
  const geoms = { w: {}, b: {} };
  const textures = { w: {}, b: {} };
  const missing = [];
  const maxWidth = def.maxWidth || 0.9;

  const jobs = [];
  for (const color of ['w', 'b']) {
    for (const type of TYPES) {
      const file = def.models && def.models[color] && def.models[color][type];
      if (!file) {
        missing.push(`${color}${type}`);
        continue;
      }
      const url = new URL(`${def.dir}/${file}`, new URL(base, window.location.href)).href;
      jobs.push(
        loader.loadAsync(url)
          .then((gltf) => {
            const mesh = firstMesh(gltf);
            if (!mesh) throw new Error('no mesh in file');
            const { geometry, texture } = mesh;
            fitGeometry(geometry, def.heights[type], maxWidth);
            // The piece material multiplies its colour by each vertex's own
            // colour (see themes.js's `pieceMaterial`), so an AO-baked model
            // shades itself; one without that data — a set that predates the
            // bake, or a piece a bake happened to skip — needs a neutral
            // white attribute instead, or the shader would be reading a
            // vertex attribute the file never supplied.
            if (!geometry.getAttribute('color')) {
              const count = geometry.attributes.position.count;
              geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
            }
            geoms[color][type] = geometry;
            if (texture) {
              texture.colorSpace = THREE.SRGBColorSpace;
              textures[color][type] = texture;
            }
          })
          .catch(() => missing.push(`${color}${type}`))
      );
    }
  }
  await Promise.all(jobs);

  return {
    id: def.id,
    name: def.name,
    sides: def.sides || { w: 'White', b: 'Black' },
    heights: def.heights,
    // Hunyuan3D-2 (the generator behind every piece so far) reconstructs a
    // figure facing local +Z, so left unrotated it faces White's own home
    // edge — its back, not its face, is what the opponent sees. Rotating
    // White by half a turn and leaving Black alone points both sides' pieces
    // across the board at each other, confirmed by rendering a known piece
    // in isolation with the true board axes. A set can still override this.
    facing: def.facing || { w: Math.PI, b: 0 },
    // A knight prompted as a "side profile" creature (a rearing horse, a
    // four-legged wolf) doesn't always come back with local +Z as its own
    // forward — its front can end up on a different local axis than a
    // front-facing piece like the king or bishop, so the general facing
    // rotation above can point it sideways instead of across the board.
    // `typeFacing` lets a set override rotation.y per piece type/colour;
    // any type/colour not listed here still uses `facing` above. Confirmed
    // per-piece the same way `facing` was: render in isolation, check which
    // way it actually points, don't guess.
    typeFacing: def.typeFacing || {},
    geoms,
    textures,
    missing,
  };
}

export function disposeModelSet(set) {
  if (!set) return;
  for (const color of Object.values(set.geoms)) {
    for (const geometry of Object.values(color)) geometry.dispose();
  }
  for (const color of Object.values(set.textures || {})) {
    for (const texture of Object.values(color)) texture.dispose();
  }
}

/**
 * Picking a piece by its triangles would test tens of thousands of them on
 * every pointer move, across up to thirty-two pieces. The bounding box of a
 * piece standing on its own square is exactly as good for choosing which piece
 * was meant, and is one test.
 */
export function boxRaycast(raycaster, intersects) {
  const box = this.geometry.boundingBox;
  if (!box) return;
  const inverse = new THREE.Matrix4().copy(this.matrixWorld).invert();
  const ray = raycaster.ray.clone().applyMatrix4(inverse);
  const local = ray.intersectBox(box, new THREE.Vector3());
  if (!local) return;
  const point = local.applyMatrix4(this.matrixWorld);
  intersects.push({ distance: raycaster.ray.origin.distanceTo(point), point, object: this });
}
