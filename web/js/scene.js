/**
 * The stage: renderer, camera, lights, environment, and the frame loop.
 *
 * The look lives here. Tone mapping and colour space are the difference
 * between a scene that reads as expensive and one that reads as a demo, and
 * they are set once, at this level, so everything downstream inherits them.
 */

import * as THREE from './vendor/three.module.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { backgroundTexture } from './themes.js';

// The camera distance a theme's fog distances are written against.
const REFERENCE_DISTANCE = 13;

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camera.position.set(0, 9, 10);
    this.camera.lookAt(0, 0, 0);

    this._buildLights();
    this._buildEnvironment();

    this.updaters = [];
    this._clock = new THREE.Clock();
    this._running = false;
    this._bgTexture = null;

    this._observeSize();
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    this.scene.add(this.hemi);

    this.key = new THREE.DirectionalLight(0xffffff, 2.4);
    this.key.position.set(6, 11, 7);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.camera.near = 1;
    this.key.shadow.camera.far = 40;
    this.key.shadow.camera.left = -8;
    this.key.shadow.camera.right = 8;
    this.key.shadow.camera.top = 8;
    this.key.shadow.camera.bottom = -8;
    this.key.shadow.bias = -0.0009;
    this.key.shadow.normalBias = 0.02;
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    this.fill = new THREE.DirectionalLight(0xffffff, 0.5);
    this.fill.position.set(-7, 5, -5);
    this.scene.add(this.fill);
  }

  _buildEnvironment() {
    // A generated room, so materials have something real to reflect without
    // shipping an HDR file. This is most of why the pieces read as solid.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new RoomEnvironment();
    this.envMap = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environment = this.envMap;
    envScene.dispose?.();
    pmrem.dispose();
  }

  /** Apply a theme's background, fog, lighting and exposure. */
  applyTheme(theme) {
    if (this._bgTexture) this._bgTexture.dispose();
    this._bgTexture = backgroundTexture(theme);
    this.scene.background = this._bgTexture;

    if (theme.fog) {
      this.scene.fog = new THREE.Fog(theme.fog.color, theme.fog.near, theme.fog.far);
      this._fogSpec = theme.fog;
      this.updateFog(this.camera.position.length());
    } else {
      this.scene.fog = null;
      this._fogSpec = null;
    }

    const L = theme.lighting || {};
    if (L.hemi) {
      this.hemi.color.set(L.hemi.sky);
      this.hemi.groundColor.set(L.hemi.ground);
      this.hemi.intensity = L.hemi.intensity;
    }
    if (L.key) {
      this.key.color.set(L.key.color);
      this.key.intensity = L.key.intensity;
      if (L.key.position) this.key.position.set(...L.key.position);
    }
    if (L.fill) {
      this.fill.color.set(L.fill.color);
      this.fill.intensity = L.fill.intensity;
      if (L.fill.position) this.fill.position.set(...L.fill.position);
    }
    this.renderer.toneMappingExposure = L.exposure !== undefined ? L.exposure : 1.0;
    this.scene.environmentIntensity = L.envIntensity !== undefined ? L.envIntensity : 1.0;
  }

  /**
   * Keep the fog behind the board however far away the camera is.
   *
   * A theme's fog distances are written for the ordinary desktop view. On a
   * tall screen the camera pulls back more than twice as far to fit the board
   * across the width, and fixed distances then swallow the whole scene in fog
   * colour. Slide the band with the camera so it always begins just behind the
   * board and does what it is there for — giving depth to what is beyond it.
   */
  updateFog(distance) {
    if (!this.scene.fog || !this._fogSpec) return;
    const shift = distance - REFERENCE_DISTANCE;
    this.scene.fog.near = this._fogSpec.near + shift;
    this.scene.fog.far = this._fogSpec.far + shift;
  }

  /**
   * Shift what the camera renders up or down the canvas, in pixels.
   *
   * The canvas fills the window, but the chrome does not: a top bar covers the
   * first sixty pixels and, on a narrow screen, the move panel and controls
   * cover the last three hundred. Centring the board in the canvas therefore
   * centres it behind the furniture. This offsets the projection in screen
   * space, so the board sits in the space actually left for it — and because
   * the shift is in screen space, it holds however the board is turned.
   */
  setViewShift(pixelsUp) {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this._viewShift = pixelsUp;
    if (!pixelsUp) {
      this.camera.clearViewOffset();
    } else {
      this.camera.setViewOffset(w, h, 0, pixelsUp, w, h);
    }
    this.camera.updateProjectionMatrix();
  }

  _observeSize() {
    const resize = () => {
      const parent = this.canvas.parentElement || document.body;
      const w = Math.max(1, parent.clientWidth);
      const h = Math.max(1, parent.clientHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (this._viewShift) this.setViewShift(this._viewShift);
    };
    this._resize = resize;
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(resize);
      this._ro.observe(this.canvas.parentElement || document.body);
    }
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 120));
    resize();
  }

  add(object) {
    this.scene.add(object);
  }

  onFrame(fn) {
    this.updaters.push(fn);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._clock.start();
    const tick = () => {
      if (!this._running) return;
      this._frame = requestAnimationFrame(tick);
      const dt = Math.min(this._clock.getDelta(), 0.05);
      for (const fn of this.updaters) fn(dt);
      this.updateFog(this.camera.position.length());
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  stop() {
    this._running = false;
    if (this._frame) cancelAnimationFrame(this._frame);
  }
}
