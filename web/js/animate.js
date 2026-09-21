/**
 * Motion.
 *
 * A move is not a teleport and it is not a straight slide: the piece is
 * lifted, carried, and set down, and it settles under its own weight when it
 * lands. That settle is three frames of work and it is most of why the board
 * feels like it has objects on it rather than sprites.
 *
 * Pieces share their material with every other piece of their colour, so
 * nothing here may touch opacity — a capture leaves by shrinking and sinking
 * instead. Fading one piece would fade the whole army.
 */

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export class Animator {
  constructor() {
    this.tweens = [];
  }

  get busy() {
    return this.tweens.length > 0;
  }

  update(dt) {
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const t = this.tweens[i];
      t.elapsed += dt;
      const k = t.duration > 0 ? Math.min(1, t.elapsed / t.duration) : 1;
      t.onUpdate(t.ease ? t.ease(k) : k, k);
      if (k >= 1) {
        this.tweens.splice(i, 1);
        if (t.onComplete) t.onComplete();
      }
    }
  }

  tween({ duration, onUpdate, onComplete, ease, delay = 0 }) {
    return new Promise((resolve) => {
      const entry = {
        elapsed: -delay,
        duration,
        ease,
        onUpdate: (e, raw) => {
          if (entry.elapsed < 0) return;
          onUpdate(e, raw);
        },
        onComplete: () => {
          if (onComplete) onComplete();
          resolve();
        },
      };
      this.tweens.push(entry);
    });
  }

  /**
   * Carry a piece from one point to another. Knights hop higher — they are
   * the piece that jumps, and showing that costs nothing.
   */
  movePiece(mesh, from, to, { lift = 0.55, duration = 0.42, arcOnly = false } = {}) {
    const start = { x: from.x, z: from.z };
    const end = { x: to.x, z: to.z };
    const baseY = mesh.position.y;

    return this.tween({
      duration,
      ease: easeInOutCubic,
      onUpdate: (e) => {
        mesh.position.x = start.x + (end.x - start.x) * e;
        mesh.position.z = start.z + (end.z - start.z) * e;
        mesh.position.y = baseY + Math.sin(Math.PI * e) * lift;
      },
      onComplete: () => {
        mesh.position.set(end.x, baseY, end.z);
        if (!arcOnly) this.settle(mesh);
      },
    });
  }

  /** The small compression of something heavy being set down. */
  settle(mesh, duration = 0.16) {
    return this.tween({
      duration,
      onUpdate: (_, raw) => {
        const squash = Math.sin(Math.PI * raw) * 0.055;
        mesh.scale.set(1 + squash * 0.6, 1 - squash, 1 + squash * 0.6);
      },
      onComplete: () => mesh.scale.set(1, 1, 1),
    });
  }

  /** A piece leaving the board: it shrinks and sinks through it. */
  capturePiece(mesh, { duration = 0.34 } = {}) {
    const startY = mesh.position.y;
    return this.tween({
      duration,
      ease: easeOutCubic,
      onUpdate: (e) => {
        const s = Math.max(0.001, 1 - e);
        mesh.scale.set(s, s, s);
        mesh.position.y = startY - e * 0.5;
        mesh.rotation.y += 0.05;
      },
      onComplete: () => {
        mesh.visible = false;
        mesh.scale.set(1, 1, 1);
        mesh.position.y = startY;
      },
    });
  }

  /** A piece arriving on the board: promotion, or a new game being set up. */
  appearPiece(mesh, { duration = 0.3, delay = 0 } = {}) {
    mesh.scale.set(0.001, 0.001, 0.001);
    mesh.visible = true;
    return this.tween({
      duration,
      delay,
      ease: easeOutCubic,
      onUpdate: (e) => {
        const s = Math.max(0.001, e);
        mesh.scale.set(s, s, s);
      },
      onComplete: () => mesh.scale.set(1, 1, 1),
    });
  }

  /** Lift a selected piece just off the board, or set it back down. */
  hover(mesh, up, { height = 0.16, duration = 0.14 } = {}) {
    const startY = mesh.position.y;
    const endY = up ? height : 0;
    if (Math.abs(startY - endY) < 1e-4) return Promise.resolve();
    return this.tween({
      duration,
      ease: easeOutCubic,
      onUpdate: (e) => {
        mesh.position.y = startY + (endY - startY) * e;
      },
      onComplete: () => {
        mesh.position.y = endY;
      },
    });
  }

  /** Drop everything immediately — used when a game is reset mid-animation. */
  clear() {
    this.tweens.length = 0;
  }
}
