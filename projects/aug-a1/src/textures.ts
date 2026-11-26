import * as THREE from 'three';

export interface AugPbrTextureSet {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  metalnessMap: THREE.CanvasTexture;
  aoMap: THREE.CanvasTexture;
  resolution: number;
}

export interface AugPbrMaterials {
  mat_polymer_od: THREE.MeshStandardMaterial;
  mat_receiver_anodized: THREE.MeshStandardMaterial;
  mat_optic_worn_metal: THREE.MeshStandardMaterial;
  mat_barrel_parkerized: THREE.MeshStandardMaterial;
  mat_mag_translucent: THREE.MeshPhysicalMaterial;
  mat_mag_internals: THREE.MeshStandardMaterial;
  mat_mag_floorplate: THREE.MeshStandardMaterial;
  mat_rubber_buttpad: THREE.MeshStandardMaterial;
  mat_optic_glass: THREE.MeshPhysicalMaterial;
  mat_ejection_cavity: THREE.MeshStandardMaterial;
}

export interface AugTextureLibrary {
  materials: AugPbrMaterials;
  textures: THREE.Texture[];
  sets: Record<string, AugPbrTextureSet>;
  allLoaded: boolean;
}

// ============================================================================
// Deterministic PRNG & Periodic Tileable Noise Primitives
// ============================================================================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashInt2D(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampByte(v: number): number {
  const n = Math.round(v);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Generates a tileable periodic FBM field at `size x size` by evaluating periodic lattice octaves
 * on a fast low-res grid (`baseGrid`) and smooth-upsampling to `size`, keeping 2048px generation
 * crisp and deterministic under ~60ms.
 */
function buildPeriodicFbmField(
  size: number,
  seed: number,
  octaves: Array<{ freq: number; amp: number }>,
  workGridSize = 256,
): Float32Array {
  const grid = new Float32Array(workGridSize * workGridSize);
  let totalAmp = 0;

  for (let oi = 0; oi < octaves.length; oi += 1) {
    const { freq, amp } = octaves[oi];
    totalAmp += amp;
    const octSeed = (seed + oi * 7919) | 0;
    const period = Math.max(2, Math.round(freq));

    for (let y = 0; y < workGridSize; y += 1) {
      const fy = (y / workGridSize) * period;
      const iy0 = Math.floor(fy) % period;
      const iy1 = (iy0 + 1) % period;
      const ty = smooth(fy - Math.floor(fy));

      for (let x = 0; x < workGridSize; x += 1) {
        const fx = (x / workGridSize) * period;
        const ix0 = Math.floor(fx) % period;
        const ix1 = (ix0 + 1) % period;
        const tx = smooth(fx - Math.floor(fx));

        const v00 = hashInt2D(ix0, iy0, octSeed);
        const v10 = hashInt2D(ix1, iy0, octSeed);
        const v01 = hashInt2D(ix0, iy1, octSeed);
        const v11 = hashInt2D(ix1, iy1, octSeed);

        const a = v00 + (v10 - v00) * tx;
        const b = v01 + (v11 - v01) * tx;
        grid[y * workGridSize + x] += (a + (b - a) * ty) * amp;
      }
    }
  }

  const invAmp = totalAmp > 0 ? 1 / totalAmp : 1;
  for (let i = 0; i < grid.length; i += 1) {
    grid[i] *= invAmp;
  }

  if (workGridSize === size) return grid;

  const out = new Float32Array(size * size);
  const scale = workGridSize / size;
  for (let y = 0; y < size; y += 1) {
    const sy = y * scale;
    const y0 = Math.floor(sy) % workGridSize;
    const y1 = (y0 + 1) % workGridSize;
    const ty = sy - Math.floor(sy);
    const row0 = y0 * workGridSize;
    const row1 = y1 * workGridSize;

    for (let x = 0; x < size; x += 1) {
      const sx = x * scale;
      const x0 = Math.floor(sx) % workGridSize;
      const x1 = (x0 + 1) % workGridSize;
      const tx = sx - Math.floor(sx);

      const v00 = grid[row0 + x0];
      const v10 = grid[row0 + x1];
      const v01 = grid[row1 + x0];
      const v11 = grid[row1 + x1];
      const a = v00 + (v10 - v00) * tx;
      const b = v01 + (v11 - v01) * tx;
      out[y * size + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/**
 * Generates an isotropic tileable stipple / injection-molded polymer grain height field
 * at native pixel resolution using jittered periodic Voronoi/cell distance (`~14-24px` grains).
 */
function buildPeriodicCellGrain(size: number, cellCount: number, seed: number): Float32Array {
  const ptsX = new Float32Array(cellCount * cellCount);
  const ptsY = new Float32Array(cellCount * cellCount);
  const rng = mulberry32(seed);
  for (let cy = 0; cy < cellCount; cy += 1) {
    for (let cx = 0; cx < cellCount; cx += 1) {
      const idx = cy * cellCount + cx;
      ptsX[idx] = cx + 0.15 + rng() * 0.7;
      ptsY[idx] = cy + 0.15 + rng() * 0.7;
    }
  }

  const out = new Float32Array(size * size);
  const scale = cellCount / size;
  for (let y = 0; y < size; y += 1) {
    const gy = y * scale;
    const cy = Math.floor(gy);
    for (let x = 0; x < size; x += 1) {
      const gx = x * scale;
      const cx = Math.floor(gx);
      let d1 = 10.0;
      for (let oy = -1; oy <= 1; oy += 1) {
        const ny = (cy + oy + cellCount) % cellCount;
        const wrapY = cy + oy < 0 ? -cellCount : cy + oy >= cellCount ? cellCount : 0;
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = (cx + ox + cellCount) % cellCount;
          const wrapX = cx + ox < 0 ? -cellCount : cx + ox >= cellCount ? cellCount : 0;
          const idx = ny * cellCount + nx;
          const dx = gx - (ptsX[idx] + wrapX);
          const dy = gy - (ptsY[idx] + wrapY);
          const d2 = dx * dx + dy * dy;
          if (d2 < d1) d1 = d2;
        }
      }
      // Dome-shaped pebble grain (high in center, crease at border)
      out[y * size + x] = clamp01(1.0 - Math.sqrt(d1) * 1.18);
    }
  }
  return out;
}

function drawScratchesMask(
  size: number,
  seed: number,
  count: number,
  minWidthPx: number,
  maxWidthPx: number,
  minLenFrac: number,
  maxLenFrac: number,
  directionalBias?: number,
): Float32Array {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);

  const rng = mulberry32(seed);
  ctx.lineCap = 'round';

  for (let i = 0; i < count; i += 1) {
    const x0 = rng() * size;
    const y0 = rng() * size;
    const angle =
      directionalBias !== undefined
        ? directionalBias + (rng() - 0.5) * 0.45
        : rng() * Math.PI * 2;
    const len = size * (minLenFrac + rng() * (maxLenFrac - minLenFrac));
    const cx = x0 + Math.cos(angle) * len * 0.5 + (rng() - 0.5) * len * 0.28;
    const cy = y0 + Math.sin(angle) * len * 0.5 + (rng() - 0.5) * len * 0.28;
    const x1 = x0 + Math.cos(angle) * len;
    const y1 = y0 + Math.sin(angle) * len;
    const lw = minWidthPx + rng() * (maxWidthPx - minWidthPx);
    const alpha = 0.25 + rng() * 0.65;

    ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
    ctx.lineWidth = lw;

    // Tile-wrap across edges for seamless RepeatWrapping
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        const dx = ox * size;
        const dy = oy * size;
        if (
          Math.max(x0 + dx, x1 + dx, cx + dx) < -10 ||
          Math.min(x0 + dx, x1 + dx, cx + dx) > size + 10 ||
          Math.max(y0 + dy, y1 + dy, cy + dy) < -10 ||
          Math.min(y0 + dy, y1 + dy, cy + dy) > size + 10
        ) {
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(x0 + dx, y0 + dy);
        ctx.quadraticCurveTo(cx + dx, cy + dy, x1 + dx, y1 + dy);
        ctx.stroke();
      }
    }
  }

  const data = ctx.getImageData(0, 0, size, size).data;
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = data[i * 4] / 255;
  }
  return out;
}

