// Shared noise field + the canvas-based <noise-dissolve> effect.
// The field is /noise.png rank-transformed into evenly distributed values in [0, 1],
// so "dissolve amount" maps linearly to the share of pixels that disappear.

export type NoiseVariant = "dissolve" | "sweep" | "static";

export interface NoiseOptions {
  variant: NoiseVariant;
  amount: number;
  outDuration: number;
  inDuration: number;
  fps: number;
  boil: number;
  grain: number;
  tone: number;
  scatter: number;
}

export interface NoiseField {
  size: number;
  values: Float32Array;
}

export const NOISE_DEFAULTS: NoiseOptions = {
  variant: "dissolve",
  amount: 0.5,
  outDuration: 260,
  inDuration: 420,
  fps: 24,
  boil: 8,
  grain: 1,
  tone: 0.5,
  scatter: 3,
};

const NOISE_URL = "/noise.png";
const MAX_DPR = 2;
const SWEEP_SOFTNESS = 0.3; // width of the sweep front, as a share of the element width
const SCATTER_BAND = 0.2; // cells this close above the cutoff jitter in the "static" variant
const STRAY_CHANCE = 0.12; // chance a dissolved cell reappears displaced in the "static" variant
const ASSEMBLE_SLOWDOWN = 1.8;

/** Integer hash → [0, 1). */
export function hash01(input: number) {
  let h = input | 0;
  h = Math.imul(h ^ (h >>> 16), 2146121005);
  h = Math.imul(h ^ (h >>> 15), 2221713035);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(Error(`Could not load ${src}`));
    image.src = src;
  });
}

let fieldPromise: Promise<NoiseField> | null = null;

/** Loads the noise texture once and returns its rank-normalised values (cached; retried after a failure). */
export function loadNoiseField(url = NOISE_URL): Promise<NoiseField> {
  fieldPromise ??= loadImage(url).then((image) => {
    const size = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw Error("2D canvas unavailable");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, size, size);
    const count = size * size;

    // Red channel plus a tiny hash jitter so equal values still get distinct ranks.
    const raw = new Float32Array(count);
    for (let i = 0; i < count; i++) raw[i] = data[i * 4] / 256 + hash01(i) / 256;

    // Positive floats sort the same as their bit patterns; pack bits and index into one sortable number.
    const bits = new Uint32Array(raw.buffer);
    const keyed = new Float64Array(count);
    for (let i = 0; i < count; i++) keyed[i] = bits[i] * count + i;
    keyed.sort();

    const values = new Float32Array(count);
    for (let rank = 0; rank < count; rank++) values[keyed[rank] % count] = rank / (count - 1);
    return { size, values };
  });
  fieldPromise.catch(() => {
    fieldPromise = null;
  });
  return fieldPromise;
}

let texturePromise: Promise<{ url: string; size: number }> | null = null;

