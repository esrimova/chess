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
// How far the board may be pushed off centre. Far enough to look along a rank
// from the edge, close enough that it can never be lost off screen.
const MAX_PAN = 9;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CameraRig {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;
    // Where the camera is looking, and where it is being asked to look. The
    // gap between them is closed each frame, so a pan glides like the orbit.
    this.target = new THREE.Vector3(0, 0, 0);
    this.targetGoal = new THREE.Vector3(0, 0, 0);

    // Which of the two a drag in progress is doing, decided by the modifier
    // that started it.
    this._dragKind = 'orbit';

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

  /**
   * True when this event is the camera's to handle, not the board's.
   *
   * A bare click is always the board's — that rule is what keeps selecting a
   * piece and moving the camera from fighting over the same gesture.
   */
  claims(event) {
    if (!this.enabled) return false;
    if (event.pointerType === 'touch') return this._pointers.size >= 2;
    return (
      event.ctrlKey || event.metaKey || event.shiftKey
      || event.button === 2 || event.button === 1
    );
  }

  /**
   * What a drag will do, from the key that started it.
   *
   * Ctrl turns the board, shift slides it. Reading the modifier at the moment
   * the drag begins, rather than every frame, means letting go of the key
   * mid-drag finishes what you started instead of switching under your hand.
   */
  _kindFor(event) {
    if (event.pointerType === 'touch') {
      return this._pointers.size >= 3 ? 'pan' : 'orbit';
    }
    if (event.shiftKey) return 'pan';
    if (event.button === 1) return 'pan';   // middle drag, as elsewhere
    return 'orbit';
  }

  _onDown = (event) => {
    if (!this.enabled) return;
    this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (event.pointerType === 'touch') {
      if (this._pointers.size >= 2) {
        this._orbiting = true;
        this._tween = null;
        this._dragKind = this._kindFor(event);
        const points = [...this._pointers.values()];
        const [a, b] = points;
        this._pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
        this._last = this._centroid(points);
      }
      return;
    }

    if (this.claims(event)) {
      this._orbiting = true;
      this._tween = null;
      this._dragKind = this._kindFor(event);
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
      const points = [...this._pointers.values()];
      const [a, b] = points;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = this._centroid(points);

      // A third finger arriving turns the gesture into a slide.
      this._dragKind = this._pointers.size >= 3 ? 'pan' : this._dragKind;

      if (this._pinchDistance > 0) {
        const ratio = this._pinchDistance / Math.max(distance, 1);
        this.radius = THREE.MathUtils.clamp(this.radius * ratio, MIN_RADIUS, MAX_RADIUS);
      }
      this._pinchDistance = distance;

      this._dragBy(mid.x - this._last.x, mid.y - this._last.y);
      this._last = mid;
      event.preventDefault();
      return;
    }

    this._dragBy(event.clientX - this._last.x, event.clientY - this._last.y);
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

  _centroid(points) {
    const sum = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
    return { x: sum.x / points.length, y: sum.y / points.length };
  }

  /** A drag does whichever the modifier that started it asked for. */
  _dragBy(dx, dy) {
    if (this._dragKind === 'pan') this._panBy(dx, dy);
    else this._rotateBy(dx, dy);
  }

  /**
   * Slide the board across the view.
   *
   * Moves along the camera's own right and up axes, so the board follows the
   * cursor whichever way the board happens to be turned, and scales with the
   * distance so the drag tracks at any zoom. Clamped, because a camera that
   * can be pushed until the board is off screen is a camera that will be.
   */
  _panBy(dx, dy) {
    this.userAdjusted = true;
    this.camera.updateMatrixWorld();
    const m = this.camera.matrixWorld.elements;
    const right = new THREE.Vector3(m[0], m[1], m[2]);
    const up = new THREE.Vector3(m[4], m[5], m[6]);

    const scale = this.current.radius * 0.0016;
    this.targetGoal
      .addScaledVector(right, -dx * scale)
      .addScaledVector(up, dy * scale);

    this.targetGoal.y = 0;
    if (this.targetGoal.length() > MAX_PAN) {
      this.targetGoal.setLength(MAX_PAN);
    }
  }

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

  /** True when the board has been pushed off centre. */
  get panned() {
    return this.targetGoal.lengthSq() > 1e-6;
  }

  reset(duration = 0.8) {
    this.userAdjusted = false;
    this.targetGoal.set(0, 0, 0);
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
  frame(points, { marginX = 0.86, marginY = 0.86, aspect = null } = {}) {
    if (!points || points.length === 0) return;
    // Framing assumes the board is centred, so bring it back first.
    this.targetGoal.set(0, 0, 0);
    this.target.set(0, 0, 0);
    if (aspect !== null && !this.userAdjusted) {
      this.phi = this.angleForAspect(aspect);
      this.current.phi = this.phi;
      this.defaultPhi = this.phi;
    }
    for (let pass = 0; pass < 8; pass++) {
      this._apply(true);
      let extentX = 0;
      let extentY = 0;
      for (const point of points) {
        const v = point.clone().project(this.camera);
        extentX = Math.max(extentX, Math.abs(v.x));
        extentY = Math.max(extentY, Math.abs(v.y));
      }
      if (extentX <= 1e-6 && extentY <= 1e-6) return;
      // Horizontal and vertical room differ once the chrome is accounted for,
      // so each axis is measured against its own margin.
      const over = Math.max(extentX / marginX, extentY / marginY);
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
    this.target.lerp(this.targetGoal, k);
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