function createCanvasFromRGBAPixels(
  size: number,
  pixels: Uint8ClampedArray<ArrayBuffer>,
  colorSpace: THREE.ColorSpace,
  repeat = true,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = new ImageData(pixels, size, size);
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = colorSpace;
  tex.anisotropy = 8;
  tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function createGrayTextureFromFloat(
  size: number,
  field: Float32Array,
  repeat = true,
): THREE.CanvasTexture {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < field.length; i += 1) {
    const v = clampByte(field[i] * 255);
    const p = i * 4;
    pixels[p] = v;
    pixels[p + 1] = v;
    pixels[p + 2] = v;
    pixels[p + 3] = 255;
  }
  return createCanvasFromRGBAPixels(size, pixels, THREE.NoColorSpace, repeat);
}

/**
 * 3x3 periodic Sobel filter converting an independent height field [0..1] into a tangent-space normalMap.
 * CanvasTexture has flipY=true, so +canvasY corresponds to -V: nx = -dH/du, ny = +dH/dy_canvas.
 */
function createSobelNormalTexture(
  size: number,
  height: Float32Array,
  strength: number,
  repeat = true,
): THREE.CanvasTexture {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const mask = size - 1;
  const isPow2 = (size & mask) === 0;

  for (let y = 0; y < size; y += 1) {
    const ym = isPow2 ? (y - 1) & mask : (y - 1 + size) % size;
    const yp = isPow2 ? (y + 1) & mask : (y + 1) % size;
    const rowM = ym * size;
    const row0 = y * size;
    const rowP = yp * size;

    for (let x = 0; x < size; x += 1) {
      const xm = isPow2 ? (x - 1) & mask : (x - 1 + size) % size;
      const xp = isPow2 ? (x + 1) & mask : (x + 1) % size;

      const tl = height[rowM + xm];
      const t = height[rowM + x];
      const tr = height[rowM + xp];
      const l = height[row0 + xm];
      const r = height[row0 + xp];
      const bl = height[rowP + xm];
      const b = height[rowP + x];
      const br = height[rowP + xp];

      const dx = tr + 2 * r + br - (tl + 2 * l + bl);
      const dy = bl + 2 * b + br - (tl + 2 * t + tr);

      const nx = -dx * strength;
      const ny = dy * strength;
      const nz = 1.0;
      const invLen = 1.0 / Math.hypot(nx, ny, nz);

      const p = (row0 + x) * 4;
      pixels[p] = clampByte((nx * invLen * 0.5 + 0.5) * 255);
      pixels[p + 1] = clampByte((ny * invLen * 0.5 + 0.5) * 255);
      pixels[p + 2] = clampByte((nz * invLen * 0.5 + 0.5) * 255);
      pixels[p + 3] = 255;
    }
  }

  return createCanvasFromRGBAPixels(size, pixels, THREE.NoColorSpace, repeat);
}

// ============================================================================
// Independent Procedural PBR Set Generators (2048px primary / 1024px secondary)
// ============================================================================

function generatePolymerODSet(size = 2048): AugPbrTextureSet {
  // Independent seeds for each channel so no two channels alias
  const albedoFbm = buildPeriodicFbmField(size, 101, [
    { freq: 4, amp: 0.48 },
    { freq: 11, amp: 0.30 },
    { freq: 28, amp: 0.22 },
  ]);
  const roughFbm = buildPeriodicFbmField(size, 202, [
    { freq: 5, amp: 0.45 },
    { freq: 14, amp: 0.32 },
    { freq: 38, amp: 0.23 },
  ]);
  const heightFbm = buildPeriodicFbmField(size, 303, [
    { freq: 12, amp: 0.35 },
    { freq: 42, amp: 0.65 },
  ]);
  const aoFbm = buildPeriodicFbmField(size, 404, [
    { freq: 7, amp: 0.55 },
    { freq: 22, amp: 0.45 },
  ]);

  // 128x128 cell pebbles across 0.085m -> ~0.65mm injection-molded pebble scale
  const pebble = buildPeriodicCellGrain(size, 128, 505);
  const scratchShort = drawScratchesMask(size, 606, 150, 0.75, 1.6, 0.02, 0.12);
  const scratchLong = drawScratchesMask(size, 656, 70, 0.85, 1.8, 0.10, 0.34, 0.12);
  const scratchHeight = drawScratchesMask(size, 707, 130, 0.85, 1.8, 0.02, 0.15);

  const count = size * size;
  const albedoPx = new Uint8ClampedArray(count * 4);
  const roughField = new Float32Array(count);
  const heightField = new Float32Array(count);
  const metalField = new Float32Array(count);
  const aoField = new Float32Array(count);

  // Target warm brownish military OD polymer: R > G > B (renders near REF [92, 88, 68]) + subtle lighter scuffs #7a755c
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const microA = hashInt2D(x, y, 808);
      const microR = hashInt2D(x, y, 909);
      const microH = hashInt2D(x, y, 1010);

      const fA = albedoFbm[i] * 0.72 + microA * 0.28;
      const sc = clamp01(scratchShort[i] * 0.95 + scratchLong[i] * 1.0);
      // Warm olive-drab (R > G > B, no mossy green cast)
      let r = lerp(62, 73, fA);
      let g = lerp(58, 69, fA);
      let b = lerp(41, 49, fA);
      // Fine lighter handling scuffs (#857f64 -> RGB 133, 127, 100)
      if (sc > 0.02) {
        r = lerp(r, 133, sc * 0.85);
        g = lerp(g, 127, sc * 0.85);
        b = lerp(b, 100, sc * 0.85);
      }
      const p = i * 4;
      albedoPx[p] = clampByte(r);
      albedoPx[p + 1] = clampByte(g);
      albedoPx[p + 2] = clampByte(b);
      albedoPx[p + 3] = 255;

      // Roughness: matte/satin injection polymer 0.58..0.82, slightly glossier on scuffs/burnish
      const burnish = smooth((roughFbm[i] - 0.35) / 0.45);
      const roughBase = lerp(0.80, 0.62, burnish * 0.7) + (microR - 0.5) * 0.08;
      roughField[i] = clamp01(lerp(roughBase, 0.54, sc * 0.68));

      // Height: physical molded pebble + subtle long warp + incised scratches
      heightField[i] = clamp01(
        pebble[i] * 0.60 + heightFbm[i] * 0.22 + microH * 0.18 - scratchHeight[i] * 0.34,
      );

      // Metalness: dielectric ~0.02
      metalField[i] = 0.02 + microA * 0.01;

      // AO: subtle pore micro-occlusion + macro handling shadow
      aoField[i] = clamp01(0.86 + pebble[i] * 0.08 + aoFbm[i] * 0.06);
    }
  }

  return {
    map: createCanvasFromRGBAPixels(size, albedoPx, THREE.SRGBColorSpace, true),
    roughnessMap: createGrayTextureFromFloat(size, roughField, true),
    normalMap: createSobelNormalTexture(size, heightField, 1.55, true),
    metalnessMap: createGrayTextureFromFloat(size, metalField, true),
    aoMap: createGrayTextureFromFloat(size, aoField, true),
    resolution: size,
  };
}

