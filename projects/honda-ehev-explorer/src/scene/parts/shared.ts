import * as THREE from 'three';

export interface SharedMaterials {
  plasticGrainBump: THREE.CanvasTexture;
  brushedMetal: THREE.CanvasTexture;
  satinBlackPlastic: THREE.MeshStandardMaterial;
  matteDarkPlastic: THREE.MeshStandardMaterial;
  castAluminum: THREE.MeshStandardMaterial;
  polishedAluminum: THREE.MeshStandardMaterial;
  steelHardware: THREE.MeshStandardMaterial;
  pearlWhiteBody: THREE.MeshPhysicalMaterial;
  hvOrange: THREE.MeshStandardMaterial;
  rubberHose: THREE.MeshStandardMaterial;
  translucentHdpe: THREE.MeshPhysicalMaterial;
}

export function createSharedMaterials(
  plasticGrainBump: THREE.CanvasTexture,
  brushedMetal: THREE.CanvasTexture
): SharedMaterials {
  return {
    plasticGrainBump,
    brushedMetal,
    satinBlackPlastic: new THREE.MeshStandardMaterial({
      color: 0x1d2026,
      roughness: 0.56,
      metalness: 0.04,
      bumpMap: plasticGrainBump,
      bumpScale: 0.003,
    }),
    matteDarkPlastic: new THREE.MeshStandardMaterial({
      color: 0x25282f,
      roughness: 0.68,
      metalness: 0.03,
      bumpMap: plasticGrainBump,
      bumpScale: 0.004,
    }),
    castAluminum: new THREE.MeshStandardMaterial({
      color: 0xaab1ba,
      roughness: 0.42,
      metalness: 0.84,
      bumpMap: brushedMetal,
      bumpScale: 0.002,
    }),
    polishedAluminum: new THREE.MeshStandardMaterial({
      color: 0xcfd5dd,
      roughness: 0.25,
      metalness: 0.92,
      bumpMap: brushedMetal,
      bumpScale: 0.0015,
    }),
    steelHardware: new THREE.MeshStandardMaterial({
      color: 0x8b929c,
      roughness: 0.34,
      metalness: 0.88,
    }),
    pearlWhiteBody: new THREE.MeshPhysicalMaterial({
      color: 0xd8d6cd,
      roughness: 0.30,
      metalness: 0.12,
      clearcoat: 0.50,
      clearcoatRoughness: 0.20,
    }),
    hvOrange: new THREE.MeshStandardMaterial({
      color: 0xe65817,
      roughness: 0.44,
      metalness: 0.03,
      bumpMap: plasticGrainBump,
      bumpScale: 0.0025,
    }),
    rubberHose: new THREE.MeshStandardMaterial({
      color: 0x181a1e,
      roughness: 0.78,
      metalness: 0.02,
    }),
    translucentHdpe: new THREE.MeshPhysicalMaterial({
      color: 0xe7e8e2,
      roughness: 0.48,
      metalness: 0.0,
      transmission: 0.12,
      transparent: true,
      opacity: 0.92,
      thickness: 0.06,
      ior: 1.46,
    }),
  };
}

export function createRoundedBoxGeometry(
  width: number,
  height: number,
  depth: number,
  radius: number,
  bevelSegments = 3
): THREE.ExtrudeGeometry {
  const r = Math.min(radius, width * 0.45, depth * 0.45);
  const hw = width * 0.5 - r;
  const hd = depth * 0.5 - r;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, -depth * 0.5);
  shape.lineTo(hw, -depth * 0.5);
  shape.absarc(hw, -hd, r, -Math.PI / 2, 0, false);
  shape.lineTo(width * 0.5, hd);
  shape.absarc(hw, hd, r, 0, Math.PI / 2, false);
  shape.lineTo(-hw, depth * 0.5);
  shape.absarc(-hw, hd, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-width * 0.5, -hd);
  shape.absarc(-hw, -hd, r, Math.PI, (3 * Math.PI) / 2, false);

  const bevel = Math.min(0.015, height * 0.18);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.004, height - bevel * 2),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments,
    curveSegments: 8,
  });
  geo.rotateX(-Math.PI / 2);
  geo.center();
  return geo;
}

export function tagPartHierarchy(group: THREE.Group, partId: string): THREE.Group {
  group.name = partId;
  group.userData.partId = partId;
  group.traverse((child) => {
    child.userData.partId = partId;
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      if (!child.name) {
        child.name = `${partId}_mesh`;
      }
    }
  });
  return group;
}
