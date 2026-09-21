/**
 * Turning a pointer into an intention.
 *
 * Two jobs: work out which square is under the cursor, and tell a click apart
 * from a drag. The second matters more than it sounds — without it, nudging
 * the mouse a pixel while pressing would count as a move, and a board that
 * moves pieces you did not mean to move is worse than one that is slow.
 *
 * Pieces are raycast alongside squares, because a piece stands in front of the
 * square it occupies and the player is aiming at the piece.
 */

import * as THREE from './vendor/three.module.js';

const CLICK_SLOP_PX = 6;
const CLICK_MAX_MS = 700;

export class Picker {
  constructor({ dom, camera, board, pieceMeshes, cameraRig }) {
    this.dom = dom;
    this.camera = camera;
    this.board = board;
    this.pieceMeshes = pieceMeshes; // live array, owned by the caller
    this.cameraRig = cameraRig;

    this.enabled = true;
    this.onPick = null;   // (square) => void
    this.onHover = null;  // (square | null) => void

    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._down = null;
    this._hovered = null;
    this._touch = false;

    dom.addEventListener('pointerdown', this._onDown, { passive: true });
    dom.addEventListener('pointerup', this._onUp, { passive: true });
    dom.addEventListener('pointermove', this._onMove, { passive: true });
    dom.addEventListener('pointerleave', this._onLeave, { passive: true });
  }

  /** The square under a client-space point, or null. */
  squareAt(clientX, clientY) {
    const rect = this.dom.getBoundingClientRect();
    this._pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointer, this.camera);

    const targets = this.pieceMeshes.concat(this.board.pickTargets);
    const hits = this._raycaster.intersectObjects(targets, false);
    for (const hit of hits) {
      const square = hit.object.userData.square;
      if (square) return square;
    }
    return null;
  }

  _onDown = (event) => {
    this._touch = event.pointerType === 'touch';
    if (!this.enabled) return;
    if (this.cameraRig && this.cameraRig.claims(event)) {
      this._down = null;
      return;
    }
    this._down = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      at: performance.now(),
    };
  };

  _onUp = (event) => {
    const down = this._down;
    this._down = null;
    if (!this.enabled || !down || down.id !== event.pointerId) return;

    // A second finger landing mid-gesture means the camera took over.
    if (this.cameraRig && this.cameraRig.claims(event)) return;

    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moved > CLICK_SLOP_PX) return;
    if (performance.now() - down.at > CLICK_MAX_MS) return;

    const square = this.squareAt(event.clientX, event.clientY);
    if (this.onPick) this.onPick(square);
  };

  _onMove = (event) => {
    if (!this.enabled || this._touch || event.pointerType === 'touch') return;
    // Hover is a desktop affordance; on touch there is no cursor to follow.
    const square = this.squareAt(event.clientX, event.clientY);
    if (square !== this._hovered) {
      this._hovered = square;
      if (this.onHover) this.onHover(square);
    }
  };

  _onLeave = () => {
    if (this._hovered !== null) {
      this._hovered = null;
      if (this.onHover) this.onHover(null);
    }
  };

  get hovered() {
    return this._hovered;
  }
}