function generateReceiverAnodizedSet(size = 2048): AugPbrTextureSet {
  const albedoFbm = buildPeriodicFbmField(size, 1101, [
    { freq: 4, amp: 0.45 },
    { freq: 14, amp: 0.35 },
    { freq: 36, amp: 0.20 },
  ]);
  const roughFbm = buildPeriodicFbmField(size, 1202, [
    { freq: 6, amp: 0.50 },
    { freq: 18, amp: 0.30 },
    { freq: 48, amp: 0.20 },
  ]);
  const heightFbm = buildPeriodicFbmField(size, 1303, [
    { freq: 18, amp: 0.40 },
    { freq: 64, amp: 0.60 },
  ]);
  const aoFbm = buildPeriodicFbmField(size, 1404, [
    { freq: 8, amp: 0.6 },
    { freq: 24, amp: 0.4 },
  ]);

  // Subtle satin bead-blasted anodized finish with very faint directional machining grain
  const millStreaks = new Float32Array(size);
  for (let y = 0; y < size; y += 1) {
    millStreaks[y] =
      hashInt2D(y, 17, 1505) * 0.25 +
      Math.sin((y / size) * Math.PI * 2 * 96) * 0.12 +
      Math.sin((y / size) * Math.PI * 2 * 240) * 0.07;
  }
  const microChips = drawScratchesMask(size, 1606, 85, 0.6, 1.3, 0.005, 0.035, 0.08);
  const chipHeight = drawScratchesMask(size, 1707, 80, 0.7, 1.4, 0.005, 0.032, -0.05);

  const count = size * size;
  const albedoPx = new Uint8ClampedArray(count * 4);
  const roughField = new Float32Array(count);
  const heightField = new Float32Array(count);
  const metalField = new Float32Array(count);
  const aoField = new Float32Array(count);

  // Dark satin anodized aluminum (renders close to REF [64, 64, 61]) without chrome-brushed sheen
  for (let y = 0; y < size; y += 1) {
    const ms = millStreaks[y];
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const mA = hashInt2D(x, y, 1808);
      const mR = hashInt2D(x, y, 1909);
      const mH = hashInt2D(x, y, 2010);

      const f = albedoFbm[i] * 0.72 + ms * 0.10 + mA * 0.18;
      const chip = clamp01(microChips[i] * 0.65);

      let r = lerp(56, 70, f);
      let g = lerp(56, 70, f);
      let b = lerp(54, 67, f);
      if (chip > 0.05) {
        r = lerp(r, 106, chip * 0.50);
        g = lerp(g, 107, chip * 0.50);
        b = lerp(b, 104, chip * 0.50);
      }
      const p = i * 4;
      albedoPx[p] = clampByte(r);
      albedoPx[p + 1] = clampByte(g);
      albedoPx[p + 2] = clampByte(b);
      albedoPx[p + 3] = 255;

      // Dark satin anodized roughness 0.50..0.64, dropping mildly on tiny nicks
      const rBase = lerp(0.50, 0.64, roughFbm[i] * 0.75 + mR * 0.25);
      roughField[i] = clamp01(lerp(rBase, 0.38, chip));

      // Metalness 0.68..0.74 base -> 0.84 exposed (prevents crushing dark albedo in satin roughness)
      metalField[i] = clamp01(lerp(0.68 + mA * 0.06, 0.84, chip));

      // Height: fine satin bead-blasted anodized micro-texture
      heightField[i] = clamp01(
        heightFbm[i] * 0.45 + ms * 0.14 + mH * 0.41 - chipHeight[i] * 0.18,
      );

      aoField[i] = clamp01(0.88 + aoFbm[i] * 0.12);
    }
  }

  return {
    map: createCanvasFromRGBAPixels(size, albedoPx, THREE.SRGBColorSpace, true),
    roughnessMap: createGrayTextureFromFloat(size, roughField, true),
    normalMap: createSobelNormalTexture(size, heightField, 0.62, true),
    metalnessMap: createGrayTextureFromFloat(size, metalField, true),
    aoMap: createGrayTextureFromFloat(size, aoField, true),
    resolution: size,
  };
}

function generateOpticWornMetalSet(size = 2048): AugPbrTextureSet {
  const albedoFbm = buildPeriodicFbmField(size, 2101, [
    { freq: 4, amp: 0.44 },
    { freq: 14, amp: 0.34 },
    { freq: 38, amp: 0.22 },
  ]);
  const roughFbm = buildPeriodicFbmField(size, 2303, [
    { freq: 7, amp: 0.50 },
    { freq: 24, amp: 0.32 },
    { freq: 56, amp: 0.18 },
  ]);
  // Fine metallic cast micro-porosity (no coarse orange-peel Voronoi pebble)
  const heightFbm = buildPeriodicFbmField(size, 2404, [
    { freq: 28, amp: 0.35 },
    { freq: 84, amp: 0.65 },
  ]);
  const scratches = drawScratchesMask(size, 2505, 160, 0.55, 1.35, 0.008, 0.055);
  const scratchesLinear = drawScratchesMask(size, 2555, 90, 0.55, 1.15, 0.012, 0.075, 0.04);
  const scratchDepth = drawScratchesMask(size, 2606, 130, 0.60, 1.30, 0.008, 0.055);

  const count = size * size;
  const albedoPx = new Uint8ClampedArray(count * 4);
  const roughField = new Float32Array(count);
  const heightField = new Float32Array(count);
  const metalField = new Float32Array(count);
  const aoField = new Float32Array(count);

  // Reference optic_housing.png: neutral cool graphite-lead painted cast alloy (renders near REF [84, 84, 78])
  // with crisp fine metallic scratches & edge scrapes, NO green plastic or cloudy patches
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const mA = hashInt2D(x, y, 2707);
      const mR = hashInt2D(x, y, 2808);
      const mH = hashInt2D(x, y, 2909);

      const sc = clamp01(scratches[i] * 0.55 + scratchesLinear[i] * 0.65);

      // Neutral cool lead-graphite finish (R ~= G > B slightly, zero green cast)
      const f = albedoFbm[i] * 0.72 + mA * 0.28;
      let r = lerp(66, 78, f);
      let g = lerp(66, 78, f);
      let b = lerp(61, 72, f);

      // Fine scraped bare cast alloy micro-scratches
      if (sc > 0.03) {
        r = lerp(r, 126 + mA * 10, sc * 0.48);
        g = lerp(g, 127 + mA * 10, sc * 0.48);
        b = lerp(b, 120 + mA * 10, sc * 0.48);
      }

      const p = i * 4;
      albedoPx[p] = clampByte(r);
      albedoPx[p + 1] = clampByte(g);
      albedoPx[p + 2] = clampByte(b);
      albedoPx[p + 3] = 255;

      // Satin painted cast metal roughness ~0.46..0.60, fine scratches ~0.34
      const rCast = lerp(0.46, 0.60, roughFbm[i] * 0.78 + mR * 0.22);
      roughField[i] = clamp01(lerp(rCast, 0.34, sc * 0.72));

      // Metalness: satin coated cast alloy ~0.66..0.72 -> exposed alloy ~0.86
      metalField[i] = clamp01(lerp(0.66 + mA * 0.06, 0.86, sc * 0.75));

      // Fine cast micro-porosity (no coarse pebble!)
      heightField[i] = clamp01(
        heightFbm[i] * 0.45 + mH * 0.55 - scratchDepth[i] * 0.28,
      );

      aoField[i] = clamp01(0.88 + heightFbm[i] * 0.08 + mR * 0.04);
    }
  }

  return {
    map: createCanvasFromRGBAPixels(size, albedoPx, THREE.SRGBColorSpace, true),
    roughnessMap: createGrayTextureFromFloat(size, roughField, true),
    normalMap: createSobelNormalTexture(size, heightField, 0.58, true),
    metalnessMap: createGrayTextureFromFloat(size, metalField, true),
    aoMap: createGrayTextureFromFloat(size, aoField, true),
    resolution: size,
  };
}

