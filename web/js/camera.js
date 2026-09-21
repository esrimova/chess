/**
 * Camera control.
 *
 * One rule decides the whole design: a plain click belongs to the game. The
 * camera only listens when ctrl is held, or when a second finger arrives. If
 * that rule ever slips, selecting a piece and rotating the board start
 * fighting over the same gesture, and the board stops feeling trustworthy.
 *
 * Azimuth is deliberately unbounded, so the board turns a full 360° and keeps
 * going. Polar is clamped so the camera never drops under the table.
 */

import * as THREE from './vendor/three.module.js';

const MIN_POLAR = 0.12;
const MAX_POLAR = Math.PI / 2 - 0.06;
const MIN_RADIUS = 5.5;
const MAX_RADIUS = 46;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CameraRig {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;
    this.target = new THREE.Vector3(0, 0, 0);

    // Where the camera is going, and where it currently is. The gap between
    // them, closed a little each frame, is the damping.
    this.theta = 0;
    this.phi = 0.62;
    this.radius = 13.0;
    this.current = { theta: this.theta, phi: this.phi, radius: this.radius };

    this.enabled = true;
    // Once the player has moved the camera themselves, stop choosing an angle
    // for them on resize. Re-framing is helpful; overriding their view is not.
    this.userAdjusted = false;
    this._pointers = new Map();
    this._orbiting = false;
    this._last = { x: 0, y: 0 };
    this._pinchDistance = 0;
    this._tween = null;

    this._bind();
    this._apply(true);
  }

  /* --------------------------------------------------------------- input */

  _bind() {
    const dom = this.dom;
    dom.addEventListener('pointerdown', this._onDown, { passive: false });
    window.addEventListener('pointermove', this._onMove, { passive: false });
    window.addEventListener('pointerup', this._onUp, { passive: true });
    window.addEventListener('pointercancel', this._onUp, { passive: true });
    dom.addEventListener('wheel', this._onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => {
      if (e.ctrlKey) e.preventDefault();
    });
  }

  /** True when this event is the camera's to handle, not the board's. */
  claims(event) {
    if (!this.enabled) return false;
    if (event.pointerType === 'touch') return this._pointers.size >= 2;
    return event.ctrlKey || event.metaKey || event.button === 2 || event.button === 1;
  }

  _onDown = (event) => {
    if (!this.enabled) return;
    this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (event.pointerType === 'touch') {
      if (this._pointers.size === 2) {
        this._orbiting = true;
        this._tween = null;
        const [a, b] = [...this._pointers.values()];
        this._pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
        this._last = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
      return;
    }

    if (this.claims(event)) {
      this._orbiting = true;
      this._tween = null;
      this._last = { x: event.clientX, y: event.clientY };
      event.preventDefault();
    }
  };

  _onMove = (event) => {
    if (this._pointers.has(event.pointerId)) {
      this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (!this._orbiting) return;

    if (event.pointerType === 'touch' && this._pointers.size >= 2) {
      const [a, b] = [...this._pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

      if (this._pinchDistance > 0) {
        const ratio = this._pinchDistance / Math.max(distance, 1);
        this.radius = THREE.MathUtils.clamp(this.radius * ratio, MIN_RADIUS, MAX_RADIUS);
      }
      this._pinchDistance = distance;

      this._rotateBy(mid.x - this._last.x, mid.y - this._last.y);
      this._last = mid;
      event.preventDefault();
      return;
    }

    this._rotateBy(event.clientX - this._last.x, event.clientY - this._last.y);
    this._last = { x: event.clientX, y: event.clientY };
    event.preventDefault();
  };

  _onUp = (event) => {
    this._pointers.delete(event.pointerId);
    if (this._pointers.size < 2) this._pinchDistance = 0;
    if (this._pointers.size === 0 || event.pointerType !== 'touch') this._orbiting = false;
  };

  _onWheel = (event) => {
    if (!this.enabled) return;
    event.preventDefault();
    this.userAdjusted = true;
    this._tween = null;
    const factor = Math.exp(event.deltaY * 0.0012);
    this.radius = THREE.MathUtils.clamp(this.radius * factor, MIN_RADIUS, MAX_RADIUS);
  };

  _rotateBy(dx, dy) {
    this.userAdjusted = true;
    // Unbounded in azimuth on purpose: the board turns forever in either
    // direction rather than stopping at an invisible seam.
    this.theta -= dx * 0.006;
    this.phi = THREE.MathUtils.clamp(this.phi - dy * 0.005, MIN_POLAR, MAX_POLAR);
  }

  /* ------------------------------------------------------------ commands */

  /** Turn to face from a given side. 'w' looks from white, 'b' from black. */
  setSide(color, animate = true) {
    const theta = color === 'b' ? Math.PI : 0;
    // Take the shortest way round from wherever we are now.
    const turns = Math.round((this.theta - theta) / (Math.PI * 2));
    this._goto({ theta: theta + turns * Math.PI * 2 }, animate ? 0.9 : 0);
  }

  /** Swing to the other side of the board. */
  flip(duration = 1.0) {
    this._goto({ theta: this.theta + Math.PI }, duration);
  }

  /** One full turn, for the sake of it. */
  spin(duration = 2.4) {
    this._goto({ theta: this.theta + Math.PI * 2 }, duration);
  }

  reset(duration = 0.8) {
    this.userAdjusted = false;
    const turns = Math.round(this.theta / (Math.PI * 2));
    this._goto(
      { theta: turns * Math.PI * 2, phi: this.homePhi, radius: this.homeRadius },
      duration
    );
  }

  /**
   * The viewing angle that suits the shape of the window.
   *
   * A tall, narrow screen is the awkward case: the board is wide, so the
   * distance is set by the width, and a low angle then flattens the board into
   * a thin band with most of the height left empty. Looking down on it more
   * squares it up and puts that height to use. A wide screen has the room to
   * spare, and keeps the low angle that makes the pieces read as objects
   * standing on a table rather than markers on a diagram.
   *
   * Phi is measured from straight overhead, so smaller is more of a plan view.
   */
  angleForAspect(aspect) {
    if (aspect < 0.7) return 0.34;
    if (aspect < 1.0) return 0.46;
    if (aspect < 1.4) return 0.56;
    return 0.62;
  }

  /**
   * Pull back until every given point is inside the frame.
   *
   * A camera's field of view is vertical, so the horizontal one narrows with
   * the aspect ratio: a distance that frames the board on a wide monitor lets
   * it hang off both sides of a phone. Rather than guessing a distance per
   * breakpoint, project the board's own corners and solve for the distance
   * that contains them — which is correct at every shape of window, and stays
   * correct if the board or the field of view ever changes.
   *
   * Projected size is very nearly inversely proportional to distance, so
   * scaling by the current overshoot converges in two or three passes.
   */
  frame(points, margin = 0.86, aspect = null) {
    if (!points || points.length === 0) return;
    if (aspect !== null && !this.userAdjusted) {
      this.phi = this.angleForAspect(aspect);
      this.current.phi = this.phi;
      this.defaultPhi = this.phi;
    }
    for (let pass = 0; pass < 8; pass++) {
      this._apply(true);
      let extent = 0;
      for (const point of points) {
        const v = point.clone().project(this.camera);
        extent = Math.max(extent, Math.abs(v.x), Math.abs(v.y));
      }
      if (extent <= 1e-6) return;
      const over = extent / margin;
      if (Math.abs(over - 1) < 0.01) break;
      this.radius = THREE.MathUtils.clamp(this.radius * over, MIN_RADIUS, MAX_RADIUS);
    }
    this.current.radius = this.radius;
    this.defaultRadius = this.radius;
  }

  /** The framing `reset` returns to, once `frame` has worked it out. */
  get homeRadius() {
    return this.defaultRadius || 13.0;
  }

  get homePhi() {
    return this.defaultPhi !== undefined ? this.defaultPhi : 0.62;
  }

  _goto(values, duration) {
    if (!duration) {
      Object.assign(this, values);
      this._tween = null;
      return;
    }
    this._tween = {
      from: { theta: this.theta, phi: this.phi, radius: this.radius },
      to: { ...{ theta: this.theta, phi: this.phi, radius: this.radius }, ...values },
      elapsed: 0,
      duration,
    };
  }

  get busy() {
    return this._tween !== null;
  }

  /* -------------------------------------------------------------- update */

  update(dt) {
    if (this._tween) {
      const t = this._tween;
      t.elapsed += dt;
      const k = Math.min(1, t.elapsed / t.duration);
      const e = easeInOut(k);
      this.theta = t.from.theta + (t.to.theta - t.from.theta) * e;
      this.phi = t.from.phi + (t.to.phi - t.from.phi) * e;
      this.radius = t.from.radius + (t.to.radius - t.from.radius) * e;
      if (k >= 1) this._tween = null;
    }

    // Critically-damped-ish follow: fast enough to feel direct, slow enough
    // that the camera glides to a stop instead of snapping.
    const k = 1 - Math.pow(0.0015, dt);
    this.current.theta += (this.theta - this.current.theta) * k;
    this.current.phi += (this.phi - this.current.phi) * k;
    this.current.radius += (this.radius - this.current.radius) * k;
    this._apply();
  }

  _apply(immediate = false) {
    const c = immediate
      ? { theta: this.theta, phi: this.phi, radius: this.radius }
      : this.current;
    if (immediate) Object.assign(this.current, c);

    const sinPhi = Math.sin(c.phi);
    this.camera.position.set(
      this.target.x + c.radius * sinPhi * Math.sin(c.theta),
      this.target.y + c.radius * Math.cos(c.phi),
      this.target.z + c.radius * sinPhi * Math.cos(c.theta)
    );
    this.camera.lookAt(this.target);
  }
}
