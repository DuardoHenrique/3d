import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

export type ExportGLBOptions = {
  fileName?: string;
  download?: boolean;
  maxTextureSize?: number;
};

type TextureSlot = 'map' | 'roughnessMap' | 'normalMap' | 'metalnessMap' | 'aoMap' | 'emissiveMap';
const TEXTURE_SLOTS: TextureSlot[] = [
  'map',
  'roughnessMap',
  'normalMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
];

function createDownscaledCanvasTexture(
  src: THREE.Texture,
  maxSize: number,
): THREE.Texture | null {
  const img = src.image as HTMLCanvasElement | HTMLImageElement | ImageBitmap | undefined;
  if (!img || typeof (img as any).width !== 'number' || typeof (img as any).height !== 'number') {
    return null;
  }
  const w = (img as any).width as number;
  const h = (img as any).height as number;
  if (w <= maxSize && h <= maxSize) {
    return null;
  }
  const scale = Math.min(maxSize / w, maxSize / h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = nw;
  canvas.height = nh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img as CanvasImageSource, 0, 0, nw, nh);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = src.colorSpace;
  tex.wrapS = src.wrapS;
  tex.wrapT = src.wrapT;
  tex.repeat.copy(src.repeat);
  tex.offset.copy(src.offset);
  tex.flipY = src.flipY;
  tex.name = src.name;
  tex.needsUpdate = true;
  return tex;
}

export async function exportAugA1ToGLB(
  target: THREE.Object3D,
  options: ExportGLBOptions = {},
): Promise<number> {
  const fileName = options.fileName ?? 'steyr-aug-a1.glb';
  const shouldDownload = options.download ?? true;
  const maxTexSize = options.maxTextureSize ?? 512;
  const exporter = new GLTFExporter();

  // Temporarily swap oversized textures (> maxTexSize) with downscaled CanvasTextures
  // so GLTFExporter's metalRoughness merge & PNG encoding stay fast and memory-safe.
  const downscaledCache = new Map<THREE.Texture, THREE.Texture>();
  const swappedMats: Array<{
    mat: THREE.MeshStandardMaterial;
    slot: TextureSlot;
    orig: THREE.Texture;
  }> = [];

  const materialsSeen = new Set<THREE.Material>();
  target.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m || materialsSeen.has(m)) continue;
      materialsSeen.add(m);
      if (!(m instanceof THREE.MeshStandardMaterial)) continue;
      for (const slot of TEXTURE_SLOTS) {
        const tex = m[slot];
        if (!tex) continue;
        let small = downscaledCache.get(tex);
        if (!small) {
          const created = createDownscaledCanvasTexture(tex, maxTexSize);
          if (created) {
            small = created;
            downscaledCache.set(tex, small);
          }
        }
        if (small) {
          swappedMats.push({ mat: m, slot, orig: tex });
          m[slot] = small;
        }
      }
    }
  });

  try {
    return await new Promise<number>((resolve, reject) => {
      exporter.parse(
        target,
        (gltf) => {
          if (gltf instanceof ArrayBuffer) {
            if (shouldDownload) {
              const blob = new Blob([gltf], { type: 'model/gltf-binary' });
              const link = document.createElement('a');
              link.href = URL.createObjectURL(blob);
              link.download = fileName;
              link.click();
              setTimeout(() => URL.revokeObjectURL(link.href), 1500);
            }
            console.log(`[GLTFExporter] Exported ${fileName} (${gltf.byteLength} bytes)`);
            resolve(gltf.byteLength);
          } else {
            const output = JSON.stringify(gltf, null, 2);
            const bytes = new TextEncoder().encode(output).byteLength;
            if (shouldDownload) {
              const blob = new Blob([output], { type: 'application/json' });
              const link = document.createElement('a');
              link.href = URL.createObjectURL(blob);
              link.download = fileName.replace(/\.glb$/i, '.gltf');
              link.click();
              setTimeout(() => URL.revokeObjectURL(link.href), 1500);
            }
            resolve(bytes);
          }
        },
        (error) => {
          console.error('[GLTFExporter] Export error:', error);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
        { binary: true, maxTextureSize: maxTexSize },
      );
    });
  } finally {
    for (const { mat, slot, orig } of swappedMats) {
      mat[slot] = orig;
    }
    for (const tex of downscaledCache.values()) {
      tex.dispose();
    }
  }
}