function generateBarrelParkerizedSet(size = 2048): AugPbrTextureSet {
  const albedoFbm = buildPeriodicFbmField(size, 3101, [
    { freq: 5, amp: 0.45 },
    { freq: 18, amp: 0.35 },
    { freq: 50, amp: 0.20 },
  ]);
  const roughFbm = buildPeriodicFbmField(size, 3202, [
    { freq: 8, amp: 0.55 },
    { freq: 26, amp: 0.45 },
  ]);
  const aoFbm = buildPeriodicFbmField(size, 3303, [
    { freq: 10, amp: 0.6 },
    { freq: 32, amp: 0.4 },
  ]);

  // Subtle micro-lathe turning texture along V (reduced amplitude ~60% vs coarse grooves)
  const latheProfile = new Float32Array(size);
  for (let y = 0; y < size; y += 1) {
    latheProfile[y] =
      hashInt2D(y, 53, 3404) * 0.32 +
      Math.sin((y / size) * Math.PI * 2 * 160) * 0.14 +
      Math.sin((y / size) * Math.PI * 2 * 410) * 0.10;
  }
  const fineWear = drawScratchesMask(size, 3505, 65, 0.6, 1.2, 0.008, 0.045, 0.0);

  const count = size * size;
  const albedoPx = new Uint8ClampedArray(count * 4);
  const roughField = new Float32Array(count);
  const heightField = new Float32Array(count);
  const metalField = new Float32Array(count);
  const aoField = new Float32Array(count);

  // Dark parkerized manganese-phosphate steel #242628..#2e3033
  for (let y = 0; y < size; y += 1) {
    const lp = latheProfile[y];
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const mA = hashInt2D(x, y, 3606);
      const mR = hashInt2D(x, y, 3707);
      const mH = hashInt2D(x, y, 3808);

      const f = albedoFbm[i] * 0.62 + lp * 0.16 + mA * 0.22;
      const fw = fineWear[i];
      let r = lerp(34, 44, f);
      let g = lerp(36, 46, f);
      let b = lerp(38, 49, f);
      if (fw > 0.04) {
        r = lerp(r, 68, fw * 0.42);
        g = lerp(g, 71, fw * 0.42);
        b = lerp(b, 75, fw * 0.42);
      }

      const p = i * 4;
      albedoPx[p] = clampByte(r);
      albedoPx[p + 1] = clampByte(g);
      albedoPx[p + 2] = clampByte(b);
      albedoPx[p + 3] = 255;

      roughField[i] = clamp01(lerp(0.50, 0.64, roughFbm[i] * 0.72 + mR * 0.28) - fw * 0.08);
      metalField[i] = clamp01(0.78 + mA * 0.06 + fw * 0.06);
      heightField[i] = clamp01(lp * 0.20 + mH * 0.45 + albedoFbm[i] * 0.35);
      aoField[i] = clamp01(0.86 + aoFbm[i] * 0.10 + lp * 0.04);
    }
  }

  return {
    map: createCanvasFromRGBAPixels(size, albedoPx, THREE.SRGBColorSpace, true),
    roughnessMap: createGrayTextureFromFloat(size, roughField, true),
    normalMap: createSobelNormalTexture(size, heightField, 0.68, true),
    metalnessMap: createGrayTextureFromFloat(size, metalField, true),
    aoMap: createGrayTextureFromFloat(size, aoField, true),
    resolution: size,
  };
}

function generateMagTranslucentSet(size = 1024): AugPbrTextureSet {
  const albedoFbm = buildPeriodicFbmField(size, 4101, [
    { freq: 4, amp: 0.5 },
    { freq: 12, amp: 0.32 },
    { freq: 30, amp: 0.18 },
  ]);
  const roughFbm = buildPeriodicFbmField(size, 4202, [
    { freq: 6, amp: 0.55 },
    { freq: 20, amp: 0.45 },
  ]);
  const grain = buildPeriodicCellGrain(size, 96, 4303);
  const insertionScuffs = drawScratchesMask(size, 4404, 70, 0.8, 1.8, 0.04, 0.18, Math.PI * 0.48);

  const count = size * size;
  const albedoPx = new Uint8ClampedArray(count * 4);
  const roughField = new Float32Array(count);
  const heightField = new Float32Array(count);
  const metalField = new Float32Array(count);
  const aoField = new Float32Array(count);

  // Richer warm matte olive-amber translucent polymer (R > G > B, renders near REF [137, 124, 89])
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const mA = hashInt2D(x, y, 4505);
      const mR = hashInt2D(x, y, 4606);
      const mH = hashInt2D(x, y, 4707);

      const f = albedoFbm[i] * 0.76 + mA * 0.24;
      const sc = insertionScuffs[i];

      let r = lerp(74, 90, f);
      let g = lerp(65, 80, f);
      let b = lerp(38, 48, f);
      if (sc > 0.04) {
        r = lerp(r, 104, sc * 0.32);
        g = lerp(g, 94, sc * 0.32);
        b = lerp(b, 60, sc * 0.32);
      }

      const p = i * 4;
      albedoPx[p] = clampByte(r);
      albedoPx[p + 1] = clampByte(g);
      albedoPx[p + 2] = clampByte(b);
      albedoPx[p + 3] = 255;

      // Frosted polymer roughness 0.56..0.70
      roughField[i] = clamp01(lerp(0.56, 0.70, roughFbm[i] * 0.72 + mR * 0.28) - sc * 0.06);
      metalField[i] = 0.0;
      heightField[i] = clamp01(grain[i] * 0.45 + mH * 0.35 - sc * 0.22);
      aoField[i] = clamp01(0.84 + grain[i] * 0.09 + albedoFbm[i] * 0.07);
    }
  }

  return {
    map: createCanvasFromRGBAPixels(size, albedoPx, THREE.SRGBColorSpace, true),
    roughnessMap: createGrayTextureFromFloat(size, roughField, true),
    normalMap: createSobelNormalTexture(size, heightField, 0.85, true),
    metalnessMap: createGrayTextureFromFloat(size, metalField, true),
    aoMap: createGrayTextureFromFloat(size, aoField, true),
    resolution: size,
  };
}

function generateMagFloorplateSet(size = 1024): AugPbrTextureSet {
  const albedoFbm = buildPeriodicFbmField(size, 5101, [
    { freq: 5, amp: 0.5 },
    { freq: 16, amp: 0.5 },
  ]);
  const roughFbm = buildPeriodicFbmField(size, 5202, [
    { freq: 6, amp: 0.5 },
    { freq: 20, amp: 0.5 },
  ]);
  const grain = buildPeriodicCellGrain(size, 96, 5303);
  const scuffs = drawScratchesMask(size, 5404, 75, 1.0, 2.2, 0.03, 0.14);

  const count = size * size;
  const albedoPx = new Uint8ClampedArray(count * 4);
  const roughField = new Float32Array(count);
  const heightField = new Float32Array(count);
  const metalField = new Float32Array(count);
  const aoField = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const x = i % size;
    const y = (i - x) / size;
    const mA = hashInt2D(x, y, 5505);
    const mR = hashInt2D(x, y, 5606);
    const mH = hashInt2D(x, y, 5707);

    const f = albedoFbm[i] * 0.72 + mA * 0.28;
    const sc = scuffs[i];
    const r = lerp(lerp(63, 75, f), 120, sc * 0.58);
    const g = lerp(lerp(59, 71, f), 115, sc * 0.58);
    const b = lerp(lerp(42, 51, f), 90, sc * 0.58);

    const p = i * 4;
    albedoPx[p] = clampByte(r);
    albedoPx[p + 1] = clampByte(g);
    albedoPx[p + 2] = clampByte(b);
    albedoPx[p + 3] = 255;

    roughField[i] = clamp01(lerp(0.68, 0.84, roughFbm[i] * 0.75 + mR * 0.25) - sc * 0.12);
    metalField[i] = 0.02;
    heightField[i] = clamp01(grain[i] * 0.60 + mH * 0.40 - sc * 0.25);
    aoField[i] = clamp01(0.86 + grain[i] * 0.14);
  }

  return {
    map: createCanvasFromRGBAPixels(size, albedoPx, THREE.SRGBColorSpace, true),
    roughnessMap: createGrayTextureFromFloat(size, roughField, true),
    normalMap: createSobelNormalTexture(size, heightField, 1.35, true),
    metalnessMap: createGrayTextureFromFloat(size, metalField, true),
    aoMap: createGrayTextureFromFloat(size, aoField, true),
    resolution: size,
  };
}

