// Embossed / carved 3D relief of an SVG logo, lit by a light that follows the pointer.
// Ported from the production bundle (three.js r186 + this class).
import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshPhongMaterial,
  NoToneMapping,
  Path,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector2,
  VSMShadowMap,
  WebGLRenderer,
} from "three";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

export type Relief = "raised" | "carved";

export interface EmbossedIsotypeOptions {
  /** SVG URL, or inline SVG markup (anything starting with "<"). */
  src: string;
  relief?: Relief;
  /** CSS color, or "auto" to match the first opaque ancestor background. */
  color?: string;
  size?: number;
  depth?: number;
  bevel?: number;
  shadow?: number;
  travel?: number;
  softness?: number;
  lerp?: number;
  bounce?: number;
  reducedMotion?: boolean;
  onReady?: () => void;
}

type ResolvedOptions = Required<Omit<EmbossedIsotypeOptions, "onReady">> & { onReady?: () => void };

const DEFAULTS = {
  relief: "carved" as Relief,
  color: "auto",
  size: 0.55,
  shadow: 0.5,
  lerp: 0.05,
  bounce: 0.65,
  reducedMotion: false,
  onReady: undefined,
};

const RELIEF_PRESETS = {
  carved: { depth: 0.03, bevel: 0.02, travel: 1.2, softness: 5 },
  raised: { depth: 0.09, bevel: 0.03, travel: 1.6, softness: 24 },
};

/** The logo is normalised to this many world units across its longest side. */
const LOGO_SIZE = 100;
/** Points sampled per curve when flattening SVG shapes. */
const CURVE_SEGMENTS = 24;
/** Height of the light above the relief plane. */
const LIGHT_HEIGHT = LOGO_SIZE;
/** Resting light position (normalised -1..1), i.e. top-left. */
const REST = { x: -0.5, y: -0.5 };
/** Fixed physics step (60 Hz). */
const STEP_MS = 1000 / 60;
/** Target world units per shadow-map texel. */
const SHADOW_TEXEL = 0.35;

type Vec = { x: number; y: number };

export class EmbossedIsotype {
  canvas: HTMLCanvasElement;
  opts: ResolvedOptions;
  renderer?: WebGLRenderer;
  scene = new Scene();
  camera = new PerspectiveCamera(30, 1, 1, 10000);
  ambient = new AmbientLight(0xffffff, 0);
  light = new DirectionalLight(0xffffff, 0);
  material = new MeshPhongMaterial({ specular: 0, shininess: 0 });
  slab?: Mesh;
  logo?: Mesh;
  // Spring state for the light: pos chases target with velocity vel.
  target: Vec = { ...REST };
  pos: Vec = { ...REST };
  vel: Vec = { x: 0, y: 0 };
  raf = 0;
  lastTime = 0;
  accumulator = 0;
  visible = false;
  lastPointer?: Vec;
  dirty = true;
  ready = false;
  destroyed = false;
  resizeObserver?: ResizeObserver;
  intersectionObserver?: IntersectionObserver;
  hoverQuery = window.matchMedia("(hover: hover) and (pointer: fine)");

  constructor(canvas: HTMLCanvasElement, options: EmbossedIsotypeOptions) {
    this.canvas = canvas;
    const given = withoutUndefined(options);
    const relief: Relief = given.relief ?? DEFAULTS.relief;
    this.opts = { ...DEFAULTS, ...RELIEF_PRESETS[relief], ...given } as ResolvedOptions;
  }

