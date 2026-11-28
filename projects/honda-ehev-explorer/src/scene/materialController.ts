import * as THREE from 'three';
import { EnginePartNode } from './createHondaEngineBayModel';

export type VisualPartMode =
  | 'realistic'
  | 'hovered'
  | 'inspected-color'
  | 'inspected-realistic'
  | 'ghost';

interface MaterialSlot {
  mesh: THREE.Mesh;
  slotIndex: number;
  original: THREE.Material;
  origTransparent: boolean;
  origOpacity: number;
  origDepthWrite: boolean;
  hoverMat: THREE.Material;
  inspectedColorMat: THREE.Material;
  ghostMat: THREE.MeshStandardMaterial;
  fadeClone: THREE.Material | null;
}

export class MaterialController {
  private readonly slotsByPart = new Map<string, MaterialSlot[]>();
  private readonly sharedGhostMat: THREE.MeshStandardMaterial;

  constructor(parts: Map<string, EnginePartNode>) {
    this.sharedGhostMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.75,
      metalness: 0.08,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
    });

    for (const [partId, node] of parts.entries()) {
      const partColor = new THREE.Color(node.metadata.cor);
      const slots: MaterialSlot[] = [];

      node.group.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];

        mats.forEach((origMat, slotIndex) => {
          // Clone original per mesh slot so base visibility/fade never leaks across shared materials
          const original = origMat.clone();
          const stdOrig = original as THREE.MeshStandardMaterial;

          // Hover material: replaces/blends albedo clearly toward partColor + emissive glow
          // so dark black parts (engine cover, airbox, battery, fuse box) visibly light up in partColor
          const hoverMat = original.clone() as THREE.MeshStandardMaterial;
          if ('color' in hoverMat && hoverMat.color) {
            hoverMat.color.copy(stdOrig.color ?? new THREE.Color(0xffffff)).lerp(partColor, 0.72);
          }
          if ('map' in hoverMat && hoverMat.map) {
            // Drop dark albedo texture on hover so the unique identifier color reads clearly
            hoverMat.map = null;
          }
          if ('emissive' in hoverMat && hoverMat.emissive) {
            hoverMat.emissive.copy(partColor);
            hoverMat.emissiveIntensity = 0.28;
          }
          hoverMat.needsUpdate = true;

          // Inspected solid identifier color material: replaces dark albedo & map with partColor
          // while preserving bumpMap/roughness/metalness for crisp 360° surface detail
          const inspectedColorMat = new THREE.MeshStandardMaterial({
            color: partColor.clone(),
            roughness:
              typeof stdOrig.roughness === 'number'
                ? THREE.MathUtils.clamp(stdOrig.roughness * 0.9, 0.25, 0.65)
                : 0.45,
            metalness:
              typeof stdOrig.metalness === 'number'
                ? Math.min(stdOrig.metalness, 0.35)
                : 0.1,
            bumpMap: stdOrig.bumpMap ?? null,
            bumpScale: stdOrig.bumpScale ?? 0.003,
            emissive: partColor.clone(),
            emissiveIntensity: 0.11,
            transparent: original.transparent && original.opacity < 0.95,
            opacity: original.transparent && original.opacity < 0.95 ? Math.max(0.75, original.opacity) : 1.0,
            depthWrite: true,
          });

          slots.push({
            mesh: obj,
            slotIndex,
            original,
            origTransparent: original.transparent,
            origOpacity: original.opacity,
            origDepthWrite: original.depthWrite,
            hoverMat,
            inspectedColorMat,
            ghostMat: this.sharedGhostMat,
            fadeClone: null,
          });
        });
      });

      this.slotsByPart.set(partId, slots);
    }
  }

  public applyMode(partId: string, mode: VisualPartMode): void {
    const slots = this.slotsByPart.get(partId);
    if (!slots) return;

    for (const slot of slots) {
      let targetMat: THREE.Material;
      switch (mode) {
        case 'hovered':
          targetMat = slot.hoverMat;
          break;
        case 'inspected-color':
          targetMat = slot.inspectedColorMat;
          break;
        case 'ghost':
          targetMat = slot.ghostMat;
          break;
        case 'inspected-realistic':
        case 'realistic':
        default:
          // Restore exact original transparency/depthWrite invariants
          slot.original.transparent = slot.origTransparent;
          slot.original.opacity = slot.origOpacity;
          slot.original.depthWrite = slot.origDepthWrite;
          targetMat = slot.original;
          break;
      }

      this.assignSlotMaterial(slot, targetMat);
    }
  }

  /**
   * Smoothly fades a removable part (base-cofre) while restoring exact original
   * transparent = false and depthWrite = true when alpha returns to 1.0.
   */
  public applyBaseFade(partId: string, node: EnginePartNode, alpha: number, mode: VisualPartMode): void {
    if (alpha <= 0.01) {
      node.group.visible = false;
      return;
    }
    node.group.visible = true;

    if (alpha >= 0.995) {
      this.applyMode(partId, mode);
      return;
    }

    const slots = this.slotsByPart.get(partId);
    if (!slots) return;

    for (const slot of slots) {
      const baseRef =
        mode === 'hovered'
          ? slot.hoverMat
          : mode === 'inspected-color'
            ? slot.inspectedColorMat
            : mode === 'ghost'
              ? slot.ghostMat
              : slot.original;

      if (!slot.fadeClone) {
        slot.fadeClone = baseRef.clone();
      } else {
        const dst = slot.fadeClone as THREE.MeshStandardMaterial;
        const src = baseRef as THREE.MeshStandardMaterial;
        if (dst.color && src.color) dst.color.copy(src.color);
        if (dst.emissive && src.emissive) {
          dst.emissive.copy(src.emissive);
          dst.emissiveIntensity = src.emissiveIntensity;
        }
      }

      const targetOpacity =
        mode === 'ghost' ? Math.min(0.14, alpha * 0.14) : slot.origOpacity * alpha;
      slot.fadeClone.transparent = true;
      slot.fadeClone.depthWrite = false;
      slot.fadeClone.opacity = targetOpacity;
      slot.fadeClone.needsUpdate = true;

      this.assignSlotMaterial(slot, slot.fadeClone);
    }
  }

  private assignSlotMaterial(slot: MaterialSlot, mat: THREE.Material): void {
    const current = slot.mesh.material;
    if (Array.isArray(current)) {
      if (current[slot.slotIndex] !== mat) {
        current[slot.slotIndex] = mat;
      }
    } else if (current !== mat) {
      slot.mesh.material = mat;
    }
  }
}