function generateRubberButtpadSet(size = 1024): AugPbrTextureSet {
  const albedoFbm = buildPeriodicFbmField(size, 6101, [
    { freq: 6, amp: 0.55 },
    { freq: 20, amp: 0.45 },
  ]);
  const roughFbm = buildPeriodicFbmField(size, 6202, [
    { freq: 8, amp: 0.55 },
    { freq: 24, amp: 0.45 },
  ]);
  const antiSlipDots = buildPeriodicCellGrain(size, 110, 6303);
  const scuffs = drawScratchesMask(size, 6404, 50, 1.2, 2.8, 0.02, 0.10);

  const count = size * size;
  const albedoPx = new Uint8ClampedArray(count * 4);
  const roughField = new Float32Array(count);
  const heightField = new Float32Array(count);
  const metalField = new Float32Array(count);
  const aoField = new Float32Array(count);

  // Dark charcoal matte elastomer calibrated to render near ~[60, 59, 54] without crushing
  for (let i = 0; i < count; i += 1) {
    const x = i % size;
    const y = (i - x) / size;
    const mA = hashInt2D(x, y, 6505);
    const mR = hashInt2D(x, y, 6606);
    const mH = hashInt2D(x, y, 6707);

    const f = albedoFbm[i] * 0.72 + mA * 0.28;
    const sc = scuffs[i];
    const r = lerp(lerp(46, 58, f), 74, sc * 0.45);
    const g = lerp(lerp(46, 57, f), 73, sc * 0.45);
    const b = lerp(lerp(41, 51, f), 66, sc * 0.45);

    const p = i * 4;
    albedoPx[p] = clampByte(r);
    albedoPx[p + 1] = clampByte(g);
    albedoPx[p + 2] = clampByte(b);
    albedoPx[p + 3] = 255;

    roughField[i] = clamp01(lerp(0.84, 0.94, roughFbm[i] * 0.75 + mR * 0.25) - sc * 0.08);
    metalField[i] = 0.0;
    heightField[i] = clamp01(antiSlipDots[i] * 0.65 + mH * 0.35 - sc * 0.20);
    aoField[i] = clamp01(0.84 + antiSlipDots[i] * 0.16);
  }

  return {
    map: createCanvasFromRGBAPixels(size, albedoPx, THREE.SRGBColorSpace, true),
    roughnessMap: createGrayTextureFromFloat(size, roughField, true),
    normalMap: createSobelNormalTexture(size, heightField, 1.55, true),
    metalnessMap: createGrayTextureFromFloat(size, metalField, true),
    aoMap: createGrayTextureFromFloat(size, aoField, true),
    resolution: size,
  };
}

function generateOpticGlassSet(size = 512): AugPbrTextureSet {
  const count = size * size;
  const albedoPx = new Uint8ClampedArray(count * 4);
  const roughField = new Float32Array(count);
  const heightField = new Float32Array(count);
  const metalField = new Float32Array(count);
  const aoField = new Float32Array(count);

  const half = size * 0.5;
  for (let y = 0; y < size; y += 1) {
    const dy = (y - half) / half;
    for (let x = 0; x < size; x += 1) {
      const dx = (x - half) / half;
      const r = Math.min(1, Math.hypot(dx, dy));
      const i = y * size + x;
      const m = hashInt2D(x, y, 7101);
      // Dark coated optical glass with subtle cyan-emerald anti-reflective coating tint
      const coat = Math.sin(r * Math.PI * 0.85) * 0.5 + 0.5;
      const p = i * 4;
      albedoPx[p] = clampByte(lerp(11, 20, coat));
      albedoPx[p + 1] = clampByte(lerp(22, 36, coat));
      albedoPx[p + 2] = clampByte(lerp(30, 46, coat));
      albedoPx[p + 3] = 255;

      roughField[i] = clamp01(0.045 + r * 0.02 + m * 0.01);
      metalField[i] = 0.08;
      heightField[i] = 0.5 + (1 - r * r) * 0.05;
      aoField[i] = clamp01(1.0 - r * 0.14);
    }
  }

  return {
    map: createCanvasFromRGBAPixels(size, albedoPx, THREE.SRGBColorSpace, false),
    roughnessMap: createGrayTextureFromFloat(size, roughField, false),
    normalMap: createSobelNormalTexture(size, heightField, 0.25, false),
    metalnessMap: createGrayTextureFromFloat(size, metalField, false),
    aoMap: createGrayTextureFromFloat(size, aoField, false),
    resolution: size,
  };
}

function generateMagInternalsSet(size = 1024): AugPbrTextureSet {
  const fbm = buildPeriodicFbmField(size, 8101, [
    { freq: 6, amp: 0.5 },
    { freq: 24, amp: 0.5 },
  ]);
  const count = size * size;
  const albedoPx = new Uint8ClampedArray(count * 4);
  const roughField = new Float32Array(count);
  const heightField = new Float32Array(count);
  const metalField = new Float32Array(count);
  const aoField = new Float32Array(count);

  // Shaded brass base (#5c5234) modulated per-component in shader for cartridges, copper tips & dark steel follower/spring
  for (let i = 0; i < count; i += 1) {
    const x = i % size;
    const y = (i - x) / size;
    const m = hashInt2D(x, y, 8202);
    const f = fbm[i] * 0.75 + m * 0.25;
    const p = i * 4;
    albedoPx[p] = clampByte(lerp(76, 98, f));
    albedoPx[p + 1] = clampByte(lerp(68, 88, f));
    albedoPx[p + 2] = clampByte(lerp(42, 56, f));
    albedoPx[p + 3] = 255;

    roughField[i] = clamp01(0.48 + m * 0.14);
    metalField[i] = 0.62;
    heightField[i] = clamp01(0.5 + (m - 0.5) * 0.25);
    aoField[i] = clamp01(0.88 + fbm[i] * 0.12);
  }

  return {
    map: createCanvasFromRGBAPixels(size, albedoPx, THREE.SRGBColorSpace, true),
    roughnessMap: createGrayTextureFromFloat(size, roughField, true),
    normalMap: createSobelNormalTexture(size, heightField, 0.35, true),
    metalnessMap: createGrayTextureFromFloat(size, metalField, true),
    aoMap: createGrayTextureFromFloat(size, aoField, true),
    resolution: size,
  };
}

// ============================================================================
// Procedural Edge-Wear, Cavity AO & Localized Detail Shader Injection
// ============================================================================

type AugSurfaceRole =
  | 'polymer'
  | 'receiver'
  | 'optic'
  | 'barrel'
  | 'magazine'
  | 'floorplate'
  | 'buttpad'
  | 'internals';

interface AugSurfaceHookOptions {
  role: AugSurfaceRole;
  wearColor: string;
  wearStrength: number;
  wearRoughness: number;
  wearMetalness: number;
  cavityStrength: number;
  cavityDarken: number;
}