  async init(): Promise<void> {
    const renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: "low-power",
    });
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = VSMShadowMap;

    const color = new Color(this.opts.color === "auto" ? detectBackground(this.canvas) : this.opts.color);
    this.material.color.copy(color);
    this.scene.background = color.clone();

    // Shadow strength splits a fixed light budget between ambient and the directional light.
    const shadow = clamp(this.opts.shadow, 0, 0.95);
    this.ambient.intensity = Math.PI * (1 - shadow);
    this.scene.add(this.ambient);

    const light = this.light;
    light.castShadow = true;
    light.shadow.blurSamples = 25;
    light.shadow.bias = -0.0005;
    light.shadow.camera.near = 1;
    light.shadow.camera.far = 800;
    this.scene.add(light, light.target);

    const shapes = await this.loadShapes();
    if (this.destroyed) return;

    const { page, logo } = this.opts.relief === "raised" ? this.buildRaised(shapes) : this.buildCarved(shapes);
    this.slab = new Mesh(page, this.material);
    this.logo = new Mesh(logo, this.material);
    for (const mesh of [this.slab, this.logo]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }

    this.applyLight();
    this.resize();

    if (renderer.extensions.has("KHR_parallel_shader_compile")) {
      try {
        await renderer.compileAsync(this.scene, this.camera);
      } catch {}
      if (this.destroyed) return;
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
      this.requestRender();
    });
    this.resizeObserver.observe(this.canvas);

    this.intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        this.visible = entry.isIntersecting;
        if (this.visible) {
          if (this.lastPointer) this.aimAt(this.lastPointer.x, this.lastPointer.y);
          this.requestRender();
        }
      },
      { rootMargin: "100px" },
    );
    this.intersectionObserver.observe(this.canvas);

    if (!this.opts.reducedMotion) {
      window.addEventListener("pointermove", this.onPointerMove, { passive: true });
      window.addEventListener("scroll", this.onScroll, { passive: true });
    }

    this.render();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("scroll", this.onScroll);
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.logo?.geometry.dispose();
    this.slab?.geometry.dispose();
    this.material.dispose();
    this.light.shadow.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
  }

  /** Loads the SVG's filled paths as shapes, centred and scaled to LOGO_SIZE (y flipped to world up). */
  async loadShapes(): Promise<Shape[]> {
    const loader = new SVGLoader();
    const src = this.opts.src.trim();
    const data = src.startsWith("<") ? loader.parse(src) : await loader.loadAsync(src);

    const shapes: Shape[] = [];
    for (const path of data.paths) {
      const fill = path.userData?.style?.fill;
      if (fill !== "none" && fill !== "transparent") shapes.push(...path.toShapes());
    }
    if (!shapes.length) throw Error(`No filled shapes found in ${this.opts.src}`);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const shape of shapes) {
      for (const p of shape.getPoints(CURVE_SEGMENTS)) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }

    const scale = LOGO_SIZE / Math.max(maxX - minX, maxY - minY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const toWorld = (p: Vector2) => new Vector2((p.x - cx) * scale, -(p.y - cy) * scale);

    return shapes.map((shape) => {
      const flat = new Shape(shape.getPoints(CURVE_SEGMENTS).map(toWorld));
      flat.holes = shape.holes.map((hole) => new Path(hole.getPoints(CURVE_SEGMENTS).map(toWorld)));
      return flat;
    });
  }

  /** Logo cut into the page: a huge plane with logo-shaped holes, plus the carved walls/floor behind it. */
  buildCarved(shapes: Shape[]) {
    const bevel = this.opts.bevel * LOGO_SIZE;
    const extrude = new ExtrudeGeometry(shapes, {
      depth: Math.max(this.opts.depth * LOGO_SIZE, 0.01),
      curveSegments: 1,
      bevelEnabled: bevel > 0,
      bevelSize: -bevel,
      bevelThickness: bevel,
      bevelOffset: 0,
      bevelSegments: 10,
    });
    // Push the extrusion behind z = 0, then drop its front cap (the holes stay open).
    extrude.translate(0, 0, bevel);
    extrude.scale(1, 1, -1);
    const cavity = dropFacesAtZ(extrude, 0);
    extrude.dispose();

    const extent = 3000;
    const page = new Shape([
      new Vector2(-extent, -extent),
      new Vector2(extent, -extent),
      new Vector2(extent, extent),
      new Vector2(-extent, extent),
    ]);
    // The logo's own holes (counters) stay at page level as islands.
    const islands: Shape[] = [];
    for (const shape of shapes) {
      page.holes.push(new Path(shape.getPoints()));
      for (const hole of shape.holes) islands.push(new Shape(hole.getPoints()));
    }

    return { page: new ShapeGeometry([page, ...islands]), logo: creased(cavity) };
  }

  /** Logo standing proud of a flat page. */
  buildRaised(shapes: Shape[]) {
    const bevel = this.opts.bevel * LOGO_SIZE;
    const extrude = new ExtrudeGeometry(shapes, {
      depth: Math.max(this.opts.depth * LOGO_SIZE, 0.01),
      curveSegments: 1,
      bevelEnabled: bevel > 0,
      bevelSize: bevel,
      bevelThickness: bevel,
      bevelOffset: -bevel,
      bevelSegments: 10,
    });
    return { page: new PlaneGeometry(6000, 6000), logo: creased(extrude) };
  }

  /** Moves the light over the relief; intensity compensates for distance so brightness stays even. */
  applyLight() {
    const range = this.opts.travel * LIGHT_HEIGHT;
    const x = this.pos.x * range;
    const y = -this.pos.y * range;
    this.light.position.set(x, y, LIGHT_HEIGHT);
    const cosine = LIGHT_HEIGHT / Math.hypot(x, y, LIGHT_HEIGHT);
    const intensity = Math.PI * clamp(this.opts.shadow, 0, 0.95);
    this.light.intensity = intensity / cosine;
  }

  onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" && !this.hoverQuery.matches) return;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    if (this.visible) {
      this.aimAt(event.clientX, event.clientY);
      this.requestRender();
    }
  };

  /** Points the light target at a viewport position, relative to the canvas centre (-1..1). */
  aimAt(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.target.x = clamp((clientX - rect.left - rect.width / 2) / (rect.width / 2), -1, 1);
    this.target.y = clamp((clientY - rect.top - rect.height / 2) / (rect.height / 2), -1, 1);
  }

  /** Touch devices: scroll position drives the light vertically instead of the pointer. */
  onScroll = () => {
    if (this.hoverQuery.matches || !this.visible) return;
    const rect = this.canvas.getBoundingClientRect();
    const progress = (rect.top + rect.height / 2) / window.innerHeight;
    this.target.x = REST.x;
    this.target.y = clamp(progress * 2 - 1, -1, 1) * 0.9;
    this.requestRender();
  };

  requestRender() {
    this.dirty = true;
    if (this.raf || this.destroyed) return;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  tick = (now: number) => {
    this.raf = 0;
    if (this.destroyed) return;

    this.accumulator += Math.min(now - this.lastTime, 100);
    this.lastTime = now;

    // Damped spring, stepped at a fixed rate so feel doesn't depend on refresh rate.
    const { lerp, bounce } = this.opts;
    while (this.accumulator >= STEP_MS) {
      this.accumulator -= STEP_MS;
      for (const axis of ["x", "y"] as const) {
        this.vel[axis] = this.vel[axis] * bounce + (this.target[axis] - this.pos[axis]) * lerp;
        this.pos[axis] += this.vel[axis];
      }
    }

    const settled =
      Math.abs(this.vel.x) < 1e-4 &&
      Math.abs(this.vel.y) < 1e-4 &&
      Math.abs(this.target.x - this.pos.x) < 1e-4 &&
      Math.abs(this.target.y - this.pos.y) < 1e-4;

    if (this.visible || this.dirty) {
      this.applyLight();
      this.render();
    }
    if (!settled && this.visible) this.raf = requestAnimationFrame(this.tick);
  };

  render() {
    if (!this.renderer) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    if (!this.ready) {
      this.ready = true;
      this.opts.onReady?.();
    }
  }

  /** Sizes the renderer and pulls the camera back so the logo fills `size` of the shorter side. */
  resize() {
    if (!this.renderer) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;

    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    this.camera.aspect = aspect;

    const halfFovTan = Math.tan((this.camera.fov * Math.PI) / 360);
    const framed = LOGO_SIZE / clamp(this.opts.size, 0.05, 1);
    const distance = aspect >= 1 ? framed / (2 * halfFovTan) : framed / (2 * halfFovTan * aspect);
    this.camera.position.set(0, 0, distance);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();

    const viewHeight = 2 * distance * halfFovTan;
    this.fitShadow(Math.max(viewHeight, viewHeight * aspect));
  }

  /** Fits the shadow frustum to the view (plus light travel) and keeps texel size / blur radius constant. */
  fitShadow(viewSize: number) {
    const shadow = this.light.shadow;
    const half = (viewSize / 2) * (1 + this.opts.travel * 0.5);
    const mapSize = clamp(2 ** Math.ceil(Math.log2((2 * half) / SHADOW_TEXEL)), 256, 2048);
    const texel = (2 * half) / mapSize;
    const cam = shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.updateProjectionMatrix();
    shadow.radius = this.opts.softness * (SHADOW_TEXEL / texel);
    if (shadow.mapSize.x !== mapSize) {
      shadow.mapSize.set(mapSize, mapSize);
      shadow.map?.dispose();
      shadow.map = null;
    }
  }
}

