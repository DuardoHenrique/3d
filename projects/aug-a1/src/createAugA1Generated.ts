import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
}

// Plan 1.3 F.6 — sweep a thin 2D cross-section along a 3D spine so a curved
// form (hooked blade, handle) reads correctly from EVERY camera angle, not just
// the reference angle a flat extrude happens to match. Uses ExtrudeGeometry's
// native extrudePath; bevelEnabled: false keeps sharp tips (same rule as F.5).
function buildCurveSweepGeometry(
  sweep: { spine: [number, number, number][]; crossSection: { points: [number, number][] }; closed?: boolean },
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const cs = sweep.crossSection.points;
  if (cs.length > 0) {
    shape.moveTo(cs[0][0], cs[0][1]);
    for (let i = 1; i < cs.length; i += 1) shape.lineTo(cs[i][0], cs[i][1]);
    shape.closePath();
  }
  const spine = sweep.spine.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const path = new THREE.CatmullRomCurve3(spine, sweep.closed ?? false);
  return new THREE.ExtrudeGeometry(shape, {
    extrudePath: path,
    steps: Math.max(24, spine.length * 8),
    bevelEnabled: false,
  });
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Steyr AUG A1
// Sculpt build pass: material-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createSteyrAUGA1Model(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Steyr AUG A1";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": "image-only", "referenceCamera": {"solved": true, "fovDegrees": 35.0, "aspect": 2.2857142857142856, "projection": "orthographic-matching", "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, -0.04, 1.45], "secondaryLeftOrientation": {"yaw": 175.0, "pitch": 0.0, "roll": 0.0}, "note": "Primary right elevation (+Z facing camera, muzzle +X); secondary left elevation (-Z facing camera with slight 5-deg yaw matching aug_left_side.png)."}, "approximationNotes": []};
  root.userData.materialPipeline = {"schemaVersion": 1, "status": "proceed", "registry": "/home/eduardo/Antigravity/3D/docs/materials/material-reference.json", "analysisArtifact": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-analysis.json", "targetThreshold": 0.7, "unresolvedNotObservedMaterials": [], "regions": [{"componentId": "polymer_stock_chassis", "regionId": "od-polymer-stock", "specMaterialId": "mat_polymer_od", "profileId": "plastic.matte", "status": "proceed"}, {"componentId": "upper_receiver_metal", "regionId": "anodized-receiver", "specMaterialId": "mat_receiver_anodized", "profileId": "metal.aluminum", "status": "proceed"}, {"componentId": "integrated_optic_carry_handle", "regionId": "weathered-optic-housing", "specMaterialId": "mat_optic_worn_metal", "profileId": "coating.painted-metal", "status": "proceed"}, {"componentId": "barrel_gas_muzzle_assembly", "regionId": "parkerized-barrel-muzzle", "specMaterialId": "mat_barrel_parkerized", "profileId": "metal.steel-brushed", "status": "proceed"}, {"componentId": "waffle_magazine_assembly", "regionId": "translucent-waffle-mag", "specMaterialId": "mat_mag_translucent", "profileId": "glass.frosted", "status": "proceed"}, {"componentId": "rubber_buttpad", "regionId": "buttpad-rubber", "specMaterialId": "mat_rubber_buttpad", "profileId": "rubber.matte", "status": "proceed"}], "controlledViewsRequired": ["albedo-unlit", "backlight-transmission", "environment-reflection", "grazing", "neutral-studio", "reference-beauty"]};
  root.userData.materialReferenceRegistry = "/home/eduardo/Antigravity/3D/docs/materials/material-reference.json";

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["mat_polymer_od"] = createSculptMaterial(
    "mat_polymer_od",
    {"id": "mat_polymer_od", "baseColor": "#5c5844", "secondaryColor": "#4d4937", "colorVariation": "Procedural canvas noise/patina blending #5c5844 and #4d4937 with deterministic seeded wear", "metalness": {"base": 0.02, "variation": 0.08}, "roughness": {"base": 0.74, "variation": 0.14, "map": "procedural-canvas:mat_polymer_od_roughness_channel"}, "clearcoat": 0.0, "clearcoatRoughness": 0.2, "transmission": 0.0, "ior": 1.48, "opacity": 1.0, "transparent": false, "envMapIntensity": 0.9, "needsEnvironment": false, "normal": {"type": "procedural-sobel-canvas", "strength": 0.45, "scale": 1.0}, "bump": {"amplitude": 0.0008, "scale": 1.0}, "ambientOcclusion": {"strength": 0.55, "map": "procedural-cavity-ao:mat_polymer_od_ao"}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-box-uv", "texelDensityIntent": "high-density close-up uniform texel scale across rifle length", "repeat": [1, 1], "anisotropy": 8}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 3.0, "amplitude": 0.15, "description": "broad molded polymer sheen gradient"}, {"id": "meso", "frequency": 18.0, "amplitude": 0.25, "description": "handling scuffs and faint mold parting lines"}, {"id": "micro", "frequency": 140.0, "amplitude": 0.35, "description": "fine injection-molded polymer stipple grain"}], "localOverrides": [{"id": "stock-scratches", "region": "buttstock cheek & lower flank", "effect": "fine lighter scratches (#7b7660) with slightly lower roughness (0.58)", "evidenceRef": "refs/aug_right_side.png"}, {"id": "grip-burnish", "region": "pistol grip & trigger guard edges", "effect": "hand-worn lower roughness (0.55) along palm swell", "evidenceRef": "refs/aug_right_side.png"}], "shaderNotes": ["SRGBColorSpace for color map; NoColorSpace for roughnessMap, metalnessMap, normalMap, aoMap", "Independent canvas channels per material; zero cross-channel aliasing"], "pbrEvidenceName": "od-polymer-stock", "referenceMaterialId": "plastic.matte", "materialFamily": "plastic", "materialSubtype": "generic-polymer", "materialFinish": "matte", "materialReference": {"registry": "/home/eduardo/Antigravity/3D/docs/materials/material-reference.json", "profileId": "plastic.matte", "method": "family-subtype-finish", "confidence": 0.765, "sourceRefs": ["three.mesh-standard", "adobe.pbr-guide-1", "google.filament-pbr", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "aoMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing"]}, "referencePbr": {"version": "1.0", "sourceImage": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/00-od-polymer-stock.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.765, "estimatedFidelity": 0.765, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-00-od-polymer-stock/mat-polymer-od_albedo.png", "url": "mat-polymer-od_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-00-od-polymer-stock/mat-polymer-od_roughness.png", "url": "mat-polymer-od_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-00-od-polymer-stock/mat-polymer-od_height.png", "url": "mat-polymer-od_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-00-od-polymer-stock/mat-polymer-od_normal.png", "url": "mat-polymer-od_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-00-od-polymer-stock/mat-polymer-od_ao.png", "url": "mat-polymer-od_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 150, "sourceHeight": 100, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 150, "height": 100}, "mask": {"backgroundColor": "#625E49", "backgroundNoise": 27.148, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9917}, "mapStats": {"valueRange": 0.2241, "heightP90Gradient": 0.03976, "roughnessBase": 0.707, "roughnessVariation": 0.069, "normalStrength": 0.203, "blurRadius": 10}, "palette": ["#635F4C", "#595541", "#4D4836", "#2E2C1F", "#FCFCFB"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "low value range weakens height/roughness inference"]}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#696653", "#605D4A", "#615D4A", "#4C4836", "#827F73"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 86.6, "meanSaturation": 0.254, "gradientStrength": 0.324, "mottle": 0.012, "streakRatio": 0.62, "hueSpread": 0.002, "specularFraction": 0.028}}, "materialEvidence": {"componentId": "polymer_stock_chassis", "regionId": "od-polymer-stock", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/00-od-polymer-stock.png", "bbox": {"x": 90, "y": 175, "width": 150, "height": 100}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.0327}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "polymer_stock_chassis", "regionId": "od-polymer-stock", "materialId": null, "family": "plastic", "subtype": "generic-polymer", "finish": "matte", "aliases": [], "confidence": 0.765, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["mat_receiver_anodized"] = createSculptMaterial(
    "mat_receiver_anodized",
    {"id": "mat_receiver_anodized", "baseColor": "#2c2d2e", "secondaryColor": "#4e5154", "colorVariation": "Procedural canvas noise/patina blending #2c2d2e and #4e5154 with deterministic seeded wear", "metalness": {"base": 0.84, "variation": 0.08}, "roughness": {"base": 0.4, "variation": 0.14, "map": "procedural-canvas:mat_receiver_anodized_roughness_channel"}, "clearcoat": 0.12, "clearcoatRoughness": 0.35, "transmission": 0.0, "ior": 1.48, "opacity": 1.0, "transparent": false, "envMapIntensity": 1.1, "needsEnvironment": true, "normal": {"type": "procedural-sobel-canvas", "strength": 0.45, "scale": 1.0}, "bump": {"amplitude": 0.0008, "scale": 1.0}, "ambientOcclusion": {"strength": 0.55, "map": "procedural-cavity-ao:mat_receiver_anodized_ao"}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-box-uv", "texelDensityIntent": "high-density close-up uniform texel scale across rifle length", "repeat": [1, 1], "anisotropy": 8}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 4.0, "amplitude": 0.12, "description": "broad anodized tonal response"}, {"id": "meso", "frequency": 24.0, "amplitude": 0.3, "description": "machined flute streaks and corner wear"}, {"id": "micro", "frequency": 110.0, "amplitude": 0.22, "description": "anodized bead-blast micro-pitting"}], "localOverrides": [{"id": "flute-edge-wear", "region": "receiver chamfered ridges & flute lips", "effect": "exposed bright aluminum edge highlights (#7c8085), roughness 0.24, metalness 0.92", "evidenceRef": "refs/aug_right_side.png"}], "shaderNotes": ["SRGBColorSpace for color map; NoColorSpace for roughnessMap, metalnessMap, normalMap, aoMap", "Independent canvas channels per material; zero cross-channel aliasing"], "pbrEvidenceName": "anodized-receiver", "referenceMaterialId": "metal.aluminum", "materialFamily": "metal", "materialSubtype": "aluminum", "materialFinish": "satin", "materialReference": {"registry": "/home/eduardo/Antigravity/3D/docs/materials/material-reference.json", "profileId": "metal.aluminum", "method": "family-subtype-finish", "confidence": 0.909, "sourceRefs": ["three.mesh-standard", "three.pmrem", "gltf.2", "khronos.gltf-pbr", "adobe.pbr-guide-2", "google.filament-pbr"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "anisotropyMap"], "validationViews": ["neutral-studio", "environment-reflection", "grazing"]}, "anisotropy": {"base": 0.2, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/01-anodized-receiver.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.909, "estimatedFidelity": 0.909, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-01-anodized-receiver/mat-receiver-anodized_albedo.png", "url": "mat-receiver-anodized_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-01-anodized-receiver/mat-receiver-anodized_roughness.png", "url": "mat-receiver-anodized_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-01-anodized-receiver/mat-receiver-anodized_height.png", "url": "mat-receiver-anodized_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-01-anodized-receiver/mat-receiver-anodized_normal.png", "url": "mat-receiver-anodized_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-01-anodized-receiver/mat-receiver-anodized_ao.png", "url": "mat-receiver-anodized_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 135, "sourceHeight": 34, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 135, "height": 34}, "mask": {"backgroundColor": "#2A2821", "backgroundNoise": 41.593, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.3305}, "mapStats": {"valueRange": 0.5316, "heightP90Gradient": 0.05839, "roughnessBase": 0.68, "roughnessVariation": 0.11, "normalStrength": 0.225, "blurRadius": 10}, "palette": ["#2B291D", "#6E6F6A", "#1B1C16", "#A6A6A3", "#39372E"]}, "warnings": []}, "textureAnalysis": {"finishClass": "worn-composite", "recipe": {"metalness": 0.0, "roughness": 0.9, "clearcoat": 0.0, "clearcoatRoughness": 0.0, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.5, "anisotropy": 0.0, "procedural": "mottle"}, "palette": ["#4B4B46", "#42423E", "#5B5C58", "#2C2C27", "#2B281C"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 65.3, "meanSaturation": 0.112, "gradientStrength": 0.531, "mottle": 0.015, "streakRatio": 0.55, "hueSpread": 0.007, "specularFraction": 0.0}}, "materialEvidence": {"componentId": "upper_receiver_metal", "regionId": "anodized-receiver", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/01-anodized-receiver.png", "bbox": {"x": 495, "y": 156, "width": 135, "height": 34}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.01}, "observations": ["near-neutral colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "upper_receiver_metal", "regionId": "anodized-receiver", "materialId": null, "family": "metal", "subtype": "aluminum", "finish": "satin", "aliases": [], "confidence": 0.909, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["mat_optic_worn_metal"] = createSculptMaterial(
    "mat_optic_worn_metal",
    {"id": "mat_optic_worn_metal", "baseColor": "#54544d", "secondaryColor": "#84867f", "colorVariation": "Procedural canvas noise/patina blending #54544d and #84867f with deterministic seeded wear", "metalness": {"base": 0.7, "variation": 0.08}, "roughness": {"base": 0.46, "variation": 0.14, "map": "procedural-canvas:mat_optic_worn_metal_roughness_channel"}, "clearcoat": 0.0, "clearcoatRoughness": 0.2, "transmission": 0.0, "ior": 1.48, "opacity": 1.0, "transparent": false, "envMapIntensity": 1.0, "needsEnvironment": true, "normal": {"type": "procedural-sobel-canvas", "strength": 0.45, "scale": 1.0}, "bump": {"amplitude": 0.0008, "scale": 1.0}, "ambientOcclusion": {"strength": 0.55, "map": "procedural-cavity-ao:mat_optic_worn_metal_ao"}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-box-uv", "texelDensityIntent": "high-density close-up uniform texel scale across rifle length", "repeat": [1, 1], "anisotropy": 8}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 5.0, "amplitude": 0.24, "description": "cast aluminum mottled patina contrast"}, {"id": "meso", "frequency": 22.0, "amplitude": 0.35, "description": "rubbed paint wear around ocular bell and turret ring"}, {"id": "micro", "frequency": 95.0, "amplitude": 0.28, "description": "cast metal surface grain"}], "localOverrides": [{"id": "tube-patina", "region": "optic cylinder & ocular bell rim", "effect": "mottled silver-grey worn patches exposing bright bare aluminum rims", "evidenceRef": "refs/aug_right_side.png"}], "shaderNotes": ["SRGBColorSpace for color map; NoColorSpace for roughnessMap, metalnessMap, normalMap, aoMap", "Independent canvas channels per material; zero cross-channel aliasing"], "pbrEvidenceName": "weathered-optic-housing", "referenceMaterialId": "coating.painted-metal", "materialFamily": "coating", "materialSubtype": "paint-over-metal", "materialFinish": "gloss-or-satin", "materialReference": {"registry": "/home/eduardo/Antigravity/3D/docs/materials/material-reference.json", "profileId": "coating.painted-metal", "method": "family-subtype-finish", "confidence": 0.843, "sourceRefs": ["three.mesh-physical", "gltf.2", "khronos.gltf-pbr", "adobe.pbr-guide-1", "adobe.pbr-guide-2"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "clearcoatMap", "clearcoatRoughnessMap", "metalnessMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "environment-reflection", "reference-beauty"]}, "referencePbr": {"version": "1.0", "sourceImage": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/02-weathered-optic-housing.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.843, "estimatedFidelity": 0.843, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-02-weathered-optic-housing/mat-optic-worn-metal_albedo.png", "url": "mat-optic-worn-metal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-02-weathered-optic-housing/mat-optic-worn-metal_roughness.png", "url": "mat-optic-worn-metal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-02-weathered-optic-housing/mat-optic-worn-metal_height.png", "url": "mat-optic-worn-metal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-02-weathered-optic-housing/mat-optic-worn-metal_normal.png", "url": "mat-optic-worn-metal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-02-weathered-optic-housing/mat-optic-worn-metal_ao.png", "url": "mat-optic-worn-metal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 195, "sourceHeight": 42, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 2, "width": 195, "height": 40}, "mask": {"backgroundColor": "#FFFFFF", "backgroundNoise": 281.752, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.1571}, "mapStats": {"valueRange": 0.2145, "heightP90Gradient": 0.04026, "roughnessBase": 0.68, "roughnessVariation": 0.061, "normalStrength": 0.203, "blurRadius": 10}, "palette": ["#21211B", "#313128", "#171712", "#0D0D09", "#49483C"]}, "warnings": ["low value range weakens height/roughness inference"]}, "textureAnalysis": {"finishClass": "worn-composite", "recipe": {"metalness": 0.0, "roughness": 0.9, "clearcoat": 0.0, "clearcoatRoughness": 0.0, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.5, "anisotropy": 0.0, "procedural": "mottle"}, "palette": ["#8D8D88", "#52524A", "#181814", "#CBCBC9", "#E7E7E6"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 128.3, "meanSaturation": 0.087, "gradientStrength": 0.831, "mottle": 0.048, "streakRatio": 1.51, "hueSpread": 0.033, "specularFraction": 0.278}}, "materialEvidence": {"componentId": "integrated_optic_carry_handle", "regionId": "weathered-optic-housing", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/02-weathered-optic-housing.png", "bbox": {"x": 365, "y": 72, "width": 195, "height": 42}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.0179}, "observations": ["near-neutral colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "integrated_optic_carry_handle", "regionId": "weathered-optic-housing", "materialId": null, "family": "coating", "subtype": "paint-over-metal", "finish": "gloss-or-satin", "aliases": [], "confidence": 0.843, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["mat_barrel_parkerized"] = createSculptMaterial(
    "mat_barrel_parkerized",
    {"id": "mat_barrel_parkerized", "baseColor": "#232527", "secondaryColor": "#484b4f", "colorVariation": "Procedural canvas noise/patina blending #232527 and #484b4f with deterministic seeded wear", "metalness": {"base": 0.86, "variation": 0.08}, "roughness": {"base": 0.41, "variation": 0.14, "map": "procedural-canvas:mat_barrel_parkerized_roughness_channel"}, "clearcoat": 0.0, "clearcoatRoughness": 0.2, "transmission": 0.0, "ior": 1.48, "opacity": 1.0, "transparent": false, "envMapIntensity": 1.05, "needsEnvironment": true, "normal": {"type": "procedural-sobel-canvas", "strength": 0.45, "scale": 1.0}, "bump": {"amplitude": 0.0008, "scale": 1.0}, "ambientOcclusion": {"strength": 0.55, "map": "procedural-cavity-ao:mat_barrel_parkerized_ao"}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-box-uv", "texelDensityIntent": "high-density close-up uniform texel scale across rifle length", "repeat": [1, 1], "anisotropy": 8}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.1, "description": "even dark steel shaft tone"}, {"id": "meso", "frequency": 28.0, "amplitude": 0.22, "description": "flash hider prong flats & collar edge wear"}, {"id": "micro", "frequency": 160.0, "amplitude": 0.25, "description": "lathe turning radial micro-grooves"}], "localOverrides": [{"id": "muzzle-edge-wear", "region": "tulip flash hider prongs & barrel clamp lug", "effect": "burnished steel edges (#5e6268) roughness 0.28", "evidenceRef": "refs/aug_right_side.png"}], "shaderNotes": ["SRGBColorSpace for color map; NoColorSpace for roughnessMap, metalnessMap, normalMap, aoMap", "Independent canvas channels per material; zero cross-channel aliasing"], "pbrEvidenceName": "parkerized-barrel-muzzle", "referenceMaterialId": "metal.steel-brushed", "materialFamily": "metal", "materialSubtype": "steel", "materialFinish": "brushed", "materialReference": {"registry": "/home/eduardo/Antigravity/3D/docs/materials/material-reference.json", "profileId": "metal.steel-brushed", "method": "family-subtype-finish", "confidence": 0.768, "sourceRefs": ["three.mesh-physical", "three.pmrem", "gltf.2", "khronos.gltf-pbr", "adobe.pbr-guide-2", "google.filament-pbr"], "requiredMaps": ["map", "roughnessMap", "normalMap", "anisotropyMap"], "optionalMaps": ["metalnessMap"], "validationViews": ["neutral-studio", "grazing", "environment-reflection", "reference-beauty"]}, "anisotropy": {"base": 0.85, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/03-parkerized-barrel-muzzle.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.768, "estimatedFidelity": 0.768, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-03-parkerized-barrel-muzzle/mat-barrel-parkerized_albedo.png", "url": "mat-barrel-parkerized_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-03-parkerized-barrel-muzzle/mat-barrel-parkerized_roughness.png", "url": "mat-barrel-parkerized_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-03-parkerized-barrel-muzzle/mat-barrel-parkerized_height.png", "url": "mat-barrel-parkerized_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-03-parkerized-barrel-muzzle/mat-barrel-parkerized_normal.png", "url": "mat-barrel-parkerized_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-03-parkerized-barrel-muzzle/mat-barrel-parkerized_ao.png", "url": "mat-barrel-parkerized_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 230, "sourceHeight": 26, "mapSize": 512, "cropBBoxPixels": {"x": 9, "y": 0, "width": 221, "height": 26}, "mask": {"backgroundColor": "#808080", "backgroundNoise": 151.872, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.0564}, "mapStats": {"valueRange": 0.1157, "heightP90Gradient": 0.02217, "roughnessBase": 0.68, "roughnessVariation": 0.05, "normalStrength": 0.182, "blurRadius": 10}, "palette": ["#12130F", "#181914", "#1E1F19", "#0C0D09", "#020201"]}, "warnings": ["foreground mask is very small", "low value range weakens height/roughness inference"]}, "textureAnalysis": {"finishClass": "worn-composite", "recipe": {"metalness": 0.0, "roughness": 0.9, "clearcoat": 0.0, "clearcoatRoughness": 0.0, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.5, "anisotropy": 0.0, "procedural": "mottle"}, "palette": ["#CBCBCA", "#535453", "#333431", "#151613", "#DDDDDC"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 85.5, "meanSaturation": 0.064, "gradientStrength": 0.829, "mottle": 0.045, "streakRatio": 1.23, "hueSpread": 0.075, "specularFraction": 0.09}}, "materialEvidence": {"componentId": "barrel_gas_muzzle_assembly", "regionId": "parkerized-barrel-muzzle", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/03-parkerized-barrel-muzzle.png", "bbox": {"x": 700, "y": 150, "width": 230, "height": 26}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.013}, "observations": ["near-neutral colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "barrel_gas_muzzle_assembly", "regionId": "parkerized-barrel-muzzle", "materialId": null, "family": "metal", "subtype": "steel", "finish": "brushed", "aliases": [], "confidence": 0.768, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["mat_mag_translucent"] = createSculptMaterial(
    "mat_mag_translucent",
    {"id": "mat_mag_translucent", "baseColor": "#988d68", "secondaryColor": "#6d6346", "colorVariation": "Procedural canvas noise/patina blending #988d68 and #6d6346 with deterministic seeded wear", "metalness": {"base": 0.0, "variation": 0.08}, "roughness": {"base": 0.32, "variation": 0.14, "map": "procedural-canvas:mat_mag_translucent_roughness_channel"}, "clearcoat": 0.25, "clearcoatRoughness": 0.28, "transmission": 0.38, "ior": 1.52, "opacity": 0.86, "transparent": true, "envMapIntensity": 0.95, "needsEnvironment": true, "normal": {"type": "procedural-sobel-canvas", "strength": 0.45, "scale": 1.0}, "bump": {"amplitude": 0.0008, "scale": 1.0}, "ambientOcclusion": {"strength": 0.55, "map": "procedural-cavity-ao:mat_mag_translucent_ao"}, "textureResolution": 2048, "textureProjection": {"mode": "triplanar-box-uv", "texelDensityIntent": "high-density close-up uniform texel scale across rifle length", "repeat": [1, 1], "anisotropy": 8}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 3.0, "amplitude": 0.18, "description": "amber polymer tint variation"}, {"id": "meso", "frequency": 20.0, "amplitude": 0.25, "description": "molded waffle rib cavity shading"}, {"id": "micro", "frequency": 85.0, "amplitude": 0.14, "description": "satin polycarbonate micro-frost"}], "localOverrides": [{"id": "internal-ammo-shadow", "region": "lower/mid translucent mag walls", "effect": "subtle semi-translucent visibility over internal spring and dark follower", "evidenceRef": "refs/aug_right_side.png"}], "shaderNotes": ["SRGBColorSpace for color map; NoColorSpace for roughnessMap, metalnessMap, normalMap, aoMap", "Independent canvas channels per material; zero cross-channel aliasing"], "pbrEvidenceName": "translucent-waffle-mag", "referenceMaterialId": "glass.frosted", "materialFamily": "glass", "materialSubtype": "frosted", "materialFinish": "rough-transmissive", "materialReference": {"registry": "/home/eduardo/Antigravity/3D/docs/materials/material-reference.json", "profileId": "glass.frosted", "method": "family-subtype-finish", "confidence": 0.791, "sourceRefs": ["three.mesh-physical", "three.pmrem", "khronos.transmission", "khronos.volume", "google.filament-pbr"], "requiredMaps": ["roughnessMap", "normalMap", "thicknessMap"], "optionalMaps": ["transmissionMap", "map"], "validationViews": ["neutral-studio", "grazing", "backlight-transmission", "reference-beauty"]}, "referencePbr": {"version": "1.0", "sourceImage": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/04-translucent-waffle-mag.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.791, "estimatedFidelity": 0.791, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-04-translucent-waffle-mag/mat-mag-translucent_albedo.png", "url": "mat-mag-translucent_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-04-translucent-waffle-mag/mat-mag-translucent_roughness.png", "url": "mat-mag-translucent_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-04-translucent-waffle-mag/mat-mag-translucent_height.png", "url": "mat-mag-translucent_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-04-translucent-waffle-mag/mat-mag-translucent_normal.png", "url": "mat-mag-translucent_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-04-translucent-waffle-mag/mat-mag-translucent_ao.png", "url": "mat-mag-translucent_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 85, "sourceHeight": 120, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 85, "height": 120}, "mask": {"backgroundColor": "#FEFEFC", "backgroundNoise": 277.065, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9182}, "mapStats": {"valueRange": 0.3282, "heightP90Gradient": 0.09394, "roughnessBase": 0.756, "roughnessVariation": 0.169, "normalStrength": 0.266, "blurRadius": 10}, "palette": ["#867A57", "#9B8C65", "#6B6247", "#B0A17A", "#443E2B"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak"]}, "textureAnalysis": {"finishClass": "gem-metal", "recipe": {"metalness": 0.75, "roughness": 0.14, "clearcoat": 0.6, "clearcoatRoughness": 0.06, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.3, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#A09985", "#867955", "#796E51", "#8B7E5B", "#D3CEBF"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 130.4, "meanSaturation": 0.316, "gradientStrength": 0.378, "mottle": 0.041, "streakRatio": 0.85, "hueSpread": 0.001, "specularFraction": 0.067}}, "materialEvidence": {"componentId": "waffle_magazine_assembly", "regionId": "translucent-waffle-mag", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/04-translucent-waffle-mag.png", "bbox": {"x": 265, "y": 230, "width": 85, "height": 120}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.0222}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "waffle_magazine_assembly", "regionId": "translucent-waffle-mag", "materialId": null, "family": "glass", "subtype": "frosted", "finish": "rough-transmissive", "aliases": [], "confidence": 0.791, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["mat_mag_floorplate"] = createSculptMaterial(
    "mat_mag_floorplate",
    {"id": "mat_mag_floorplate", "baseColor": "#6b6752", "secondaryColor": "#524e3c", "colorVariation": "Procedural canvas noise/patina blending #6b6752 and #524e3c with deterministic seeded wear", "metalness": {"base": 0.02, "variation": 0.08}, "roughness": {"base": 0.78, "variation": 0.14, "map": "procedural-canvas:mat_mag_floorplate_roughness_channel"}, "clearcoat": 0.0, "clearcoatRoughness": 0.2, "transmission": 0.0, "ior": 1.48, "opacity": 1.0, "transparent": false, "envMapIntensity": 0.9, "needsEnvironment": false, "normal": {"type": "procedural-sobel-canvas", "strength": 0.45, "scale": 1.0}, "bump": {"amplitude": 0.0008, "scale": 1.0}, "ambientOcclusion": {"strength": 0.55, "map": "procedural-cavity-ao:mat_mag_floorplate_ao"}, "textureResolution": 1024, "textureProjection": {"mode": "triplanar-box-uv", "texelDensityIntent": "high-density close-up uniform texel scale across rifle length", "repeat": [1, 1], "anisotropy": 8}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 4.0, "amplitude": 0.1, "description": "matte tan-olive baseplate"}, {"id": "meso", "frequency": 24.0, "amplitude": 0.18, "description": "bottom edge scuffing"}, {"id": "micro", "frequency": 120.0, "amplitude": 0.3, "description": "polymer grain"}], "localOverrides": [], "shaderNotes": ["SRGBColorSpace for color map; NoColorSpace for roughnessMap, metalnessMap, normalMap, aoMap", "Independent canvas channels per material; zero cross-channel aliasing"], "pbrEvidenceName": "od-polymer-stock", "referencePbr": {"version": "1.0", "sourceImage": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/00-od-polymer-stock.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.765, "estimatedFidelity": 0.765, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-00-od-polymer-stock/mat-polymer-od_albedo.png", "url": "mat-polymer-od_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-00-od-polymer-stock/mat-polymer-od_roughness.png", "url": "mat-polymer-od_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-00-od-polymer-stock/mat-polymer-od_height.png", "url": "mat-polymer-od_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-00-od-polymer-stock/mat-polymer-od_normal.png", "url": "mat-polymer-od_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-00-od-polymer-stock/mat-polymer-od_ao.png", "url": "mat-polymer-od_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 150, "sourceHeight": 100, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 150, "height": 100}, "mask": {"backgroundColor": "#625E49", "backgroundNoise": 27.148, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9917}, "mapStats": {"valueRange": 0.2241, "heightP90Gradient": 0.03976, "roughnessBase": 0.707, "roughnessVariation": 0.069, "normalStrength": 0.203, "blurRadius": 10}, "palette": ["#635F4C", "#595541", "#4D4836", "#2E2C1F", "#FCFCFB"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "low value range weakens height/roughness inference"]}},
    options
  );
  materialMap["mat_rubber_buttpad"] = createSculptMaterial(
    "mat_rubber_buttpad",
    {"id": "mat_rubber_buttpad", "baseColor": "#2b2b28", "secondaryColor": "#1d1d1b", "colorVariation": "Procedural canvas noise/patina blending #2b2b28 and #1d1d1b with deterministic seeded wear", "metalness": {"base": 0.0, "variation": 0.08}, "roughness": {"base": 0.9, "variation": 0.14, "map": "procedural-canvas:mat_rubber_buttpad_roughness_channel"}, "clearcoat": 0.0, "clearcoatRoughness": 0.2, "transmission": 0.0, "ior": 1.48, "opacity": 1.0, "transparent": false, "envMapIntensity": 0.9, "needsEnvironment": false, "normal": {"type": "procedural-sobel-canvas", "strength": 0.45, "scale": 1.0}, "bump": {"amplitude": 0.0008, "scale": 1.0}, "ambientOcclusion": {"strength": 0.55, "map": "procedural-cavity-ao:mat_rubber_buttpad_ao"}, "textureResolution": 1024, "textureProjection": {"mode": "triplanar-box-uv", "texelDensityIntent": "high-density close-up uniform texel scale across rifle length", "repeat": [1, 1], "anisotropy": 8}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.08, "description": "matte vulcanized charcoal tone"}, {"id": "meso", "frequency": 30.0, "amplitude": 0.22, "description": "anti-slip ribbed pad texture"}, {"id": "micro", "frequency": 150.0, "amplitude": 0.32, "description": "fine elastomer matte grain"}], "localOverrides": [], "shaderNotes": ["SRGBColorSpace for color map; NoColorSpace for roughnessMap, metalnessMap, normalMap, aoMap", "Independent canvas channels per material; zero cross-channel aliasing"], "pbrEvidenceName": "buttpad-rubber", "referenceMaterialId": "rubber.matte", "materialFamily": "rubber", "materialSubtype": "generic-elastomer", "materialFinish": "matte", "materialReference": {"registry": "/home/eduardo/Antigravity/3D/docs/materials/material-reference.json", "profileId": "rubber.matte", "method": "family-subtype-finish", "confidence": 0.909, "sourceRefs": ["three.mesh-standard", "adobe.pbr-guide-1", "google.filament-pbr", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap", "normalMap"], "optionalMaps": ["aoMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "referencePbr": {"version": "1.0", "sourceImage": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/05-buttpad-rubber.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.909, "estimatedFidelity": 0.909, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-05-buttpad-rubber/mat-rubber-buttpad_albedo.png", "url": "mat-rubber-buttpad_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-05-buttpad-rubber/mat-rubber-buttpad_roughness.png", "url": "mat-rubber-buttpad_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-05-buttpad-rubber/mat-rubber-buttpad_height.png", "url": "mat-rubber-buttpad_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-05-buttpad-rubber/mat-rubber-buttpad_normal.png", "url": "mat-rubber-buttpad_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-05-buttpad-rubber/mat-rubber-buttpad_ao.png", "url": "mat-rubber-buttpad_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 14, "sourceHeight": 135, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 14, "height": 84}, "mask": {"backgroundColor": "#FFFFFF", "backgroundNoise": 12.369, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.3672}, "mapStats": {"valueRange": 0.6877, "heightP90Gradient": 0.05467, "roughnessBase": 0.687, "roughnessVariation": 0.073, "normalStrength": 0.22, "blurRadius": 10}, "palette": ["#302F28", "#4D4C44", "#78766A", "#0B0B08", "#CDCDCB"]}, "warnings": []}, "textureAnalysis": {"finishClass": "brushed-steel", "recipe": {"metalness": 1.0, "roughness": 0.35, "clearcoat": 0.0, "clearcoatRoughness": 0.0, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 1.0, "procedural": "brushed"}, "palette": ["#878882", "#54534A", "#84837D", "#C9C9C7", "#F9FAF9"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 148.4, "meanSaturation": 0.084, "gradientStrength": 0.667, "mottle": 0.02, "streakRatio": 0.66, "hueSpread": 0.09, "specularFraction": 0.401}}, "materialEvidence": {"componentId": "rubber_buttpad", "regionId": "buttpad-rubber", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/05-buttpad-rubber.png", "bbox": {"x": 52, "y": 158, "width": 14, "height": 135}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.0041}, "observations": ["near-neutral colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "rubber_buttpad", "regionId": "buttpad-rubber", "materialId": null, "family": "rubber", "subtype": "generic-elastomer", "finish": "matte", "aliases": [], "confidence": 0.909, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["mat_optic_glass"] = createSculptMaterial(
    "mat_optic_glass",
    {"id": "mat_optic_glass", "baseColor": "#121a20", "secondaryColor": "#1f323b", "colorVariation": "Procedural canvas noise/patina blending #121a20 and #1f323b with deterministic seeded wear", "metalness": {"base": 0.08, "variation": 0.08}, "roughness": {"base": 0.05, "variation": 0.14, "map": "procedural-canvas:mat_optic_glass_roughness_channel"}, "clearcoat": 1.0, "clearcoatRoughness": 0.06, "transmission": 0.0, "ior": 1.54, "opacity": 1.0, "transparent": false, "envMapIntensity": 1.5, "needsEnvironment": true, "normal": {"type": "procedural-sobel-canvas", "strength": 0.45, "scale": 1.0}, "bump": {"amplitude": 0.0008, "scale": 1.0}, "ambientOcclusion": {"strength": 0.55, "map": "procedural-cavity-ao:mat_optic_glass_ao"}, "textureResolution": 1024, "textureProjection": {"mode": "triplanar-box-uv", "texelDensityIntent": "high-density close-up uniform texel scale across rifle length", "repeat": [1, 1], "anisotropy": 8}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.0, "amplitude": 0.05, "description": "deep dark optical cavity"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.04, "description": "multi-coated lens vignette"}, {"id": "micro", "frequency": 60.0, "amplitude": 0.02, "description": "polished optical glass"}], "localOverrides": [], "shaderNotes": ["SRGBColorSpace for color map; NoColorSpace for roughnessMap, metalnessMap, normalMap, aoMap", "Independent canvas channels per material; zero cross-channel aliasing"], "pbrEvidenceName": "weathered-optic-housing", "referencePbr": {"version": "1.0", "sourceImage": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/02-weathered-optic-housing.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.843, "estimatedFidelity": 0.843, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-02-weathered-optic-housing/mat-optic-worn-metal_albedo.png", "url": "mat-optic-worn-metal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-02-weathered-optic-housing/mat-optic-worn-metal_roughness.png", "url": "mat-optic-worn-metal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-02-weathered-optic-housing/mat-optic-worn-metal_height.png", "url": "mat-optic-worn-metal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-02-weathered-optic-housing/mat-optic-worn-metal_normal.png", "url": "mat-optic-worn-metal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/pbr-02-weathered-optic-housing/mat-optic-worn-metal_ao.png", "url": "mat-optic-worn-metal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 195, "sourceHeight": 42, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 2, "width": 195, "height": 40}, "mask": {"backgroundColor": "#FFFFFF", "backgroundNoise": 281.752, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.1571}, "mapStats": {"valueRange": 0.2145, "heightP90Gradient": 0.04026, "roughnessBase": 0.68, "roughnessVariation": 0.061, "normalStrength": 0.203, "blurRadius": 10}, "palette": ["#21211B", "#313128", "#171712", "#0D0D09", "#49483C"]}, "warnings": ["low value range weakens height/roughness inference"]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "aug_a1_root__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "aug_a1_root", "level": "macro", "parent": null, "role": "container-root", "topologyClass": "assembled-solid", "topologyRationale": "Root assembly group containing all AUG A1 subsystems and sculptRuntime sockets/pivots.", "primitive": "box", "material": "mat_polymer_od", "materialLayers": ["mat_polymer_od"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 88, 68, 1.0)", "secondaryAlbedo": "rgba(77, 73, 55, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(92, 88, 68, 1.0)"}, {"position": 1.0, "color": "rgba(77, 73, 55, 1.0)"}]}}, "importance": 1.0, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "localFeatures": [], "actionProfile": {"animationRole": "root", "pivotType": "center"}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivotType": "center"};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["mat_polymer_od"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "aug_a1_root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "aug_a1_root", "level": "macro", "parent": null, "role": "container-root", "topologyClass": "assembled-solid", "topologyRationale": "Root assembly group containing all AUG A1 subsystems and sculptRuntime sockets/pivots.", "primitive": "box", "material": "mat_polymer_od", "materialLayers": ["mat_polymer_od"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 88, 68, 1.0)", "secondaryAlbedo": "rgba(77, 73, 55, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(92, 88, 68, 1.0)"}, {"position": 1.0, "color": "rgba(77, 73, 55, 1.0)"}]}}, "importance": 1.0, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "localFeatures": [], "actionProfile": {"animationRole": "root", "pivotType": "center"}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {};

  const endpoint_polymer_stock_chassis_1 = makeAttachmentEndpoint(null);
  const node_polymer_stock_chassis_1 = new THREE.Group();
  node_polymer_stock_chassis_1.name = "polymer_stock_chassis__pivot";
  node_polymer_stock_chassis_1.scale.set(1, 1, 1);
  if (endpoint_polymer_stock_chassis_1) {
    node_polymer_stock_chassis_1.position.copy(endpoint_polymer_stock_chassis_1.start);
    node_polymer_stock_chassis_1.rotation.set(0, 0, 0);
  } else {
    node_polymer_stock_chassis_1.position.set(0, 0, 0);
    node_polymer_stock_chassis_1.rotation.set(0, 0, 0);
  }
  node_polymer_stock_chassis_1.userData.sculptComponent = {"id": "polymer_stock_chassis", "name": "polymer_stock_chassis", "level": "macro", "parent": "root", "role": "bullpup-chassis", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic molded bullpup polymer stock blending buttstock, magwell, pistol grip, and winter trigger guard into a variable-Z lofted shell with real trigger-guard hole.", "primitive": "extrude", "material": "mat_polymer_od", "materialLayers": ["mat_polymer_od"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 88, 68, 1.0)", "secondaryAlbedo": "rgba(77, 73, 55, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(92, 88, 68, 1.0)"}, {"position": 1.0, "color": "rgba(77, 73, 55, 1.0)"}]}}, "importance": 1.0, "attachment": {"parentId": "root", "parentSocket": "chassis_origin", "localStart": [-0.39, -0.04, 0.0], "localEnd": [0.155, 0.02, 0.0], "contactType": "socket", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "stock-cheek-bevel", "type": "bevel highlight", "placement": "upper buttstock cheek crest", "confidence": 0.94}, {"id": "pistol-grip-palm-swell", "type": "raised ridge", "placement": "ergonomic palm swell along +/-Z grip faces", "confidence": 0.9}], "actionProfile": {"animationRole": "chassis-body", "pivotType": "center", "destructionGroup": "chassis_group"}, "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "mat_polymer_od"}, "materialRegions": [{"regionId": "od-polymer-stock", "materialId": "mat_polymer_od", "profileId": "plastic.matte", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/00-od-polymer-stock.png", "bbox": {"x": 90, "y": 175, "width": 150, "height": 100}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.0327}}]};
  node_polymer_stock_chassis_1.userData.actionProfile = {"animationRole": "chassis-body", "pivotType": "center", "destructionGroup": "chassis_group"};
  (nodes["root"] ?? root).add(node_polymer_stock_chassis_1);
  nodes["polymer_stock_chassis"] = node_polymer_stock_chassis_1;
  const mesh_polymer_stock_chassis_1Geometry = endpoint_polymer_stock_chassis_1
    ? new THREE.CylinderGeometry(endpoint_polymer_stock_chassis_1.endRadius, endpoint_polymer_stock_chassis_1.baseRadius, endpoint_polymer_stock_chassis_1.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_polymer_stock_chassis_1) {
    mesh_polymer_stock_chassis_1Geometry.scale(1, 1, 1);
  }
  const mesh_polymer_stock_chassis_1 = new THREE.Mesh(
    mesh_polymer_stock_chassis_1Geometry,
    materialMap["mat_polymer_od"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_polymer_stock_chassis_1.name = "polymer_stock_chassis";
  if (endpoint_polymer_stock_chassis_1) {
    mesh_polymer_stock_chassis_1.position.copy(endpoint_polymer_stock_chassis_1.midpoint);
    mesh_polymer_stock_chassis_1.quaternion.copy(endpoint_polymer_stock_chassis_1.quaternion);
  }
  mesh_polymer_stock_chassis_1.castShadow = options.castShadow ?? true;
  mesh_polymer_stock_chassis_1.receiveShadow = options.receiveShadow ?? true;
  mesh_polymer_stock_chassis_1.userData.sculptComponent = {"id": "polymer_stock_chassis", "name": "polymer_stock_chassis", "level": "macro", "parent": "root", "role": "bullpup-chassis", "topologyClass": "continuous-sculpt", "topologyRationale": "Organic molded bullpup polymer stock blending buttstock, magwell, pistol grip, and winter trigger guard into a variable-Z lofted shell with real trigger-guard hole.", "primitive": "extrude", "material": "mat_polymer_od", "materialLayers": ["mat_polymer_od"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 88, 68, 1.0)", "secondaryAlbedo": "rgba(77, 73, 55, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(92, 88, 68, 1.0)"}, {"position": 1.0, "color": "rgba(77, 73, 55, 1.0)"}]}}, "importance": 1.0, "attachment": {"parentId": "root", "parentSocket": "chassis_origin", "localStart": [-0.39, -0.04, 0.0], "localEnd": [0.155, 0.02, 0.0], "contactType": "socket", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "stock-cheek-bevel", "type": "bevel highlight", "placement": "upper buttstock cheek crest", "confidence": 0.94}, {"id": "pistol-grip-palm-swell", "type": "raised ridge", "placement": "ergonomic palm swell along +/-Z grip faces", "confidence": 0.9}], "actionProfile": {"animationRole": "chassis-body", "pivotType": "center", "destructionGroup": "chassis_group"}, "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "mat_polymer_od"}, "materialRegions": [{"regionId": "od-polymer-stock", "materialId": "mat_polymer_od", "profileId": "plastic.matte", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/00-od-polymer-stock.png", "bbox": {"x": 90, "y": 175, "width": 150, "height": 100}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.0327}}]};
  node_polymer_stock_chassis_1.add(mesh_polymer_stock_chassis_1);
  meshes["polymer_stock_chassis"] = mesh_polymer_stock_chassis_1;
  colliders["polymer_stock_chassis"] = {};

  const endpoint_upper_receiver_metal_2 = makeAttachmentEndpoint(null);
  const node_upper_receiver_metal_2 = new THREE.Group();
  node_upper_receiver_metal_2.name = "upper_receiver_metal__pivot";
  node_upper_receiver_metal_2.scale.set(1, 1, 1);
  if (endpoint_upper_receiver_metal_2) {
    node_upper_receiver_metal_2.position.copy(endpoint_upper_receiver_metal_2.start);
    node_upper_receiver_metal_2.rotation.set(0, 0, 0);
  } else {
    node_upper_receiver_metal_2.position.set(0, 0, 0);
    node_upper_receiver_metal_2.rotation.set(0, 0, 0);
  }
  node_upper_receiver_metal_2.userData.sculptComponent = {"id": "upper_receiver_metal", "name": "upper_receiver_metal", "level": "macro", "parent": "root", "role": "upper-receiver", "topologyClass": "assembled-solid", "topologyRationale": "Machined aluminum upper receiver seated in forward chassis cradle with distinct chamfered faces, flutes, and trunnion block.", "primitive": "extrude", "material": "mat_receiver_anodized", "materialLayers": ["mat_receiver_anodized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 45, 46, 1.0)", "secondaryAlbedo": "rgba(92, 96, 100, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.95, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(44, 45, 46, 1.0)"}, {"position": 1.0, "color": "rgba(92, 96, 100, 1.0)"}]}}, "importance": 1.0, "attachment": {"parentId": "root", "parentSocket": "receiver_cradle", "localStart": [-0.025, 0.002, 0.0], "localEnd": [0.165, 0.002, 0.0], "contactType": "embedded", "embedDepth": 0.025, "overlap": 0.025, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "receiver-flutes", "type": "recessed groove", "placement": "both side faces along upper receiver", "confidence": 0.95}], "actionProfile": {"animationRole": "receiver-core", "pivotType": "center", "destructionGroup": "receiver_group"}, "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "mat_receiver_anodized"}, "materialRegions": [{"regionId": "anodized-receiver", "materialId": "mat_receiver_anodized", "profileId": "metal.aluminum", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/01-anodized-receiver.png", "bbox": {"x": 495, "y": 156, "width": 135, "height": 34}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.01}}]};
  node_upper_receiver_metal_2.userData.actionProfile = {"animationRole": "receiver-core", "pivotType": "center", "destructionGroup": "receiver_group"};
  (nodes["root"] ?? root).add(node_upper_receiver_metal_2);
  nodes["upper_receiver_metal"] = node_upper_receiver_metal_2;
  const mesh_upper_receiver_metal_2Geometry = endpoint_upper_receiver_metal_2
    ? new THREE.CylinderGeometry(endpoint_upper_receiver_metal_2.endRadius, endpoint_upper_receiver_metal_2.baseRadius, endpoint_upper_receiver_metal_2.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_upper_receiver_metal_2) {
    mesh_upper_receiver_metal_2Geometry.scale(1, 1, 1);
  }
  const mesh_upper_receiver_metal_2 = new THREE.Mesh(
    mesh_upper_receiver_metal_2Geometry,
    materialMap["mat_receiver_anodized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_receiver_metal_2.name = "upper_receiver_metal";
  if (endpoint_upper_receiver_metal_2) {
    mesh_upper_receiver_metal_2.position.copy(endpoint_upper_receiver_metal_2.midpoint);
    mesh_upper_receiver_metal_2.quaternion.copy(endpoint_upper_receiver_metal_2.quaternion);
  }
  mesh_upper_receiver_metal_2.castShadow = options.castShadow ?? true;
  mesh_upper_receiver_metal_2.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_receiver_metal_2.userData.sculptComponent = {"id": "upper_receiver_metal", "name": "upper_receiver_metal", "level": "macro", "parent": "root", "role": "upper-receiver", "topologyClass": "assembled-solid", "topologyRationale": "Machined aluminum upper receiver seated in forward chassis cradle with distinct chamfered faces, flutes, and trunnion block.", "primitive": "extrude", "material": "mat_receiver_anodized", "materialLayers": ["mat_receiver_anodized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 45, 46, 1.0)", "secondaryAlbedo": "rgba(92, 96, 100, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.95, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(44, 45, 46, 1.0)"}, {"position": 1.0, "color": "rgba(92, 96, 100, 1.0)"}]}}, "importance": 1.0, "attachment": {"parentId": "root", "parentSocket": "receiver_cradle", "localStart": [-0.025, 0.002, 0.0], "localEnd": [0.165, 0.002, 0.0], "contactType": "embedded", "embedDepth": 0.025, "overlap": 0.025, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "receiver-flutes", "type": "recessed groove", "placement": "both side faces along upper receiver", "confidence": 0.95}], "actionProfile": {"animationRole": "receiver-core", "pivotType": "center", "destructionGroup": "receiver_group"}, "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "mat_receiver_anodized"}, "materialRegions": [{"regionId": "anodized-receiver", "materialId": "mat_receiver_anodized", "profileId": "metal.aluminum", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/01-anodized-receiver.png", "bbox": {"x": 495, "y": 156, "width": 135, "height": 34}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.01}}]};
  node_upper_receiver_metal_2.add(mesh_upper_receiver_metal_2);
  meshes["upper_receiver_metal"] = mesh_upper_receiver_metal_2;
  colliders["upper_receiver_metal"] = {};

  const attachment_integrated_optic_carry_handle_3 = {"parentId": "upper_receiver_metal", "parentSocket": "receiver_top_bridge", "localStart": [-0.015, 0.016, 0.0], "localEnd": [0.145, 0.016, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]};
  const endpoint_integrated_optic_carry_handle_3 = makeAttachmentEndpoint(attachment_integrated_optic_carry_handle_3);
  const node_integrated_optic_carry_handle_3 = new THREE.Group();
  node_integrated_optic_carry_handle_3.name = "integrated_optic_carry_handle__pivot";
  node_integrated_optic_carry_handle_3.scale.set(1, 1, 1);
  if (endpoint_integrated_optic_carry_handle_3) {
    node_integrated_optic_carry_handle_3.position.copy(endpoint_integrated_optic_carry_handle_3.start);
    node_integrated_optic_carry_handle_3.rotation.set(0, 0, 0);
  } else {
    node_integrated_optic_carry_handle_3.position.set(0, 0, 0);
    node_integrated_optic_carry_handle_3.rotation.set(0, 0, 0);
  }
  node_integrated_optic_carry_handle_3.userData.sculptComponent = {"id": "integrated_optic_carry_handle", "name": "integrated_optic_carry_handle", "level": "macro", "parent": "upper_receiver_metal", "role": "optic-bridge", "topologyClass": "continuous-sculpt", "topologyRationale": "Cast aluminum carry-handle bridge housing integrated 1.5x tubular optic over open trapezoidal arch.", "primitive": "curve-sweep", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 1.0, "attachment": {"parentId": "upper_receiver_metal", "parentSocket": "receiver_top_bridge", "localStart": [-0.015, 0.016, 0.0], "localEnd": [0.145, 0.016, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "optic-assembly", "pivotType": "base", "destructionGroup": "optic_group"}, "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "mat_optic_worn_metal"}, "materialRegions": [{"regionId": "weathered-optic-housing", "materialId": "mat_optic_worn_metal", "profileId": "coating.painted-metal", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/02-weathered-optic-housing.png", "bbox": {"x": 365, "y": 72, "width": 195, "height": 42}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.0179}}]};
  node_integrated_optic_carry_handle_3.userData.actionProfile = {"animationRole": "optic-assembly", "pivotType": "base", "destructionGroup": "optic_group"};
  (nodes["upper_receiver_metal"] ?? root).add(node_integrated_optic_carry_handle_3);
  nodes["integrated_optic_carry_handle"] = node_integrated_optic_carry_handle_3;
  const mesh_integrated_optic_carry_handle_3Geometry = endpoint_integrated_optic_carry_handle_3
    ? new THREE.CylinderGeometry(endpoint_integrated_optic_carry_handle_3.endRadius, endpoint_integrated_optic_carry_handle_3.baseRadius, endpoint_integrated_optic_carry_handle_3.length, 32, 12)
    : buildCurveSweepGeometry({"spine": [[-0.5, -0.4, 0.0], [-0.1, 0.1, 0.0], [0.3, 0.2, 0.0], [0.6, -0.1, 0.0]], "crossSection": {"points": [[-0.04, -0.02], [0.04, -0.02], [0.04, 0.02], [-0.04, 0.02]]}, "closed": false});
  if (!endpoint_integrated_optic_carry_handle_3) {
    mesh_integrated_optic_carry_handle_3Geometry.scale(1, 1, 1);
  }
  const mesh_integrated_optic_carry_handle_3 = new THREE.Mesh(
    mesh_integrated_optic_carry_handle_3Geometry,
    materialMap["mat_optic_worn_metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_integrated_optic_carry_handle_3.name = "integrated_optic_carry_handle";
  if (endpoint_integrated_optic_carry_handle_3) {
    mesh_integrated_optic_carry_handle_3.position.copy(endpoint_integrated_optic_carry_handle_3.midpoint);
    mesh_integrated_optic_carry_handle_3.quaternion.copy(endpoint_integrated_optic_carry_handle_3.quaternion);
  }
  mesh_integrated_optic_carry_handle_3.castShadow = options.castShadow ?? true;
  mesh_integrated_optic_carry_handle_3.receiveShadow = options.receiveShadow ?? true;
  mesh_integrated_optic_carry_handle_3.userData.sculptComponent = {"id": "integrated_optic_carry_handle", "name": "integrated_optic_carry_handle", "level": "macro", "parent": "upper_receiver_metal", "role": "optic-bridge", "topologyClass": "continuous-sculpt", "topologyRationale": "Cast aluminum carry-handle bridge housing integrated 1.5x tubular optic over open trapezoidal arch.", "primitive": "curve-sweep", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 1.0, "attachment": {"parentId": "upper_receiver_metal", "parentSocket": "receiver_top_bridge", "localStart": [-0.015, 0.016, 0.0], "localEnd": [0.145, 0.016, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "optic-assembly", "pivotType": "base", "destructionGroup": "optic_group"}, "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "mat_optic_worn_metal"}, "materialRegions": [{"regionId": "weathered-optic-housing", "materialId": "mat_optic_worn_metal", "profileId": "coating.painted-metal", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/02-weathered-optic-housing.png", "bbox": {"x": 365, "y": 72, "width": 195, "height": 42}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.0179}}]};
  node_integrated_optic_carry_handle_3.add(mesh_integrated_optic_carry_handle_3);
  meshes["integrated_optic_carry_handle"] = mesh_integrated_optic_carry_handle_3;
  colliders["integrated_optic_carry_handle"] = {};

  const endpoint_barrel_gas_muzzle_assembly_4 = makeAttachmentEndpoint(null);
  const node_barrel_gas_muzzle_assembly_4 = new THREE.Group();
  node_barrel_gas_muzzle_assembly_4.name = "barrel_gas_muzzle_assembly__pivot";
  node_barrel_gas_muzzle_assembly_4.scale.set(1, 1, 1);
  if (endpoint_barrel_gas_muzzle_assembly_4) {
    node_barrel_gas_muzzle_assembly_4.position.copy(endpoint_barrel_gas_muzzle_assembly_4.start);
    node_barrel_gas_muzzle_assembly_4.rotation.set(0, 0, 0);
  } else {
    node_barrel_gas_muzzle_assembly_4.position.set(0, 0, 0);
    node_barrel_gas_muzzle_assembly_4.rotation.set(0, 0, 0);
  }
  node_barrel_gas_muzzle_assembly_4.userData.sculptComponent = {"id": "barrel_gas_muzzle_assembly", "name": "barrel_gas_muzzle_assembly", "level": "macro", "parent": "upper_receiver_metal", "role": "barrel-assembly", "topologyClass": "assembled-solid", "topologyRationale": "Revolved stepped heavy steel barrel mounted in upper receiver front trunnion.", "primitive": "lathe", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 1.0, "attachment": {"parentId": "upper_receiver_metal", "parentSocket": "barrel_trunnion_socket", "localStart": [0.14, 0.0, 0.0], "localEnd": [0.355, 0.0, 0.0], "contactType": "socket", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "barrel-core", "pivotType": "base", "destructionGroup": "barrel_group"}, "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "mat_barrel_parkerized"}, "materialRegions": [{"regionId": "parkerized-barrel-muzzle", "materialId": "mat_barrel_parkerized", "profileId": "metal.steel-brushed", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/03-parkerized-barrel-muzzle.png", "bbox": {"x": 700, "y": 150, "width": 230, "height": 26}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.013}}]};
  node_barrel_gas_muzzle_assembly_4.userData.actionProfile = {"animationRole": "barrel-core", "pivotType": "base", "destructionGroup": "barrel_group"};
  (nodes["upper_receiver_metal"] ?? root).add(node_barrel_gas_muzzle_assembly_4);
  nodes["barrel_gas_muzzle_assembly"] = node_barrel_gas_muzzle_assembly_4;
  const mesh_barrel_gas_muzzle_assembly_4Geometry = endpoint_barrel_gas_muzzle_assembly_4
    ? new THREE.CylinderGeometry(endpoint_barrel_gas_muzzle_assembly_4.endRadius, endpoint_barrel_gas_muzzle_assembly_4.baseRadius, endpoint_barrel_gas_muzzle_assembly_4.length, 32, 12)
    : buildLatheGeometry({"points": [[0.3, -0.5], [0.15, 0.0], [0.3, 0.5]], "segments": 24});
  if (!endpoint_barrel_gas_muzzle_assembly_4) {
    mesh_barrel_gas_muzzle_assembly_4Geometry.scale(1, 1, 1);
  }
  const mesh_barrel_gas_muzzle_assembly_4 = new THREE.Mesh(
    mesh_barrel_gas_muzzle_assembly_4Geometry,
    materialMap["mat_barrel_parkerized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_barrel_gas_muzzle_assembly_4.name = "barrel_gas_muzzle_assembly";
  if (endpoint_barrel_gas_muzzle_assembly_4) {
    mesh_barrel_gas_muzzle_assembly_4.position.copy(endpoint_barrel_gas_muzzle_assembly_4.midpoint);
    mesh_barrel_gas_muzzle_assembly_4.quaternion.copy(endpoint_barrel_gas_muzzle_assembly_4.quaternion);
  }
  mesh_barrel_gas_muzzle_assembly_4.castShadow = options.castShadow ?? true;
  mesh_barrel_gas_muzzle_assembly_4.receiveShadow = options.receiveShadow ?? true;
  mesh_barrel_gas_muzzle_assembly_4.userData.sculptComponent = {"id": "barrel_gas_muzzle_assembly", "name": "barrel_gas_muzzle_assembly", "level": "macro", "parent": "upper_receiver_metal", "role": "barrel-assembly", "topologyClass": "assembled-solid", "topologyRationale": "Revolved stepped heavy steel barrel mounted in upper receiver front trunnion.", "primitive": "lathe", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 1.0, "attachment": {"parentId": "upper_receiver_metal", "parentSocket": "barrel_trunnion_socket", "localStart": [0.14, 0.0, 0.0], "localEnd": [0.355, 0.0, 0.0], "contactType": "socket", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "barrel-core", "pivotType": "base", "destructionGroup": "barrel_group"}, "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "mat_barrel_parkerized"}, "materialRegions": [{"regionId": "parkerized-barrel-muzzle", "materialId": "mat_barrel_parkerized", "profileId": "metal.steel-brushed", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/03-parkerized-barrel-muzzle.png", "bbox": {"x": 700, "y": 150, "width": 230, "height": 26}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.013}}]};
  node_barrel_gas_muzzle_assembly_4.add(mesh_barrel_gas_muzzle_assembly_4);
  meshes["barrel_gas_muzzle_assembly"] = mesh_barrel_gas_muzzle_assembly_4;
  colliders["barrel_gas_muzzle_assembly"] = {};

  const endpoint_waffle_magazine_assembly_5 = makeAttachmentEndpoint(null);
  const node_waffle_magazine_assembly_5 = new THREE.Group();
  node_waffle_magazine_assembly_5.name = "waffle_magazine_assembly__pivot";
  node_waffle_magazine_assembly_5.scale.set(1, 1, 1);
  if (endpoint_waffle_magazine_assembly_5) {
    node_waffle_magazine_assembly_5.position.copy(endpoint_waffle_magazine_assembly_5.start);
    node_waffle_magazine_assembly_5.rotation.set(0, 0, 0);
  } else {
    node_waffle_magazine_assembly_5.position.set(0, 0, 0);
    node_waffle_magazine_assembly_5.rotation.set(0, 0, 0);
  }
  node_waffle_magazine_assembly_5.userData.sculptComponent = {"id": "waffle_magazine_assembly", "name": "waffle_magazine_assembly", "level": "macro", "parent": "polymer_stock_chassis", "role": "magazine", "topologyClass": "assembled-solid", "topologyRationale": "Curved forward-canted translucent box magazine seated inside bullpup magazine well behind grip.", "primitive": "extrude", "material": "mat_mag_translucent", "materialLayers": ["mat_mag_translucent"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(152, 141, 104, 0.86)", "secondaryAlbedo": "rgba(109, 99, 70, 0.90)", "materialClass": "plastic", "materialClassConfidence": 0.92, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(152, 141, 104, 0.86)"}, {"position": 1.0, "color": "rgba(109, 99, 70, 0.90)"}]}}, "importance": 1.0, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "magwell_socket", "localStart": [-0.175, -0.072, 0.0], "localEnd": [-0.148, -0.184, 0.0], "contactType": "socket", "embedDepth": 0.035, "overlap": 0.035, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "detachable-magazine", "pivotType": "socket", "destructionGroup": "magazine_group"}, "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "mat_mag_translucent"}, "materialRegions": [{"regionId": "translucent-waffle-mag", "materialId": "mat_mag_translucent", "profileId": "glass.frosted", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/04-translucent-waffle-mag.png", "bbox": {"x": 265, "y": 230, "width": 85, "height": 120}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.0222}}]};
  node_waffle_magazine_assembly_5.userData.actionProfile = {"animationRole": "detachable-magazine", "pivotType": "socket", "destructionGroup": "magazine_group"};
  (nodes["polymer_stock_chassis"] ?? root).add(node_waffle_magazine_assembly_5);
  nodes["waffle_magazine_assembly"] = node_waffle_magazine_assembly_5;
  const mesh_waffle_magazine_assembly_5Geometry = endpoint_waffle_magazine_assembly_5
    ? new THREE.CylinderGeometry(endpoint_waffle_magazine_assembly_5.endRadius, endpoint_waffle_magazine_assembly_5.baseRadius, endpoint_waffle_magazine_assembly_5.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_waffle_magazine_assembly_5) {
    mesh_waffle_magazine_assembly_5Geometry.scale(1, 1, 1);
  }
  const mesh_waffle_magazine_assembly_5 = new THREE.Mesh(
    mesh_waffle_magazine_assembly_5Geometry,
    materialMap["mat_mag_translucent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_waffle_magazine_assembly_5.name = "waffle_magazine_assembly";
  if (endpoint_waffle_magazine_assembly_5) {
    mesh_waffle_magazine_assembly_5.position.copy(endpoint_waffle_magazine_assembly_5.midpoint);
    mesh_waffle_magazine_assembly_5.quaternion.copy(endpoint_waffle_magazine_assembly_5.quaternion);
  }
  mesh_waffle_magazine_assembly_5.castShadow = options.castShadow ?? true;
  mesh_waffle_magazine_assembly_5.receiveShadow = options.receiveShadow ?? true;
  mesh_waffle_magazine_assembly_5.userData.sculptComponent = {"id": "waffle_magazine_assembly", "name": "waffle_magazine_assembly", "level": "macro", "parent": "polymer_stock_chassis", "role": "magazine", "topologyClass": "assembled-solid", "topologyRationale": "Curved forward-canted translucent box magazine seated inside bullpup magazine well behind grip.", "primitive": "extrude", "material": "mat_mag_translucent", "materialLayers": ["mat_mag_translucent"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(152, 141, 104, 0.86)", "secondaryAlbedo": "rgba(109, 99, 70, 0.90)", "materialClass": "plastic", "materialClassConfidence": 0.92, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(152, 141, 104, 0.86)"}, {"position": 1.0, "color": "rgba(109, 99, 70, 0.90)"}]}}, "importance": 1.0, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "magwell_socket", "localStart": [-0.175, -0.072, 0.0], "localEnd": [-0.148, -0.184, 0.0], "contactType": "socket", "embedDepth": 0.035, "overlap": 0.035, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "detachable-magazine", "pivotType": "socket", "destructionGroup": "magazine_group"}, "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "mat_mag_translucent"}, "materialRegions": [{"regionId": "translucent-waffle-mag", "materialId": "mat_mag_translucent", "profileId": "glass.frosted", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/04-translucent-waffle-mag.png", "bbox": {"x": 265, "y": 230, "width": 85, "height": 120}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.0222}}]};
  node_waffle_magazine_assembly_5.add(mesh_waffle_magazine_assembly_5);
  meshes["waffle_magazine_assembly"] = mesh_waffle_magazine_assembly_5;
  colliders["waffle_magazine_assembly"] = {};

  const endpoint_folding_vertical_foregrip_6 = makeAttachmentEndpoint(null);
  const node_folding_vertical_foregrip_6 = new THREE.Group();
  node_folding_vertical_foregrip_6.name = "folding_vertical_foregrip__pivot";
  node_folding_vertical_foregrip_6.scale.set(1, 1, 1);
  if (endpoint_folding_vertical_foregrip_6) {
    node_folding_vertical_foregrip_6.position.copy(endpoint_folding_vertical_foregrip_6.start);
    node_folding_vertical_foregrip_6.rotation.set(0, 0, 0);
  } else {
    node_folding_vertical_foregrip_6.position.set(0, 0, 0);
    node_folding_vertical_foregrip_6.rotation.set(0, 0, 0);
  }
  node_folding_vertical_foregrip_6.userData.sculptComponent = {"id": "folding_vertical_foregrip", "name": "folding_vertical_foregrip", "level": "macro", "parent": "upper_receiver_metal", "role": "foregrip-handle", "topologyClass": "continuous-sculpt", "topologyRationale": "Lathed ergonomic contoured vertical foregrip pivoting under front receiver trunnion.", "primitive": "lathe", "material": "mat_polymer_od", "materialLayers": ["mat_polymer_od"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 88, 68, 1.0)", "secondaryAlbedo": "rgba(77, 73, 55, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(92, 88, 68, 1.0)"}, {"position": 1.0, "color": "rgba(77, 73, 55, 1.0)"}]}}, "importance": 0.95, "attachment": {"parentId": "upper_receiver_metal", "parentSocket": "foregrip_hinge_socket", "localStart": [0.135, -0.028, 0.0], "localEnd": [0.135, -0.131, 0.0], "contactType": "hinge", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "foregrip-waist-contour", "type": "bevel highlight", "placement": "ergonomic center waist taper and rounded flared heel", "confidence": 0.97}], "actionProfile": {"animationRole": "hinged-foregrip", "pivotType": "hinge", "destructionGroup": "foregrip_group"}};
  node_folding_vertical_foregrip_6.userData.actionProfile = {"animationRole": "hinged-foregrip", "pivotType": "hinge", "destructionGroup": "foregrip_group"};
  (nodes["upper_receiver_metal"] ?? root).add(node_folding_vertical_foregrip_6);
  nodes["folding_vertical_foregrip"] = node_folding_vertical_foregrip_6;
  const mesh_folding_vertical_foregrip_6Geometry = endpoint_folding_vertical_foregrip_6
    ? new THREE.CylinderGeometry(endpoint_folding_vertical_foregrip_6.endRadius, endpoint_folding_vertical_foregrip_6.baseRadius, endpoint_folding_vertical_foregrip_6.length, 32, 12)
    : buildLatheGeometry({"points": [[0.3, -0.5], [0.15, 0.0], [0.3, 0.5]], "segments": 24});
  if (!endpoint_folding_vertical_foregrip_6) {
    mesh_folding_vertical_foregrip_6Geometry.scale(1, 1, 1);
  }
  const mesh_folding_vertical_foregrip_6 = new THREE.Mesh(
    mesh_folding_vertical_foregrip_6Geometry,
    materialMap["mat_polymer_od"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_folding_vertical_foregrip_6.name = "folding_vertical_foregrip";
  if (endpoint_folding_vertical_foregrip_6) {
    mesh_folding_vertical_foregrip_6.position.copy(endpoint_folding_vertical_foregrip_6.midpoint);
    mesh_folding_vertical_foregrip_6.quaternion.copy(endpoint_folding_vertical_foregrip_6.quaternion);
  }
  mesh_folding_vertical_foregrip_6.castShadow = options.castShadow ?? true;
  mesh_folding_vertical_foregrip_6.receiveShadow = options.receiveShadow ?? true;
  mesh_folding_vertical_foregrip_6.userData.sculptComponent = {"id": "folding_vertical_foregrip", "name": "folding_vertical_foregrip", "level": "macro", "parent": "upper_receiver_metal", "role": "foregrip-handle", "topologyClass": "continuous-sculpt", "topologyRationale": "Lathed ergonomic contoured vertical foregrip pivoting under front receiver trunnion.", "primitive": "lathe", "material": "mat_polymer_od", "materialLayers": ["mat_polymer_od"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 88, 68, 1.0)", "secondaryAlbedo": "rgba(77, 73, 55, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(92, 88, 68, 1.0)"}, {"position": 1.0, "color": "rgba(77, 73, 55, 1.0)"}]}}, "importance": 0.95, "attachment": {"parentId": "upper_receiver_metal", "parentSocket": "foregrip_hinge_socket", "localStart": [0.135, -0.028, 0.0], "localEnd": [0.135, -0.131, 0.0], "contactType": "hinge", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "foregrip-waist-contour", "type": "bevel highlight", "placement": "ergonomic center waist taper and rounded flared heel", "confidence": 0.97}], "actionProfile": {"animationRole": "hinged-foregrip", "pivotType": "hinge", "destructionGroup": "foregrip_group"}};
  node_folding_vertical_foregrip_6.add(mesh_folding_vertical_foregrip_6);
  meshes["folding_vertical_foregrip"] = mesh_folding_vertical_foregrip_6;
  colliders["folding_vertical_foregrip"] = {};

  const endpoint_rubber_buttpad_7 = makeAttachmentEndpoint(null);
  const node_rubber_buttpad_7 = new THREE.Group();
  node_rubber_buttpad_7.name = "rubber_buttpad__pivot";
  node_rubber_buttpad_7.scale.set(1, 1, 1);
  if (endpoint_rubber_buttpad_7) {
    node_rubber_buttpad_7.position.copy(endpoint_rubber_buttpad_7.start);
    node_rubber_buttpad_7.rotation.set(0, 0, 0);
  } else {
    node_rubber_buttpad_7.position.set(0, 0, 0);
    node_rubber_buttpad_7.rotation.set(0, 0, 0);
  }
  node_rubber_buttpad_7.userData.sculptComponent = {"id": "rubber_buttpad", "name": "rubber_buttpad", "level": "meso", "parent": "polymer_stock_chassis", "role": "buttpad", "topologyClass": "continuous-sculpt", "topologyRationale": "Contoured vulcanized elastomer shoulder pad capping rear edge of bullpup stock.", "primitive": "extrude", "material": "mat_rubber_buttpad", "materialLayers": ["mat_rubber_buttpad"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 43, 40, 1.0)", "secondaryAlbedo": "rgba(29, 29, 27, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(43, 43, 40, 1.0)"}, {"position": 1.0, "color": "rgba(29, 29, 27, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "buttstock_rear", "localStart": [-0.395, -0.06, 0.0], "localEnd": [-0.376, -0.06, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "buttpad-seam-step", "type": "seam line", "placement": "rear chassis junction", "confidence": 0.95}], "actionProfile": {"animationRole": "static-part", "pivotType": "base", "destructionGroup": "chassis_group"}, "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "mat_rubber_buttpad"}, "materialRegions": [{"regionId": "buttpad-rubber", "materialId": "mat_rubber_buttpad", "profileId": "rubber.matte", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/05-buttpad-rubber.png", "bbox": {"x": 52, "y": 158, "width": 14, "height": 135}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.0041}}]};
  node_rubber_buttpad_7.userData.actionProfile = {"animationRole": "static-part", "pivotType": "base", "destructionGroup": "chassis_group"};
  (nodes["polymer_stock_chassis"] ?? root).add(node_rubber_buttpad_7);
  nodes["rubber_buttpad"] = node_rubber_buttpad_7;
  const mesh_rubber_buttpad_7Geometry = endpoint_rubber_buttpad_7
    ? new THREE.CylinderGeometry(endpoint_rubber_buttpad_7.endRadius, endpoint_rubber_buttpad_7.baseRadius, endpoint_rubber_buttpad_7.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_rubber_buttpad_7) {
    mesh_rubber_buttpad_7Geometry.scale(1, 1, 1);
  }
  const mesh_rubber_buttpad_7 = new THREE.Mesh(
    mesh_rubber_buttpad_7Geometry,
    materialMap["mat_rubber_buttpad"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rubber_buttpad_7.name = "rubber_buttpad";
  if (endpoint_rubber_buttpad_7) {
    mesh_rubber_buttpad_7.position.copy(endpoint_rubber_buttpad_7.midpoint);
    mesh_rubber_buttpad_7.quaternion.copy(endpoint_rubber_buttpad_7.quaternion);
  }
  mesh_rubber_buttpad_7.castShadow = options.castShadow ?? true;
  mesh_rubber_buttpad_7.receiveShadow = options.receiveShadow ?? true;
  mesh_rubber_buttpad_7.userData.sculptComponent = {"id": "rubber_buttpad", "name": "rubber_buttpad", "level": "meso", "parent": "polymer_stock_chassis", "role": "buttpad", "topologyClass": "continuous-sculpt", "topologyRationale": "Contoured vulcanized elastomer shoulder pad capping rear edge of bullpup stock.", "primitive": "extrude", "material": "mat_rubber_buttpad", "materialLayers": ["mat_rubber_buttpad"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 43, 40, 1.0)", "secondaryAlbedo": "rgba(29, 29, 27, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(43, 43, 40, 1.0)"}, {"position": 1.0, "color": "rgba(29, 29, 27, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "buttstock_rear", "localStart": [-0.395, -0.06, 0.0], "localEnd": [-0.376, -0.06, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "buttpad-seam-step", "type": "seam line", "placement": "rear chassis junction", "confidence": 0.95}], "actionProfile": {"animationRole": "static-part", "pivotType": "base", "destructionGroup": "chassis_group"}, "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "mat_rubber_buttpad"}, "materialRegions": [{"regionId": "buttpad-rubber", "materialId": "mat_rubber_buttpad", "profileId": "rubber.matte", "crop": {"path": "/home/eduardo/Antigravity/3D/projects/aug-a1/material-evidence/05-buttpad-rubber.png", "bbox": {"x": 52, "y": 158, "width": 14, "height": 135}, "sourceWidth": 1024, "sourceHeight": 448, "loaderWarnings": [], "coverage": 0.0041}}]};
  node_rubber_buttpad_7.add(mesh_rubber_buttpad_7);
  meshes["rubber_buttpad"] = mesh_rubber_buttpad_7;
  colliders["rubber_buttpad"] = {};

  const endpoint_ejection_port_right_8 = makeAttachmentEndpoint(null);
  const node_ejection_port_right_8 = new THREE.Group();
  node_ejection_port_right_8.name = "ejection_port_right__pivot";
  node_ejection_port_right_8.scale.set(1, 1, 1);
  if (endpoint_ejection_port_right_8) {
    node_ejection_port_right_8.position.copy(endpoint_ejection_port_right_8.start);
    node_ejection_port_right_8.rotation.set(0, 0, 0);
  } else {
    node_ejection_port_right_8.position.set(0, 0, 0);
    node_ejection_port_right_8.rotation.set(0, 0, 0);
  }
  node_ejection_port_right_8.userData.sculptComponent = {"id": "ejection_port_right", "name": "ejection_port_right", "level": "meso", "parent": "polymer_stock_chassis", "role": "ejection-port-right", "topologyClass": "assembled-solid", "topologyRationale": "Right-side (+Z) ejection opening frame and protruding molded deflector lip.", "primitive": "extrude", "material": "mat_receiver_anodized", "materialLayers": ["mat_receiver_anodized", "mat_polymer_od"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 45, 46, 1.0)", "secondaryAlbedo": "rgba(92, 96, 100, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.95, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(44, 45, 46, 1.0)"}, {"position": 1.0, "color": "rgba(92, 96, 100, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "ejection_right_mount", "localStart": [-0.21, 0.015, 0.022], "localEnd": [-0.115, 0.015, 0.024], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "ejection-lip-deflector", "type": "raised ridge", "placement": "forward edge of right ejection port", "confidence": 0.95}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_ejection_port_right_8.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"};
  (nodes["polymer_stock_chassis"] ?? root).add(node_ejection_port_right_8);
  nodes["ejection_port_right"] = node_ejection_port_right_8;
  const mesh_ejection_port_right_8Geometry = endpoint_ejection_port_right_8
    ? new THREE.CylinderGeometry(endpoint_ejection_port_right_8.endRadius, endpoint_ejection_port_right_8.baseRadius, endpoint_ejection_port_right_8.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_ejection_port_right_8) {
    mesh_ejection_port_right_8Geometry.scale(1, 1, 1);
  }
  const mesh_ejection_port_right_8 = new THREE.Mesh(
    mesh_ejection_port_right_8Geometry,
    materialMap["mat_receiver_anodized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ejection_port_right_8.name = "ejection_port_right";
  if (endpoint_ejection_port_right_8) {
    mesh_ejection_port_right_8.position.copy(endpoint_ejection_port_right_8.midpoint);
    mesh_ejection_port_right_8.quaternion.copy(endpoint_ejection_port_right_8.quaternion);
  }
  mesh_ejection_port_right_8.castShadow = options.castShadow ?? true;
  mesh_ejection_port_right_8.receiveShadow = options.receiveShadow ?? true;
  mesh_ejection_port_right_8.userData.sculptComponent = {"id": "ejection_port_right", "name": "ejection_port_right", "level": "meso", "parent": "polymer_stock_chassis", "role": "ejection-port-right", "topologyClass": "assembled-solid", "topologyRationale": "Right-side (+Z) ejection opening frame and protruding molded deflector lip.", "primitive": "extrude", "material": "mat_receiver_anodized", "materialLayers": ["mat_receiver_anodized", "mat_polymer_od"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 45, 46, 1.0)", "secondaryAlbedo": "rgba(92, 96, 100, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.95, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(44, 45, 46, 1.0)"}, {"position": 1.0, "color": "rgba(92, 96, 100, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "ejection_right_mount", "localStart": [-0.21, 0.015, 0.022], "localEnd": [-0.115, 0.015, 0.024], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "ejection-lip-deflector", "type": "raised ridge", "placement": "forward edge of right ejection port", "confidence": 0.95}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_ejection_port_right_8.add(mesh_ejection_port_right_8);
  meshes["ejection_port_right"] = mesh_ejection_port_right_8;
  colliders["ejection_port_right"] = {};

  const endpoint_ejection_blanking_plate_left_9 = makeAttachmentEndpoint(null);
  const node_ejection_blanking_plate_left_9 = new THREE.Group();
  node_ejection_blanking_plate_left_9.name = "ejection_blanking_plate_left__pivot";
  node_ejection_blanking_plate_left_9.scale.set(1, 1, 1);
  if (endpoint_ejection_blanking_plate_left_9) {
    node_ejection_blanking_plate_left_9.position.copy(endpoint_ejection_blanking_plate_left_9.start);
    node_ejection_blanking_plate_left_9.rotation.set(0, 0, 0);
  } else {
    node_ejection_blanking_plate_left_9.position.set(0, 0, 0);
    node_ejection_blanking_plate_left_9.rotation.set(0, 0, 0);
  }
  node_ejection_blanking_plate_left_9.userData.sculptComponent = {"id": "ejection_blanking_plate_left", "name": "ejection_blanking_plate_left", "level": "meso", "parent": "polymer_stock_chassis", "role": "blanking-plate-left", "topologyClass": "conforming-shell", "topologyRationale": "Flush left-side (-Z) molded polymer cover closing the unused left ejection port.", "primitive": "extrude", "material": "mat_polymer_od", "materialLayers": ["mat_polymer_od"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 88, 68, 1.0)", "secondaryAlbedo": "rgba(77, 73, 55, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(92, 88, 68, 1.0)"}, {"position": 1.0, "color": "rgba(77, 73, 55, 1.0)"}]}}, "importance": 0.85, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "ejection_left_mount", "localStart": [-0.21, 0.015, -0.023], "localEnd": [-0.115, 0.015, -0.023], "contactType": "surface-contact", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_left_side.png"]}, "localFeatures": [{"id": "blanking-plate-seam", "type": "seam line", "placement": "left upper stock port contour", "confidence": 0.93}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_ejection_blanking_plate_left_9.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"};
  (nodes["polymer_stock_chassis"] ?? root).add(node_ejection_blanking_plate_left_9);
  nodes["ejection_blanking_plate_left"] = node_ejection_blanking_plate_left_9;
  const mesh_ejection_blanking_plate_left_9Geometry = endpoint_ejection_blanking_plate_left_9
    ? new THREE.CylinderGeometry(endpoint_ejection_blanking_plate_left_9.endRadius, endpoint_ejection_blanking_plate_left_9.baseRadius, endpoint_ejection_blanking_plate_left_9.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_ejection_blanking_plate_left_9) {
    mesh_ejection_blanking_plate_left_9Geometry.scale(1, 1, 1);
  }
  const mesh_ejection_blanking_plate_left_9 = new THREE.Mesh(
    mesh_ejection_blanking_plate_left_9Geometry,
    materialMap["mat_polymer_od"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ejection_blanking_plate_left_9.name = "ejection_blanking_plate_left";
  if (endpoint_ejection_blanking_plate_left_9) {
    mesh_ejection_blanking_plate_left_9.position.copy(endpoint_ejection_blanking_plate_left_9.midpoint);
    mesh_ejection_blanking_plate_left_9.quaternion.copy(endpoint_ejection_blanking_plate_left_9.quaternion);
  }
  mesh_ejection_blanking_plate_left_9.castShadow = options.castShadow ?? true;
  mesh_ejection_blanking_plate_left_9.receiveShadow = options.receiveShadow ?? true;
  mesh_ejection_blanking_plate_left_9.userData.sculptComponent = {"id": "ejection_blanking_plate_left", "name": "ejection_blanking_plate_left", "level": "meso", "parent": "polymer_stock_chassis", "role": "blanking-plate-left", "topologyClass": "conforming-shell", "topologyRationale": "Flush left-side (-Z) molded polymer cover closing the unused left ejection port.", "primitive": "extrude", "material": "mat_polymer_od", "materialLayers": ["mat_polymer_od"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 88, 68, 1.0)", "secondaryAlbedo": "rgba(77, 73, 55, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(92, 88, 68, 1.0)"}, {"position": 1.0, "color": "rgba(77, 73, 55, 1.0)"}]}}, "importance": 0.85, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "ejection_left_mount", "localStart": [-0.21, 0.015, -0.023], "localEnd": [-0.115, 0.015, -0.023], "contactType": "surface-contact", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_left_side.png"]}, "localFeatures": [{"id": "blanking-plate-seam", "type": "seam line", "placement": "left upper stock port contour", "confidence": 0.93}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_ejection_blanking_plate_left_9.add(mesh_ejection_blanking_plate_left_9);
  meshes["ejection_blanking_plate_left"] = mesh_ejection_blanking_plate_left_9;
  colliders["ejection_blanking_plate_left"] = {};

  const attachment_enlarged_trigger_guard_loop_10 = {"parentId": "polymer_stock_chassis", "parentSocket": "trigger_guard_base", "localStart": [-0.068, -0.135, 0.0], "localEnd": [0.092, 0.005, 0.0], "contactType": "embedded", "embedDepth": 0.025, "overlap": 0.025, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]};
  const endpoint_enlarged_trigger_guard_loop_10 = makeAttachmentEndpoint(attachment_enlarged_trigger_guard_loop_10);
  const node_enlarged_trigger_guard_loop_10 = new THREE.Group();
  node_enlarged_trigger_guard_loop_10.name = "enlarged_trigger_guard_loop__pivot";
  node_enlarged_trigger_guard_loop_10.scale.set(1, 1, 1);
  if (endpoint_enlarged_trigger_guard_loop_10) {
    node_enlarged_trigger_guard_loop_10.position.copy(endpoint_enlarged_trigger_guard_loop_10.start);
    node_enlarged_trigger_guard_loop_10.rotation.set(0, 0, 0);
  } else {
    node_enlarged_trigger_guard_loop_10.position.set(0, 0, 0);
    node_enlarged_trigger_guard_loop_10.rotation.set(0, 0, 0);
  }
  node_enlarged_trigger_guard_loop_10.userData.sculptComponent = {"id": "enlarged_trigger_guard_loop", "name": "enlarged_trigger_guard_loop", "level": "meso", "parent": "polymer_stock_chassis", "role": "trigger-guard", "topologyClass": "continuous-sculpt", "topologyRationale": "Swept winter trigger guard strut framing the open hand loop beneath the receiver.", "primitive": "curve-sweep", "material": "mat_polymer_od", "materialLayers": ["mat_polymer_od"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 88, 68, 1.0)", "secondaryAlbedo": "rgba(77, 73, 55, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(92, 88, 68, 1.0)"}, {"position": 1.0, "color": "rgba(77, 73, 55, 1.0)"}]}}, "importance": 0.95, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "trigger_guard_base", "localStart": [-0.068, -0.135, 0.0], "localEnd": [0.092, 0.005, 0.0], "contactType": "embedded", "embedDepth": 0.025, "overlap": 0.025, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "guard-loop-cutout", "type": "hole or socket", "placement": "central open loop between grip and front ramp", "confidence": 0.98}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_enlarged_trigger_guard_loop_10.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"};
  (nodes["polymer_stock_chassis"] ?? root).add(node_enlarged_trigger_guard_loop_10);
  nodes["enlarged_trigger_guard_loop"] = node_enlarged_trigger_guard_loop_10;
  const mesh_enlarged_trigger_guard_loop_10Geometry = endpoint_enlarged_trigger_guard_loop_10
    ? new THREE.CylinderGeometry(endpoint_enlarged_trigger_guard_loop_10.endRadius, endpoint_enlarged_trigger_guard_loop_10.baseRadius, endpoint_enlarged_trigger_guard_loop_10.length, 32, 12)
    : buildCurveSweepGeometry({"spine": [[-0.5, -0.4, 0.0], [-0.1, 0.1, 0.0], [0.3, 0.2, 0.0], [0.6, -0.1, 0.0]], "crossSection": {"points": [[-0.04, -0.02], [0.04, -0.02], [0.04, 0.02], [-0.04, 0.02]]}, "closed": false});
  if (!endpoint_enlarged_trigger_guard_loop_10) {
    mesh_enlarged_trigger_guard_loop_10Geometry.scale(1, 1, 1);
  }
  const mesh_enlarged_trigger_guard_loop_10 = new THREE.Mesh(
    mesh_enlarged_trigger_guard_loop_10Geometry,
    materialMap["mat_polymer_od"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_enlarged_trigger_guard_loop_10.name = "enlarged_trigger_guard_loop";
  if (endpoint_enlarged_trigger_guard_loop_10) {
    mesh_enlarged_trigger_guard_loop_10.position.copy(endpoint_enlarged_trigger_guard_loop_10.midpoint);
    mesh_enlarged_trigger_guard_loop_10.quaternion.copy(endpoint_enlarged_trigger_guard_loop_10.quaternion);
  }
  mesh_enlarged_trigger_guard_loop_10.castShadow = options.castShadow ?? true;
  mesh_enlarged_trigger_guard_loop_10.receiveShadow = options.receiveShadow ?? true;
  mesh_enlarged_trigger_guard_loop_10.userData.sculptComponent = {"id": "enlarged_trigger_guard_loop", "name": "enlarged_trigger_guard_loop", "level": "meso", "parent": "polymer_stock_chassis", "role": "trigger-guard", "topologyClass": "continuous-sculpt", "topologyRationale": "Swept winter trigger guard strut framing the open hand loop beneath the receiver.", "primitive": "curve-sweep", "material": "mat_polymer_od", "materialLayers": ["mat_polymer_od"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 88, 68, 1.0)", "secondaryAlbedo": "rgba(77, 73, 55, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(92, 88, 68, 1.0)"}, {"position": 1.0, "color": "rgba(77, 73, 55, 1.0)"}]}}, "importance": 0.95, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "trigger_guard_base", "localStart": [-0.068, -0.135, 0.0], "localEnd": [0.092, 0.005, 0.0], "contactType": "embedded", "embedDepth": 0.025, "overlap": 0.025, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "guard-loop-cutout", "type": "hole or socket", "placement": "central open loop between grip and front ramp", "confidence": 0.98}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_enlarged_trigger_guard_loop_10.add(mesh_enlarged_trigger_guard_loop_10);
  meshes["enlarged_trigger_guard_loop"] = mesh_enlarged_trigger_guard_loop_10;
  colliders["enlarged_trigger_guard_loop"] = {};

  const attachment_optic_main_tube_11 = {"parentId": "integrated_optic_carry_handle", "parentSocket": "optic_tube_saddle", "localStart": [-0.045, 0.068, 0.0], "localEnd": [0.072, 0.068, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]};
  const endpoint_optic_main_tube_11 = makeAttachmentEndpoint(attachment_optic_main_tube_11);
  const node_optic_main_tube_11 = new THREE.Group();
  node_optic_main_tube_11.name = "optic_main_tube__pivot";
  node_optic_main_tube_11.scale.set(1, 1, 1);
  if (endpoint_optic_main_tube_11) {
    node_optic_main_tube_11.position.copy(endpoint_optic_main_tube_11.start);
    node_optic_main_tube_11.rotation.set(0, 0, 0);
  } else {
    node_optic_main_tube_11.position.set(0, 0, 0);
    node_optic_main_tube_11.rotation.set(0, 0, 0);
  }
  node_optic_main_tube_11.userData.sculptComponent = {"id": "optic_main_tube", "name": "optic_main_tube", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "optic-tube", "topologyClass": "assembled-solid", "topologyRationale": "Cylindrical Swarovski 1.5x optic body spanning between front objective ring and turret saddle.", "primitive": "cylinder", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.95, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "optic_tube_saddle", "localStart": [-0.045, 0.068, 0.0], "localEnd": [0.072, 0.068, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"}};
  node_optic_main_tube_11.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"};
  (nodes["integrated_optic_carry_handle"] ?? root).add(node_optic_main_tube_11);
  nodes["optic_main_tube"] = node_optic_main_tube_11;
  const mesh_optic_main_tube_11Geometry = endpoint_optic_main_tube_11
    ? new THREE.CylinderGeometry(endpoint_optic_main_tube_11.endRadius, endpoint_optic_main_tube_11.baseRadius, endpoint_optic_main_tube_11.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_optic_main_tube_11) {
    mesh_optic_main_tube_11Geometry.scale(1, 1, 1);
  }
  const mesh_optic_main_tube_11 = new THREE.Mesh(
    mesh_optic_main_tube_11Geometry,
    materialMap["mat_optic_worn_metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_optic_main_tube_11.name = "optic_main_tube";
  if (endpoint_optic_main_tube_11) {
    mesh_optic_main_tube_11.position.copy(endpoint_optic_main_tube_11.midpoint);
    mesh_optic_main_tube_11.quaternion.copy(endpoint_optic_main_tube_11.quaternion);
  }
  mesh_optic_main_tube_11.castShadow = options.castShadow ?? true;
  mesh_optic_main_tube_11.receiveShadow = options.receiveShadow ?? true;
  mesh_optic_main_tube_11.userData.sculptComponent = {"id": "optic_main_tube", "name": "optic_main_tube", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "optic-tube", "topologyClass": "assembled-solid", "topologyRationale": "Cylindrical Swarovski 1.5x optic body spanning between front objective ring and turret saddle.", "primitive": "cylinder", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.95, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "optic_tube_saddle", "localStart": [-0.045, 0.068, 0.0], "localEnd": [0.072, 0.068, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"}};
  node_optic_main_tube_11.add(mesh_optic_main_tube_11);
  meshes["optic_main_tube"] = mesh_optic_main_tube_11;
  colliders["optic_main_tube"] = {};

  const endpoint_optic_ocular_bell_12 = makeAttachmentEndpoint(null);
  const node_optic_ocular_bell_12 = new THREE.Group();
  node_optic_ocular_bell_12.name = "optic_ocular_bell__pivot";
  node_optic_ocular_bell_12.scale.set(1, 1, 1);
  if (endpoint_optic_ocular_bell_12) {
    node_optic_ocular_bell_12.position.copy(endpoint_optic_ocular_bell_12.start);
    node_optic_ocular_bell_12.rotation.set(0, 0, 0);
  } else {
    node_optic_ocular_bell_12.position.set(0, 0, 0);
    node_optic_ocular_bell_12.rotation.set(0, 0, 0);
  }
  node_optic_ocular_bell_12.userData.sculptComponent = {"id": "optic_ocular_bell", "name": "optic_ocular_bell", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "ocular-bell", "topologyClass": "assembled-solid", "topologyRationale": "Stepped flared rear ocular bell and rim collar of the 1.5x scope.", "primitive": "lathe", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.92, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "optic_rear_bell", "localStart": [-0.125, 0.068, 0.0], "localEnd": [-0.04, 0.068, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"}};
  node_optic_ocular_bell_12.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"};
  (nodes["integrated_optic_carry_handle"] ?? root).add(node_optic_ocular_bell_12);
  nodes["optic_ocular_bell"] = node_optic_ocular_bell_12;
  const mesh_optic_ocular_bell_12Geometry = endpoint_optic_ocular_bell_12
    ? new THREE.CylinderGeometry(endpoint_optic_ocular_bell_12.endRadius, endpoint_optic_ocular_bell_12.baseRadius, endpoint_optic_ocular_bell_12.length, 32, 12)
    : buildLatheGeometry({"points": [[0.3, -0.5], [0.15, 0.0], [0.3, 0.5]], "segments": 24});
  if (!endpoint_optic_ocular_bell_12) {
    mesh_optic_ocular_bell_12Geometry.scale(1, 1, 1);
  }
  const mesh_optic_ocular_bell_12 = new THREE.Mesh(
    mesh_optic_ocular_bell_12Geometry,
    materialMap["mat_optic_worn_metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_optic_ocular_bell_12.name = "optic_ocular_bell";
  if (endpoint_optic_ocular_bell_12) {
    mesh_optic_ocular_bell_12.position.copy(endpoint_optic_ocular_bell_12.midpoint);
    mesh_optic_ocular_bell_12.quaternion.copy(endpoint_optic_ocular_bell_12.quaternion);
  }
  mesh_optic_ocular_bell_12.castShadow = options.castShadow ?? true;
  mesh_optic_ocular_bell_12.receiveShadow = options.receiveShadow ?? true;
  mesh_optic_ocular_bell_12.userData.sculptComponent = {"id": "optic_ocular_bell", "name": "optic_ocular_bell", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "ocular-bell", "topologyClass": "assembled-solid", "topologyRationale": "Stepped flared rear ocular bell and rim collar of the 1.5x scope.", "primitive": "lathe", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.92, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "optic_rear_bell", "localStart": [-0.125, 0.068, 0.0], "localEnd": [-0.04, 0.068, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"}};
  node_optic_ocular_bell_12.add(mesh_optic_ocular_bell_12);
  meshes["optic_ocular_bell"] = mesh_optic_ocular_bell_12;
  colliders["optic_ocular_bell"] = {};

  const endpoint_optic_front_strut_13 = makeAttachmentEndpoint(null);
  const node_optic_front_strut_13 = new THREE.Group();
  node_optic_front_strut_13.name = "optic_front_strut__pivot";
  node_optic_front_strut_13.scale.set(1, 1, 1);
  if (endpoint_optic_front_strut_13) {
    node_optic_front_strut_13.position.copy(endpoint_optic_front_strut_13.start);
    node_optic_front_strut_13.rotation.set(0, 0, 0);
  } else {
    node_optic_front_strut_13.position.set(0, 0, 0);
    node_optic_front_strut_13.rotation.set(0, 0, 0);
  }
  node_optic_front_strut_13.userData.sculptComponent = {"id": "optic_front_strut", "name": "optic_front_strut", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "optic-pillar-front", "topologyClass": "continuous-sculpt", "topologyRationale": "Swept cast front mounting pillar connecting optic tube forward onto the receiver with top lock ramp.", "primitive": "extrude", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.93, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "optic_front_mount", "localStart": [0.055, 0.066, 0.0], "localEnd": [0.135, 0.015, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "front-strut-ramp-nub", "type": "raised ridge", "placement": "sloped forward face of front optic pillar", "confidence": 0.95}], "actionProfile": {"animationRole": "static-part", "pivotType": "base", "destructionGroup": "optic_group"}};
  node_optic_front_strut_13.userData.actionProfile = {"animationRole": "static-part", "pivotType": "base", "destructionGroup": "optic_group"};
  (nodes["integrated_optic_carry_handle"] ?? root).add(node_optic_front_strut_13);
  nodes["optic_front_strut"] = node_optic_front_strut_13;
  const mesh_optic_front_strut_13Geometry = endpoint_optic_front_strut_13
    ? new THREE.CylinderGeometry(endpoint_optic_front_strut_13.endRadius, endpoint_optic_front_strut_13.baseRadius, endpoint_optic_front_strut_13.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_optic_front_strut_13) {
    mesh_optic_front_strut_13Geometry.scale(1, 1, 1);
  }
  const mesh_optic_front_strut_13 = new THREE.Mesh(
    mesh_optic_front_strut_13Geometry,
    materialMap["mat_optic_worn_metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_optic_front_strut_13.name = "optic_front_strut";
  if (endpoint_optic_front_strut_13) {
    mesh_optic_front_strut_13.position.copy(endpoint_optic_front_strut_13.midpoint);
    mesh_optic_front_strut_13.quaternion.copy(endpoint_optic_front_strut_13.quaternion);
  }
  mesh_optic_front_strut_13.castShadow = options.castShadow ?? true;
  mesh_optic_front_strut_13.receiveShadow = options.receiveShadow ?? true;
  mesh_optic_front_strut_13.userData.sculptComponent = {"id": "optic_front_strut", "name": "optic_front_strut", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "optic-pillar-front", "topologyClass": "continuous-sculpt", "topologyRationale": "Swept cast front mounting pillar connecting optic tube forward onto the receiver with top lock ramp.", "primitive": "extrude", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.93, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "optic_front_mount", "localStart": [0.055, 0.066, 0.0], "localEnd": [0.135, 0.015, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "front-strut-ramp-nub", "type": "raised ridge", "placement": "sloped forward face of front optic pillar", "confidence": 0.95}], "actionProfile": {"animationRole": "static-part", "pivotType": "base", "destructionGroup": "optic_group"}};
  node_optic_front_strut_13.add(mesh_optic_front_strut_13);
  meshes["optic_front_strut"] = mesh_optic_front_strut_13;
  colliders["optic_front_strut"] = {};

  const endpoint_optic_rear_strut_14 = makeAttachmentEndpoint(null);
  const node_optic_rear_strut_14 = new THREE.Group();
  node_optic_rear_strut_14.name = "optic_rear_strut__pivot";
  node_optic_rear_strut_14.scale.set(1, 1, 1);
  if (endpoint_optic_rear_strut_14) {
    node_optic_rear_strut_14.position.copy(endpoint_optic_rear_strut_14.start);
    node_optic_rear_strut_14.rotation.set(0, 0, 0);
  } else {
    node_optic_rear_strut_14.position.set(0, 0, 0);
    node_optic_rear_strut_14.rotation.set(0, 0, 0);
  }
  node_optic_rear_strut_14.userData.sculptComponent = {"id": "optic_rear_strut", "name": "optic_rear_strut", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "optic-pillar-rear", "topologyClass": "continuous-sculpt", "topologyRationale": "Curved rear carry-handle arch pillar joining scope saddle down to rear upper receiver.", "primitive": "extrude", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.93, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "optic_rear_mount", "localStart": [-0.042, 0.064, 0.0], "localEnd": [-0.015, 0.015, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "base", "destructionGroup": "optic_group"}};
  node_optic_rear_strut_14.userData.actionProfile = {"animationRole": "static-part", "pivotType": "base", "destructionGroup": "optic_group"};
  (nodes["integrated_optic_carry_handle"] ?? root).add(node_optic_rear_strut_14);
  nodes["optic_rear_strut"] = node_optic_rear_strut_14;
  const mesh_optic_rear_strut_14Geometry = endpoint_optic_rear_strut_14
    ? new THREE.CylinderGeometry(endpoint_optic_rear_strut_14.endRadius, endpoint_optic_rear_strut_14.baseRadius, endpoint_optic_rear_strut_14.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_optic_rear_strut_14) {
    mesh_optic_rear_strut_14Geometry.scale(1, 1, 1);
  }
  const mesh_optic_rear_strut_14 = new THREE.Mesh(
    mesh_optic_rear_strut_14Geometry,
    materialMap["mat_optic_worn_metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_optic_rear_strut_14.name = "optic_rear_strut";
  if (endpoint_optic_rear_strut_14) {
    mesh_optic_rear_strut_14.position.copy(endpoint_optic_rear_strut_14.midpoint);
    mesh_optic_rear_strut_14.quaternion.copy(endpoint_optic_rear_strut_14.quaternion);
  }
  mesh_optic_rear_strut_14.castShadow = options.castShadow ?? true;
  mesh_optic_rear_strut_14.receiveShadow = options.receiveShadow ?? true;
  mesh_optic_rear_strut_14.userData.sculptComponent = {"id": "optic_rear_strut", "name": "optic_rear_strut", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "optic-pillar-rear", "topologyClass": "continuous-sculpt", "topologyRationale": "Curved rear carry-handle arch pillar joining scope saddle down to rear upper receiver.", "primitive": "extrude", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.93, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "optic_rear_mount", "localStart": [-0.042, 0.064, 0.0], "localEnd": [-0.015, 0.015, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "base", "destructionGroup": "optic_group"}};
  node_optic_rear_strut_14.add(mesh_optic_rear_strut_14);
  meshes["optic_rear_strut"] = mesh_optic_rear_strut_14;
  colliders["optic_rear_strut"] = {};

  const attachment_optic_turret_housing_15 = {"parentId": "integrated_optic_carry_handle", "parentSocket": "turret_saddle", "localStart": [0.014, 0.068, 0.0], "localEnd": [0.032, 0.086, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]};
  const endpoint_optic_turret_housing_15 = makeAttachmentEndpoint(attachment_optic_turret_housing_15);
  const node_optic_turret_housing_15 = new THREE.Group();
  node_optic_turret_housing_15.name = "optic_turret_housing__pivot";
  node_optic_turret_housing_15.scale.set(1, 1, 1);
  if (endpoint_optic_turret_housing_15) {
    node_optic_turret_housing_15.position.copy(endpoint_optic_turret_housing_15.start);
    node_optic_turret_housing_15.rotation.set(0, 0, 0);
  } else {
    node_optic_turret_housing_15.position.set(0, 0, 0);
    node_optic_turret_housing_15.rotation.set(0, 0, 0);
  }
  node_optic_turret_housing_15.userData.sculptComponent = {"id": "optic_turret_housing", "name": "optic_turret_housing", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "optic-turrets", "topologyClass": "assembled-solid", "topologyRationale": "Central turret block with cylindrical windage (+/-Z) and elevation (+Y) adjustment caps.", "primitive": "cylinder", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "turret_saddle", "localStart": [0.014, 0.068, 0.0], "localEnd": [0.032, 0.086, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "turret-adjustment-caps", "type": "raised ridge", "placement": "center optic saddle top and both sides", "confidence": 0.96}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"}};
  node_optic_turret_housing_15.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"};
  (nodes["integrated_optic_carry_handle"] ?? root).add(node_optic_turret_housing_15);
  nodes["optic_turret_housing"] = node_optic_turret_housing_15;
  const mesh_optic_turret_housing_15Geometry = endpoint_optic_turret_housing_15
    ? new THREE.CylinderGeometry(endpoint_optic_turret_housing_15.endRadius, endpoint_optic_turret_housing_15.baseRadius, endpoint_optic_turret_housing_15.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_optic_turret_housing_15) {
    mesh_optic_turret_housing_15Geometry.scale(1, 1, 1);
  }
  const mesh_optic_turret_housing_15 = new THREE.Mesh(
    mesh_optic_turret_housing_15Geometry,
    materialMap["mat_optic_worn_metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_optic_turret_housing_15.name = "optic_turret_housing";
  if (endpoint_optic_turret_housing_15) {
    mesh_optic_turret_housing_15.position.copy(endpoint_optic_turret_housing_15.midpoint);
    mesh_optic_turret_housing_15.quaternion.copy(endpoint_optic_turret_housing_15.quaternion);
  }
  mesh_optic_turret_housing_15.castShadow = options.castShadow ?? true;
  mesh_optic_turret_housing_15.receiveShadow = options.receiveShadow ?? true;
  mesh_optic_turret_housing_15.userData.sculptComponent = {"id": "optic_turret_housing", "name": "optic_turret_housing", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "optic-turrets", "topologyClass": "assembled-solid", "topologyRationale": "Central turret block with cylindrical windage (+/-Z) and elevation (+Y) adjustment caps.", "primitive": "cylinder", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "turret_saddle", "localStart": [0.014, 0.068, 0.0], "localEnd": [0.032, 0.086, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "turret-adjustment-caps", "type": "raised ridge", "placement": "center optic saddle top and both sides", "confidence": 0.96}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"}};
  node_optic_turret_housing_15.add(mesh_optic_turret_housing_15);
  meshes["optic_turret_housing"] = mesh_optic_turret_housing_15;
  colliders["optic_turret_housing"] = {};

  const attachment_optic_lenses_16 = {"parentId": "integrated_optic_carry_handle", "parentSocket": "lens_seats", "localStart": [-0.12, 0.068, 0.0], "localEnd": [0.07, 0.068, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]};
  const endpoint_optic_lenses_16 = makeAttachmentEndpoint(attachment_optic_lenses_16);
  const node_optic_lenses_16 = new THREE.Group();
  node_optic_lenses_16.name = "optic_lenses__pivot";
  node_optic_lenses_16.scale.set(1, 1, 1);
  if (endpoint_optic_lenses_16) {
    node_optic_lenses_16.position.copy(endpoint_optic_lenses_16.start);
    node_optic_lenses_16.rotation.set(0, 0, 0);
  } else {
    node_optic_lenses_16.position.set(0, 0, 0);
    node_optic_lenses_16.rotation.set(0, 0, 0);
  }
  node_optic_lenses_16.userData.sculptComponent = {"id": "optic_lenses", "name": "optic_lenses", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "optic-glass", "topologyClass": "assembled-solid", "topologyRationale": "Coated objective and ocular lenses recessed slightly inside optic tube ends.", "primitive": "cylinder", "material": "mat_optic_glass", "materialLayers": ["mat_optic_glass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 26, 32, 1.0)", "secondaryAlbedo": "rgba(31, 50, 59, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(18, 26, 32, 1.0)"}, {"position": 1.0, "color": "rgba(31, 50, 59, 1.0)"}]}}, "importance": 0.85, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "lens_seats", "localStart": [-0.12, 0.068, 0.0], "localEnd": [0.07, 0.068, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"}};
  node_optic_lenses_16.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"};
  (nodes["integrated_optic_carry_handle"] ?? root).add(node_optic_lenses_16);
  nodes["optic_lenses"] = node_optic_lenses_16;
  const mesh_optic_lenses_16Geometry = endpoint_optic_lenses_16
    ? new THREE.CylinderGeometry(endpoint_optic_lenses_16.endRadius, endpoint_optic_lenses_16.baseRadius, endpoint_optic_lenses_16.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_optic_lenses_16) {
    mesh_optic_lenses_16Geometry.scale(1, 1, 1);
  }
  const mesh_optic_lenses_16 = new THREE.Mesh(
    mesh_optic_lenses_16Geometry,
    materialMap["mat_optic_glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_optic_lenses_16.name = "optic_lenses";
  if (endpoint_optic_lenses_16) {
    mesh_optic_lenses_16.position.copy(endpoint_optic_lenses_16.midpoint);
    mesh_optic_lenses_16.quaternion.copy(endpoint_optic_lenses_16.quaternion);
  }
  mesh_optic_lenses_16.castShadow = options.castShadow ?? true;
  mesh_optic_lenses_16.receiveShadow = options.receiveShadow ?? true;
  mesh_optic_lenses_16.userData.sculptComponent = {"id": "optic_lenses", "name": "optic_lenses", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "optic-glass", "topologyClass": "assembled-solid", "topologyRationale": "Coated objective and ocular lenses recessed slightly inside optic tube ends.", "primitive": "cylinder", "material": "mat_optic_glass", "materialLayers": ["mat_optic_glass"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(18, 26, 32, 1.0)", "secondaryAlbedo": "rgba(31, 50, 59, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(18, 26, 32, 1.0)"}, {"position": 1.0, "color": "rgba(31, 50, 59, 1.0)"}]}}, "importance": 0.85, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "lens_seats", "localStart": [-0.12, 0.068, 0.0], "localEnd": [0.07, 0.068, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"}};
  node_optic_lenses_16.add(mesh_optic_lenses_16);
  meshes["optic_lenses"] = mesh_optic_lenses_16;
  colliders["optic_lenses"] = {};

  const endpoint_backup_iron_sights_17 = makeAttachmentEndpoint(null);
  const node_backup_iron_sights_17 = new THREE.Group();
  node_backup_iron_sights_17.name = "backup_iron_sights__pivot";
  node_backup_iron_sights_17.scale.set(1, 1, 1);
  if (endpoint_backup_iron_sights_17) {
    node_backup_iron_sights_17.position.copy(endpoint_backup_iron_sights_17.start);
    node_backup_iron_sights_17.rotation.set(0, 0, 0);
  } else {
    node_backup_iron_sights_17.position.set(0, 0, 0);
    node_backup_iron_sights_17.rotation.set(0, 0, 0);
  }
  node_backup_iron_sights_17.userData.sculptComponent = {"id": "backup_iron_sights", "name": "backup_iron_sights", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "backup-sights", "topologyClass": "assembled-solid", "topologyRationale": "Molded emergency front blade post and rear notch on top of the 1.5x optic housing.", "primitive": "box", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.85, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "optic_top_spine", "localStart": [-0.118, 0.082, 0.0], "localEnd": [0.065, 0.082, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"}};
  node_backup_iron_sights_17.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"};
  (nodes["integrated_optic_carry_handle"] ?? root).add(node_backup_iron_sights_17);
  nodes["backup_iron_sights"] = node_backup_iron_sights_17;
  const mesh_backup_iron_sights_17Geometry = endpoint_backup_iron_sights_17
    ? new THREE.CylinderGeometry(endpoint_backup_iron_sights_17.endRadius, endpoint_backup_iron_sights_17.baseRadius, endpoint_backup_iron_sights_17.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_backup_iron_sights_17) {
    mesh_backup_iron_sights_17Geometry.scale(1, 1, 1);
  }
  const mesh_backup_iron_sights_17 = new THREE.Mesh(
    mesh_backup_iron_sights_17Geometry,
    materialMap["mat_optic_worn_metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_backup_iron_sights_17.name = "backup_iron_sights";
  if (endpoint_backup_iron_sights_17) {
    mesh_backup_iron_sights_17.position.copy(endpoint_backup_iron_sights_17.midpoint);
    mesh_backup_iron_sights_17.quaternion.copy(endpoint_backup_iron_sights_17.quaternion);
  }
  mesh_backup_iron_sights_17.castShadow = options.castShadow ?? true;
  mesh_backup_iron_sights_17.receiveShadow = options.receiveShadow ?? true;
  mesh_backup_iron_sights_17.userData.sculptComponent = {"id": "backup_iron_sights", "name": "backup_iron_sights", "level": "meso", "parent": "integrated_optic_carry_handle", "role": "backup-sights", "topologyClass": "assembled-solid", "topologyRationale": "Molded emergency front blade post and rear notch on top of the 1.5x optic housing.", "primitive": "box", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.85, "attachment": {"parentId": "integrated_optic_carry_handle", "parentSocket": "optic_top_spine", "localStart": [-0.118, 0.082, 0.0], "localEnd": [0.065, 0.082, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "optic_group"}};
  node_backup_iron_sights_17.add(mesh_backup_iron_sights_17);
  meshes["backup_iron_sights"] = mesh_backup_iron_sights_17;
  colliders["backup_iron_sights"] = {};

  const attachment_gas_regulator_block_18 = {"parentId": "barrel_gas_muzzle_assembly", "parentSocket": "gas_port_seat", "localStart": [0.14, -0.015, 0.0], "localEnd": [0.195, -0.015, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]};
  const endpoint_gas_regulator_block_18 = makeAttachmentEndpoint(attachment_gas_regulator_block_18);
  const node_gas_regulator_block_18 = new THREE.Group();
  node_gas_regulator_block_18.name = "gas_regulator_block__pivot";
  node_gas_regulator_block_18.scale.set(1, 1, 1);
  if (endpoint_gas_regulator_block_18) {
    node_gas_regulator_block_18.position.copy(endpoint_gas_regulator_block_18.start);
    node_gas_regulator_block_18.rotation.set(0, 0, 0);
  } else {
    node_gas_regulator_block_18.position.set(0, 0, 0);
    node_gas_regulator_block_18.rotation.set(0, 0, 0);
  }
  node_gas_regulator_block_18.userData.sculptComponent = {"id": "gas_regulator_block", "name": "gas_regulator_block", "level": "meso", "parent": "barrel_gas_muzzle_assembly", "role": "gas-regulator", "topologyClass": "assembled-solid", "topologyRationale": "Under-barrel stepped gas block cylinder and regulator knob emerging forward of the receiver.", "primitive": "cylinder", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "barrel_gas_muzzle_assembly", "parentSocket": "gas_port_seat", "localStart": [0.14, -0.015, 0.0], "localEnd": [0.195, -0.015, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "base", "destructionGroup": "barrel_group"}};
  node_gas_regulator_block_18.userData.actionProfile = {"animationRole": "static-part", "pivotType": "base", "destructionGroup": "barrel_group"};
  (nodes["barrel_gas_muzzle_assembly"] ?? root).add(node_gas_regulator_block_18);
  nodes["gas_regulator_block"] = node_gas_regulator_block_18;
  const mesh_gas_regulator_block_18Geometry = endpoint_gas_regulator_block_18
    ? new THREE.CylinderGeometry(endpoint_gas_regulator_block_18.endRadius, endpoint_gas_regulator_block_18.baseRadius, endpoint_gas_regulator_block_18.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_gas_regulator_block_18) {
    mesh_gas_regulator_block_18Geometry.scale(1, 1, 1);
  }
  const mesh_gas_regulator_block_18 = new THREE.Mesh(
    mesh_gas_regulator_block_18Geometry,
    materialMap["mat_barrel_parkerized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_gas_regulator_block_18.name = "gas_regulator_block";
  if (endpoint_gas_regulator_block_18) {
    mesh_gas_regulator_block_18.position.copy(endpoint_gas_regulator_block_18.midpoint);
    mesh_gas_regulator_block_18.quaternion.copy(endpoint_gas_regulator_block_18.quaternion);
  }
  mesh_gas_regulator_block_18.castShadow = options.castShadow ?? true;
  mesh_gas_regulator_block_18.receiveShadow = options.receiveShadow ?? true;
  mesh_gas_regulator_block_18.userData.sculptComponent = {"id": "gas_regulator_block", "name": "gas_regulator_block", "level": "meso", "parent": "barrel_gas_muzzle_assembly", "role": "gas-regulator", "topologyClass": "assembled-solid", "topologyRationale": "Under-barrel stepped gas block cylinder and regulator knob emerging forward of the receiver.", "primitive": "cylinder", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "barrel_gas_muzzle_assembly", "parentSocket": "gas_port_seat", "localStart": [0.14, -0.015, 0.0], "localEnd": [0.195, -0.015, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "base", "destructionGroup": "barrel_group"}};
  node_gas_regulator_block_18.add(mesh_gas_regulator_block_18);
  meshes["gas_regulator_block"] = mesh_gas_regulator_block_18;
  colliders["gas_regulator_block"] = {};

  const attachment_barrel_clamp_lug_19 = {"parentId": "barrel_gas_muzzle_assembly", "parentSocket": "barrel_mid_collar", "localStart": [0.27, 0.0, 0.0], "localEnd": [0.282, 0.0, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]};
  const endpoint_barrel_clamp_lug_19 = makeAttachmentEndpoint(attachment_barrel_clamp_lug_19);
  const node_barrel_clamp_lug_19 = new THREE.Group();
  node_barrel_clamp_lug_19.name = "barrel_clamp_lug__pivot";
  node_barrel_clamp_lug_19.scale.set(1, 1, 1);
  if (endpoint_barrel_clamp_lug_19) {
    node_barrel_clamp_lug_19.position.copy(endpoint_barrel_clamp_lug_19.start);
    node_barrel_clamp_lug_19.rotation.set(0, 0, 0);
  } else {
    node_barrel_clamp_lug_19.position.set(0, 0, 0);
    node_barrel_clamp_lug_19.rotation.set(0, 0, 0);
  }
  node_barrel_clamp_lug_19.userData.sculptComponent = {"id": "barrel_clamp_lug", "name": "barrel_clamp_lug", "level": "meso", "parent": "barrel_gas_muzzle_assembly", "role": "barrel-lug", "topologyClass": "assembled-solid", "topologyRationale": "Mid-barrel circular clamp ring with upper alignment spur and lower rectangular screw lug.", "primitive": "cylinder", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.92, "attachment": {"parentId": "barrel_gas_muzzle_assembly", "parentSocket": "barrel_mid_collar", "localStart": [0.27, 0.0, 0.0], "localEnd": [0.282, 0.0, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "collar-clamp-bolt", "type": "raised ridge", "placement": "mid-barrel collar upper spur and bottom lug", "confidence": 0.96}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "barrel_group"}};
  node_barrel_clamp_lug_19.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "barrel_group"};
  (nodes["barrel_gas_muzzle_assembly"] ?? root).add(node_barrel_clamp_lug_19);
  nodes["barrel_clamp_lug"] = node_barrel_clamp_lug_19;
  const mesh_barrel_clamp_lug_19Geometry = endpoint_barrel_clamp_lug_19
    ? new THREE.CylinderGeometry(endpoint_barrel_clamp_lug_19.endRadius, endpoint_barrel_clamp_lug_19.baseRadius, endpoint_barrel_clamp_lug_19.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_barrel_clamp_lug_19) {
    mesh_barrel_clamp_lug_19Geometry.scale(1, 1, 1);
  }
  const mesh_barrel_clamp_lug_19 = new THREE.Mesh(
    mesh_barrel_clamp_lug_19Geometry,
    materialMap["mat_barrel_parkerized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_barrel_clamp_lug_19.name = "barrel_clamp_lug";
  if (endpoint_barrel_clamp_lug_19) {
    mesh_barrel_clamp_lug_19.position.copy(endpoint_barrel_clamp_lug_19.midpoint);
    mesh_barrel_clamp_lug_19.quaternion.copy(endpoint_barrel_clamp_lug_19.quaternion);
  }
  mesh_barrel_clamp_lug_19.castShadow = options.castShadow ?? true;
  mesh_barrel_clamp_lug_19.receiveShadow = options.receiveShadow ?? true;
  mesh_barrel_clamp_lug_19.userData.sculptComponent = {"id": "barrel_clamp_lug", "name": "barrel_clamp_lug", "level": "meso", "parent": "barrel_gas_muzzle_assembly", "role": "barrel-lug", "topologyClass": "assembled-solid", "topologyRationale": "Mid-barrel circular clamp ring with upper alignment spur and lower rectangular screw lug.", "primitive": "cylinder", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.92, "attachment": {"parentId": "barrel_gas_muzzle_assembly", "parentSocket": "barrel_mid_collar", "localStart": [0.27, 0.0, 0.0], "localEnd": [0.282, 0.0, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "collar-clamp-bolt", "type": "raised ridge", "placement": "mid-barrel collar upper spur and bottom lug", "confidence": 0.96}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "barrel_group"}};
  node_barrel_clamp_lug_19.add(mesh_barrel_clamp_lug_19);
  meshes["barrel_clamp_lug"] = mesh_barrel_clamp_lug_19;
  colliders["barrel_clamp_lug"] = {};

  const endpoint_tulip_flash_hider_20 = makeAttachmentEndpoint(null);
  const node_tulip_flash_hider_20 = new THREE.Group();
  node_tulip_flash_hider_20.name = "tulip_flash_hider__pivot";
  node_tulip_flash_hider_20.scale.set(1, 1, 1);
  if (endpoint_tulip_flash_hider_20) {
    node_tulip_flash_hider_20.position.copy(endpoint_tulip_flash_hider_20.start);
    node_tulip_flash_hider_20.rotation.set(0, 0, 0);
  } else {
    node_tulip_flash_hider_20.position.set(0, 0, 0);
    node_tulip_flash_hider_20.rotation.set(0, 0, 0);
  }
  node_tulip_flash_hider_20.userData.sculptComponent = {"id": "tulip_flash_hider", "name": "tulip_flash_hider", "level": "meso", "parent": "barrel_gas_muzzle_assembly", "role": "muzzle-flash-hider", "topologyClass": "assembled-solid", "topologyRationale": "Stepped check-nut collar and cylindrical Steyr tulip flash hider at the muzzle tip.", "primitive": "lathe", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.96, "attachment": {"parentId": "barrel_gas_muzzle_assembly", "parentSocket": "muzzle_threads", "localStart": [0.335, 0.0, 0.0], "localEnd": [0.395, 0.0, 0.0], "contactType": "socket", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "flash-hider-prongs", "type": "groove", "placement": "radial longitudinal slots at muzzle", "confidence": 0.97}], "actionProfile": {"animationRole": "muzzle-tip", "pivotType": "base", "destructionGroup": "barrel_group"}};
  node_tulip_flash_hider_20.userData.actionProfile = {"animationRole": "muzzle-tip", "pivotType": "base", "destructionGroup": "barrel_group"};
  (nodes["barrel_gas_muzzle_assembly"] ?? root).add(node_tulip_flash_hider_20);
  nodes["tulip_flash_hider"] = node_tulip_flash_hider_20;
  const mesh_tulip_flash_hider_20Geometry = endpoint_tulip_flash_hider_20
    ? new THREE.CylinderGeometry(endpoint_tulip_flash_hider_20.endRadius, endpoint_tulip_flash_hider_20.baseRadius, endpoint_tulip_flash_hider_20.length, 32, 12)
    : buildLatheGeometry({"points": [[0.3, -0.5], [0.15, 0.0], [0.3, 0.5]], "segments": 24});
  if (!endpoint_tulip_flash_hider_20) {
    mesh_tulip_flash_hider_20Geometry.scale(1, 1, 1);
  }
  const mesh_tulip_flash_hider_20 = new THREE.Mesh(
    mesh_tulip_flash_hider_20Geometry,
    materialMap["mat_barrel_parkerized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tulip_flash_hider_20.name = "tulip_flash_hider";
  if (endpoint_tulip_flash_hider_20) {
    mesh_tulip_flash_hider_20.position.copy(endpoint_tulip_flash_hider_20.midpoint);
    mesh_tulip_flash_hider_20.quaternion.copy(endpoint_tulip_flash_hider_20.quaternion);
  }
  mesh_tulip_flash_hider_20.castShadow = options.castShadow ?? true;
  mesh_tulip_flash_hider_20.receiveShadow = options.receiveShadow ?? true;
  mesh_tulip_flash_hider_20.userData.sculptComponent = {"id": "tulip_flash_hider", "name": "tulip_flash_hider", "level": "meso", "parent": "barrel_gas_muzzle_assembly", "role": "muzzle-flash-hider", "topologyClass": "assembled-solid", "topologyRationale": "Stepped check-nut collar and cylindrical Steyr tulip flash hider at the muzzle tip.", "primitive": "lathe", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.96, "attachment": {"parentId": "barrel_gas_muzzle_assembly", "parentSocket": "muzzle_threads", "localStart": [0.335, 0.0, 0.0], "localEnd": [0.395, 0.0, 0.0], "contactType": "socket", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "flash-hider-prongs", "type": "groove", "placement": "radial longitudinal slots at muzzle", "confidence": 0.97}], "actionProfile": {"animationRole": "muzzle-tip", "pivotType": "base", "destructionGroup": "barrel_group"}};
  node_tulip_flash_hider_20.add(mesh_tulip_flash_hider_20);
  meshes["tulip_flash_hider"] = mesh_tulip_flash_hider_20;
  colliders["tulip_flash_hider"] = {};

  const attachment_foregrip_hinge_bracket_21 = {"parentId": "folding_vertical_foregrip", "parentSocket": "foregrip_hinge_top", "localStart": [0.135, -0.022, 0.0], "localEnd": [0.135, -0.038, 0.0], "contactType": "hinge", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]};
  const endpoint_foregrip_hinge_bracket_21 = makeAttachmentEndpoint(attachment_foregrip_hinge_bracket_21);
  const node_foregrip_hinge_bracket_21 = new THREE.Group();
  node_foregrip_hinge_bracket_21.name = "foregrip_hinge_bracket__pivot";
  node_foregrip_hinge_bracket_21.scale.set(1, 1, 1);
  if (endpoint_foregrip_hinge_bracket_21) {
    node_foregrip_hinge_bracket_21.position.copy(endpoint_foregrip_hinge_bracket_21.start);
    node_foregrip_hinge_bracket_21.rotation.set(0, 0, 0);
  } else {
    node_foregrip_hinge_bracket_21.position.set(0, 0, 0);
    node_foregrip_hinge_bracket_21.rotation.set(0, 0, 0);
  }
  node_foregrip_hinge_bracket_21.userData.sculptComponent = {"id": "foregrip_hinge_bracket", "name": "foregrip_hinge_bracket", "level": "meso", "parent": "folding_vertical_foregrip", "role": "hinge-bracket", "topologyClass": "assembled-solid", "topologyRationale": "Dark metal hinge knuckle joining top of vertical foregrip to receiver front underside.", "primitive": "cylinder", "material": "mat_receiver_anodized", "materialLayers": ["mat_receiver_anodized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 45, 46, 1.0)", "secondaryAlbedo": "rgba(92, 96, 100, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.95, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(44, 45, 46, 1.0)"}, {"position": 1.0, "color": "rgba(92, 96, 100, 1.0)"}]}}, "importance": 0.88, "attachment": {"parentId": "folding_vertical_foregrip", "parentSocket": "foregrip_hinge_top", "localStart": [0.135, -0.022, 0.0], "localEnd": [0.135, -0.038, 0.0], "contactType": "hinge", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "hinge", "destructionGroup": "foregrip_group"}};
  node_foregrip_hinge_bracket_21.userData.actionProfile = {"animationRole": "static-part", "pivotType": "hinge", "destructionGroup": "foregrip_group"};
  (nodes["folding_vertical_foregrip"] ?? root).add(node_foregrip_hinge_bracket_21);
  nodes["foregrip_hinge_bracket"] = node_foregrip_hinge_bracket_21;
  const mesh_foregrip_hinge_bracket_21Geometry = endpoint_foregrip_hinge_bracket_21
    ? new THREE.CylinderGeometry(endpoint_foregrip_hinge_bracket_21.endRadius, endpoint_foregrip_hinge_bracket_21.baseRadius, endpoint_foregrip_hinge_bracket_21.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_foregrip_hinge_bracket_21) {
    mesh_foregrip_hinge_bracket_21Geometry.scale(1, 1, 1);
  }
  const mesh_foregrip_hinge_bracket_21 = new THREE.Mesh(
    mesh_foregrip_hinge_bracket_21Geometry,
    materialMap["mat_receiver_anodized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foregrip_hinge_bracket_21.name = "foregrip_hinge_bracket";
  if (endpoint_foregrip_hinge_bracket_21) {
    mesh_foregrip_hinge_bracket_21.position.copy(endpoint_foregrip_hinge_bracket_21.midpoint);
    mesh_foregrip_hinge_bracket_21.quaternion.copy(endpoint_foregrip_hinge_bracket_21.quaternion);
  }
  mesh_foregrip_hinge_bracket_21.castShadow = options.castShadow ?? true;
  mesh_foregrip_hinge_bracket_21.receiveShadow = options.receiveShadow ?? true;
  mesh_foregrip_hinge_bracket_21.userData.sculptComponent = {"id": "foregrip_hinge_bracket", "name": "foregrip_hinge_bracket", "level": "meso", "parent": "folding_vertical_foregrip", "role": "hinge-bracket", "topologyClass": "assembled-solid", "topologyRationale": "Dark metal hinge knuckle joining top of vertical foregrip to receiver front underside.", "primitive": "cylinder", "material": "mat_receiver_anodized", "materialLayers": ["mat_receiver_anodized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 45, 46, 1.0)", "secondaryAlbedo": "rgba(92, 96, 100, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.95, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(44, 45, 46, 1.0)"}, {"position": 1.0, "color": "rgba(92, 96, 100, 1.0)"}]}}, "importance": 0.88, "attachment": {"parentId": "folding_vertical_foregrip", "parentSocket": "foregrip_hinge_top", "localStart": [0.135, -0.022, 0.0], "localEnd": [0.135, -0.038, 0.0], "contactType": "hinge", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "hinge", "destructionGroup": "foregrip_group"}};
  node_foregrip_hinge_bracket_21.add(mesh_foregrip_hinge_bracket_21);
  meshes["foregrip_hinge_bracket"] = mesh_foregrip_hinge_bracket_21;
  colliders["foregrip_hinge_bracket"] = {};

  const endpoint_mag_floorplate_22 = makeAttachmentEndpoint(null);
  const node_mag_floorplate_22 = new THREE.Group();
  node_mag_floorplate_22.name = "mag_floorplate__pivot";
  node_mag_floorplate_22.scale.set(1, 1, 1);
  if (endpoint_mag_floorplate_22) {
    node_mag_floorplate_22.position.copy(endpoint_mag_floorplate_22.start);
    node_mag_floorplate_22.rotation.set(0, 0, 0);
  } else {
    node_mag_floorplate_22.position.set(0, 0, 0);
    node_mag_floorplate_22.rotation.set(0, 0, 0);
  }
  node_mag_floorplate_22.userData.sculptComponent = {"id": "mag_floorplate", "name": "mag_floorplate", "level": "meso", "parent": "waffle_magazine_assembly", "role": "magazine-floorplate", "topologyClass": "assembled-solid", "topologyRationale": "Opaque matte chamfered bottom floorplate capping the translucent waffle magazine.", "primitive": "extrude", "material": "mat_mag_floorplate", "materialLayers": ["mat_mag_floorplate"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 103, 82, 1.0)", "secondaryAlbedo": "rgba(82, 78, 60, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.94, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(107, 103, 82, 1.0)"}, {"position": 1.0, "color": "rgba(82, 78, 60, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "waffle_magazine_assembly", "parentSocket": "mag_bottom_lip", "localStart": [-0.152, -0.175, 0.0], "localEnd": [-0.146, -0.19, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "magazine_group"}};
  node_mag_floorplate_22.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "magazine_group"};
  (nodes["waffle_magazine_assembly"] ?? root).add(node_mag_floorplate_22);
  nodes["mag_floorplate"] = node_mag_floorplate_22;
  const mesh_mag_floorplate_22Geometry = endpoint_mag_floorplate_22
    ? new THREE.CylinderGeometry(endpoint_mag_floorplate_22.endRadius, endpoint_mag_floorplate_22.baseRadius, endpoint_mag_floorplate_22.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_mag_floorplate_22) {
    mesh_mag_floorplate_22Geometry.scale(1, 1, 1);
  }
  const mesh_mag_floorplate_22 = new THREE.Mesh(
    mesh_mag_floorplate_22Geometry,
    materialMap["mat_mag_floorplate"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mag_floorplate_22.name = "mag_floorplate";
  if (endpoint_mag_floorplate_22) {
    mesh_mag_floorplate_22.position.copy(endpoint_mag_floorplate_22.midpoint);
    mesh_mag_floorplate_22.quaternion.copy(endpoint_mag_floorplate_22.quaternion);
  }
  mesh_mag_floorplate_22.castShadow = options.castShadow ?? true;
  mesh_mag_floorplate_22.receiveShadow = options.receiveShadow ?? true;
  mesh_mag_floorplate_22.userData.sculptComponent = {"id": "mag_floorplate", "name": "mag_floorplate", "level": "meso", "parent": "waffle_magazine_assembly", "role": "magazine-floorplate", "topologyClass": "assembled-solid", "topologyRationale": "Opaque matte chamfered bottom floorplate capping the translucent waffle magazine.", "primitive": "extrude", "material": "mat_mag_floorplate", "materialLayers": ["mat_mag_floorplate"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(107, 103, 82, 1.0)", "secondaryAlbedo": "rgba(82, 78, 60, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.94, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(107, 103, 82, 1.0)"}, {"position": 1.0, "color": "rgba(82, 78, 60, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "waffle_magazine_assembly", "parentSocket": "mag_bottom_lip", "localStart": [-0.152, -0.175, 0.0], "localEnd": [-0.146, -0.19, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "magazine_group"}};
  node_mag_floorplate_22.add(mesh_mag_floorplate_22);
  meshes["mag_floorplate"] = mesh_mag_floorplate_22;
  colliders["mag_floorplate"] = {};

  const attachment_mag_internal_stack_23 = {"parentId": "waffle_magazine_assembly", "parentSocket": "mag_interior", "localStart": [-0.17, -0.08, 0.0], "localEnd": [-0.15, -0.175, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]};
  const endpoint_mag_internal_stack_23 = makeAttachmentEndpoint(attachment_mag_internal_stack_23);
  const node_mag_internal_stack_23 = new THREE.Group();
  node_mag_internal_stack_23.name = "mag_internal_stack__pivot";
  node_mag_internal_stack_23.scale.set(1, 1, 1);
  if (endpoint_mag_internal_stack_23) {
    node_mag_internal_stack_23.position.copy(endpoint_mag_internal_stack_23.start);
    node_mag_internal_stack_23.rotation.set(0, 0, 0);
  } else {
    node_mag_internal_stack_23.position.set(0, 0, 0);
    node_mag_internal_stack_23.rotation.set(0, 0, 0);
  }
  node_mag_internal_stack_23.userData.sculptComponent = {"id": "mag_internal_stack", "name": "mag_internal_stack", "level": "meso", "parent": "waffle_magazine_assembly", "role": "magazine-internals", "topologyClass": "assembled-solid", "topologyRationale": "Internal magazine follower block, spring coils, and stacked dummy brass/lead cartridges visible inside translucent shell.", "primitive": "cylinder", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.85, "attachment": {"parentId": "waffle_magazine_assembly", "parentSocket": "mag_interior", "localStart": [-0.17, -0.08, 0.0], "localEnd": [-0.15, -0.175, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "magazine_group"}};
  node_mag_internal_stack_23.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "magazine_group"};
  (nodes["waffle_magazine_assembly"] ?? root).add(node_mag_internal_stack_23);
  nodes["mag_internal_stack"] = node_mag_internal_stack_23;
  const mesh_mag_internal_stack_23Geometry = endpoint_mag_internal_stack_23
    ? new THREE.CylinderGeometry(endpoint_mag_internal_stack_23.endRadius, endpoint_mag_internal_stack_23.baseRadius, endpoint_mag_internal_stack_23.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_mag_internal_stack_23) {
    mesh_mag_internal_stack_23Geometry.scale(1, 1, 1);
  }
  const mesh_mag_internal_stack_23 = new THREE.Mesh(
    mesh_mag_internal_stack_23Geometry,
    materialMap["mat_barrel_parkerized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mag_internal_stack_23.name = "mag_internal_stack";
  if (endpoint_mag_internal_stack_23) {
    mesh_mag_internal_stack_23.position.copy(endpoint_mag_internal_stack_23.midpoint);
    mesh_mag_internal_stack_23.quaternion.copy(endpoint_mag_internal_stack_23.quaternion);
  }
  mesh_mag_internal_stack_23.castShadow = options.castShadow ?? true;
  mesh_mag_internal_stack_23.receiveShadow = options.receiveShadow ?? true;
  mesh_mag_internal_stack_23.userData.sculptComponent = {"id": "mag_internal_stack", "name": "mag_internal_stack", "level": "meso", "parent": "waffle_magazine_assembly", "role": "magazine-internals", "topologyClass": "assembled-solid", "topologyRationale": "Internal magazine follower block, spring coils, and stacked dummy brass/lead cartridges visible inside translucent shell.", "primitive": "cylinder", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.85, "attachment": {"parentId": "waffle_magazine_assembly", "parentSocket": "mag_interior", "localStart": [-0.17, -0.08, 0.0], "localEnd": [-0.15, -0.175, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "magazine_group"}};
  node_mag_internal_stack_23.add(mesh_mag_internal_stack_23);
  meshes["mag_internal_stack"] = mesh_mag_internal_stack_23;
  colliders["mag_internal_stack"] = {};

  const endpoint_left_charging_handle_assembly_24 = makeAttachmentEndpoint(null);
  const node_left_charging_handle_assembly_24 = new THREE.Group();
  node_left_charging_handle_assembly_24.name = "left_charging_handle_assembly__pivot";
  node_left_charging_handle_assembly_24.scale.set(1, 1, 1);
  if (endpoint_left_charging_handle_assembly_24) {
    node_left_charging_handle_assembly_24.position.copy(endpoint_left_charging_handle_assembly_24.start);
    node_left_charging_handle_assembly_24.rotation.set(0, 0, 0);
  } else {
    node_left_charging_handle_assembly_24.position.set(0, 0, 0);
    node_left_charging_handle_assembly_24.rotation.set(0, 0, 0);
  }
  node_left_charging_handle_assembly_24.userData.sculptComponent = {"id": "left_charging_handle_assembly", "name": "left_charging_handle_assembly", "level": "meso", "parent": "upper_receiver_metal", "role": "charging-handle", "topologyClass": "continuous-sculpt", "topologyRationale": "Left-side (-Z) folding polymer/steel cocking handle knob riding in the receiver guide slot.", "primitive": "extrude", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.94, "attachment": {"parentId": "upper_receiver_metal", "parentSocket": "charging_handle_slot", "localStart": [0.06, 0.008, -0.02], "localEnd": [0.105, 0.028, -0.032], "contactType": "socket", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_left_side.png"]}, "localFeatures": [{"id": "charging-handle-knob", "type": "raised ridge", "placement": "left (-Z) receiver guide slot", "confidence": 0.96}], "actionProfile": {"animationRole": "charging-handle-slide", "pivotType": "hinge", "destructionGroup": "receiver_group"}};
  node_left_charging_handle_assembly_24.userData.actionProfile = {"animationRole": "charging-handle-slide", "pivotType": "hinge", "destructionGroup": "receiver_group"};
  (nodes["upper_receiver_metal"] ?? root).add(node_left_charging_handle_assembly_24);
  nodes["left_charging_handle_assembly"] = node_left_charging_handle_assembly_24;
  const mesh_left_charging_handle_assembly_24Geometry = endpoint_left_charging_handle_assembly_24
    ? new THREE.CylinderGeometry(endpoint_left_charging_handle_assembly_24.endRadius, endpoint_left_charging_handle_assembly_24.baseRadius, endpoint_left_charging_handle_assembly_24.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_left_charging_handle_assembly_24) {
    mesh_left_charging_handle_assembly_24Geometry.scale(1, 1, 1);
  }
  const mesh_left_charging_handle_assembly_24 = new THREE.Mesh(
    mesh_left_charging_handle_assembly_24Geometry,
    materialMap["mat_optic_worn_metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_left_charging_handle_assembly_24.name = "left_charging_handle_assembly";
  if (endpoint_left_charging_handle_assembly_24) {
    mesh_left_charging_handle_assembly_24.position.copy(endpoint_left_charging_handle_assembly_24.midpoint);
    mesh_left_charging_handle_assembly_24.quaternion.copy(endpoint_left_charging_handle_assembly_24.quaternion);
  }
  mesh_left_charging_handle_assembly_24.castShadow = options.castShadow ?? true;
  mesh_left_charging_handle_assembly_24.receiveShadow = options.receiveShadow ?? true;
  mesh_left_charging_handle_assembly_24.userData.sculptComponent = {"id": "left_charging_handle_assembly", "name": "left_charging_handle_assembly", "level": "meso", "parent": "upper_receiver_metal", "role": "charging-handle", "topologyClass": "continuous-sculpt", "topologyRationale": "Left-side (-Z) folding polymer/steel cocking handle knob riding in the receiver guide slot.", "primitive": "extrude", "material": "mat_optic_worn_metal", "materialLayers": ["mat_optic_worn_metal"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(84, 84, 77, 1.0)", "secondaryAlbedo": "rgba(132, 134, 127, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.93, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(84, 84, 77, 1.0)"}, {"position": 1.0, "color": "rgba(132, 134, 127, 1.0)"}]}}, "importance": 0.94, "attachment": {"parentId": "upper_receiver_metal", "parentSocket": "charging_handle_slot", "localStart": [0.06, 0.008, -0.02], "localEnd": [0.105, 0.028, -0.032], "contactType": "socket", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_left_side.png"]}, "localFeatures": [{"id": "charging-handle-knob", "type": "raised ridge", "placement": "left (-Z) receiver guide slot", "confidence": 0.96}], "actionProfile": {"animationRole": "charging-handle-slide", "pivotType": "hinge", "destructionGroup": "receiver_group"}};
  node_left_charging_handle_assembly_24.add(mesh_left_charging_handle_assembly_24);
  meshes["left_charging_handle_assembly"] = mesh_left_charging_handle_assembly_24;
  colliders["left_charging_handle_assembly"] = {};

  const endpoint_waffle_rib_grid_right_25 = makeAttachmentEndpoint(null);
  const node_waffle_rib_grid_right_25 = new THREE.Group();
  node_waffle_rib_grid_right_25.name = "waffle_rib_grid_right__pivot";
  node_waffle_rib_grid_right_25.scale.set(1, 1, 1);
  if (endpoint_waffle_rib_grid_right_25) {
    node_waffle_rib_grid_right_25.position.copy(endpoint_waffle_rib_grid_right_25.start);
    node_waffle_rib_grid_right_25.rotation.set(0, 0, 0);
  } else {
    node_waffle_rib_grid_right_25.position.set(0, 0, 0);
    node_waffle_rib_grid_right_25.rotation.set(0, 0, 0);
  }
  node_waffle_rib_grid_right_25.userData.sculptComponent = {"id": "waffle_rib_grid_right", "name": "waffle_rib_grid_right", "level": "micro", "parent": "waffle_magazine_assembly", "role": "waffle-ribs", "topologyClass": "surface-relief", "topologyRationale": "Raised geometric 3D grid ribs across right (+Z) translucent magazine face.", "primitive": "instanced-cluster", "material": "mat_mag_translucent", "materialLayers": ["mat_mag_translucent"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(152, 141, 104, 0.86)", "secondaryAlbedo": "rgba(109, 99, 70, 0.90)", "materialClass": "plastic", "materialClassConfidence": 0.92, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(152, 141, 104, 0.86)"}, {"position": 1.0, "color": "rgba(109, 99, 70, 0.90)"}]}}, "importance": 0.95, "attachment": {"parentId": "waffle_magazine_assembly", "parentSocket": "mag_right_wall", "localStart": [-0.172, -0.082, 0.013], "localEnd": [-0.152, -0.175, 0.014], "contactType": "surface-contact", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "waffle-grid-right", "type": "ridge", "placement": "+Z magazine face", "confidence": 0.97}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "magazine_group"}};
  node_waffle_rib_grid_right_25.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "magazine_group"};
  (nodes["waffle_magazine_assembly"] ?? root).add(node_waffle_rib_grid_right_25);
  nodes["waffle_rib_grid_right"] = node_waffle_rib_grid_right_25;
  const mesh_waffle_rib_grid_right_25Geometry = endpoint_waffle_rib_grid_right_25
    ? new THREE.CylinderGeometry(endpoint_waffle_rib_grid_right_25.endRadius, endpoint_waffle_rib_grid_right_25.baseRadius, endpoint_waffle_rib_grid_right_25.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_waffle_rib_grid_right_25) {
    mesh_waffle_rib_grid_right_25Geometry.scale(1, 1, 1);
  }
  const mesh_waffle_rib_grid_right_25 = new THREE.Mesh(
    mesh_waffle_rib_grid_right_25Geometry,
    materialMap["mat_mag_translucent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_waffle_rib_grid_right_25.name = "waffle_rib_grid_right";
  if (endpoint_waffle_rib_grid_right_25) {
    mesh_waffle_rib_grid_right_25.position.copy(endpoint_waffle_rib_grid_right_25.midpoint);
    mesh_waffle_rib_grid_right_25.quaternion.copy(endpoint_waffle_rib_grid_right_25.quaternion);
  }
  mesh_waffle_rib_grid_right_25.castShadow = options.castShadow ?? true;
  mesh_waffle_rib_grid_right_25.receiveShadow = options.receiveShadow ?? true;
  mesh_waffle_rib_grid_right_25.userData.sculptComponent = {"id": "waffle_rib_grid_right", "name": "waffle_rib_grid_right", "level": "micro", "parent": "waffle_magazine_assembly", "role": "waffle-ribs", "topologyClass": "surface-relief", "topologyRationale": "Raised geometric 3D grid ribs across right (+Z) translucent magazine face.", "primitive": "instanced-cluster", "material": "mat_mag_translucent", "materialLayers": ["mat_mag_translucent"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(152, 141, 104, 0.86)", "secondaryAlbedo": "rgba(109, 99, 70, 0.90)", "materialClass": "plastic", "materialClassConfidence": 0.92, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(152, 141, 104, 0.86)"}, {"position": 1.0, "color": "rgba(109, 99, 70, 0.90)"}]}}, "importance": 0.95, "attachment": {"parentId": "waffle_magazine_assembly", "parentSocket": "mag_right_wall", "localStart": [-0.172, -0.082, 0.013], "localEnd": [-0.152, -0.175, 0.014], "contactType": "surface-contact", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "waffle-grid-right", "type": "ridge", "placement": "+Z magazine face", "confidence": 0.97}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "magazine_group"}};
  node_waffle_rib_grid_right_25.add(mesh_waffle_rib_grid_right_25);
  meshes["waffle_rib_grid_right"] = mesh_waffle_rib_grid_right_25;
  colliders["waffle_rib_grid_right"] = {};

  const endpoint_waffle_rib_grid_left_26 = makeAttachmentEndpoint(null);
  const node_waffle_rib_grid_left_26 = new THREE.Group();
  node_waffle_rib_grid_left_26.name = "waffle_rib_grid_left__pivot";
  node_waffle_rib_grid_left_26.scale.set(1, 1, 1);
  if (endpoint_waffle_rib_grid_left_26) {
    node_waffle_rib_grid_left_26.position.copy(endpoint_waffle_rib_grid_left_26.start);
    node_waffle_rib_grid_left_26.rotation.set(0, 0, 0);
  } else {
    node_waffle_rib_grid_left_26.position.set(0, 0, 0);
    node_waffle_rib_grid_left_26.rotation.set(0, 0, 0);
  }
  node_waffle_rib_grid_left_26.userData.sculptComponent = {"id": "waffle_rib_grid_left", "name": "waffle_rib_grid_left", "level": "micro", "parent": "waffle_magazine_assembly", "role": "waffle-ribs", "topologyClass": "surface-relief", "topologyRationale": "Raised geometric 3D grid ribs across left (-Z) translucent magazine face.", "primitive": "instanced-cluster", "material": "mat_mag_translucent", "materialLayers": ["mat_mag_translucent"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(152, 141, 104, 0.86)", "secondaryAlbedo": "rgba(109, 99, 70, 0.90)", "materialClass": "plastic", "materialClassConfidence": 0.92, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(152, 141, 104, 0.86)"}, {"position": 1.0, "color": "rgba(109, 99, 70, 0.90)"}]}}, "importance": 0.95, "attachment": {"parentId": "waffle_magazine_assembly", "parentSocket": "mag_left_wall", "localStart": [-0.172, -0.082, -0.013], "localEnd": [-0.152, -0.175, -0.014], "contactType": "surface-contact", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_left_side.png"]}, "localFeatures": [{"id": "waffle-grid-left", "type": "ridge", "placement": "-Z magazine face", "confidence": 0.97}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "magazine_group"}};
  node_waffle_rib_grid_left_26.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "magazine_group"};
  (nodes["waffle_magazine_assembly"] ?? root).add(node_waffle_rib_grid_left_26);
  nodes["waffle_rib_grid_left"] = node_waffle_rib_grid_left_26;
  const mesh_waffle_rib_grid_left_26Geometry = endpoint_waffle_rib_grid_left_26
    ? new THREE.CylinderGeometry(endpoint_waffle_rib_grid_left_26.endRadius, endpoint_waffle_rib_grid_left_26.baseRadius, endpoint_waffle_rib_grid_left_26.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_waffle_rib_grid_left_26) {
    mesh_waffle_rib_grid_left_26Geometry.scale(1, 1, 1);
  }
  const mesh_waffle_rib_grid_left_26 = new THREE.Mesh(
    mesh_waffle_rib_grid_left_26Geometry,
    materialMap["mat_mag_translucent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_waffle_rib_grid_left_26.name = "waffle_rib_grid_left";
  if (endpoint_waffle_rib_grid_left_26) {
    mesh_waffle_rib_grid_left_26.position.copy(endpoint_waffle_rib_grid_left_26.midpoint);
    mesh_waffle_rib_grid_left_26.quaternion.copy(endpoint_waffle_rib_grid_left_26.quaternion);
  }
  mesh_waffle_rib_grid_left_26.castShadow = options.castShadow ?? true;
  mesh_waffle_rib_grid_left_26.receiveShadow = options.receiveShadow ?? true;
  mesh_waffle_rib_grid_left_26.userData.sculptComponent = {"id": "waffle_rib_grid_left", "name": "waffle_rib_grid_left", "level": "micro", "parent": "waffle_magazine_assembly", "role": "waffle-ribs", "topologyClass": "surface-relief", "topologyRationale": "Raised geometric 3D grid ribs across left (-Z) translucent magazine face.", "primitive": "instanced-cluster", "material": "mat_mag_translucent", "materialLayers": ["mat_mag_translucent"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(152, 141, 104, 0.86)", "secondaryAlbedo": "rgba(109, 99, 70, 0.90)", "materialClass": "plastic", "materialClassConfidence": 0.92, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(152, 141, 104, 0.86)"}, {"position": 1.0, "color": "rgba(109, 99, 70, 0.90)"}]}}, "importance": 0.95, "attachment": {"parentId": "waffle_magazine_assembly", "parentSocket": "mag_left_wall", "localStart": [-0.172, -0.082, -0.013], "localEnd": [-0.152, -0.175, -0.014], "contactType": "surface-contact", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_left_side.png"]}, "localFeatures": [{"id": "waffle-grid-left", "type": "ridge", "placement": "-Z magazine face", "confidence": 0.97}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "magazine_group"}};
  node_waffle_rib_grid_left_26.add(mesh_waffle_rib_grid_left_26);
  meshes["waffle_rib_grid_left"] = mesh_waffle_rib_grid_left_26;
  colliders["waffle_rib_grid_left"] = {};

  const endpoint_flash_hider_slots_27 = makeAttachmentEndpoint(null);
  const node_flash_hider_slots_27 = new THREE.Group();
  node_flash_hider_slots_27.name = "flash_hider_slots__pivot";
  node_flash_hider_slots_27.scale.set(1, 1, 1);
  if (endpoint_flash_hider_slots_27) {
    node_flash_hider_slots_27.position.copy(endpoint_flash_hider_slots_27.start);
    node_flash_hider_slots_27.rotation.set(0, 0, 0);
  } else {
    node_flash_hider_slots_27.position.set(0, 0, 0);
    node_flash_hider_slots_27.rotation.set(0, 0, 0);
  }
  node_flash_hider_slots_27.userData.sculptComponent = {"id": "flash_hider_slots", "name": "flash_hider_slots", "level": "micro", "parent": "tulip_flash_hider", "role": "muzzle-prongs", "topologyClass": "surface-relief", "topologyRationale": "Radial prong ribs around slotted tulip flash hider exterior.", "primitive": "instanced-cluster", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "tulip_flash_hider", "parentSocket": "flash_hider_body", "localStart": [0.365, 0.0, 0.0], "localEnd": [0.394, 0.0, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "barrel_group"}};
  node_flash_hider_slots_27.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "barrel_group"};
  (nodes["tulip_flash_hider"] ?? root).add(node_flash_hider_slots_27);
  nodes["flash_hider_slots"] = node_flash_hider_slots_27;
  const mesh_flash_hider_slots_27Geometry = endpoint_flash_hider_slots_27
    ? new THREE.CylinderGeometry(endpoint_flash_hider_slots_27.endRadius, endpoint_flash_hider_slots_27.baseRadius, endpoint_flash_hider_slots_27.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_flash_hider_slots_27) {
    mesh_flash_hider_slots_27Geometry.scale(1, 1, 1);
  }
  const mesh_flash_hider_slots_27 = new THREE.Mesh(
    mesh_flash_hider_slots_27Geometry,
    materialMap["mat_barrel_parkerized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_flash_hider_slots_27.name = "flash_hider_slots";
  if (endpoint_flash_hider_slots_27) {
    mesh_flash_hider_slots_27.position.copy(endpoint_flash_hider_slots_27.midpoint);
    mesh_flash_hider_slots_27.quaternion.copy(endpoint_flash_hider_slots_27.quaternion);
  }
  mesh_flash_hider_slots_27.castShadow = options.castShadow ?? true;
  mesh_flash_hider_slots_27.receiveShadow = options.receiveShadow ?? true;
  mesh_flash_hider_slots_27.userData.sculptComponent = {"id": "flash_hider_slots", "name": "flash_hider_slots", "level": "micro", "parent": "tulip_flash_hider", "role": "muzzle-prongs", "topologyClass": "surface-relief", "topologyRationale": "Radial prong ribs around slotted tulip flash hider exterior.", "primitive": "instanced-cluster", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "tulip_flash_hider", "parentSocket": "flash_hider_body", "localStart": [0.365, 0.0, 0.0], "localEnd": [0.394, 0.0, 0.0], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "barrel_group"}};
  node_flash_hider_slots_27.add(mesh_flash_hider_slots_27);
  meshes["flash_hider_slots"] = mesh_flash_hider_slots_27;
  colliders["flash_hider_slots"] = {};

  const endpoint_progressive_trigger_28 = makeAttachmentEndpoint(null);
  const node_progressive_trigger_28 = new THREE.Group();
  node_progressive_trigger_28.name = "progressive_trigger__pivot";
  node_progressive_trigger_28.scale.set(1, 1, 1);
  if (endpoint_progressive_trigger_28) {
    node_progressive_trigger_28.position.copy(endpoint_progressive_trigger_28.start);
    node_progressive_trigger_28.rotation.set(0, 0, 0);
  } else {
    node_progressive_trigger_28.position.set(0, 0, 0);
    node_progressive_trigger_28.rotation.set(0, 0, 0);
  }
  node_progressive_trigger_28.userData.sculptComponent = {"id": "progressive_trigger", "name": "progressive_trigger", "level": "micro", "parent": "polymer_stock_chassis", "role": "trigger", "topologyClass": "assembled-solid", "topologyRationale": "Curved dark sliding polymer trigger shoe mounted at top of trigger guard opening.", "primitive": "extrude", "material": "mat_rubber_buttpad", "materialLayers": ["mat_rubber_buttpad"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 43, 40, 1.0)", "secondaryAlbedo": "rgba(29, 29, 27, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(43, 43, 40, 1.0)"}, {"position": 1.0, "color": "rgba(29, 29, 27, 1.0)"}]}}, "importance": 0.92, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "trigger_housing", "localStart": [-0.028, -0.042, 0.0], "localEnd": [-0.01, -0.062, 0.0], "contactType": "hinge", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "trigger-shoe-face", "type": "bevel highlight", "placement": "upper trigger guard cutout", "confidence": 0.95}], "actionProfile": {"animationRole": "trigger-pull", "pivotType": "hinge", "destructionGroup": "chassis_group"}};
  node_progressive_trigger_28.userData.actionProfile = {"animationRole": "trigger-pull", "pivotType": "hinge", "destructionGroup": "chassis_group"};
  (nodes["polymer_stock_chassis"] ?? root).add(node_progressive_trigger_28);
  nodes["progressive_trigger"] = node_progressive_trigger_28;
  const mesh_progressive_trigger_28Geometry = endpoint_progressive_trigger_28
    ? new THREE.CylinderGeometry(endpoint_progressive_trigger_28.endRadius, endpoint_progressive_trigger_28.baseRadius, endpoint_progressive_trigger_28.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_progressive_trigger_28) {
    mesh_progressive_trigger_28Geometry.scale(1, 1, 1);
  }
  const mesh_progressive_trigger_28 = new THREE.Mesh(
    mesh_progressive_trigger_28Geometry,
    materialMap["mat_rubber_buttpad"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_progressive_trigger_28.name = "progressive_trigger";
  if (endpoint_progressive_trigger_28) {
    mesh_progressive_trigger_28.position.copy(endpoint_progressive_trigger_28.midpoint);
    mesh_progressive_trigger_28.quaternion.copy(endpoint_progressive_trigger_28.quaternion);
  }
  mesh_progressive_trigger_28.castShadow = options.castShadow ?? true;
  mesh_progressive_trigger_28.receiveShadow = options.receiveShadow ?? true;
  mesh_progressive_trigger_28.userData.sculptComponent = {"id": "progressive_trigger", "name": "progressive_trigger", "level": "micro", "parent": "polymer_stock_chassis", "role": "trigger", "topologyClass": "assembled-solid", "topologyRationale": "Curved dark sliding polymer trigger shoe mounted at top of trigger guard opening.", "primitive": "extrude", "material": "mat_rubber_buttpad", "materialLayers": ["mat_rubber_buttpad"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 43, 40, 1.0)", "secondaryAlbedo": "rgba(29, 29, 27, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(43, 43, 40, 1.0)"}, {"position": 1.0, "color": "rgba(29, 29, 27, 1.0)"}]}}, "importance": 0.92, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "trigger_housing", "localStart": [-0.028, -0.042, 0.0], "localEnd": [-0.01, -0.062, 0.0], "contactType": "hinge", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "trigger-shoe-face", "type": "bevel highlight", "placement": "upper trigger guard cutout", "confidence": 0.95}], "actionProfile": {"animationRole": "trigger-pull", "pivotType": "hinge", "destructionGroup": "chassis_group"}};
  node_progressive_trigger_28.add(mesh_progressive_trigger_28);
  meshes["progressive_trigger"] = mesh_progressive_trigger_28;
  colliders["progressive_trigger"] = {};

  const endpoint_crossbolt_safety_29 = makeAttachmentEndpoint(null);
  const node_crossbolt_safety_29 = new THREE.Group();
  node_crossbolt_safety_29.name = "crossbolt_safety__pivot";
  node_crossbolt_safety_29.scale.set(1, 1, 1);
  if (endpoint_crossbolt_safety_29) {
    node_crossbolt_safety_29.position.copy(endpoint_crossbolt_safety_29.start);
    node_crossbolt_safety_29.rotation.set(0, 0, 0);
  } else {
    node_crossbolt_safety_29.position.set(0, 0, 0);
    node_crossbolt_safety_29.rotation.set(0, 0, 0);
  }
  node_crossbolt_safety_29.userData.sculptComponent = {"id": "crossbolt_safety", "name": "crossbolt_safety", "level": "micro", "parent": "polymer_stock_chassis", "role": "safety-button", "topologyClass": "assembled-solid", "topologyRationale": "Square cross-bolt safety button passing transversely above pistol grip.", "primitive": "box", "material": "mat_rubber_buttpad", "materialLayers": ["mat_rubber_buttpad"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 43, 40, 1.0)", "secondaryAlbedo": "rgba(29, 29, 27, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(43, 43, 40, 1.0)"}, {"position": 1.0, "color": "rgba(29, 29, 27, 1.0)"}]}}, "importance": 0.85, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "safety_bore", "localStart": [-0.055, -0.032, -0.02], "localEnd": [-0.055, -0.032, 0.02], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "safety-slide", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_crossbolt_safety_29.userData.actionProfile = {"animationRole": "safety-slide", "pivotType": "center", "destructionGroup": "chassis_group"};
  (nodes["polymer_stock_chassis"] ?? root).add(node_crossbolt_safety_29);
  nodes["crossbolt_safety"] = node_crossbolt_safety_29;
  const mesh_crossbolt_safety_29Geometry = endpoint_crossbolt_safety_29
    ? new THREE.CylinderGeometry(endpoint_crossbolt_safety_29.endRadius, endpoint_crossbolt_safety_29.baseRadius, endpoint_crossbolt_safety_29.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_crossbolt_safety_29) {
    mesh_crossbolt_safety_29Geometry.scale(1, 1, 1);
  }
  const mesh_crossbolt_safety_29 = new THREE.Mesh(
    mesh_crossbolt_safety_29Geometry,
    materialMap["mat_rubber_buttpad"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crossbolt_safety_29.name = "crossbolt_safety";
  if (endpoint_crossbolt_safety_29) {
    mesh_crossbolt_safety_29.position.copy(endpoint_crossbolt_safety_29.midpoint);
    mesh_crossbolt_safety_29.quaternion.copy(endpoint_crossbolt_safety_29.quaternion);
  }
  mesh_crossbolt_safety_29.castShadow = options.castShadow ?? true;
  mesh_crossbolt_safety_29.receiveShadow = options.receiveShadow ?? true;
  mesh_crossbolt_safety_29.userData.sculptComponent = {"id": "crossbolt_safety", "name": "crossbolt_safety", "level": "micro", "parent": "polymer_stock_chassis", "role": "safety-button", "topologyClass": "assembled-solid", "topologyRationale": "Square cross-bolt safety button passing transversely above pistol grip.", "primitive": "box", "material": "mat_rubber_buttpad", "materialLayers": ["mat_rubber_buttpad"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 43, 40, 1.0)", "secondaryAlbedo": "rgba(29, 29, 27, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(43, 43, 40, 1.0)"}, {"position": 1.0, "color": "rgba(29, 29, 27, 1.0)"}]}}, "importance": 0.85, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "safety_bore", "localStart": [-0.055, -0.032, -0.02], "localEnd": [-0.055, -0.032, 0.02], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "safety-slide", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_crossbolt_safety_29.add(mesh_crossbolt_safety_29);
  meshes["crossbolt_safety"] = mesh_crossbolt_safety_29;
  colliders["crossbolt_safety"] = {};

  const endpoint_receiver_takedown_latch_30 = makeAttachmentEndpoint(null);
  const node_receiver_takedown_latch_30 = new THREE.Group();
  node_receiver_takedown_latch_30.name = "receiver_takedown_latch__pivot";
  node_receiver_takedown_latch_30.scale.set(1, 1, 1);
  if (endpoint_receiver_takedown_latch_30) {
    node_receiver_takedown_latch_30.position.copy(endpoint_receiver_takedown_latch_30.start);
    node_receiver_takedown_latch_30.rotation.set(0, 0, 0);
  } else {
    node_receiver_takedown_latch_30.position.set(0, 0, 0);
    node_receiver_takedown_latch_30.rotation.set(0, 0, 0);
  }
  node_receiver_takedown_latch_30.userData.sculptComponent = {"id": "receiver_takedown_latch", "name": "receiver_takedown_latch", "level": "micro", "parent": "polymer_stock_chassis", "role": "takedown-latch", "topologyClass": "assembled-solid", "topologyRationale": "Cross-stock takedown latch: dark rectangular plate on right face, vertical protruding catch bar on left face.", "primitive": "box", "material": "mat_receiver_anodized", "materialLayers": ["mat_receiver_anodized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 45, 46, 1.0)", "secondaryAlbedo": "rgba(92, 96, 100, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.95, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(44, 45, 46, 1.0)"}, {"position": 1.0, "color": "rgba(92, 96, 100, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "takedown_cross_slot", "localStart": [-0.125, -0.026, -0.024], "localEnd": [-0.125, -0.026, 0.024], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "latch-left-protrusion", "type": "ridge", "placement": "above magwell both sides", "confidence": 0.95}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_receiver_takedown_latch_30.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"};
  (nodes["polymer_stock_chassis"] ?? root).add(node_receiver_takedown_latch_30);
  nodes["receiver_takedown_latch"] = node_receiver_takedown_latch_30;
  const mesh_receiver_takedown_latch_30Geometry = endpoint_receiver_takedown_latch_30
    ? new THREE.CylinderGeometry(endpoint_receiver_takedown_latch_30.endRadius, endpoint_receiver_takedown_latch_30.baseRadius, endpoint_receiver_takedown_latch_30.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_receiver_takedown_latch_30) {
    mesh_receiver_takedown_latch_30Geometry.scale(1, 1, 1);
  }
  const mesh_receiver_takedown_latch_30 = new THREE.Mesh(
    mesh_receiver_takedown_latch_30Geometry,
    materialMap["mat_receiver_anodized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_receiver_takedown_latch_30.name = "receiver_takedown_latch";
  if (endpoint_receiver_takedown_latch_30) {
    mesh_receiver_takedown_latch_30.position.copy(endpoint_receiver_takedown_latch_30.midpoint);
    mesh_receiver_takedown_latch_30.quaternion.copy(endpoint_receiver_takedown_latch_30.quaternion);
  }
  mesh_receiver_takedown_latch_30.castShadow = options.castShadow ?? true;
  mesh_receiver_takedown_latch_30.receiveShadow = options.receiveShadow ?? true;
  mesh_receiver_takedown_latch_30.userData.sculptComponent = {"id": "receiver_takedown_latch", "name": "receiver_takedown_latch", "level": "micro", "parent": "polymer_stock_chassis", "role": "takedown-latch", "topologyClass": "assembled-solid", "topologyRationale": "Cross-stock takedown latch: dark rectangular plate on right face, vertical protruding catch bar on left face.", "primitive": "box", "material": "mat_receiver_anodized", "materialLayers": ["mat_receiver_anodized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 45, 46, 1.0)", "secondaryAlbedo": "rgba(92, 96, 100, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.95, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(44, 45, 46, 1.0)"}, {"position": 1.0, "color": "rgba(92, 96, 100, 1.0)"}]}}, "importance": 0.9, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "takedown_cross_slot", "localStart": [-0.125, -0.026, -0.024], "localEnd": [-0.125, -0.026, 0.024], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "latch-left-protrusion", "type": "ridge", "placement": "above magwell both sides", "confidence": 0.95}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_receiver_takedown_latch_30.add(mesh_receiver_takedown_latch_30);
  meshes["receiver_takedown_latch"] = mesh_receiver_takedown_latch_30;
  colliders["receiver_takedown_latch"] = {};

  const endpoint_magazine_release_paddle_31 = makeAttachmentEndpoint(null);
  const node_magazine_release_paddle_31 = new THREE.Group();
  node_magazine_release_paddle_31.name = "magazine_release_paddle__pivot";
  node_magazine_release_paddle_31.scale.set(1, 1, 1);
  if (endpoint_magazine_release_paddle_31) {
    node_magazine_release_paddle_31.position.copy(endpoint_magazine_release_paddle_31.start);
    node_magazine_release_paddle_31.rotation.set(0, 0, 0);
  } else {
    node_magazine_release_paddle_31.position.set(0, 0, 0);
    node_magazine_release_paddle_31.rotation.set(0, 0, 0);
  }
  node_magazine_release_paddle_31.userData.sculptComponent = {"id": "magazine_release_paddle", "name": "magazine_release_paddle", "level": "micro", "parent": "polymer_stock_chassis", "role": "mag-release", "topologyClass": "assembled-solid", "topologyRationale": "Triangular magazine release lever pivoted just behind the magazine well.", "primitive": "extrude", "material": "mat_rubber_buttpad", "materialLayers": ["mat_rubber_buttpad"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 43, 40, 1.0)", "secondaryAlbedo": "rgba(29, 29, 27, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(43, 43, 40, 1.0)"}, {"position": 1.0, "color": "rgba(29, 29, 27, 1.0)"}]}}, "importance": 0.86, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "mag_release_pin", "localStart": [-0.215, -0.072, 0.0], "localEnd": [-0.195, -0.078, 0.0], "contactType": "hinge", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "mag-release-bevel", "type": "bevel highlight", "placement": "behind magwell", "confidence": 0.9}], "actionProfile": {"animationRole": "static-part", "pivotType": "hinge", "destructionGroup": "chassis_group"}};
  node_magazine_release_paddle_31.userData.actionProfile = {"animationRole": "static-part", "pivotType": "hinge", "destructionGroup": "chassis_group"};
  (nodes["polymer_stock_chassis"] ?? root).add(node_magazine_release_paddle_31);
  nodes["magazine_release_paddle"] = node_magazine_release_paddle_31;
  const mesh_magazine_release_paddle_31Geometry = endpoint_magazine_release_paddle_31
    ? new THREE.CylinderGeometry(endpoint_magazine_release_paddle_31.endRadius, endpoint_magazine_release_paddle_31.baseRadius, endpoint_magazine_release_paddle_31.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_magazine_release_paddle_31) {
    mesh_magazine_release_paddle_31Geometry.scale(1, 1, 1);
  }
  const mesh_magazine_release_paddle_31 = new THREE.Mesh(
    mesh_magazine_release_paddle_31Geometry,
    materialMap["mat_rubber_buttpad"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_magazine_release_paddle_31.name = "magazine_release_paddle";
  if (endpoint_magazine_release_paddle_31) {
    mesh_magazine_release_paddle_31.position.copy(endpoint_magazine_release_paddle_31.midpoint);
    mesh_magazine_release_paddle_31.quaternion.copy(endpoint_magazine_release_paddle_31.quaternion);
  }
  mesh_magazine_release_paddle_31.castShadow = options.castShadow ?? true;
  mesh_magazine_release_paddle_31.receiveShadow = options.receiveShadow ?? true;
  mesh_magazine_release_paddle_31.userData.sculptComponent = {"id": "magazine_release_paddle", "name": "magazine_release_paddle", "level": "micro", "parent": "polymer_stock_chassis", "role": "mag-release", "topologyClass": "assembled-solid", "topologyRationale": "Triangular magazine release lever pivoted just behind the magazine well.", "primitive": "extrude", "material": "mat_rubber_buttpad", "materialLayers": ["mat_rubber_buttpad"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 43, 40, 1.0)", "secondaryAlbedo": "rgba(29, 29, 27, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(43, 43, 40, 1.0)"}, {"position": 1.0, "color": "rgba(29, 29, 27, 1.0)"}]}}, "importance": 0.86, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "mag_release_pin", "localStart": [-0.215, -0.072, 0.0], "localEnd": [-0.195, -0.078, 0.0], "contactType": "hinge", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "mag-release-bevel", "type": "bevel highlight", "placement": "behind magwell", "confidence": 0.9}], "actionProfile": {"animationRole": "static-part", "pivotType": "hinge", "destructionGroup": "chassis_group"}};
  node_magazine_release_paddle_31.add(mesh_magazine_release_paddle_31);
  meshes["magazine_release_paddle"] = mesh_magazine_release_paddle_31;
  colliders["magazine_release_paddle"] = {};

  const endpoint_rear_sling_swivel_left_32 = makeAttachmentEndpoint(null);
  const node_rear_sling_swivel_left_32 = new THREE.Group();
  node_rear_sling_swivel_left_32.name = "rear_sling_swivel_left__pivot";
  node_rear_sling_swivel_left_32.scale.set(1, 1, 1);
  if (endpoint_rear_sling_swivel_left_32) {
    node_rear_sling_swivel_left_32.position.copy(endpoint_rear_sling_swivel_left_32.start);
    node_rear_sling_swivel_left_32.rotation.set(0, 0, 0);
  } else {
    node_rear_sling_swivel_left_32.position.set(0, 0, 0);
    node_rear_sling_swivel_left_32.rotation.set(0, 0, 0);
  }
  node_rear_sling_swivel_left_32.userData.sculptComponent = {"id": "rear_sling_swivel_left", "name": "rear_sling_swivel_left", "level": "micro", "parent": "polymer_stock_chassis", "role": "sling-loop", "topologyClass": "assembled-solid", "topologyRationale": "Left-side (-Z) rear sling plate and steel wire D-loop mounted near buttstock rear.", "primitive": "torus", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.92, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "left_rear_sling_mount", "localStart": [-0.36, -0.068, -0.025], "localEnd": [-0.335, -0.068, -0.032], "contactType": "hinge", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_left_side.png"]}, "localFeatures": [{"id": "sling-loop-ring", "type": "fastener", "placement": "left rear buttstock flank", "confidence": 0.96}], "actionProfile": {"animationRole": "sling-hinge", "pivotType": "hinge", "destructionGroup": "chassis_group"}};
  node_rear_sling_swivel_left_32.userData.actionProfile = {"animationRole": "sling-hinge", "pivotType": "hinge", "destructionGroup": "chassis_group"};
  (nodes["polymer_stock_chassis"] ?? root).add(node_rear_sling_swivel_left_32);
  nodes["rear_sling_swivel_left"] = node_rear_sling_swivel_left_32;
  const mesh_rear_sling_swivel_left_32Geometry = endpoint_rear_sling_swivel_left_32
    ? new THREE.CylinderGeometry(endpoint_rear_sling_swivel_left_32.endRadius, endpoint_rear_sling_swivel_left_32.baseRadius, endpoint_rear_sling_swivel_left_32.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.08, 24, 96);
  if (!endpoint_rear_sling_swivel_left_32) {
    mesh_rear_sling_swivel_left_32Geometry.scale(1, 1, 1);
  }
  const mesh_rear_sling_swivel_left_32 = new THREE.Mesh(
    mesh_rear_sling_swivel_left_32Geometry,
    materialMap["mat_barrel_parkerized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_sling_swivel_left_32.name = "rear_sling_swivel_left";
  if (endpoint_rear_sling_swivel_left_32) {
    mesh_rear_sling_swivel_left_32.position.copy(endpoint_rear_sling_swivel_left_32.midpoint);
    mesh_rear_sling_swivel_left_32.quaternion.copy(endpoint_rear_sling_swivel_left_32.quaternion);
  }
  mesh_rear_sling_swivel_left_32.castShadow = options.castShadow ?? true;
  mesh_rear_sling_swivel_left_32.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_sling_swivel_left_32.userData.sculptComponent = {"id": "rear_sling_swivel_left", "name": "rear_sling_swivel_left", "level": "micro", "parent": "polymer_stock_chassis", "role": "sling-loop", "topologyClass": "assembled-solid", "topologyRationale": "Left-side (-Z) rear sling plate and steel wire D-loop mounted near buttstock rear.", "primitive": "torus", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.92, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "left_rear_sling_mount", "localStart": [-0.36, -0.068, -0.025], "localEnd": [-0.335, -0.068, -0.032], "contactType": "hinge", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_left_side.png"]}, "localFeatures": [{"id": "sling-loop-ring", "type": "fastener", "placement": "left rear buttstock flank", "confidence": 0.96}], "actionProfile": {"animationRole": "sling-hinge", "pivotType": "hinge", "destructionGroup": "chassis_group"}};
  node_rear_sling_swivel_left_32.add(mesh_rear_sling_swivel_left_32);
  meshes["rear_sling_swivel_left"] = mesh_rear_sling_swivel_left_32;
  colliders["rear_sling_swivel_left"] = {};

  const attachment_barrel_lock_pin_right_33 = {"parentId": "upper_receiver_metal", "parentSocket": "barrel_lock_bore", "localStart": [0.115, 0.005, 0.018], "localEnd": [0.115, 0.005, 0.024], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]};
  const endpoint_barrel_lock_pin_right_33 = makeAttachmentEndpoint(attachment_barrel_lock_pin_right_33);
  const node_barrel_lock_pin_right_33 = new THREE.Group();
  node_barrel_lock_pin_right_33.name = "barrel_lock_pin_right__pivot";
  node_barrel_lock_pin_right_33.scale.set(1, 1, 1);
  if (endpoint_barrel_lock_pin_right_33) {
    node_barrel_lock_pin_right_33.position.copy(endpoint_barrel_lock_pin_right_33.start);
    node_barrel_lock_pin_right_33.rotation.set(0, 0, 0);
  } else {
    node_barrel_lock_pin_right_33.position.set(0, 0, 0);
    node_barrel_lock_pin_right_33.rotation.set(0, 0, 0);
  }
  node_barrel_lock_pin_right_33.userData.sculptComponent = {"id": "barrel_lock_pin_right", "name": "barrel_lock_pin_right", "level": "micro", "parent": "upper_receiver_metal", "role": "barrel-lock-pin", "topologyClass": "assembled-solid", "topologyRationale": "Circular barrel quick-change lock button on right side of upper receiver.", "primitive": "cylinder", "material": "mat_receiver_anodized", "materialLayers": ["mat_receiver_anodized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 45, 46, 1.0)", "secondaryAlbedo": "rgba(92, 96, 100, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.95, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(44, 45, 46, 1.0)"}, {"position": 1.0, "color": "rgba(92, 96, 100, 1.0)"}]}}, "importance": 0.84, "attachment": {"parentId": "upper_receiver_metal", "parentSocket": "barrel_lock_bore", "localStart": [0.115, 0.005, 0.018], "localEnd": [0.115, 0.005, 0.024], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "receiver_group"}};
  node_barrel_lock_pin_right_33.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "receiver_group"};
  (nodes["upper_receiver_metal"] ?? root).add(node_barrel_lock_pin_right_33);
  nodes["barrel_lock_pin_right"] = node_barrel_lock_pin_right_33;
  const mesh_barrel_lock_pin_right_33Geometry = endpoint_barrel_lock_pin_right_33
    ? new THREE.CylinderGeometry(endpoint_barrel_lock_pin_right_33.endRadius, endpoint_barrel_lock_pin_right_33.baseRadius, endpoint_barrel_lock_pin_right_33.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_barrel_lock_pin_right_33) {
    mesh_barrel_lock_pin_right_33Geometry.scale(1, 1, 1);
  }
  const mesh_barrel_lock_pin_right_33 = new THREE.Mesh(
    mesh_barrel_lock_pin_right_33Geometry,
    materialMap["mat_receiver_anodized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_barrel_lock_pin_right_33.name = "barrel_lock_pin_right";
  if (endpoint_barrel_lock_pin_right_33) {
    mesh_barrel_lock_pin_right_33.position.copy(endpoint_barrel_lock_pin_right_33.midpoint);
    mesh_barrel_lock_pin_right_33.quaternion.copy(endpoint_barrel_lock_pin_right_33.quaternion);
  }
  mesh_barrel_lock_pin_right_33.castShadow = options.castShadow ?? true;
  mesh_barrel_lock_pin_right_33.receiveShadow = options.receiveShadow ?? true;
  mesh_barrel_lock_pin_right_33.userData.sculptComponent = {"id": "barrel_lock_pin_right", "name": "barrel_lock_pin_right", "level": "micro", "parent": "upper_receiver_metal", "role": "barrel-lock-pin", "topologyClass": "assembled-solid", "topologyRationale": "Circular barrel quick-change lock button on right side of upper receiver.", "primitive": "cylinder", "material": "mat_receiver_anodized", "materialLayers": ["mat_receiver_anodized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 45, 46, 1.0)", "secondaryAlbedo": "rgba(92, 96, 100, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.95, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(44, 45, 46, 1.0)"}, {"position": 1.0, "color": "rgba(92, 96, 100, 1.0)"}]}}, "importance": 0.84, "attachment": {"parentId": "upper_receiver_metal", "parentSocket": "barrel_lock_bore", "localStart": [0.115, 0.005, 0.018], "localEnd": [0.115, 0.005, 0.024], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "receiver_group"}};
  node_barrel_lock_pin_right_33.add(mesh_barrel_lock_pin_right_33);
  meshes["barrel_lock_pin_right"] = mesh_barrel_lock_pin_right_33;
  colliders["barrel_lock_pin_right"] = {};

  const endpoint_stock_cross_pins_34 = makeAttachmentEndpoint(null);
  const node_stock_cross_pins_34 = new THREE.Group();
  node_stock_cross_pins_34.name = "stock_cross_pins__pivot";
  node_stock_cross_pins_34.scale.set(1, 1, 1);
  if (endpoint_stock_cross_pins_34) {
    node_stock_cross_pins_34.position.copy(endpoint_stock_cross_pins_34.start);
    node_stock_cross_pins_34.rotation.set(0, 0, 0);
  } else {
    node_stock_cross_pins_34.position.set(0, 0, 0);
    node_stock_cross_pins_34.rotation.set(0, 0, 0);
  }
  node_stock_cross_pins_34.userData.sculptComponent = {"id": "stock_cross_pins", "name": "stock_cross_pins", "level": "micro", "parent": "polymer_stock_chassis", "role": "fastener-pins", "topologyClass": "surface-relief", "topologyRationale": "Steel takedown and buttpad retaining pins inset into polymer stock corners.", "primitive": "instanced-cluster", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.86, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "stock_pin_bores", "localStart": [-0.365, -0.012, -0.024], "localEnd": [-0.355, -0.125, 0.024], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "rear-steel-pins", "type": "fastener", "placement": "buttstock upper and lower rear corners", "confidence": 0.91}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_stock_cross_pins_34.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"};
  (nodes["polymer_stock_chassis"] ?? root).add(node_stock_cross_pins_34);
  nodes["stock_cross_pins"] = node_stock_cross_pins_34;
  const mesh_stock_cross_pins_34Geometry = endpoint_stock_cross_pins_34
    ? new THREE.CylinderGeometry(endpoint_stock_cross_pins_34.endRadius, endpoint_stock_cross_pins_34.baseRadius, endpoint_stock_cross_pins_34.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_stock_cross_pins_34) {
    mesh_stock_cross_pins_34Geometry.scale(1, 1, 1);
  }
  const mesh_stock_cross_pins_34 = new THREE.Mesh(
    mesh_stock_cross_pins_34Geometry,
    materialMap["mat_barrel_parkerized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stock_cross_pins_34.name = "stock_cross_pins";
  if (endpoint_stock_cross_pins_34) {
    mesh_stock_cross_pins_34.position.copy(endpoint_stock_cross_pins_34.midpoint);
    mesh_stock_cross_pins_34.quaternion.copy(endpoint_stock_cross_pins_34.quaternion);
  }
  mesh_stock_cross_pins_34.castShadow = options.castShadow ?? true;
  mesh_stock_cross_pins_34.receiveShadow = options.receiveShadow ?? true;
  mesh_stock_cross_pins_34.userData.sculptComponent = {"id": "stock_cross_pins", "name": "stock_cross_pins", "level": "micro", "parent": "polymer_stock_chassis", "role": "fastener-pins", "topologyClass": "surface-relief", "topologyRationale": "Steel takedown and buttpad retaining pins inset into polymer stock corners.", "primitive": "instanced-cluster", "material": "mat_barrel_parkerized", "materialLayers": ["mat_barrel_parkerized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(35, 37, 39, 1.0)", "secondaryAlbedo": "rgba(72, 75, 79, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.96, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(35, 37, 39, 1.0)"}, {"position": 1.0, "color": "rgba(72, 75, 79, 1.0)"}]}}, "importance": 0.86, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "stock_pin_bores", "localStart": [-0.365, -0.012, -0.024], "localEnd": [-0.355, -0.125, 0.024], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_right_side.png"]}, "localFeatures": [{"id": "rear-steel-pins", "type": "fastener", "placement": "buttstock upper and lower rear corners", "confidence": 0.91}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_stock_cross_pins_34.add(mesh_stock_cross_pins_34);
  meshes["stock_cross_pins"] = mesh_stock_cross_pins_34;
  colliders["stock_cross_pins"] = {};

  const endpoint_left_stock_vertical_latch_35 = makeAttachmentEndpoint(null);
  const node_left_stock_vertical_latch_35 = new THREE.Group();
  node_left_stock_vertical_latch_35.name = "left_stock_vertical_latch__pivot";
  node_left_stock_vertical_latch_35.scale.set(1, 1, 1);
  if (endpoint_left_stock_vertical_latch_35) {
    node_left_stock_vertical_latch_35.position.copy(endpoint_left_stock_vertical_latch_35.start);
    node_left_stock_vertical_latch_35.rotation.set(0, 0, 0);
  } else {
    node_left_stock_vertical_latch_35.position.set(0, 0, 0);
    node_left_stock_vertical_latch_35.rotation.set(0, 0, 0);
  }
  node_left_stock_vertical_latch_35.userData.sculptComponent = {"id": "left_stock_vertical_latch", "name": "left_stock_vertical_latch", "level": "micro", "parent": "polymer_stock_chassis", "role": "stock-vertical-latch-left", "topologyClass": "assembled-solid", "topologyRationale": "Left-side (-Z) vertical serrated latch bar and circular pin located above the rear magazine well beneath the blanking plate.", "primitive": "extrude", "material": "mat_receiver_anodized", "materialLayers": ["mat_receiver_anodized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 45, 46, 1.0)", "secondaryAlbedo": "rgba(92, 96, 100, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.95, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(44, 45, 46, 1.0)"}, {"position": 1.0, "color": "rgba(92, 96, 100, 1.0)"}]}}, "importance": 0.88, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "left_vertical_latch_slot", "localStart": [-0.215, -0.06, -0.0235], "localEnd": [-0.215, -0.036, -0.0245], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_left_side.png"]}, "localFeatures": [{"id": "left-vertical-latch-ribs", "type": "ridge", "placement": "left (-Z) stock flank above rear magwell", "confidence": 0.95}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_left_stock_vertical_latch_35.userData.actionProfile = {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"};
  (nodes["polymer_stock_chassis"] ?? root).add(node_left_stock_vertical_latch_35);
  nodes["left_stock_vertical_latch"] = node_left_stock_vertical_latch_35;
  const mesh_left_stock_vertical_latch_35Geometry = endpoint_left_stock_vertical_latch_35
    ? new THREE.CylinderGeometry(endpoint_left_stock_vertical_latch_35.endRadius, endpoint_left_stock_vertical_latch_35.baseRadius, endpoint_left_stock_vertical_latch_35.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_left_stock_vertical_latch_35) {
    mesh_left_stock_vertical_latch_35Geometry.scale(1, 1, 1);
  }
  const mesh_left_stock_vertical_latch_35 = new THREE.Mesh(
    mesh_left_stock_vertical_latch_35Geometry,
    materialMap["mat_receiver_anodized"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_left_stock_vertical_latch_35.name = "left_stock_vertical_latch";
  if (endpoint_left_stock_vertical_latch_35) {
    mesh_left_stock_vertical_latch_35.position.copy(endpoint_left_stock_vertical_latch_35.midpoint);
    mesh_left_stock_vertical_latch_35.quaternion.copy(endpoint_left_stock_vertical_latch_35.quaternion);
  }
  mesh_left_stock_vertical_latch_35.castShadow = options.castShadow ?? true;
  mesh_left_stock_vertical_latch_35.receiveShadow = options.receiveShadow ?? true;
  mesh_left_stock_vertical_latch_35.userData.sculptComponent = {"id": "left_stock_vertical_latch", "name": "left_stock_vertical_latch", "level": "micro", "parent": "polymer_stock_chassis", "role": "stock-vertical-latch-left", "topologyClass": "assembled-solid", "topologyRationale": "Left-side (-Z) vertical serrated latch bar and circular pin located above the rear magazine well beneath the blanking plate.", "primitive": "extrude", "material": "mat_receiver_anodized", "materialLayers": ["mat_receiver_anodized"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 45, 46, 1.0)", "secondaryAlbedo": "rgba(92, 96, 100, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.95, "colorGradient": {"type": "linear", "stops": [{"position": 0.0, "color": "rgba(44, 45, 46, 1.0)"}, {"position": 1.0, "color": "rgba(92, 96, 100, 1.0)"}]}}, "importance": 0.88, "attachment": {"parentId": "polymer_stock_chassis", "parentSocket": "left_vertical_latch_slot", "localStart": [-0.215, -0.06, -0.0235], "localEnd": [-0.215, -0.036, -0.0245], "contactType": "embedded", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.002, "evidenceRefs": ["refs/aug_left_side.png"]}, "localFeatures": [{"id": "left-vertical-latch-ribs", "type": "ridge", "placement": "left (-Z) stock flank above rear magwell", "confidence": 0.95}], "actionProfile": {"animationRole": "static-part", "pivotType": "center", "destructionGroup": "chassis_group"}};
  node_left_stock_vertical_latch_35.add(mesh_left_stock_vertical_latch_35);
  meshes["left_stock_vertical_latch"] = mesh_left_stock_vertical_latch_35;
  colliders["left_stock_vertical_latch"] = {};

  // repetition system: waffle-mag-rib-grid (InstancedMesh, radial, count=48, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["mat_polymer_od"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 48);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 48; i++) {
      const ang = ((0.0) + (i * 360) / 48) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "waffle-mag-rib-grid";
    parent.add(cluster);
  }

  // repetition system: tulip-flash-hider-slots (InstancedMesh, radial, count=5, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["mat_polymer_od"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 5);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 5; i++) {
      const ang = ((0.0) + (i * 360) / 5) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "tulip-flash-hider-slots";
    parent.add(cluster);
  }

  // repetition system: chassis-steel-cross-pins (InstancedMesh, radial, count=6, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["mat_polymer_od"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 6);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 6; i++) {
      const ang = ((0.0) + (i * 360) / 6) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "chassis-steel-cross-pins";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createSteyrAUGA1LookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Steyr AUG A1 look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = ["Key directional studio light from upper-front-right (+2.2, +3.5, +4.0), warm-neutral 5400K, intensity 2.6, soft shadow radius 4", "Fill directional light from opposite front-left (-2.5, +1.5, -3.5), cool-neutral 6500K, intensity 1.5 to illuminate left-side details cleanly", "Rim/back directional light from upper-rear (-1.0, +3.2, -3.8), intensity 1.8 for crisp edge separation on dark barrel and anodized receiver", "Code-generated RoomEnvironment -> PMREMGenerator IBL (envMapIntensity 0.9-1.1) with ACESFilmicToneMapping, toneMappingExposure 1.12, SRGBColorSpace, and soft ground contact shadow (ShadowMaterial opacity 0.16)"];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createSteyrAUGA1Environment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameSteyrAUGA1Camera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createSteyrAUGA1PresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureSteyrAUGA1Renderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createSteyrAUGA1InspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