const GLSL_NOISE_HELPERS = /* glsl */ `
float augHash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.23));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float augNoise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(augHash3(i + vec3(0,0,0)), augHash3(i + vec3(1,0,0)), f.x),
        mix(augHash3(i + vec3(0,1,0)), augHash3(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(augHash3(i + vec3(0,0,1)), augHash3(i + vec3(1,0,1)), f.x),
        mix(augHash3(i + vec3(0,1,1)), augHash3(i + vec3(1,1,1)), f.x), f.y),
    f.z
  );
}
float augFbm3(vec3 p) {
  float v = 0.0;
  float a = 0.55;
  for (int k = 0; k < 3; k++) {
    v += a * augNoise3(p);
    p = p * 2.13 + vec3(3.1, 1.7, 2.3);
    a *= 0.45;
  }
  return v;
}
`;

function attachAugSurfaceDetailShader(
  mat: THREE.MeshStandardMaterial,
  opts: AugSurfaceHookOptions,
): void {
  const wearCol = new THREE.Color().setStyle(opts.wearColor, THREE.SRGBColorSpace);
  const roleCode =
    opts.role === 'polymer'
      ? 1
      : opts.role === 'receiver'
        ? 2
        : opts.role === 'optic'
          ? 3
          : opts.role === 'barrel'
            ? 4
            : opts.role === 'magazine'
              ? 5
              : opts.role === 'buttpad'
                ? 6
                : opts.role === 'internals'
                  ? 7
                  : 0;

  mat.customProgramCacheKey = () => `aug-surface-detail-v2-${opts.role}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAugWearColor = { value: wearCol };
    shader.uniforms.uAugWearStrength = { value: opts.wearStrength };
    shader.uniforms.uAugWearRoughness = { value: opts.wearRoughness };
    shader.uniforms.uAugWearMetalness = { value: opts.wearMetalness };
    shader.uniforms.uAugCavityStrength = { value: opts.cavityStrength };
    shader.uniforms.uAugCavityDarken = { value: opts.cavityDarken };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
#include <common>
attribute vec3 aWearAO;
varying vec3 vAugWearAO;
varying vec3 vAugLocalPos;
varying vec3 vAugLocalNorm;
`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
#include <begin_vertex>
vAugWearAO = aWearAO;
vAugLocalPos = transformed;
vAugLocalNorm = normal;
`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
#include <common>
#define AUG_ROLE ${roleCode}
uniform vec3 uAugWearColor;
uniform float uAugWearStrength;
uniform float uAugWearRoughness;
uniform float uAugWearMetalness;
uniform float uAugCavityStrength;
uniform float uAugCavityDarken;
varying vec3 vAugWearAO;
varying vec3 vAugLocalPos;
varying vec3 vAugLocalNorm;
${GLSL_NOISE_HELPERS}
`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
#include <map_fragment>
float augEdgeRaw = clamp(vAugWearAO.x, 0.0, 1.0);
float augCavRaw = clamp(vAugWearAO.y, 0.0, 1.0);
float augRimRaw = clamp(vAugWearAO.z, 0.0, 1.0);

float augPatinaN = augFbm3(vAugLocalPos * 58.0);
float augFineN = augNoise3(vAugLocalPos * 220.0);
float augWearMask = clamp(
  augEdgeRaw * (0.40 + 0.85 * smoothstep(0.32, 0.74, augPatinaN)) +
  augRimRaw * 0.18 * smoothstep(0.58, 0.88, augFineN),
  0.0, 1.0
);
float augCavityOcc = clamp(1.0 - augCavRaw, 0.0, 1.0);
float augFrontLugTopMask = 0.0;

#if AUG_ROLE == 1
  // Polymer stock & grip: keep crisp 2D canvas scratches clean (no 3D noise ring blotches), subtle edge wear only
  augWearMask = clamp(augWearMask * 0.48, 0.0, 1.0);
#endif

#if AUG_ROLE == 2
  // Receiver: restrict edge wear strictly to sharp flute crests & crisp corners (no broad brushed-chrome sheen)
  float fluteEdgeBoost = smoothstep(0.66, 0.94, augEdgeRaw) * (0.45 + 0.55 * augPatinaN);
  augWearMask = clamp(max(augWearMask * 0.55, fluteEdgeBoost * 0.72), 0.0, 1.0);

  // Subtle, crisp right-side engraved oval marking at X in [+0.070..+0.096], Y in [-0.013..-0.009]
  if (vAugLocalPos.z > 0.014 && vAugLocalNorm.z > 0.40) {
    vec2 sp = vec2((vAugLocalPos.x - 0.084) / 0.0125, (vAugLocalPos.y + 0.0110) / 0.0019);
    float dOval = abs(length(vec2(max(0.0, abs(sp.x) - 0.45), sp.y)) - 0.82);
    float ovalRing = 1.0 - smoothstep(0.025, 0.075, dOval);
    float microText = step(0.64, augNoise3(vec3(sp.x * 16.0, sp.y * 5.0, 1.0))) * (1.0 - step(0.40, abs(sp.y))) * step(abs(sp.x), 0.76);
    float stampMask = max(ovalRing * 0.70, microText * 0.40);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.11, 0.115, 0.12), stampMask * 0.40);
    augWearMask = max(augWearMask, ovalRing * 0.14);
  }
#endif

#if AUG_ROLE == 3
  // Optic housing: crisp linear metallic wear on rear ocular bell rim & central ring, plus controlled lug-top grazing response
  float ocularRim = (exp(-pow((vAugLocalPos.x + 0.1295) / 0.0024, 2.0)) + 0.72 * exp(-pow((vAugLocalPos.x + 0.052) / 0.0035, 2.0))) * step(0.050, vAugLocalPos.y);
  float centerRingRim = (exp(-pow((vAugLocalPos.x - 0.0145) / 0.0022, 2.0)) + exp(-pow((vAugLocalPos.x - 0.0325) / 0.0022, 2.0))) * step(0.052, vAugLocalPos.y);
  float ocularEdgeBand = clamp(ocularRim + centerRingRim * 0.92, 0.0, 1.35);
  float linearScrapeMask = clamp((1.0 - smoothstep(-0.132, -0.040, vAugLocalPos.x)) + exp(-pow((vAugLocalPos.x - 0.0235) / 0.016, 2.0)), 0.0, 1.0) * step(0.050, vAugLocalPos.y);
  float linearScrape = smoothstep(0.71, 0.87, augNoise3(vec3(vAugLocalPos.x * 36.0, vAugLocalPos.y * 280.0, vAugLocalPos.z * 280.0))) * linearScrapeMask;
  float objBezelWear = exp(-pow((vAugLocalPos.x - 0.0705) / 0.0035, 2.0)) * step(0.052, vAugLocalPos.y) * smoothstep(0.38, 0.82, augEdgeRaw);
  float strutEdge = smoothstep(-0.04, 0.11, vAugLocalPos.x) * smoothstep(0.024, 0.036, vAugLocalPos.y) * smoothstep(0.58, 0.90, augEdgeRaw);
  augFrontLugTopMask = smoothstep(0.108, 0.114, vAugLocalPos.x) * (1.0 - smoothstep(0.136, 0.142, vAugLocalPos.x))
    * smoothstep(0.016, 0.020, vAugLocalPos.y) * (1.0 - smoothstep(0.028, 0.033, vAugLocalPos.y))
    * smoothstep(0.45, 0.78, vAugLocalNorm.y);
  // Darken underside joint with receiver
  float baseJointAO = 1.0 - smoothstep(0.009, 0.0165, vAugLocalPos.y);
  augCavityOcc = clamp(augCavityOcc + baseJointAO * 0.52, 0.0, 1.0);
  augWearMask = clamp(max(augWearMask * 0.50, max(ocularEdgeBand * 0.82, max(linearScrape * 0.72, max(objBezelWear * 0.78, strutEdge * 0.68)))), 0.0, 1.0);
  augWearMask *= mix(1.0, 0.32, augFrontLugTopMask);
  diffuseColor.rgb *= mix(1.0, 0.86, augFrontLugTopMask);

  // Turret cap simple straight screwdriver slot matching reference optic_housing.png
  float augSlotGroove = 0.0;
  float augSlotRim = 0.0;
  if (abs(vAugLocalPos.z) > 0.0176 && abs(vAugLocalNorm.z) > 0.70) {
    vec2 td = vec2(vAugLocalPos.x - 0.0235, vAugLocalPos.y - 0.068);
    float tr = length(td);
    if (tr < 0.0062) {
      vec2 rot = vec2(td.x * 0.927 + td.y * 0.375, -td.x * 0.375 + td.y * 0.927);
      float dSlot = max(abs(rot.y) - 0.00038, abs(rot.x) - 0.0032);
      augSlotGroove = 1.0 - smoothstep(0.0, 0.00024, dSlot);
      augSlotRim = (1.0 - smoothstep(0.00012, 0.00050, abs(dSlot))) * (1.0 - augSlotGroove);
      float outerRing = 1.0 - smoothstep(0.0052, 0.0060, tr);
      augWearMask = max(augWearMask, (1.0 - outerRing) * 0.52);
    }
  } else if (vAugLocalPos.y > 0.0856 && vAugLocalNorm.y > 0.70) {
    vec2 td = vec2(vAugLocalPos.x - 0.0235, vAugLocalPos.z);
    float tr = length(td);
    if (tr < 0.0056) {
      vec2 rot = vec2(td.x * 0.927 + td.y * 0.375, -td.x * 0.375 + td.y * 0.927);
      float dSlot = max(abs(rot.y) - 0.00036, abs(rot.x) - 0.0029);
      augSlotGroove = 1.0 - smoothstep(0.0, 0.00022, dSlot);
      augSlotRim = (1.0 - smoothstep(0.00012, 0.00048, abs(dSlot))) * (1.0 - augSlotGroove);
    }
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.015, 0.016, 0.016), augSlotGroove * 0.85);
  augWearMask = max(augWearMask, augSlotRim * 0.50);