/** Smooth normals across shallow angles, keep hard edges past 30 degrees. */
function creased(geometry: BufferGeometry): BufferGeometry {
  const result = toCreasedNormals(geometry, Math.PI / 6);
  if (result !== geometry) geometry.dispose();
  return result;
}

/** Copies a geometry's positions, skipping triangles that lie entirely on the plane z = `z`. */
function dropFacesAtZ(geometry: BufferGeometry, z: number): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = flat.getAttribute("position");
  const kept: number[] = [];
  const eps = 1e-4;
  for (let i = 0; i < position.count; i += 3) {
    const onPlane =
      Math.abs(position.getZ(i) - z) < eps &&
      Math.abs(position.getZ(i + 1) - z) < eps &&
      Math.abs(position.getZ(i + 2) - z) < eps;
    if (onPlane) continue;
    for (let v = i; v < i + 3; v++) kept.push(position.getX(v), position.getY(v), position.getZ(v));
  }
  if (flat !== geometry) flat.dispose();
  const result = new BufferGeometry();
  result.setAttribute("position", new Float32BufferAttribute(kept, 3));
  return result;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function withoutUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** First opaque background colour up the ancestor chain, falling back to body, then white. */
function detectBackground(el: HTMLElement): string {
  let node = el.parentElement;
  while (node) {
    const hex = cssColorToHex(getComputedStyle(node).backgroundColor);
    if (hex) return hex;
    node = node.parentElement;
  }
  return cssColorToHex(getComputedStyle(document.body).backgroundColor) ?? "#ffffff";
}

/** Resolves any CSS colour to #rrggbb via a 1px canvas; null if (nearly) transparent. */
function cssColorToHex(css: string): string | null {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a < 250 ? null : `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
