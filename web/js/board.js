/**
 * The board: 64 squares, the frame around them, the coordinate labels, and
 * the highlight overlays that tell you what you may do next.
 *
 * Nothing here knows a chess rule. It is told which squares to light and in
 * which role; deciding that is the turn loop's business.
 */

import * as THREE from './vendor/three.module.js';
import { ALL_SQUARES, FILES, RANKS, isDarkSquare, squareToWorld } from './coords.js';

const SQUARE_THICKNESS = 0.12;
const FRAME_WIDTH = 0.55;
const OVERLAY_Y = 0.008;

/** A rounded-square outline, drawn once and reused by every overlay. */
function outlineTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 11;
  const inset = 11;
  const r = 16;
  ctx.beginPath();
  ctx.moveTo(inset + r, inset);
  ctx.arcTo(size - inset, inset, size - inset, size - inset, r);
  ctx.arcTo(size - inset, size - inset, inset, size - inset, r);
  ctx.arcTo(inset, size - inset, inset, inset, r);
  ctx.arcTo(inset, inset, size - inset, inset, r);
  ctx.closePath();
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function labelTexture(text, color) {
  const size = 96;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = color;
  ctx.font = '600 52px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Board {
  constructor(materials) {
    this.materials = materials;
    this.group = new THREE.Group();
    this.group.name = 'board';

    this.squares = new Map();      // square name -> mesh (the raycast targets)
    this.overlays = new Map();     // square name -> {outline, dot}
    this.pickTargets = [];
    this.labels = [];

    this._outlineTex = outlineTexture();
    this._buildSquares();
    this._buildFrame();
    this._buildOverlays();
    this._buildLabels();
  }

  _buildSquares() {
    const geometry = new THREE.BoxGeometry(1, SQUARE_THICKNESS, 1);
    for (const square of ALL_SQUARES) {
      const dark = isDarkSquare(square);
      const mesh = new THREE.Mesh(geometry, dark ? this.materials.board.dark : this.materials.board.light);
      const p = squareToWorld(square);
      mesh.position.set(p.x, -SQUARE_THICKNESS / 2, p.z);
      mesh.receiveShadow = true;
      mesh.userData.square = square;
      this.group.add(mesh);
      this.squares.set(square, mesh);
      this.pickTargets.push(mesh);
    }
  }

  _buildFrame() {
    const outer = 8 + FRAME_WIDTH * 2;
    const shape = new THREE.Shape();
    shape.moveTo(-outer / 2, -outer / 2);
    shape.lineTo(outer / 2, -outer / 2);
    shape.lineTo(outer / 2, outer / 2);
    shape.lineTo(-outer / 2, outer / 2);
    shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-4, -4);
    hole.lineTo(-4, 4);
    hole.lineTo(4, 4);
    hole.lineTo(4, -4);
    hole.closePath();
    shape.holes.push(hole);

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: SQUARE_THICKNESS + 0.04,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.03,
      bevelSegments: 2,
    });
    geometry.rotateX(Math.PI / 2);
    const frame = new THREE.Mesh(geometry, this.materials.board.frame);
    frame.position.y = 0.02;
    frame.castShadow = true;
    frame.receiveShadow = true;
    this.group.add(frame);
    this.frame = frame;
  }

  _buildOverlays() {
    const planeGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const dotGeometry = new THREE.CircleGeometry(0.16, 24).rotateX(-Math.PI / 2);

    for (const square of ALL_SQUARES) {
      const p = squareToWorld(square);

      const outline = new THREE.Mesh(
        planeGeometry,
        new THREE.MeshBasicMaterial({
          map: this._outlineTex,
          transparent: true,
          depthWrite: false,
          opacity: 0.95,
        })
      );
      outline.position.set(p.x, OVERLAY_Y, p.z);
      outline.visible = false;
      outline.renderOrder = 2;
      this.group.add(outline);

      const dot = new THREE.Mesh(
        dotGeometry,
        new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0.85 })
      );
      dot.position.set(p.x, OVERLAY_Y, p.z);
      dot.visible = false;
      dot.renderOrder = 2;
      this.group.add(dot);

      this.overlays.set(square, { outline, dot });
    }
  }

  _buildLabels() {
    const color = '#ffffff';
    const geometry = new THREE.PlaneGeometry(0.42, 0.42).rotateX(-Math.PI / 2);
    const place = (text, x, z) => {
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          map: labelTexture(text, color),
          transparent: true,
          depthWrite: false,
          opacity: 0.85,
        })
      );
      mesh.position.set(x, 0.045, z);
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.labels.push(mesh);
    };

    FILES.forEach((f, i) => {
      place(f, i - 3.5, 4 + FRAME_WIDTH / 2);
      place(f, i - 3.5, -(4 + FRAME_WIDTH / 2));
    });
    RANKS.forEach((r, i) => {
      place(r, -(4 + FRAME_WIDTH / 2), 3.5 - i);
      place(r, 4 + FRAME_WIDTH / 2, 3.5 - i);
    });
  }

  /** Labels take their colour from the theme, so they must be redrawn on a swap. */
  retintLabels(theme) {
    const color = theme.board.label || '#ffffff';
    let i = 0;
    const order = [];
    FILES.forEach((f) => { order.push(f); order.push(f); });
    RANKS.forEach((r) => { order.push(r); order.push(r); });
    for (const mesh of this.labels) {
      if (mesh.material.map) mesh.material.map.dispose();
      mesh.material.map = labelTexture(order[i++], color);
      mesh.material.needsUpdate = true;
    }
  }

  /** Clear every overlay. */
  clearHighlights() {
    for (const { outline, dot } of this.overlays.values()) {
      outline.visible = false;
      dot.visible = false;
    }
  }

  /**
   * Light a square in a role: 'select', 'move', 'capture', 'check' or 'last'.
   * Quiet moves get a dot, everything else an outline — the difference tells
   * you at a glance whether a square is empty or holds something to take.
   */
  highlight(square, role) {
    const entry = this.overlays.get(square);
    if (!entry) return;
    const colour = this.materials.highlightColors[role];
    if (!colour) return;

    if (role === 'move') {
      entry.dot.material.color.copy(colour);
      entry.dot.visible = true;
    } else {
      entry.outline.material.color.copy(colour);
      entry.outline.material.opacity = role === 'last' ? 0.55 : 0.95;
      entry.outline.visible = true;
    }
  }

  /**
   * The points the camera has to keep in frame: the four outer corners of the
   * frame, and the same corners at the height of the tallest piece, so a king
   * on a far rank is never cropped.
   */
  framingPoints(pieceHeight = 1.5) {
    const half = 4 + FRAME_WIDTH;
    const points = [];
    for (const x of [-half, half]) {
      for (const z of [-half, half]) {
        points.push(new THREE.Vector3(x, 0, z));
        points.push(new THREE.Vector3(x, pieceHeight, z));
      }
    }
    return points;
  }

  squareMesh(square) {
    return this.squares.get(square) || null;
  }

  dispose() {
    this._outlineTex.dispose();
    for (const mesh of this.labels) {
      if (mesh.material.map) mesh.material.map.dispose();
      mesh.material.dispose();
    }
  }
}