#endif

#if AUG_ROLE == 4
  // Barrel & muzzle: soot inside flash hider milled slots (X in [0.361..0.391], R < 0.0091)
  float rRad = length(vAugLocalPos.yz);
  float slotZone = smoothstep(0.360, 0.363, vAugLocalPos.x) * (1.0 - smoothstep(0.388, 0.392, vAugLocalPos.x));
  float innerSlotSoot = slotZone * (1.0 - smoothstep(0.0078, 0.0094, rRad));
  float muzzleTipSoot = smoothstep(0.391, 0.395, vAugLocalPos.x) * (1.0 - smoothstep(0.0046, 0.0072, rRad));
  float sootMask = clamp(innerSlotSoot + muzzleTipSoot, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.010, 0.011, 0.012), sootMask * 0.78);
  augCavityOcc = clamp(augCavityOcc + sootMask * 0.65, 0.0, 1.0);
#endif

#if AUG_ROLE == 7
  // Magazine internals: shaded brass casings (#5c5234), darkened copper projectiles (#4d3c2d), dark steel follower & spring (#2d2e2d)
  float isRoundZone = step(-0.1045, vAugLocalPos.y);
  float alongRound = (vAugLocalPos.x + 0.184) * 0.957 - (vAugLocalPos.y + 0.082) * 0.291;
  float isCopperBullet = isRoundZone * smoothstep(0.0035, 0.0070, alongRound);
  vec3 brassCol = vec3(0.107, 0.084, 0.034);
  vec3 copperCol = vec3(0.074, 0.045, 0.026);
  vec3 steelCol = vec3(0.026, 0.027, 0.026);
  vec3 targetInternal = mix(steelCol, mix(brassCol, copperCol, isCopperBullet), isRoundZone);
  diffuseColor.rgb = targetInternal * (0.85 + 0.30 * augPatinaN);
#endif

#if AUG_ROLE == 5
  // Frosted waffle mag: subtle dirt/grime inside waffle cell corners (cavity) & cleaner rib crests
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.56, augCavityOcc * uAugCavityDarken);
#else
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (1.0 - uAugCavityDarken), augCavityOcc);
#endif

diffuseColor.rgb = mix(diffuseColor.rgb, uAugWearColor, augWearMask * uAugWearStrength);
`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
#include <roughnessmap_fragment>
#if AUG_ROLE == 7
  roughnessFactor = mix(0.58, 0.44, step(-0.1045, vAugLocalPos.y));
#endif
roughnessFactor = mix(roughnessFactor, uAugWearRoughness, augWearMask * uAugWearStrength);
roughnessFactor = clamp(roughnessFactor + augCavityOcc * 0.16 + augFrontLugTopMask * 0.16, 0.04, 0.98);
`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `
#include <metalnessmap_fragment>
#if AUG_ROLE == 7
  metalnessFactor = mix(0.58, 0.72, step(-0.1045, vAugLocalPos.y));
#endif
metalnessFactor = mix(metalnessFactor, uAugWearMetalness, augWearMask * uAugWearStrength);
metalnessFactor = clamp(metalnessFactor * (1.0 - augCavityOcc * 0.25) * mix(1.0, 0.72, augFrontLugTopMask), 0.0, 1.0);
`,
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `
#include <aomap_fragment>
float augGeoAO = mix(1.0, augCavRaw, uAugCavityStrength);
reflectedLight.indirectDiffuse *= augGeoAO;
reflectedLight.indirectSpecular *= mix(1.0, augGeoAO, 0.85);
`,
      );
  };
}

// ============================================================================
// Public Material & Texture Factory
// ============================================================================