/** The noise field as an RGB PNG data URL: three decorrelated (offset) copies in R, G and B. */
export function getNoiseTextureUrl(): Promise<{ url: string; size: number }> {
  texturePromise ??= loadNoiseField().then(({ size, values }) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw Error("2D canvas unavailable");
    const image = context.createImageData(size, size);
    const data = image.data;
    const sample = (x: number, y: number) => values[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        data[i] = Math.round(sample(x, y) * 255);
        data[i + 1] = Math.round(sample(x + 131, y + 97) * 255);
        data[i + 2] = Math.round(sample(x + 61, y + 173) * 255);
        data[i + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    return { url: canvas.toDataURL("image/png"), size };
  });
  texturePromise.catch(() => {
    texturePromise = null;
  });
  return texturePromise;
}

interface Tween {
  from: number;
  to: number;
  start: number;
  duration: number;
}

interface Raster {
  key: string;
  width: number;
  height: number;
  dpr: number;
  pixels: Uint8ClampedArray;
  output: ImageData;
  opaque: Uint32Array; // indices of non-transparent pixels
}

interface Grid {
  cell: number;
  columns: number;
  cellOf: Uint32Array; // grain cell of each opaque pixel
}

type Source = HTMLImageElement | SVGSVGElement;

/**
 * Draws `source` (an <img> or inline <svg>) into a canvas overlay inside `host` and dissolves it
 * through the noise field. `progress` 0 = intact, 1 = dissolved by `amount`.
 */
export class NoiseDissolve {
  host: HTMLElement;
  source: Source;
  getOptions: () => Partial<NoiseOptions>;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  noise: NoiseField | null = null;
  raster: Raster | null = null;
  grid: Grid | null = null;
  bitmapCache = new Map<string, Promise<CanvasImageSource>>();
  progress = 0;
  tween: Tween | null = null;
  peakOverride: number | null = null;
  frame = 0;
  lastStep = NaN;
  renders = 0;
  showing = false;
  destroyed = false;
  seed = Math.floor(Math.random() * 1e6);

  constructor(host: HTMLElement, source: Source, getOptions: () => Partial<NoiseOptions> = () => ({})) {
    this.host = host;
    this.source = source;
    this.getOptions = getOptions;
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-hidden", "true");
    Object.assign(this.canvas.style, { position: "absolute", pointerEvents: "none", display: "none" });
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw Error("2D canvas unavailable");
    this.context = context;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.append(this.canvas);
  }

  get isActive() {
    return this.progress > 0 || this.tween !== null;
  }

  enter() {
    if (this.destroyed || prefersReducedMotion()) return;
    this.peakOverride = null;
    this.tweenTo(1, this.options().outDuration);
    this.start();
  }

  leave() {
    if (this.destroyed) return;
    if (prefersReducedMotion()) {
      this.reset();
      return;
    }
    this.tweenTo(0, this.options().inDuration);
    this.start();
  }

  pulse() {
    this.enter();
    window.setTimeout(() => this.leave(), this.options().outDuration);
  }

  /** Start fully dissolved and slowly build the image up (scroll reveal). */
  assemble() {
    if (this.destroyed) return;
    if (prefersReducedMotion()) {
      this.reset();
      return;
    }
    this.conceal();
    this.peakOverride = 1;
    this.progress = 1;
    this.tween = null;
    this.tweenTo(0, this.options().inDuration * ASSEMBLE_SLOWDOWN);
    this.start();
  }

  conceal() {
    this.source.style.visibility = "hidden";
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.reset();
    this.canvas.remove();
    this.raster = null;
    this.grid = null;
  }

  options(): NoiseOptions {
    return { ...NOISE_DEFAULTS, ...this.getOptions() };
  }

  tweenTo(to: number, duration: number) {
    const distance = Math.abs(to - this.progress);
    if (distance === 0 && !this.tween) return;
    this.tween = { from: this.progress, to, start: performance.now(), duration: Math.max(1, duration * distance) };
  }

  async start() {
    try {
      const [noise, raster] = await Promise.all([loadNoiseField(), this.prepare()]);
      if (this.destroyed) return;
      if (!raster) {
        this.reset();
        return;
      }
      this.noise = noise;
      this.frame ||= requestAnimationFrame(this.tick);
    } catch (error) {
      console.warn("[noise-dissolve]", error);
      this.reset();
    }
  }

  reset() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.tween = null;
    this.progress = 0;
    this.peakOverride = null;
    this.hideCanvas();
  }

  hideCanvas() {
    this.showing = false;
    this.canvas.style.display = "none";
    this.source.style.visibility = "";
  }

  tick = (time: number) => {
    this.frame = 0;
    if (this.destroyed) return;
    const options = this.options();
    const tween = this.tween;
    if (tween) {
      const t = clamp01((time - tween.start) / tween.duration);
      this.progress = tween.from + (tween.to - tween.from) * easeOutCubic(t);
      if (t >= 1) {
        this.progress = tween.to;
        this.tween = null;
      }
    }
    if (!this.tween && this.progress <= 0) {
      this.progress = 0;
      this.peakOverride = null;
      this.hideCanvas();
      return;
    }

    // Redraw at `fps` while tweening and at `boil` (grain re-roll rate) while holding.
    const tweening = this.tween !== null;
    const rate = tweening ? options.fps : options.boil;
    let due: boolean;
    if (rate > 0) {
      const step = Math.floor((time * rate) / 1000);
      due = step !== this.lastStep;
      this.lastStep = step;
    } else {
      due = tweening || !this.showing;
      this.lastStep = NaN;
    }
    if (due) this.render(time, options);
    if (tweening || options.boil > 0) this.frame = requestAnimationFrame(this.tick);
  };

  /** The source's painted box relative to the host (honours object-fit: contain / scale-down). */
  measure() {
    const hostRect = this.host.getBoundingClientRect();
    let { left, top, width, height } = this.source.getBoundingClientRect();
    if (this.source instanceof HTMLImageElement) {
      const fit = getComputedStyle(this.source).objectFit;
      const naturalWidth = this.source.naturalWidth;
      const naturalHeight = this.source.naturalHeight;
      if ((fit === "contain" || fit === "scale-down") && naturalWidth && naturalHeight) {
        const scale = Math.min(width / naturalWidth, height / naturalHeight, fit === "scale-down" ? 1 : Infinity);
        const fittedWidth = naturalWidth * scale;
        const fittedHeight = naturalHeight * scale;
        left += (width - fittedWidth) / 2;
        top += (height - fittedHeight) / 2;
        width = fittedWidth;
        height = fittedHeight;
      }
    }
    return {
      left: left - hostRect.left - this.host.clientLeft,
      top: top - hostRect.top - this.host.clientTop,
      width,
      height,
    };
  }

  bitmap(): Promise<CanvasImageSource> {
    if (this.source instanceof HTMLImageElement) {
      const image = this.source;
      const key = image.currentSrc || image.src;
      let cached = this.bitmapCache.get(key);
      if (!cached) {
        cached = image.complete && image.naturalWidth ? Promise.resolve(image) : image.decode().then(() => image);
        this.bitmapCache.set(key, cached);
      }
      return cached;
    }

    // Inline SVG: serialise a sized clone (with the resolved currentColor) into an image.
    const svg = this.source;
    const key = "inline";
    let cached = this.bitmapCache.get(key);
    if (!cached) {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      const { width, height } = svg.getBoundingClientRect();
      clone.setAttribute("width", String(width));
      clone.setAttribute("height", String(height));
      clone.setAttribute("color", getComputedStyle(svg).color);
      if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const markup = new XMLSerializer().serializeToString(clone);
      cached = loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
      this.bitmapCache.set(key, cached);
    }
    return cached;
  }

  /** Positions the canvas over the source and rasterises the source at device resolution (cached by size). */
  prepare(): Promise<Raster | null> {
    if (this.showing && this.raster) return Promise.resolve(this.raster);
    const box = this.measure();
    if (box.width < 1 || box.height < 1) return Promise.resolve(null);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const width = Math.round(box.width * dpr);
    const height = Math.round(box.height * dpr);
    const key = `${width}x${height}`;
    Object.assign(this.canvas.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    if (this.raster?.key === key) return Promise.resolve(this.raster);

    return this.bitmap().then((image) => {
      if (this.destroyed) return null;
      this.canvas.width = width;
      this.canvas.height = height;
      const context = this.context;
      context.clearRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      context.clearRect(0, 0, width, height);
      const opaque: number[] = [];
      for (let i = 0; i < width * height; i++) if (pixels[i * 4 + 3] !== 0) opaque.push(i);
      this.raster = {
        key,
        width,
        height,
        dpr,
        pixels,
        output: context.createImageData(width, height),
        opaque: Uint32Array.from(opaque),
      };
      this.grid = null;
      return this.raster;
    });
  }

  /** Maps each opaque pixel to its grain cell (`grain` CSS px square). */
  gridFor(raster: Raster, grain: number): Grid {
    const cell = Math.max(1, Math.round(grain * raster.dpr));
    if (this.grid?.cell === cell) return this.grid;
    const columns = Math.ceil(raster.width / cell);
    const { opaque, width } = raster;
    const cellOf = new Uint32Array(opaque.length);
    for (let i = 0; i < opaque.length; i++) {
      const pixel = opaque[i];
      const x = pixel % width;
      const y = (pixel - x) / width;
      cellOf[i] = Math.floor(y / cell) * columns + Math.floor(x / cell);
    }
    this.grid = { cell, columns, cellOf };
    return this.grid;
  }

  render(time: number, options: NoiseOptions) {
    const raster = this.raster;
    const noise = this.noise;
    if (!raster || !noise) return;
    const { width, height, pixels, output, opaque, dpr } = raster;
    const { columns, cellOf } = this.gridFor(raster, options.grain);
    const size = noise.size;
    const field = noise.values;
    const peak = this.peakOverride ?? clamp01(options.amount);
    const progress = this.progress;
    const sweep = options.variant === "sweep";
    const isStatic = options.variant === "static";
    const tone = clamp01(options.tone);
    const scatter = Math.round(options.scatter * dpr);
    const lastColumn = Math.max(1, columns - 1);

    // Each boil step shifts the noise lookups to a new random offset.
    const boilStep = options.boil > 0 ? Math.floor((time * options.boil) / 1000) : 0;
    const frameSeed = this.seed + boilStep * 7919;
    const offsetX = Math.floor(hash01(frameSeed) * size);
    const offsetY = Math.floor(hash01(frameSeed + 1) * size);
    const toneOffsetX = Math.floor(hash01(frameSeed + 2) * size);
    const toneOffsetY = Math.floor(hash01(frameSeed + 3) * size);

    const sweepFront = progress * 1.3;
    const cutoffAll = peak * progress;
    const renderIndex = this.renders++;
    const out = output.data;
    out.fill(0);

    // Opaque pixels are in row order, so consecutive pixels usually share a cell: compute per cell once.
    let currentCell = -1;
    let visible = false;
    let alpha = 1;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < opaque.length; i++) {
      const cell = cellOf[i];
      if (cell !== currentCell) {
        currentCell = cell;
        const column = cell % columns;
        const row = (cell - column) / columns;
        let local = progress;
        if (sweep) local = clamp01((sweepFront - column / lastColumn) / SWEEP_SOFTNESS);
        const cutoff = sweep ? peak * local : cutoffAll;
        const value = field[((row + offsetY) % size) * size + ((column + offsetX) % size)];
        visible = value >= cutoff;
        alpha = 1;
        dx = 0;
        dy = 0;
        if (visible && tone > 0 && local > 0) {
          const toneValue = field[((row + toneOffsetY) % size) * size + ((column + toneOffsetX) % size)];
          alpha = 1 - tone * local * (1 - toneValue);
        }
        if (isStatic && scatter > 0 && cutoff > 0) {
          const cellSeed = this.seed + cell * 31 + renderIndex * 104729;
          if (visible && value < cutoff + SCATTER_BAND) {
            // Survivors near the edge of the dissolve jitter.
            dx = Math.round((hash01(cellSeed) * 2 - 1) * scatter * local);
            dy = Math.round((hash01(cellSeed + 1) * 2 - 1) * scatter * local);
          } else if (!visible && hash01(cellSeed + 2) < STRAY_CHANCE * local) {
            // A few dissolved cells flicker back further away.
            visible = true;
            alpha = 1 - tone * local * hash01(cellSeed + 5);
            dx = Math.round((hash01(cellSeed + 3) * 2 - 1) * scatter * 2.5);
            dy = Math.round((hash01(cellSeed + 4) * 2 - 1) * scatter * 2.5);
          }
        }
      }
      if (!visible) continue;

      const source = opaque[i];
      let target = source;
      if (dx || dy) {
        const x = (source % width) + dx;
        const y = Math.floor(source / width) + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        target = y * width + x;
      }
      const from = source * 4;
      const to = target * 4;
      out[to] = pixels[from];
      out[to + 1] = pixels[from + 1];
      out[to + 2] = pixels[from + 2];
      out[to + 3] = pixels[from + 3] * alpha;
    }

    this.context.putImageData(output, 0, 0);
    if (!this.showing) {
      this.showing = true;
      this.canvas.style.display = "block";
      this.source.style.visibility = "hidden";
    }
  }
}

const VARIANTS: NoiseVariant[] = ["dissolve", "sweep", "static"];

/** Reads data-variant/amount/out/in/fps/boil/grain/tone/scatter from an element. */
export function readNoiseOptions(element: HTMLElement): Partial<NoiseOptions> {
  const data = element.dataset;
  const toNumber = (value: string | undefined) => {
    const number = value === undefined || value === "" ? NaN : Number(value);
    return Number.isFinite(number) ? number : undefined;
  };
  const options: Partial<NoiseOptions> = {};
  const variant = data.variant as NoiseVariant | undefined;
  if (variant && VARIANTS.includes(variant)) options.variant = variant;
  const numeric: [keyof NoiseOptions, number | undefined][] = [
    ["amount", toNumber(data.amount)],
    ["outDuration", toNumber(data.out)],
    ["inDuration", toNumber(data.in)],
    ["fps", toNumber(data.fps)],
    ["boil", toNumber(data.boil)],
    ["grain", toNumber(data.grain)],
    ["tone", toNumber(data.tone)],
    ["scatter", toNumber(data.scatter)],
  ];
  for (const [key, value] of numeric) if (value !== undefined) (options as any)[key] = value;
  return options;
}