export function createAugPbrMaterialLibrary(): AugTextureLibrary {
  const sets: Record<string, AugPbrTextureSet> = {
    polymer_od: generatePolymerODSet(2048),
    receiver_anodized: generateReceiverAnodizedSet(2048),
    optic_worn_metal: generateOpticWornMetalSet(2048),
    barrel_parkerized: generateBarrelParkerizedSet(2048),
    mag_translucent: generateMagTranslucentSet(1024),
    mag_floorplate: generateMagFloorplateSet(1024),
    rubber_buttpad: generateRubberButtpadSet(1024),
    optic_glass: generateOpticGlassSet(512),
    mag_internals: generateMagInternalsSet(1024),
  };

  const textures: THREE.Texture[] = [];
  for (const s of Object.values(sets)) {
    textures.push(s.map, s.roughnessMap, s.normalMap, s.metalnessMap, s.aoMap);
  }

  const mat_polymer_od = new THREE.MeshStandardMaterial({
    name: 'mat_polymer_od',
    color: 0xffffff,
    map: sets.polymer_od.map,
    roughnessMap: sets.polymer_od.roughnessMap,
    normalMap: sets.polymer_od.normalMap,
    normalScale: new THREE.Vector2(0.62, 0.62),
    metalnessMap: sets.polymer_od.metalnessMap,
    aoMap: sets.polymer_od.aoMap,
    aoMapIntensity: 0.70,
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: 0.50,
  });
  attachAugSurfaceDetailShader(mat_polymer_od, {
    role: 'polymer',
    wearColor: '#7a755c',
    wearStrength: 0.54,
    wearRoughness: 0.56,
    wearMetalness: 0.02,
    cavityStrength: 0.55,
    cavityDarken: 0.18,
  });

  const mat_receiver_anodized = new THREE.MeshStandardMaterial({
    name: 'mat_receiver_anodized',
    color: 0xffffff,
    map: sets.receiver_anodized.map,
    roughnessMap: sets.receiver_anodized.roughnessMap,
    normalMap: sets.receiver_anodized.normalMap,
    normalScale: new THREE.Vector2(0.28, 0.28),
    metalnessMap: sets.receiver_anodized.metalnessMap,
    aoMap: sets.receiver_anodized.aoMap,
    aoMapIntensity: 0.76,
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: 0.62,
  });
  attachAugSurfaceDetailShader(mat_receiver_anodized, {
    role: 'receiver',
    wearColor: '#727578',
    wearStrength: 0.40,
    wearRoughness: 0.38,
    wearMetalness: 0.88,
    cavityStrength: 0.82,
    cavityDarken: 0.30,
  });

  const mat_optic_worn_metal = new THREE.MeshStandardMaterial({
    name: 'mat_optic_worn_metal',
    color: 0xffffff,
    map: sets.optic_worn_metal.map,
    roughnessMap: sets.optic_worn_metal.roughnessMap,
    normalMap: sets.optic_worn_metal.normalMap,
    normalScale: new THREE.Vector2(0.22, 0.22),
    metalnessMap: sets.optic_worn_metal.metalnessMap,
    aoMap: sets.optic_worn_metal.aoMap,
    aoMapIntensity: 0.78,
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: 0.60,
  });
  attachAugSurfaceDetailShader(mat_optic_worn_metal, {
    role: 'optic',
    wearColor: '#8d8f8b',
    wearStrength: 0.42,
    wearRoughness: 0.34,
    wearMetalness: 0.88,
    cavityStrength: 0.72,
    cavityDarken: 0.24,
  });

  const mat_barrel_parkerized = new THREE.MeshStandardMaterial({
    name: 'mat_barrel_parkerized',
    color: 0xffffff,
    map: sets.barrel_parkerized.map,
    roughnessMap: sets.barrel_parkerized.roughnessMap,
    normalMap: sets.barrel_parkerized.normalMap,
    normalScale: new THREE.Vector2(0.34, 0.34),
    metalnessMap: sets.barrel_parkerized.metalnessMap,
    aoMap: sets.barrel_parkerized.aoMap,
    aoMapIntensity: 0.80,
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: 0.60,
  });
  attachAugSurfaceDetailShader(mat_barrel_parkerized, {
    role: 'barrel',
    wearColor: '#4c5055',
    wearStrength: 0.42,
    wearRoughness: 0.42,
    wearMetalness: 0.86,
    cavityStrength: 0.82,
    cavityDarken: 0.34,
  });

  const mat_mag_translucent = new THREE.MeshPhysicalMaterial({
    name: 'mat_mag_translucent',
    color: 0xffffff,
    map: sets.mag_translucent.map,
    roughnessMap: sets.mag_translucent.roughnessMap,
    normalMap: sets.mag_translucent.normalMap,
    normalScale: new THREE.Vector2(0.45, 0.45),
    metalnessMap: sets.mag_translucent.metalnessMap,
    aoMap: sets.mag_translucent.aoMap,
    aoMapIntensity: 0.68,
    roughness: 1.0,
    metalness: 0.0,
    clearcoat: 0.10,
    clearcoatRoughness: 0.52,
    ior: 1.50,
    transparent: true,
    opacity: 0.85,
    depthWrite: true,
    envMapIntensity: 0.44,
  });
  attachAugSurfaceDetailShader(mat_mag_translucent, {
    role: 'magazine',
    wearColor: '#7a7052',
    wearStrength: 0.30,
    wearRoughness: 0.54,
    wearMetalness: 0.0,
    cavityStrength: 0.78,
    cavityDarken: 0.34,
  });

  const mat_mag_internals = new THREE.MeshStandardMaterial({
    name: 'mat_mag_internals',
    color: 0xffffff,
    map: sets.mag_internals.map,
    roughnessMap: sets.mag_internals.roughnessMap,
    normalMap: sets.mag_internals.normalMap,
    normalScale: new THREE.Vector2(0.35, 0.35),
    metalnessMap: sets.mag_internals.metalnessMap,
    aoMap: sets.mag_internals.aoMap,
    aoMapIntensity: 0.55,
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: 0.46,
  });
  attachAugSurfaceDetailShader(mat_mag_internals, {
    role: 'internals',
    wearColor: '#665c3c',
    wearStrength: 0.14,
    wearRoughness: 0.52,
    wearMetalness: 0.60,
    cavityStrength: 0.40,
    cavityDarken: 0.16,
  });

  const mat_mag_floorplate = new THREE.MeshStandardMaterial({
    name: 'mat_mag_floorplate',
    color: 0xffffff,
    map: sets.mag_floorplate.map,
    roughnessMap: sets.mag_floorplate.roughnessMap,
    normalMap: sets.mag_floorplate.normalMap,
    normalScale: new THREE.Vector2(0.62, 0.62),
    metalnessMap: sets.mag_floorplate.metalnessMap,
    aoMap: sets.mag_floorplate.aoMap,
    aoMapIntensity: 0.70,
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: 0.50,
  });
  attachAugSurfaceDetailShader(mat_mag_floorplate, {
    role: 'floorplate',
    wearColor: '#7a755c',
    wearStrength: 0.52,
    wearRoughness: 0.56,
    wearMetalness: 0.02,
    cavityStrength: 0.55,
    cavityDarken: 0.18,
  });

  const mat_rubber_buttpad = new THREE.MeshStandardMaterial({
    name: 'mat_rubber_buttpad',
    color: 0xffffff,
    map: sets.rubber_buttpad.map,
    roughnessMap: sets.rubber_buttpad.roughnessMap,
    normalMap: sets.rubber_buttpad.normalMap,
    normalScale: new THREE.Vector2(0.72, 0.72),
    metalnessMap: sets.rubber_buttpad.metalnessMap,
    aoMap: sets.rubber_buttpad.aoMap,
    aoMapIntensity: 0.68,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.48,
  });
  attachAugSurfaceDetailShader(mat_rubber_buttpad, {
    role: 'buttpad',
    wearColor: '#4a4943',
    wearStrength: 0.40,
    wearRoughness: 0.80,
    wearMetalness: 0.0,
    cavityStrength: 0.55,
    cavityDarken: 0.16,
  });

  const mat_optic_glass = new THREE.MeshPhysicalMaterial({
    name: 'mat_optic_glass',
    color: 0xffffff,
    map: sets.optic_glass.map,
    roughnessMap: sets.optic_glass.roughnessMap,
    normalMap: sets.optic_glass.normalMap,
    normalScale: new THREE.Vector2(0.35, 0.35),
    metalnessMap: sets.optic_glass.metalnessMap,
    aoMap: sets.optic_glass.aoMap,
    aoMapIntensity: 0.55,
    roughness: 1.0,
    metalness: 1.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.055,
    ior: 1.52,
    specularIntensity: 0.95,
    specularColor: new THREE.Color().setStyle('#5ec8b4', THREE.SRGBColorSpace),
    iridescence: 0.42,
    iridescenceIOR: 1.38,
    envMapIntensity: 1.35,
  });

  const mat_ejection_cavity = new THREE.MeshStandardMaterial({
    name: 'mat_ejection_cavity',
    color: new THREE.Color().setStyle('#171819', THREE.SRGBColorSpace),
    roughness: 0.88,
    metalness: 0.15,
    envMapIntensity: 0.25,
  });

  return {
    materials: {
      mat_polymer_od,
      mat_receiver_anodized,
      mat_optic_worn_metal,
      mat_barrel_parkerized,
      mat_mag_translucent,
      mat_mag_internals,
      mat_mag_floorplate,
      mat_rubber_buttpad,
      mat_optic_glass,
      mat_ejection_cavity,
    },
    textures,
    sets,
    allLoaded: true,
  };
}
