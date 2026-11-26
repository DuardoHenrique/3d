import * as THREE from 'three';
import {
  applyTriplanarPhysicalUVs,
  buildChamferedBox,
  buildLatheProfile,
  buildSharpChamferedBox,
  buildTaperedTube,
  buildTransverseXLoft,
  buildVariableLoft,
  computeGeometryWearAndCavity,
  countDistinctZ,
  mergeGeometries,
  mergeGeometriesGrouped,
  TransverseXStation,
  Vec2,
  Vec3,
} from './geometryHelpers';
import { AugTextureLibrary, createAugPbrMaterialLibrary } from './textures';

export type RenderMode = 'clay' | 'shaded';

export type AugA1ModelOptions = {
  mode?: RenderMode;
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
};

export type ColliderBounds = {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  size: Vec3;
};

export type SculptRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, ColliderBounds>;
  destructionGroups: Record<string, THREE.Object3D[]>;
  pivots: Record<string, THREE.Group>;
};

export type AugA1ModelResult = {
  root: THREE.Group;
  runtime: SculptRuntime;
  textureLibrary: AugTextureLibrary;
};

type ComponentDef = {
  id: string;
  level: 'macro' | 'meso' | 'micro';
  parent: string;
  parentSocket: string;
  socketPos: Vec3;
  destructionGroup: string;
  materialId: string;
  explodeWithParent?: boolean;
  isPivot?: boolean;
  pivotPos?: Vec3;
  pivotName?: string;
};

function srgbColor(hex: string): THREE.Color {
  return new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const span = edge1 - edge0;
  if (Math.abs(span) < 1e-8) return x >= edge0 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / span));
  return t * t * (3 - 2 * t);
}

function gauss2D(x: number, y: number, cx: number, cy: number, sx: number, sy: number): number {
  const dx = (x - cx) / sx;
  const dy = (y - cy) / sy;
  return Math.exp(-0.5 * (dx * dx + dy * dy));
}

function sampleCatmull2D(pts: Vec2[], steps: number, closed = false): Vec2[] {
  const curve = new THREE.CatmullRomCurve3(
    pts.map(([x, y]) => new THREE.Vector3(x, y, 0)),
    closed,
    'centripetal',
    0.5,
  );
  const sampled = curve.getSpacedPoints(steps).map((p) => [p.x, p.y] as Vec2);
  if (closed && sampled.length > 1) {
    sampled.pop();
  }
  return sampled;
}

function buttpadExposedSeamX(y: number): number {
  // ~10.8-11.4 mm exposed black rubber profile ahead of buttpadRearCurve across full height
  const anchors: [number, number][] = [
    [-0.1430, -0.3584],
    [-0.1380, -0.3636],
    [-0.1300, -0.3652],
    [-0.1140, -0.3672],
    [-0.0820, -0.3702],
    [-0.0550, -0.3735],
    [-0.0315, -0.3784],
    [-0.0175, -0.3824],
    [-0.0080, -0.3840],
    [0.0012, -0.3822],
    [0.0074, -0.3778],
    [0.0120, -0.3724],
    [0.0160, -0.3662],
    [0.0195, -0.3612],
    [0.0215, -0.3588],
  ];
  if (y <= anchors[0][0]) return anchors[0][1];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const [y0, x0] = anchors[i];
    const [y1, x1] = anchors[i + 1];
    if (y <= y1) {
      const t = (y - y0) / (y1 - y0 || 1);
      return THREE.MathUtils.lerp(x0, x1, t);
    }
  }
  return anchors[anchors.length - 1][1];
}

const CYLINDRICAL_X_ZERO_PARTS = new Set(['barrel_gas_muzzle_assembly', 'tulip_flash_hider']);
const CYLINDRICAL_X_OPTIC_PARTS = new Set(['optic_main_tube', 'optic_ocular_bell']);
const FINE_GRAIN_PARTS = new Set([
  'rubber_buttpad',
  'progressive_trigger',
  'crossbolt_safety',
  'magazine_release_paddle',
]);
const OPTIC_TRIPLANAR_PARTS = new Set([
  'integrated_optic_carry_handle',
  'optic_rear_strut',
  'optic_front_strut',
  'optic_turret_housing',
  'backup_iron_sights',
]);

function applyOpticLensCircularUVs(geometry: THREE.BufferGeometry): void {
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count === 0) return;

  const uv = new Float32Array(pos.count * 2);
  const uv1 = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const maxR = x > 0 ? 0.0108 : 0.0126;
    const u = THREE.MathUtils.clamp(0.5 + z / (2 * maxR), 0, 1);
    const v = THREE.MathUtils.clamp(0.5 + (y - 0.068) / (2 * maxR), 0, 1);
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
    uv1[i * 2] = u;
    uv1[i * 2 + 1] = v;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
}

function preparePbrGeometry(id: string, geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (id === 'optic_lenses') {
    applyOpticLensCircularUVs(geometry);
    computeGeometryWearAndCavity(geometry, { convexGain: 0.25, concaveGain: 0.4, smoothPasses: 1 });
    return geometry;
  }

  const isMetal =
    id === 'upper_receiver_metal' ||
    id === 'barrel_gas_muzzle_assembly' ||
    id === 'tulip_flash_hider' ||
    id === 'flash_hider_slots' ||
    id === 'gas_regulator_block' ||
    id === 'barrel_clamp_lug' ||
    id === 'barrel_lock_pin_right' ||
    id === 'foregrip_hinge_bracket' ||
    id === 'receiver_takedown_latch' ||
    id === 'left_stock_vertical_latch' ||
    id === 'rear_sling_swivel_left' ||
    id === 'stock_cross_pins' ||
    OPTIC_TRIPLANAR_PARTS.has(id) ||
    CYLINDRICAL_X_OPTIC_PARTS.has(id);

  computeGeometryWearAndCavity(geometry, {
    convexGain: isMetal ? 1.45 : 1.15,
    concaveGain: isMetal ? 1.45 : 1.25,
    smoothPasses: 2,
  });

  if (CYLINDRICAL_X_ZERO_PARTS.has(id)) {
    return applyTriplanarPhysicalUVs(geometry, {
      mode: 'cylindrical',
      cylAxis: 'x',
      cylCenter: [0, 0, 0],
      tileMeters: id === 'tulip_flash_hider' ? 0.065 : 0.075,
    });
  }
  if (CYLINDRICAL_X_OPTIC_PARTS.has(id)) {
    return applyTriplanarPhysicalUVs(geometry, {
      mode: 'cylindrical',
      cylAxis: 'x',
      cylCenter: [0, 0.068, 0],
      tileMeters: 0.085,
    });
  }
  if (id === 'folding_vertical_foregrip') {
    return applyTriplanarPhysicalUVs(geometry, {
      mode: 'cylindrical',
      cylAxis: 'y',
      cylCenter: [0.1415, 0, 0],
      tileMeters: 0.085,
    });
  }

  let tileMeters = 0.085;
  if (FINE_GRAIN_PARTS.has(id)) tileMeters = 0.065;
  else if (id === 'mag_internal_stack') tileMeters = 0.055;
  else if (OPTIC_TRIPLANAR_PARTS.has(id)) tileMeters = 0.080;

  return applyTriplanarPhysicalUVs(geometry, {
    mode: 'triplanar',
    tileMeters,
  });
}

function createClayMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    name: 'mat_clay_blockout',
    color: srgbColor('#b8b8b4'),
    roughness: 0.78,
    metalness: 0.0,
    envMapIntensity: 0.45,
  });
}

function computeBoxCollider(obj: THREE.Object3D): ColliderBounds {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], size: [0, 0, 0] };
  }
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
    center: [c.x, c.y, c.z],
    size: [s.x, s.y, s.z],
  };
}

/**
 * Builds the procedural Steyr AUG A1 3D model (Pass 4 Material-Pass: exact blueprint dimensions,
 * watertight variable-thickness lofts, revolved profiles, 3D waffle ribs + internal mechanism,
 * full L/R Steyr AUG A1 asymmetries, and 2048px/1024px multi-channel procedural PBR materials).
 */
export function createAugA1Model(options: AugA1ModelOptions = {}): AugA1ModelResult {
  const mode: RenderMode = options.mode ?? 'shaded';
  const castShadow = options.castShadow ?? true;
  const receiveShadow = options.receiveShadow ?? true;

  const root = new THREE.Group();
  root.name = 'Steyr AUG A1';
  root.scale.set(1, 1, 1);

  const textureLibrary = createAugPbrMaterialLibrary();
  const shaded: Record<string, THREE.Material> = { ...textureLibrary.materials };
  const clay = createClayMaterial();

  const nodes: Record<string, THREE.Object3D> = { root };
  const nodeWorldOrigins: Record<string, Vec3> = { root: [0, 0, 0] };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, ColliderBounds> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};
  const pivots: Record<string, THREE.Group> = {};

  function registerComponent(
    def: ComponentDef,
    geometry: THREE.BufferGeometry,
    customShadedMat?: THREE.Material | THREE.Material[],
  ): THREE.Mesh {
    const parentNode = nodes[def.parent] ?? root;
    const parentOrigin = nodeWorldOrigins[def.parent] ?? [0, 0, 0];

    const socket = new THREE.Object3D();
    socket.name = def.parentSocket;
    socket.position.set(
      def.socketPos[0] - parentOrigin[0],
      def.socketPos[1] - parentOrigin[1],
      def.socketPos[2] - parentOrigin[2],
    );
    parentNode.add(socket);
    sockets[def.parentSocket] = socket;

    const worldPivot: Vec3 = def.pivotPos ?? parentOrigin;
    const pivotGroup = new THREE.Group();
    pivotGroup.name = def.pivotName ?? `${def.id}__pivot`;
    pivotGroup.scale.set(1, 1, 1);
    pivotGroup.position.set(
      worldPivot[0] - parentOrigin[0],
      worldPivot[1] - parentOrigin[1],
      worldPivot[2] - parentOrigin[2],
    );
    parentNode.add(pivotGroup);
    nodes[def.id] = pivotGroup;
    nodeWorldOrigins[def.id] = worldPivot;
    if (def.isPivot) {
      pivots[def.id] = pivotGroup;
      if (def.pivotName) {
        pivots[def.pivotName] = pivotGroup;
      }
    }

    const pbrGeometry = preparePbrGeometry(def.id, geometry);

    const shadedMat = customShadedMat ?? shaded[def.materialId] ?? clay;
    const clayMat = Array.isArray(shadedMat) ? shadedMat.map(() => clay) : clay;
    const mesh = new THREE.Mesh(pbrGeometry, mode === 'clay' ? clayMat : shadedMat);
    mesh.name = def.id;
    mesh.position.set(-worldPivot[0], -worldPivot[1], -worldPivot[2]);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.userData.materialId = def.materialId;
    mesh.userData.shadedMaterial = shadedMat;
    mesh.userData.clayMaterial = clayMat;
    mesh.userData.explodeWithParent = Boolean(def.explodeWithParent);
    mesh.userData.sculptComponent = {
      id: def.id,
      name: def.id,
      level: def.level,
      parent: def.parent,
      material: def.materialId,
      destructionGroup: def.destructionGroup,
      distinctZ: countDistinctZ(pbrGeometry),
    };
    pivotGroup.add(mesh);
    meshes[def.id] = mesh;

    const grp = (destructionGroups[def.destructionGroup] ??= []);
    grp.push(pivotGroup);

    return mesh;
  }

  // =========================================================================
  // 1. POLYMER STOCK CHASSIS (continuous-sculpt variable-thickness loft)
  // =========================================================================
  const gripAndGuardArc = sampleCatmull2D(
    [
      [0.086, -0.0358],
      [0.075, -0.0418],
      [0.062, -0.0522],
      [0.048, -0.0680],
      [0.034, -0.0855],
      [0.020, -0.1035],
      [0.006, -0.1210],
      [-0.005, -0.1335],
      [-0.015, -0.1392],
      [-0.026, -0.1418],
      [-0.042, -0.1424],
      [-0.068, -0.1424],
      [-0.086, -0.1415],
      [-0.092, -0.1378],
      [-0.093, -0.1255],
      [-0.090, -0.1110],
      [-0.084, -0.0920],
      [-0.076, -0.0755],
      [-0.066, -0.0610],
      [-0.066, -0.0500],
      [-0.076, -0.0420],
      [-0.092, -0.0395],
    ],
    76,
    false,
  );

  const chassisRearInnerArc = sampleCatmull2D(
    [
      [-0.3650, -0.1424],
      [-0.3710, -0.1370],
      [-0.3745, -0.1140],
      [-0.3775, -0.0820],
      [-0.3810, -0.0550],
      [-0.3855, -0.0315],
      [-0.3895, -0.0175],
      [-0.3905, -0.0080],
      [-0.3885, 0.0012],
      [-0.3840, 0.0074],
      [-0.3785, 0.0125],
      [-0.3720, 0.0170],
      [-0.3690, 0.0205],
    ],
    28,
    false,
  );

  const chassisOutline: Vec2[] = [
    ...chassisRearInnerArc,
    [-0.320, 0.0206],
    [-0.240, 0.0206],
    [-0.160, 0.0206],
    [-0.080, 0.0206],
    [-0.045, 0.0206],
    [-0.035, 0.0210],
    [-0.028, 0.0222],
    [-0.023, 0.0232],
    [-0.019, 0.0226],
    [-0.0165, 0.0198],
    [-0.015, 0.0145],
    [-0.015, -0.0155],
    [0.040, -0.0155],
    [0.114, -0.0160],
    [0.121, -0.0195],
    [0.1225, -0.0275],
    [0.1205, -0.0338],
    [0.112, -0.0345],
    [0.095, -0.0345],
    ...gripAndGuardArc,
    [-0.112, -0.0430],
    [-0.126, -0.0465],
    [-0.138, -0.0520],
    [-0.150, -0.0610],
    [-0.165, -0.0655],
    [-0.185, -0.0685],
    [-0.205, -0.0720],
    [-0.221, -0.0748],
    [-0.235, -0.0798],
    [-0.246, -0.0865],
    [-0.254, -0.0865],
    [-0.266, -0.0895],
    [-0.280, -0.0970],
    [-0.294, -0.1070],
    [-0.305, -0.1170],
    [-0.310, -0.1320],
    [-0.314, -0.1415],
    [-0.322, -0.1424],
  ];

  const triggerGuardHole: Vec2[] = sampleCatmull2D(
    [
      [-0.047, -0.1230],
      [-0.047, -0.1120],
      [-0.042, -0.1030],
      [-0.037, -0.0930],
      [-0.032, -0.0820],
      [-0.027, -0.0710],
      [-0.023, -0.0580],
      [-0.021, -0.0450],
      [-0.016, -0.0385],
      [0.008, -0.0377],
      [0.028, -0.0377],
      [0.035, -0.0405],
      [0.040, -0.0490],
      [0.040, -0.0590],
      [0.034, -0.0665],
      [0.028, -0.0745],
      [0.021, -0.0835],
      [0.013, -0.0940],
      [0.004, -0.1055],
      [-0.005, -0.1175],
      [-0.012, -0.1240],
      [-0.019, -0.1280],
      [-0.028, -0.1295],
      [-0.039, -0.1290],
      [-0.044, -0.1265],
    ],
    88,
    true,
  );

  const rearStockProfileHw = (x: number, y: number): number => {
    let hw = 0.0210;
    // Cheek rest swell on rear upper buttstock (clear of ejection port X=[-0.21..-0.13])
    hw += 0.0022 * gauss2D(x, y, -0.255, -0.014, 0.082, 0.024);
    // Smooth lower toe taper on rear buttstock
    const rearToeMask = (1 - smoothstep(-0.24, -0.20, x)) * smoothstep(-0.05, -0.14, y);
    hw -= 0.0022 * rearToeMask;
    return hw;
  };

  const chassisHalfWidthBase = (x: number, y: number): number => {
    let hw = rearStockProfileHw(x, y);

    // Tuck behind curved rubber buttpad seam (~11 mm ahead of rear face) so only thin black cap shows
    const seamX = buttpadExposedSeamX(y);
    hw -= 0.0032 * smoothstep(seamX + 0.0020, seamX - 0.0045, x);

    // Magwell wall thickness (confined below Y=0 so top stock spine remains smooth & un-pinched)
    const magwellYMask = 1 - smoothstep(-0.045, 0.002, y);
    const inMagwell = smoothstep(-0.23, -0.20, x) * (1 - smoothstep(-0.14, -0.11, x)) * magwellYMask;
    hw = THREE.MathUtils.lerp(hw, 0.0200, inMagwell);

    // Pistol grip & trigger guard & forward cradle + slim front nose under receiver
    const forwardMask = smoothstep(-0.115, -0.08, x);
    if (forwardMask > 0) {
      const cradleZone = smoothstep(-0.048, -0.024, y) * smoothstep(-0.028, 0.006, x);
      const gripZone = 1 - smoothstep(-0.048, -0.030, y);

      const inGrip = 1 - smoothstep(-0.056, -0.022, x);
      const palmSwell = 0.0148 + 0.0032 * gauss2D(x, y, -0.072, -0.092, 0.022, 0.032);
      const guardBow = 0.0114 + 0.0010 * smoothstep(-0.07, -0.03, y);
      const lowerHw = THREE.MathUtils.lerp(guardBow, palmSwell, inGrip);

      const targetForwardHw = THREE.MathUtils.lerp(0.0192, lowerHw, gripZone);
      const cradleAdjusted = THREE.MathUtils.lerp(targetForwardHw, 0.0170, cradleZone);

      const noseMask = smoothstep(0.094, 0.118, x);
      const noseUpperTuck = smoothstep(-0.032, -0.018, y);
      const noseHw = THREE.MathUtils.lerp(0.0120, 0.0108, noseUpperTuck);
      const noseAdjusted = THREE.MathUtils.lerp(cradleAdjusted, noseHw, noseMask);

      hw = THREE.MathUtils.lerp(hw, noseAdjusted, forwardMask);
    }

    return Math.max(0.008, hw);
  };

  // Asymmetric +Z recess in right ejection port pocket X=[-0.214, -0.132], Y=[+0.0055, +0.015] (~2.1mm deep -> Z≈+0.0199)
  const chassisHalfWidthPos = (x: number, y: number): number => {
    let hw = chassisHalfWidthBase(x, y);
    const ejPocket =
      smoothstep(-0.2150, -0.2110, x) *
      (1 - smoothstep(-0.1340, -0.1305, x)) *
      smoothstep(0.0054, 0.0076, y) *
      (1 - smoothstep(0.0132, 0.0156, y));
    hw -= 0.0021 * ejPocket;
    return Math.max(0.008, hw);
  };

  const chassisGeo = buildVariableLoft(chassisOutline, [triggerGuardHole], chassisHalfWidthPos, {
    maxTriangleEdge: 0.0135,
    subdivRounds: 1,
    wallRings: 13,
    rollSpan: 0.008,
    edgeFactor: 0.84,
    wallCrown: 0,
    halfWidthNegFn: chassisHalfWidthBase,
    localMaxEdgeFn: (x, y) => {
      if (x >= -0.232 && x <= -0.124 && y >= 0.001 && y <= 0.022) return 0.0075;
      if (x <= -0.350) return 0.0080;
      return 0.0135;
    },
  });

  registerComponent(
    {
      id: 'polymer_stock_chassis',
      level: 'macro',
      parent: 'root',
      parentSocket: 'chassis_origin',
      socketPos: [-0.15, -0.04, 0],
      destructionGroup: 'chassis_group',
      materialId: 'mat_polymer_od',
      isPivot: true,
    },
    chassisGeo,
  );

  // =========================================================================
  // 2. RUBBER BUTTPAD (~11-12mm exposed rear cap + smooth high-density rings)
  // =========================================================================
  const buttpadRearCurve = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-0.369, -0.1426, 0),
      new THREE.Vector3(-0.3745, -0.1380, 0),
      new THREE.Vector3(-0.3782, -0.1140, 0),
      new THREE.Vector3(-0.3812, -0.0820, 0),
      new THREE.Vector3(-0.3845, -0.0550, 0),
      new THREE.Vector3(-0.3894, -0.0315, 0),
      new THREE.Vector3(-0.3934, -0.0175, 0),
      new THREE.Vector3(-0.3950, -0.0080, 0),
      new THREE.Vector3(-0.3932, 0.0012, 0),
      new THREE.Vector3(-0.3888, 0.0074, 0),
      new THREE.Vector3(-0.3834, 0.0120, 0),
      new THREE.Vector3(-0.3774, 0.0160, 0),
      new THREE.Vector3(-0.3722, 0.0195, 0),
      new THREE.Vector3(-0.3690, 0.0210, 0),
    ],
    false,
    'centripetal',
    0.5,
  );
  const buttpadRearPts: Vec2[] = buttpadRearCurve
    .getSpacedPoints(40)
    .map((p) => [p.x, p.y] as Vec2);
  const buttpadOutline: Vec2[] = [
    ...buttpadRearPts,
    [-0.3600, 0.0204],
    [-0.3515, 0.0155],
    [-0.3515, -0.1355],
    [-0.3580, -0.1422],
  ];
  const buttpadGeo = buildVariableLoft(
    buttpadOutline,
    [],
    (x, y) => {
      const seamX = buttpadExposedSeamX(y);
      const innerTaper = smoothstep(seamX - 0.0020, seamX + 0.0020, x);
      const localChassisHw = rearStockProfileHw(x, y);
      let hw = THREE.MathUtils.lerp(localChassisHw + 0.0001, localChassisHw - 0.0026, innerTaper);
      hw -= 0.0022 * smoothstep(-0.383, -0.395, x);
      return Math.max(0.0115, hw);
    },
    {
      maxTriangleEdge: 0.010,
      subdivRounds: 2,
      wallRings: 15,
      rollSpan: 0.0072,
      edgeFactor: 0.80,
      wallCrown: 0.0004,
    },
  );
  registerComponent(
    {
      id: 'rubber_buttpad',
      level: 'meso',
      parent: 'polymer_stock_chassis',
      parentSocket: 'buttstock_rear',
      socketPos: [-0.376, -0.06, 0],
      destructionGroup: 'chassis_group',
      materialId: 'mat_rubber_buttpad',
    },
    buttpadGeo,
  );

  // =========================================================================
  // 3. ENLARGED TRIGGER GUARD LOOP (beaded winter guard lower/outer rim)
  // =========================================================================
  const guardRimGeo = buildTaperedTube(
    [
      [-0.076, -0.1350, 0],
      [-0.064, -0.1376, 0],
      [-0.048, -0.1384, 0],
      [-0.032, -0.1382, 0],
      [-0.016, -0.1365, 0],
      [-0.001, -0.1245, 0],
      [0.019, -0.1010, 0],
      [0.043, -0.0720, 0],
      [0.069, -0.0450, 0],
      [0.090, -0.0295, 0],
    ],
    (t) => {
      const gripBlend = 0.45 + 0.55 * smoothstep(0.0, 0.22, t);
      const frontBlend = 1 - 0.14 * smoothstep(0.86, 1.0, t);
      const archCrown = 0.94 + 0.06 * Math.sin(t * Math.PI);
      const scale = gripBlend * frontBlend * archCrown;
      return [0.0112 * scale, 0.0040 * scale];
    },
    { steps: 80, radialSegments: 26, capEnds: true },
  );
  registerComponent(
    {
      id: 'enlarged_trigger_guard_loop',
      level: 'meso',
      parent: 'polymer_stock_chassis',
      parentSocket: 'trigger_guard_base',
      socketPos: [0.01, -0.09, 0],
      destructionGroup: 'chassis_group',
      materialId: 'mat_polymer_od',
      explodeWithParent: true,
    },
    guardRimGeo,
  );

  // =========================================================================
  // 4. UPPER RECEIVER METAL (transverse YZ loft along X -> crisp machined flutes)
  // =========================================================================
  const receiverBreakpoints = [
    -0.036, -0.031, -0.025, -0.020, -0.018, -0.014, -0.008, -0.003, 0.000, 0.004,
    0.012, 0.020, 0.030, 0.040, 0.050, 0.060, 0.070, 0.080, 0.090, 0.095,
    0.097, 0.100, 0.103, 0.106, 0.110, 0.120, 0.124, 0.129, 0.134, 0.142,
    0.145, 0.149, 0.156, 0.1645,
  ];
  const receiverStations: TransverseXStation[] = receiverBreakpoints.map((x) => {
    const yTop =
      x < -0.018
        ? THREE.MathUtils.lerp(0.0110, 0.0142, smoothstep(-0.036, -0.018, x))
        : x > 0.126
          ? THREE.MathUtils.lerp(0.0142, 0.0112, smoothstep(0.126, 0.142, x))
          : 0.0142;

    let yBot = -0.0180;
    if (x < -0.018) {
      yBot = THREE.MathUtils.lerp(-0.0140, -0.0180, smoothstep(-0.036, -0.018, x));
    } else if (x >= 0.097 && x <= 0.105) {
      yBot = THREE.MathUtils.lerp(-0.0180, -0.0265, smoothstep(0.097, 0.105, x));
    } else if (x > 0.105 && x < 0.145) {
      yBot = -0.0265;
    } else if (x >= 0.145 && x <= 0.149) {
      yBot = THREE.MathUtils.lerp(-0.0265, -0.0204, smoothstep(0.145, 0.149, x));
    } else if (x > 0.149) {
      yBot = -0.0204;
    }

    let hw = 0.0204;
    if (x < -0.018) {
      hw = THREE.MathUtils.lerp(0.0145, 0.0204, smoothstep(-0.036, -0.018, x));
    } else if (x > 0.136) {
      hw = THREE.MathUtils.lerp(0.0204, 0.0138, smoothstep(0.136, 0.1645, x));
    }
    const lowBlockMask = smoothstep(-0.020, -0.026, yBot);
    const hwBot = THREE.MathUtils.lerp(hw * 0.78, Math.min(hw * 0.66, 0.0110), lowBlockMask);

    // Crisp CNC-machined flutes & left charging-handle slot/rail (guard loops confine bevel curvature)
    const fluteR = 0.0022 * smoothstep(-0.003, 0.003, x) * (1 - smoothstep(0.094, 0.101, x));
    const fluteL = 0.0018 * smoothstep(-0.003, 0.003, x) * (1 - smoothstep(0.123, 0.130, x));
    const leftRailMask = smoothstep(-0.011, -0.004, x) * (1 - smoothstep(0.098, 0.106, x));
    const slotRecessL = 0.0018 * leftRailMask;
    const railOutL = 0.0018 * leftRailMask;

    const ySh = 0.0060;
    const yLo = -0.0096;
    const yRailTop = Math.min(0.0110, yTop - 0.0016);
    const yRailShoulder = Math.min(0.0114, yTop - 0.0012);
    const yRailBevel = Math.min(0.0130, yTop - 0.0005);

    const profileYZ: Vec2[] = [
      // Top center -> +Z side descending strictly in Y
      [yTop, 0],
      [yTop, hw * 0.56],
      [THREE.MathUtils.lerp(yTop, ySh, 0.35), hw * 0.85],
      [THREE.MathUtils.lerp(yTop, ySh, 0.78), hw * 0.985],
      [ySh, hw],
      [0.0052, hw],
      [0.0012, hw],
      [-0.0008, hw],
      [-0.0014, hw],
      [-0.0030, hw - fluteR],
      [-0.0036, hw - fluteR],
      [-0.0064, hw - fluteR],
      [-0.0072, hw - fluteR],
      [-0.0088, hw],
      [-0.0092, hw],
      [yLo, hw],
      [THREE.MathUtils.lerp(yLo, yBot, 0.28), THREE.MathUtils.lerp(hw, hwBot, 0.25)],
      [THREE.MathUtils.lerp(yLo, yBot, 0.65), THREE.MathUtils.lerp(hw, hwBot, 0.68)],
      [THREE.MathUtils.lerp(yLo, yBot, 0.90), hwBot * 0.92],
      [yBot, hwBot * 0.65],
      [yBot, 0],
      // -Z side ascending strictly in Y (lower flute + charging handle slot + crisp left rail)
      [yBot, -hwBot * 0.65],
      [THREE.MathUtils.lerp(yLo, yBot, 0.90), -hwBot * 0.92],
      [THREE.MathUtils.lerp(yLo, yBot, 0.65), -THREE.MathUtils.lerp(hw, hwBot, 0.68)],
      [THREE.MathUtils.lerp(yLo, yBot, 0.28), -THREE.MathUtils.lerp(hw, hwBot, 0.25)],
      [yLo, -hw],
      [-0.0088, -hw],
      [-0.0084, -hw],
      [-0.0070, -(hw - fluteL)],
      [-0.0066, -(hw - fluteL)],
      [-0.0040, -(hw - fluteL)],
      [-0.0036, -(hw - fluteL)],
      [-0.0022, -hw],
      [-0.0018, -hw],
      [0.0004, -hw],
      [0.0008, -hw],
      [0.0022, -(hw - slotRecessL)],
      [0.0026, -(hw - slotRecessL)],
      [0.0042, -(hw - slotRecessL)],
      [0.0046, -(hw - slotRecessL)],
      [0.0072, -(hw + railOutL)],
      [0.0076, -(hw + railOutL)],
      [yRailTop, -(hw + railOutL)],
      [yRailShoulder, -(hw + railOutL)],
      [yRailBevel, -(hw * 0.95 + railOutL * 0.75)],
      [yTop, -hw * THREE.MathUtils.lerp(0.56, 0.80, leftRailMask)],
    ];

    return { x, profileYZ };
  });
  const receiverLoftGeo = buildTransverseXLoft(receiverStations, {
    endCapBevel: 0.0007,
    capStart: true,
    capEnd: true,
  });
  // Disjoint by 0.6mm (> 2*epsilon) so zero self-intersection at front trunnion seam
  const receiverTrunnionCollar = buildLatheProfile(
    [
      [0.1651, 0.0118],
      [0.167, 0.0108],
      [0.181, 0.0105],
      [0.182, 0.0088],
    ],
    { axis: 'x', segments: 28, center: [0, 0, 0], maxAxialStep: 0.003 },
  );
  const receiverGeo = mergeGeometries([receiverLoftGeo, receiverTrunnionCollar]);

  registerComponent(
    {
      id: 'upper_receiver_metal',
      level: 'macro',
      parent: 'root',
      parentSocket: 'receiver_cradle',
      socketPos: [0.06, 0, 0],
      destructionGroup: 'receiver_group',
      materialId: 'mat_receiver_anodized',
      isPivot: true,
    },
    receiverGeo,
  );

  // =========================================================================
  // 5. INTEGRATED OPTIC CARRY HANDLE & ITS 7 MESO COMPONENTS
  // =========================================================================
  const handleBaseGeo = buildVariableLoft(
    [
      [-0.020, 0.009],
      [0.144, 0.009],
      [0.140, 0.0150],
      [0.088, 0.0150],
      [0.002, 0.0148],
      [-0.020, 0.0150],
    ],
    [],
    (x, y) => {
      let hw = 0.0118;
      hw -= 0.0016 * smoothstep(0.012, 0.015, y);
      hw -= 0.0020 * smoothstep(0.125, 0.144, x);
      return hw;
    },
    { maxTriangleEdge: 0.0055, subdivRounds: 1, wallRings: 9, rollSpan: 0.0035, edgeFactor: 0.80, wallCrown: 0 },
  );
  registerComponent(
    {
      id: 'integrated_optic_carry_handle',
      level: 'macro',
      parent: 'upper_receiver_metal',
      parentSocket: 'receiver_top_bridge',
      socketPos: [0.05, 0.016, 0],
      destructionGroup: 'optic_group',
      materialId: 'mat_optic_worn_metal',
      isPivot: true,
    },
    handleBaseGeo,
  );

  // Rear optic strut: continuous tangential concave fillet directly into optic_main_tube (zero top step)
  const rearStrutGeo = buildVariableLoft(
    [
      [-0.054, 0.0650],
      [-0.054, 0.0575],
      [-0.047, 0.0550],
      [-0.039, 0.0504],
      [-0.032, 0.0442],
      [-0.026, 0.0358],
      [-0.022, 0.0252],
      [-0.019, 0.0140],
      [0.000, 0.0140],
      [-0.003, 0.0235],
      [-0.007, 0.0335],
      [-0.011, 0.0430],
      [-0.0130, 0.0500],
      [-0.0126, 0.0545],
      [-0.0110, 0.0576],
      [-0.0084, 0.0598],
      [-0.0055, 0.0612],
      [-0.0055, 0.0650],
    ],
    [],
    (x, y) => {
      const baseFlare = 0.0014 * smoothstep(0.025, 0.014, y);
      const tubeTuck = 0.0014 * smoothstep(0.053, 0.064, y);
      return 0.0088 + baseFlare - tubeTuck;
    },
    { maxTriangleEdge: 0.0042, subdivRounds: 1, wallRings: 11, rollSpan: 0.0042, edgeFactor: 0.80, wallCrown: 0 },
  );
  registerComponent(
    {
      id: 'optic_rear_strut',
      level: 'meso',
      parent: 'integrated_optic_carry_handle',
      parentSocket: 'optic_rear_mount',
      socketPos: [-0.025, 0.04, 0],
      destructionGroup: 'optic_group',
      materialId: 'mat_optic_worn_metal',
    },
    rearStrutGeo,
  );

  // Front optic strut: sleek arm smoothly tucked into objective collar + separate diagonal chamfered block + cross-pin
  const frontStrutArm = buildVariableLoft(
    [
      [0.046, 0.0650],
      [0.046, 0.0530],
      [0.058, 0.0460],
      [0.070, 0.0375],
      [0.082, 0.0280],
      [0.091, 0.0175],
      [0.095, 0.0130],
      [0.144, 0.0130],
      [0.142, 0.0158],
      [0.137, 0.0172],
      [0.111, 0.0256],
      [0.103, 0.0260],
      [0.096, 0.0305],
      [0.086, 0.0405],
      [0.075, 0.0505],
      [0.068, 0.0570],
      [0.066, 0.0620],
      [0.066, 0.0650],
    ],
    [],
    (_x, y) => 0.0088 + 0.0014 * smoothstep(0.024, 0.013, y) - 0.0012 * smoothstep(0.052, 0.064, y),
    { maxTriangleEdge: 0.0040, subdivRounds: 1, wallRings: 11, rollSpan: 0.0036, edgeFactor: 0.80, wallCrown: 0 },
  );
  // Separate diagonal rectangular chamfered latch block mounted cleanly 0.35mm above sloped bed (0 self-intersection)
  const frontLugAngle = Math.atan2(0.0172 - 0.0256, 0.137 - 0.111); // ~ -0.3125 rad
  const frontLugBlock = buildSharpChamferedBox([0, 0, 0], [0.0245, 0.0068, 0.0206], 0.0008, 10, 3);
  frontLugBlock.rotateZ(frontLugAngle);
  frontLugBlock.translate(
    0.1240 - Math.sin(frontLugAngle) * 0.00375,
    0.0214 + Math.cos(frontLugAngle) * 0.00375,
    0,
  );
  const frontLugPinR = buildLatheProfile(
    [
      [0.01055, 0.0020],
      [0.0114, 0.0020],
      [0.0118, 0.0014],
    ],
    { axis: 'z', segments: 14, center: [0.1305, 0.0226, 0], maxAxialStep: 0.001 },
  );
  const frontLugPinL = buildLatheProfile(
    [
      [-0.0118, 0.0014],
      [-0.0114, 0.0020],
      [-0.01055, 0.0020],
    ],
    { axis: 'z', segments: 14, center: [0.1305, 0.0226, 0], maxAxialStep: 0.001 },
  );
  const frontStrutGeo = mergeGeometries([frontStrutArm, frontLugBlock, frontLugPinR, frontLugPinL]);
  registerComponent(
    {
      id: 'optic_front_strut',
      level: 'meso',
      parent: 'integrated_optic_carry_handle',
      parentSocket: 'optic_front_mount',
      socketPos: [0.09, 0.038, 0],
      destructionGroup: 'optic_group',
      materialId: 'mat_optic_worn_metal',
    },
    frontStrutGeo,
  );

  // Main 1.5x optic tube with crisp stepped objective bezel collar at X = +0.068..+0.074 (<=45-deg groove ramps)
  const opticMainTubeGeo = buildLatheProfile(
    [
      [-0.048, 0.0122],
      [-0.039, 0.0122],
      [-0.037, 0.0117],
      [0.050, 0.0117],
      [0.055, 0.0133],
      [0.0660, 0.0133],
      [0.0674, 0.0124],
      [0.0694, 0.0124],
      [0.0708, 0.0139],
      [0.0734, 0.0139],
      [0.0740, 0.0124],
    ],
    { axis: 'x', segments: 32, center: [0, 0.068, 0], maxAxialStep: 0.003 },
  );
  registerComponent(
    {
      id: 'optic_main_tube',
      level: 'meso',
      parent: 'integrated_optic_carry_handle',
      parentSocket: 'optic_tube_saddle',
      socketPos: [0.015, 0.068, 0],
      destructionGroup: 'optic_group',
      materialId: 'mat_optic_worn_metal',
    },
    opticMainTubeGeo,
  );

  // Stepped ocular bell (monotonic axial profile)
  const opticOcularBellGeo = buildLatheProfile(
    [
      [-0.132, 0.0146],
      [-0.1305, 0.0158],
      [-0.127, 0.0158],
      [-0.1255, 0.0144],
      [-0.072, 0.0141],
      [-0.046, 0.0122],
      [-0.038, 0.0114],
    ],
    { axis: 'x', segments: 32, center: [0, 0.068, 0] },
  );
  registerComponent(
    {
      id: 'optic_ocular_bell',
      level: 'meso',
      parent: 'integrated_optic_carry_handle',
      parentSocket: 'optic_rear_bell',
      socketPos: [-0.085, 0.068, 0],
      destructionGroup: 'optic_group',
      materialId: 'mat_optic_worn_metal',
    },
    opticOcularBellGeo,
  );

  // Turret housing centered at X = +0.0235: all 4 caps start 0.2mm outside saddle cylinder r = 0.0138
  const turretSaddle = buildLatheProfile(
    [
      [0.0140, 0.0138],
      [0.0330, 0.0138],
    ],
    { axis: 'x', segments: 24, center: [0, 0.068, 0], maxAxialStep: 0.003 },
  );
  const turretTop = buildLatheProfile(
    [
      [0.0820, 0.0068],
      [0.0858, 0.0068],
      [0.0866, 0.0056],
    ],
    { axis: 'y', segments: 24, center: [0.0235, 0, 0], maxAxialStep: 0.002 },
  );
  const turretBot = buildLatheProfile(
    [
      [0.0472, 0.0054],
      [0.0485, 0.0064],
      [0.0540, 0.0064],
    ],
    { axis: 'y', segments: 24, center: [0.0235, 0, 0], maxAxialStep: 0.002 },
  );
  const turretRight = buildLatheProfile(
    [
      [0.0140, 0.0074],
      [0.0180, 0.0074],
      [0.0188, 0.0062],
    ],
    { axis: 'z', segments: 24, center: [0.0235, 0.068, 0], maxAxialStep: 0.002 },
  );
  const turretLeft = buildLatheProfile(
    [
      [-0.0188, 0.0062],
      [-0.0180, 0.0074],
      [-0.0140, 0.0074],
    ],
    { axis: 'z', segments: 24, center: [0.0235, 0.068, 0], maxAxialStep: 0.002 },
  );
  const turretGeo = mergeGeometries([turretSaddle, turretTop, turretBot, turretRight, turretLeft]);
  registerComponent(
    {
      id: 'optic_turret_housing',
      level: 'meso',
      parent: 'integrated_optic_carry_handle',
      parentSocket: 'turret_saddle',
      socketPos: [0.0235, 0.068, 0],
      destructionGroup: 'optic_group',
      materialId: 'mat_optic_worn_metal',
    },
    turretGeo,
  );

  // Optic lenses (seated cleanly flush on objective & ocular faces without intersecting tube)
  const frontLens = buildLatheProfile(
    [
      [0.0741, 0.0108],
      [0.0750, 0.0092],
      [0.0755, 0.0058],
    ],
    { axis: 'x', segments: 24, center: [0, 0.068, 0] },
  );
  const rearLens = buildLatheProfile(
    [
      [-0.1338, 0.0065],
      [-0.1332, 0.0110],
      [-0.1321, 0.0126],
    ],
    { axis: 'x', segments: 24, center: [0, 0.068, 0] },
  );
  const opticLensesGeo = mergeGeometries([frontLens, rearLens]);
  registerComponent(
    {
      id: 'optic_lenses',
      level: 'meso',
      parent: 'integrated_optic_carry_handle',
      parentSocket: 'lens_seats',
      socketPos: [-0.03, 0.068, 0],
      destructionGroup: 'optic_group',
      materialId: 'mat_optic_glass',
    },
    opticLensesGeo,
  );

  // Backup iron sights: crisp rectangular chamfered front sight block + low-profile rear ocular notch ears
  const rearNotchLeft = buildSharpChamferedBox([-0.1285, 0.0836, -0.0044], [0.0072, 0.0034, 0.0032], 0.0004, 4, 2);
  const rearNotchRight = buildSharpChamferedBox([-0.1285, 0.0836, 0.0044], [0.0072, 0.0034, 0.0032], 0.0004, 4, 2);
  const frontBlade = buildSharpChamferedBox([0.0630, 0.0820, 0], [0.0090, 0.0052, 0.0072], 0.0005, 8, 3);
  const backupSightsGeo = mergeGeometries([rearNotchLeft, rearNotchRight, frontBlade]);
  registerComponent(
    {
      id: 'backup_iron_sights',
      level: 'meso',
      parent: 'integrated_optic_carry_handle',
      parentSocket: 'optic_top_spine',
      socketPos: [-0.03, 0.082, 0],
      destructionGroup: 'optic_group',
      materialId: 'mat_optic_worn_metal',
    },
    backupSightsGeo,
  );

  // =========================================================================
  // 6. BARREL, GAS REGULATOR, CLAMP LUG, TULIP FLASH HIDER & SLOTS
  // =========================================================================
  const barrelGeo = buildLatheProfile(
    [
      [0.130, 0.0102],
      [0.1825, 0.0102],
      [0.1848, 0.0086],
      [0.3215, 0.0086],
      [0.3238, 0.0103],
      [0.3262, 0.0103],
      [0.3285, 0.0086],
      [0.3350, 0.0086],
      [0.3372, 0.0103],
      [0.3450, 0.0103],
      [0.3465, 0.0086],
      [0.3480, 0.0074],
      [0.3540, 0.0074],
    ],
    { axis: 'x', segments: 32, center: [0, 0, 0], maxAxialStep: 0.010 },
  );
  registerComponent(
    {
      id: 'barrel_gas_muzzle_assembly',
      level: 'macro',
      parent: 'upper_receiver_metal',
      parentSocket: 'barrel_trunnion_socket',
      socketPos: [0.165, 0, 0],
      destructionGroup: 'barrel_group',
      materialId: 'mat_barrel_parkerized',
      isPivot: true,
    },
    barrelGeo,
  );

  const gasHousing = buildLatheProfile(
    [
      [0.140, 0.0068],
      [0.180, 0.0068],
      [0.1822, 0.0052],
      [0.1862, 0.0052],
      [0.1882, 0.0068],
      [0.1924, 0.0068],
      [0.1942, 0.0050],
    ],
    { axis: 'x', segments: 24, center: [0, -0.0145, 0], maxAxialStep: 0.004 },
  );
  const gasWeb = buildChamferedBox([0.162, -0.0030, 0], [0.036, 0.0080, 0.010], 0.0012, 11);
  const gasRegGeo = mergeGeometries([gasHousing, gasWeb]);
  registerComponent(
    {
      id: 'gas_regulator_block',
      level: 'meso',
      parent: 'barrel_gas_muzzle_assembly',
      parentSocket: 'gas_port_seat',
      socketPos: [0.17, -0.0145, 0],
      destructionGroup: 'barrel_group',
      materialId: 'mat_barrel_parkerized',
    },
    gasRegGeo,
  );

  const clampCollar = buildLatheProfile(
    [
      [0.2645, 0.0103],
      [0.2745, 0.0103],
    ],
    { axis: 'x', segments: 24, center: [0, 0, 0] },
  );
  const clampTopSpur = buildSharpChamferedBox([0.2695, 0.01215, 0], [0.0076, 0.0033, 0.0054], 0.0007, 10, 2);
  const clampBottomLug = buildSharpChamferedBox([0.2695, -0.0130, 0], [0.0086, 0.0050, 0.0064], 0.0008, 10, 2);
  const clampScrewR = buildLatheProfile(
    [
      [0.0034, 0.0018],
      [0.0046, 0.0018],
      [0.0050, 0.0013],
    ],
    { axis: 'z', segments: 14, center: [0.2695, -0.0131, 0], maxAxialStep: 0.001 },
  );
  const clampScrewL = buildLatheProfile(
    [
      [-0.0050, 0.0013],
      [-0.0046, 0.0018],
      [-0.0034, 0.0018],
    ],
    { axis: 'z', segments: 14, center: [0.2695, -0.0131, 0], maxAxialStep: 0.001 },
  );
  const clampLugGeo = mergeGeometries([clampCollar, clampTopSpur, clampBottomLug, clampScrewR, clampScrewL]);
  registerComponent(
    {
      id: 'barrel_clamp_lug',
      level: 'meso',
      parent: 'barrel_gas_muzzle_assembly',
      parentSocket: 'barrel_mid_collar',
      socketPos: [0.27, 0, 0],
      destructionGroup: 'barrel_group',
      materialId: 'mat_barrel_parkerized',
    },
    clampLugGeo,
  );

  // Tulip flash hider: outer collar R=0.0101, recessed milled slot floor R=0.0076, hollow bore R=0.0046
  const boreArc: [number, number][] = [];
  const boreR = 0.0042;
  for (let k = 1; k <= 8; k += 1) {
    const ang = (k / 8) * (Math.PI * 0.5);
    boreArc.push([0.3600 - Math.sin(ang) * boreR, 0.0004 + Math.cos(ang) * boreR]);
  }
  const flashHiderGeo = buildLatheProfile(
    [
      [0.3440, 0.0096],
      [0.3465, 0.0102],
      [0.3496, 0.0090],
      [0.3528, 0.0090],
      [0.3558, 0.0101],
      [0.3615, 0.0101],
      [0.3646, 0.0076],
      [0.3874, 0.0076],
      [0.3905, 0.0101],
      [0.3944, 0.0101],
      [0.3950, 0.0086],
      [0.3950, 0.0052],
      [0.3940, 0.0046],
      [0.3600, 0.0046],
      ...boreArc,
    ],
    { axis: 'x', segments: 32, center: [0, 0, 0], maxAxialStep: 0.004, capStart: true, capEnd: true },
  );
  registerComponent(
    {
      id: 'tulip_flash_hider',
      level: 'meso',
      parent: 'barrel_gas_muzzle_assembly',
      parentSocket: 'muzzle_threads',
      socketPos: [0.355, 0, 0],
      destructionGroup: 'barrel_group',
      materialId: 'mat_barrel_parkerized',
    },
    flashHiderGeo,
  );

  // 5 real CNC-machined outer prongs flush at R = 0.0101 m with 22-deg recessed slots (R = 0.0076) between them
  const prongStationsX = [0.3622, 0.3636, 0.3675, 0.3720, 0.3765, 0.3810, 0.3855, 0.3884, 0.3898];
  const prongMeshes: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i += 1) {
    const thetaC = (i / 5) * Math.PI * 2 + 0.3;
    const dOut = THREE.MathUtils.degToRad(22.5);
    const dLip = THREE.MathUtils.degToRad(24.5);
    const dIn = THREE.MathUtils.degToRad(25.2);
    const rOut = 0.0101;
    const rLip = 0.0097;
    const rIn = 0.0072;

    const stations: TransverseXStation[] = prongStationsX.map((x) => {
      const profileYZ: Vec2[] = [];
      for (let k = 0; k <= 6; k += 1) {
        const a = thetaC - dOut + (2 * dOut * k) / 6;
        profileYZ.push([Math.sin(a) * rOut, Math.cos(a) * rOut]);
      }
      profileYZ.push([Math.sin(thetaC + dLip) * rLip, Math.cos(thetaC + dLip) * rLip]);
      for (let k = 0; k <= 4; k += 1) {
        const a = thetaC + dIn - (2 * dIn * k) / 4;
        profileYZ.push([Math.sin(a) * rIn, Math.cos(a) * rIn]);
      }
      profileYZ.push([Math.sin(thetaC - dLip) * rLip, Math.cos(thetaC - dLip) * rLip]);
      return { x, profileYZ };
    });

    prongMeshes.push(
      buildTransverseXLoft(stations, {
        endCapBevel: 0.0004,
        capStart: true,
        capEnd: true,
      }),
    );
  }
  const flashSlotsGeo = mergeGeometries(prongMeshes);
  registerComponent(
    {
      id: 'flash_hider_slots',
      level: 'micro',
      parent: 'tulip_flash_hider',
      parentSocket: 'flash_hider_body',
      socketPos: [0.377, 0, 0],
      destructionGroup: 'barrel_group',
      materialId: 'mat_barrel_parkerized',
      explodeWithParent: true,
    },
    flashSlotsGeo,
  );

  // =========================================================================
  // 7. FOLDING VERTICAL FOREGRIP & HINGE BRACKET
  // =========================================================================
  const foregripLathe = buildLatheProfile(
    [
      [-0.032, 0.0126],
      [-0.037, 0.0156],
      [-0.048, 0.0168],
      [-0.062, 0.0154],
      [-0.078, 0.0138],
      [-0.095, 0.0144],
      [-0.112, 0.0158],
      [-0.123, 0.0174],
      [-0.1275, 0.0178],
      [-0.1302, 0.0168],
      [-0.1316, 0.0144],
      [-0.1322, 0.0112],
      [-0.1324, 0.0070],
    ],
    { axis: 'y', segments: 32, center: [0.1415, 0, 0], maxAxialStep: 0.004 },
  );
  const fgPos = foregripLathe.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < fgPos.count; i += 1) {
    const py = fgPos.getY(i);
    fgPos.setX(i, fgPos.getX(i) + 0.0016 * smoothstep(-0.085, -0.126, py));
  }
  foregripLathe.computeVertexNormals();
  foregripLathe.computeBoundingBox();

  registerComponent(
    {
      id: 'folding_vertical_foregrip',
      level: 'macro',
      parent: 'upper_receiver_metal',
      parentSocket: 'foregrip_hinge_socket',
      socketPos: [0.135, -0.0285, 0],
      destructionGroup: 'foregrip_group',
      materialId: 'mat_polymer_od',
      isPivot: true,
      pivotPos: [0.135, -0.0285, 0],
      pivotName: 'pivot_foregrip',
    },
    foregripLathe,
  );

  const hingeClevis = buildVariableLoft(
    sampleCatmull2D(
      [
        [0.1180, -0.0200],
        [0.1515, -0.0200],
        [0.1508, -0.0242],
        [0.1485, -0.0292],
        [0.1452, -0.0338],
        [0.1415, -0.0360],
        [0.1360, -0.0368],
        [0.1300, -0.0365],
        [0.1242, -0.0350],
        [0.1192, -0.0334],
        [0.1180, -0.0280],
      ],
      36,
      true,
    ),
    [],
    (_x, y) => {
      const topTuck = smoothstep(-0.028, -0.020, y);
      return THREE.MathUtils.lerp(0.0123, 0.0108, topTuck);
    },
    { maxTriangleEdge: 0.005, subdivRounds: 2, wallRings: 13, rollSpan: 0.0036, edgeFactor: 0.80, wallCrown: 0 },
  );
  const hingePinR = buildLatheProfile(
    [
      [0.01255, 0.0030],
      [0.0135, 0.0030],
      [0.0140, 0.0022],
    ],
    { axis: 'z', segments: 16, center: [0.136, -0.0315, 0], maxAxialStep: 0.0012 },
  );
  const hingePinL = buildLatheProfile(
    [
      [-0.0140, 0.0022],
      [-0.0135, 0.0030],
      [-0.01255, 0.0030],
    ],
    { axis: 'z', segments: 16, center: [0.136, -0.0315, 0], maxAxialStep: 0.0012 },
  );
  const foregripHingeGeo = mergeGeometries([hingeClevis, hingePinR, hingePinL]);
  registerComponent(
    {
      id: 'foregrip_hinge_bracket',
      level: 'meso',
      parent: 'upper_receiver_metal',
      parentSocket: 'foregrip_hinge_top',
      socketPos: [0.135, -0.0285, 0],
      destructionGroup: 'foregrip_group',
      materialId: 'mat_receiver_anodized',
    },
    foregripHingeGeo,
  );

  // =========================================================================
  // 8. WAFFLE MAGAZINE ASSEMBLY (body + floorplate + 3D waffle ribs + internals)
  // =========================================================================
  const magBodyOutline: Vec2[] = [
    [-0.225, -0.047],
    [-0.163, -0.047],
    [-0.151, -0.090],
    [-0.140, -0.128],
    [-0.129, -0.165],
    [-0.188, -0.184],
    [-0.194, -0.163],
    [-0.204, -0.126],
    [-0.214, -0.088],
  ];
  const magBodyGeo = buildVariableLoft(magBodyOutline, [], () => 0.0124, {
    maxTriangleEdge: 0.012,
    subdivRounds: 1,
    wallRings: 15,
    rollSpan: 0.0055,
    edgeFactor: 0.80,
    wallCrown: 0.0002,
  });
  registerComponent(
    {
      id: 'waffle_magazine_assembly',
      level: 'macro',
      parent: 'polymer_stock_chassis',
      parentSocket: 'magwell_socket',
      socketPos: [-0.175, -0.068, 0],
      destructionGroup: 'magazine_group',
      materialId: 'mat_mag_translucent',
      isPivot: true,
      pivotPos: [-0.175, -0.068, 0],
      pivotName: 'pivot_magazine',
    },
    magBodyGeo,
  );

  // Magazine floorplate (single clean contoured loft capping magazine bottom)
  const floorplateOutline: Vec2[] = [
    [-0.191, -0.174],
    [-0.126, -0.157],
    [-0.126, -0.168],
    [-0.188, -0.1895],
    [-0.193, -0.184],
  ];
  const floorplateGeo = buildVariableLoft(floorplateOutline, [], () => 0.0138, {
    maxTriangleEdge: 0.011,
    subdivRounds: 1,
    wallRings: 11,
    rollSpan: 0.004,
    edgeFactor: 0.78,
    wallCrown: 0,
  });
  registerComponent(
    {
      id: 'mag_floorplate',
      level: 'meso',
      parent: 'waffle_magazine_assembly',
      parentSocket: 'mag_bottom_lip',
      socketPos: [-0.158, -0.176, 0],
      destructionGroup: 'magazine_group',
      materialId: 'mat_mag_floorplate',
    },
    floorplateGeo,
  );

  // Real internal magazine stack: ~17-deg canted rounds + rotated follower + smooth zig-zag spring
  const internalGeos: THREE.BufferGeometry[] = [];
  for (let c = 0; c < 4; c += 1) {
    const cy = -0.068 - c * 0.0096;
    const cx = -0.188 + c * 0.0030;
    const round = buildLatheProfile(
      [
        [-0.021, 0.0040],
        [0.006, 0.0040],
        [0.011, 0.0025],
        [0.023, 0.0005],
      ],
      { axis: 'x', segments: 14, center: [0, 0, 0], maxAxialStep: 0.005 },
    );
    round.rotateZ(-0.295);
    round.translate(cx, cy, (c % 2 === 0 ? 1 : -1) * 0.0022);
    internalGeos.push(round);
  }
  // Build follower at origin, rotateZ FIRST, then translate cleanly
  const follower = buildChamferedBox([0, 0, 0], [0.044, 0.009, 0.013], 0.0012, 13);
  follower.rotateZ(-0.295);
  follower.translate(-0.174, -0.112, 0);
  internalGeos.push(follower);

  // Smooth spring starting below follower so zero intersection or hairpin fold
  const springSpine: Vec3[] = [
    [-0.177, -0.120, 0],
    [-0.157, -0.129, 0.002],
    [-0.179, -0.142, -0.002],
    [-0.153, -0.154, 0.002],
    [-0.173, -0.166, -0.001],
    [-0.155, -0.173, 0.001],
  ];
  const springTube = buildTaperedTube(springSpine, () => 0.0011, {
    steps: 64,
    radialSegments: 8,
    capEnds: true,
  });
  internalGeos.push(springTube);

  const magInternalsGeo = mergeGeometries(internalGeos);
  registerComponent(
    {
      id: 'mag_internal_stack',
      level: 'meso',
      parent: 'waffle_magazine_assembly',
      parentSocket: 'mag_interior',
      socketPos: [-0.168, -0.12, 0],
      destructionGroup: 'magazine_group',
      materialId: 'mat_mag_internals',
    },
    magInternalsGeo,
  );

  // Non-intersecting 3D waffle rib grid: 3 internal vertical ribs + 2 deep molded side borders (4 cols x 6 cells)
  function buildWaffleRibGrid(sideSign: 1 | -1): THREE.BufferGeometry {
    const ribs: THREE.BufferGeometry[] = [];

    const colTops: Vec2[] = [];
    const colBots: Vec2[] = [];
    for (let col = 0; col < 5; col += 1) {
      const u = col / 4;
      const topX = THREE.MathUtils.lerp(-0.215, -0.162, u);
      const topY = THREE.MathUtils.lerp(-0.070, -0.056, u);
      const botX = THREE.MathUtils.lerp(-0.186, -0.133, u);
      const botY = THREE.MathUtils.lerp(-0.173, -0.156, u);
      colTops.push([topX, topY]);
      colBots.push([botX, botY]);

      const cx = (topX + botX) * 0.5;
      const cy = (topY + botY) * 0.5;
      const len = Math.hypot(botX - topX, botY - topY);
      const angle = Math.atan2(topX - botX, topY - botY);
      const isBorder = col === 0 || col === 4;
      // Molded edge borders wrap deeper in Z (clear of center ammo stack) -> gives distinctZ >= 12!
      const ribWidthX = isBorder ? 0.0040 : 0.0025;
      const zCenter = isBorder ? sideSign * 0.0084 : sideSign * 0.0124;
      const sizeZ = isBorder ? 0.0118 : 0.0034;
      const rings = isBorder ? 17 : 9;
      const vRib = buildChamferedBox([0, 0, 0], [ribWidthX, len, sizeZ], 0.0006, rings);
      vRib.rotateZ(-angle);
      vRib.translate(cx, cy, zCenter);
      ribs.push(vRib);
    }

    // 7 horizontal ribs (row 0..6) -> 6 vertical cells x 4 columns strictly BETWEEN vertical ribs (0 crossing)
    for (let row = 0; row <= 6; row += 1) {
      const v = row / 6;
      for (let col = 0; col < 4; col += 1) {
        const ax = THREE.MathUtils.lerp(colTops[col][0], colBots[col][0], v);
        const ay = THREE.MathUtils.lerp(colTops[col][1], colBots[col][1], v);
        const bx = THREE.MathUtils.lerp(colTops[col + 1][0], colBots[col + 1][0], v);
        const by = THREE.MathUtils.lerp(colTops[col + 1][1], colBots[col + 1][1], v);
        const leftHalfW = col === 0 ? 0.0020 : 0.00125;
        const rightHalfW = col === 3 ? 0.0020 : 0.00125;
        const dist = Math.hypot(bx - ax, by - ay);
        const segLen = Math.max(0.002, dist - leftHalfW - rightHalfW - 0.0007);
        const shift = (leftHalfW - rightHalfW) * 0.5;
        const cx = (ax + bx) * 0.5 + ((bx - ax) / (dist || 1)) * shift;
        const cy = (ay + by) * 0.5 + ((by - ay) / (dist || 1)) * shift;
        const angle = Math.atan2(by - ay, bx - ax);
        const hSeg = buildChamferedBox([0, 0, 0], [segLen, 0.0024, 0.0034], 0.0005, 9);
        hSeg.rotateZ(angle);
        hSeg.translate(cx, cy, sideSign * 0.0124);
        ribs.push(hSeg);
      }
    }
    return mergeGeometries(ribs);
  }

  registerComponent(
    {
      id: 'waffle_rib_grid_right',
      level: 'micro',
      parent: 'waffle_magazine_assembly',
      parentSocket: 'mag_right_wall',
      socketPos: [-0.168, -0.12, 0.013],
      destructionGroup: 'magazine_group',
      materialId: 'mat_mag_translucent',
      explodeWithParent: true,
    },
    buildWaffleRibGrid(1),
  );
  registerComponent(
    {
      id: 'waffle_rib_grid_left',
      level: 'micro',
      parent: 'waffle_magazine_assembly',
      parentSocket: 'mag_left_wall',
      socketPos: [-0.168, -0.12, -0.013],
      destructionGroup: 'magazine_group',
      materialId: 'mat_mag_translucent',
      explodeWithParent: true,
    },
    buildWaffleRibGrid(-1),
  );

  // =========================================================================
  // 9. ASYMMETRIC LEFT/RIGHT & CONTROL COMPONENTS
  // =========================================================================
  // Right (+Z) ejection port: flat dark recessed slot (X=[-0.210, -0.134], Y=[+0.0064, +0.0129])
  // inside asymmetric +Z chassis pocket, topped by molded OD polymer upper hood + rounded rear deflector boss.
  const ejSlotOutline: Vec2[] = [
    [-0.2098, 0.0064],
    [-0.1345, 0.0064],
    [-0.1338, 0.0072],
    [-0.1338, 0.0121],
    [-0.1345, 0.0129],
    [-0.2098, 0.0129],
    [-0.2104, 0.0121],
    [-0.2104, 0.0072],
  ];
  const ejSlot = buildVariableLoft(
    ejSlotOutline,
    [],
    () => 0.0053,
    {
      maxTriangleEdge: 0.0032,
      subdivRounds: 1,
      wallRings: 15,
      rollSpan: 0.0009,
      edgeFactor: 0.92,
      wallCrown: 0,
      zOffset: 0.0158,
    },
  );

  // Continuous OD polymer molded upper lip + rounded rear brass deflector (strictly clear of ejSlot by >= 1mm)
  const ejHoodOutline: Vec2[] = sampleCatmull2D(
    [
      [-0.2238, 0.0080],
      [-0.2216, 0.0062],
      [-0.2154, 0.0062],
      [-0.2128, 0.0074],
      [-0.2125, 0.0102],
      [-0.2125, 0.0133],
      [-0.2116, 0.0139],
      [-0.2085, 0.0139],
      [-0.1720, 0.0139],
      [-0.1355, 0.0139],
      [-0.1326, 0.0146],
      [-0.1326, 0.0165],
      [-0.1355, 0.0174],
      [-0.1720, 0.0175],
      [-0.2120, 0.0176],
      [-0.2212, 0.0175],
      [-0.2238, 0.0156],
      [-0.2244, 0.0118],
    ],
    64,
    true,
  );
  const ejPolymerHood = buildVariableLoft(
    ejHoodOutline,
    [],
    (x, y) => {
      // Rear rounded deflector bump peaks at Z=+0.0231; horizontal upper lip tapers to hug upper stock roll
      const bossMask = 1 - smoothstep(-0.2145, -0.2085, x);
      const lipTopTaper = smoothstep(0.0146, 0.0174, y);
      const lipHw = THREE.MathUtils.lerp(0.0059, 0.0041, lipTopTaper);
      const bossCenterSwell = 0.0066 * (0.85 + 0.17 * gauss2D(x, y, -0.2180, 0.0116, 0.0046, 0.0048));
      const tipTaper = 1 - 0.16 * smoothstep(-0.140, -0.132, x);
      return THREE.MathUtils.lerp(lipHw * tipTaper, bossCenterSwell, bossMask);
    },
    {
      maxTriangleEdge: 0.0036,
      subdivRounds: 1,
      wallRings: 13,
      rollSpan: 0.0024,
      edgeFactor: 0.74,
      wallCrown: 0,
      zOffset: 0.0164,
    },
  );
  const ejectionRightGeo = mergeGeometriesGrouped([
    { geo: ejSlot, materialIndex: 0 },
    { geo: ejPolymerHood, materialIndex: 1 },
  ]);
  registerComponent(
    {
      id: 'ejection_port_right',
      level: 'meso',
      parent: 'polymer_stock_chassis',
      parentSocket: 'ejection_right_mount',
      socketPos: [-0.17, 0.012, 0.020],
      destructionGroup: 'chassis_group',
      materialId: 'mat_ejection_cavity',
    },
    ejectionRightGeo,
    [shaded.mat_ejection_cavity, shaded.mat_polymer_od],
  );

  // Flush left blanking plate (~0.4mm proud of chassis, dense loft for crisp flat shading)
  const ejectionLeftOutline: Vec2[] = [
    [-0.214, 0.0060],
    [-0.130, 0.0060],
    [-0.129, 0.0070],
    [-0.129, 0.0154],
    [-0.130, 0.0164],
    [-0.214, 0.0164],
    [-0.215, 0.0154],
    [-0.215, 0.0070],
  ];
  const ejectionLeftGeo = buildVariableLoft(ejectionLeftOutline, [], () => 0.0061, {
    maxTriangleEdge: 0.0045,
    subdivRounds: 1,
    wallRings: 15,
    rollSpan: 0.0020,
    edgeFactor: 0.88,
    wallCrown: 0,
    zOffset: -0.0154,
  });
  registerComponent(
    {
      id: 'ejection_blanking_plate_left',
      level: 'meso',
      parent: 'polymer_stock_chassis',
      parentSocket: 'ejection_left_mount',
      socketPos: [-0.17, 0.012, -0.022],
      destructionGroup: 'chassis_group',
      materialId: 'mat_polymer_od',
    },
    ejectionLeftGeo,
  );

  // Left (-Z) charging handle: tall curved ear (Y_max ~ +0.0356, concave finger scoop facing +X front, convex rear -X) + recessed circular pin ring
  const chRunner = buildSharpChamferedBox([0.058, 0.0040, -0.0174], [0.088, 0.0056, 0.0042], 0.0008, 6, 3);
  const chEarOutline: Vec2[] = sampleCatmull2D(
    [
      [0.0885, 0.0010],
      [0.1080, 0.0005],
      [0.1265, 0.0012],
      [0.1295, 0.0042],
      [0.1288, 0.0078],
      [0.1252, 0.0108],
      [0.1205, 0.0142],
      [0.1180, 0.0185],
      [0.1182, 0.0232],
      [0.1202, 0.0278],
      [0.1214, 0.0318],
      [0.1188, 0.0348],
      [0.1145, 0.0356],
      [0.1085, 0.0344],
      [0.1020, 0.0306],
      [0.0965, 0.0250],
      [0.0920, 0.0185],
      [0.0890, 0.0115],
      [0.0880, 0.0052],
    ],
    56,
    true,
  );
  const chEar = buildVariableLoft(
    chEarOutline,
    [],
    (x, y) => {
      const rPin = Math.hypot(x - 0.1105, y - 0.0165);
      const pocketFloor = 1 - smoothstep(0.0018, 0.0038, rPin);
      return 0.0036 - 0.0015 * pocketFloor;
    },
    {
      maxTriangleEdge: 0.0030,
      subdivRounds: 1,
      wallRings: 13,
      rollSpan: 0.0020,
      edgeFactor: 0.80,
      wallCrown: 0,
      zOffset: -0.0233,
    },
  );
  // Flush recessed pivot pin sitting inside the circular pocket (Z_floor = -0.0254, Z_pin in [-0.0266, -0.0258])
  const chEarPin = buildLatheProfile(
    [
      [-0.0266, 0.0012],
      [-0.0264, 0.0015],
      [-0.0258, 0.0015],
    ],
    { axis: 'z', segments: 18, center: [0.1105, 0.0165, 0], maxAxialStep: 0.0008 },
  );
  const chargingHandleGeo = mergeGeometriesGrouped([
    { geo: chRunner, materialIndex: 0 },
    { geo: chEarPin, materialIndex: 0 },
    { geo: chEar, materialIndex: 1 },
  ]);
  registerComponent(
    {
      id: 'left_charging_handle_assembly',
      level: 'meso',
      parent: 'upper_receiver_metal',
      parentSocket: 'charging_handle_slot',
      socketPos: [0.10, 0.008, -0.022],
      destructionGroup: 'receiver_group',
      materialId: 'mat_polymer_od',
      isPivot: true,
      pivotPos: [0.105, 0.01, -0.024],
      pivotName: 'pivot_charging_handle',
    },
    chargingHandleGeo,
    [shaded.mat_receiver_anodized, shaded.mat_polymer_od],
  );

  // Left (-Z) Rear sling swivel: slim base plate + oval wire loop tilted ~15 deg down-and-back (-X, -Y)
  const slingPlate = buildChamferedBox([-0.352, -0.0445, -0.0198], [0.016, 0.012, 0.0044], 0.0011, 11);
  const slingLug = buildLatheProfile(
    [
      [-0.0235, 0.0028],
      [-0.0223, 0.0028],
    ],
    { axis: 'z', segments: 14, center: [-0.352, -0.0445, 0], maxAxialStep: 0.001 },
  );
  const slingTiltRad = THREE.MathUtils.degToRad(15);
  const slingCenter: Vec3 = [-0.348, -0.0462, -0.0260];
  const slingLoopBase: [number, number, number][] = [
    [-0.014, 0.0042, 0.0002],
    [-0.016, -0.0020, -0.0008],
    [-0.005, -0.0052, -0.0012],
    [0.013, -0.0046, -0.0010],
    [0.016, 0.0016, -0.0002],
    [0.005, 0.0048, 0.0004],
  ];
  const slingLoopSpine: Vec3[] = slingLoopBase.map(([dx, dy, dz]) => [
    slingCenter[0] + dx * Math.cos(slingTiltRad) - dy * Math.sin(slingTiltRad),
    slingCenter[1] + dx * Math.sin(slingTiltRad) + dy * Math.cos(slingTiltRad),
    slingCenter[2] + dz,
  ]);
  const slingLoop = buildTaperedTube(
    slingLoopSpine,
    () => 0.0014,
    { steps: 44, radialSegments: 14, closed: true },
  );
  const slingLeftGeo = mergeGeometries([slingPlate, slingLug, slingLoop]);
  registerComponent(
    {
      id: 'rear_sling_swivel_left',
      level: 'micro',
      parent: 'polymer_stock_chassis',
      parentSocket: 'left_rear_sling_mount',
      socketPos: [-0.352, -0.0445, -0.022],
      destructionGroup: 'chassis_group',
      materialId: 'mat_barrel_parkerized',
      isPivot: true,
      pivotPos: [-0.352, -0.0445, -0.024],
    },
    slingLeftGeo,
  );

  // Progressive trigger: crisp concave ')' front finger face (-0.0050 top, -0.0092 mid waist, -0.0068 lower tip)
  const triggerGeo = buildVariableLoft(
    sampleCatmull2D(
      [
        [-0.0260, -0.0280],
        [-0.0050, -0.0280],
        [-0.0064, -0.0350],
        [-0.0080, -0.0382],
        [-0.0092, -0.0415],
        [-0.0091, -0.0455],
        [-0.0079, -0.0495],
        [-0.0068, -0.0528],
        [-0.0074, -0.0537],
        [-0.0155, -0.0535],
        [-0.0235, -0.0528],
        [-0.0252, -0.0470],
        [-0.0260, -0.0415],
      ],
      48,
      true,
    ),
    [],
    () => 0.0066,
    { maxTriangleEdge: 0.0045, subdivRounds: 2, wallRings: 15, rollSpan: 0.0018, edgeFactor: 0.86, wallCrown: 0 },
  );
  registerComponent(
    {
      id: 'progressive_trigger',
      level: 'micro',
      parent: 'polymer_stock_chassis',
      parentSocket: 'trigger_housing',
      socketPos: [-0.016, -0.042, 0],
      destructionGroup: 'chassis_group',
      materialId: 'mat_rubber_buttpad',
      isPivot: true,
      pivotPos: [-0.016, -0.042, 0],
      pivotName: 'pivot_trigger',
    },
    triggerGeo,
  );

  const safetyGeo = buildSharpChamferedBox([-0.068, -0.038, 0.0008], [0.010, 0.0082, 0.043], 0.0014, 24, 2);
  registerComponent(
    {
      id: 'crossbolt_safety',
      level: 'micro',
      parent: 'polymer_stock_chassis',
      parentSocket: 'safety_bore',
      socketPos: [-0.068, -0.038, 0],
      destructionGroup: 'chassis_group',
      materialId: 'mat_rubber_buttpad',
      isPivot: true,
      pivotPos: [-0.068, -0.038, 0],
      pivotName: 'pivot_safety',
    },
    safetyGeo,
  );

  // Horizontal elongated receiver takedown latch (~20.6x10.2mm stepped notched right + ~17.6x10mm horizontal left)
  const latchCrossShaft = buildSharpChamferedBox([-0.127, -0.0240, 0], [0.012, 0.0074, 0.0352], 0.0010, 16, 2);
  const latchRightOutline: Vec2[] = sampleCatmull2D(
    [
      [-0.1373, -0.0266],
      [-0.1362, -0.0286],
      [-0.1335, -0.0291],
      [-0.1292, -0.0291],
      [-0.1270, -0.0282],
      [-0.1248, -0.0291],
      [-0.1205, -0.0291],
      [-0.1178, -0.0286],
      [-0.1167, -0.0266],
      [-0.1167, -0.0214],
      [-0.1178, -0.0194],
      [-0.1205, -0.0189],
      [-0.1248, -0.0189],
      [-0.1270, -0.0198],
      [-0.1292, -0.0189],
      [-0.1335, -0.0189],
      [-0.1362, -0.0194],
      [-0.1373, -0.0214],
    ],
    44,
    true,
  );
  const latchRightPlate = buildVariableLoft(
    latchRightOutline,
    [],
    (x, _y) => 0.0026 - 0.0005 * smoothstep(0.0068, 0.0088, Math.abs(x + 0.127)),
    { maxTriangleEdge: 0.0032, subdivRounds: 1, wallRings: 11, rollSpan: 0.0016, edgeFactor: 0.84, wallCrown: 0, zOffset: 0.0206 },
  );
  const latchLeftOutline: Vec2[] = sampleCatmull2D(
    [
      [-0.1358, -0.0265],
      [-0.1348, -0.0286],
      [-0.1322, -0.0290],
      [-0.1270, -0.0286],
      [-0.1218, -0.0290],
      [-0.1192, -0.0286],
      [-0.1182, -0.0265],
      [-0.1182, -0.0215],
      [-0.1192, -0.0194],
      [-0.1218, -0.0190],
      [-0.1270, -0.0194],
      [-0.1322, -0.0190],
      [-0.1348, -0.0194],
      [-0.1358, -0.0215],
    ],
    36,
    true,
  );
  const latchLeftCatchBar = buildVariableLoft(
    latchLeftOutline,
    [],
    (x, _y) => 0.0026 - 0.0004 * smoothstep(0.0055, 0.0075, Math.abs(x + 0.127)),
    { maxTriangleEdge: 0.0032, subdivRounds: 1, wallRings: 11, rollSpan: 0.0016, edgeFactor: 0.84, wallCrown: 0, zOffset: -0.0206 },
  );
  const takedownLatchGeo = mergeGeometries([latchCrossShaft, latchRightPlate, latchLeftCatchBar]);
  registerComponent(
    {
      id: 'receiver_takedown_latch',
      level: 'micro',
      parent: 'polymer_stock_chassis',
      parentSocket: 'takedown_cross_slot',
      socketPos: [-0.127, -0.0240, 0],
      destructionGroup: 'chassis_group',
      materialId: 'mat_receiver_anodized',
    },
    takedownLatchGeo,
  );

  const magReleaseGeo = buildVariableLoft(
    [
      [-0.228, -0.060],
      [-0.204, -0.060],
      [-0.208, -0.076],
      [-0.224, -0.082],
      [-0.236, -0.080],
    ],
    [],
    () => 0.0108,
    { maxTriangleEdge: 0.009, subdivRounds: 1, wallRings: 13, rollSpan: 0.003, edgeFactor: 0.78, wallCrown: 0 },
  );
  registerComponent(
    {
      id: 'magazine_release_paddle',
      level: 'micro',
      parent: 'polymer_stock_chassis',
      parentSocket: 'mag_release_pin',
      socketPos: [-0.218, -0.074, 0],
      destructionGroup: 'chassis_group',
      materialId: 'mat_rubber_buttpad',
      isPivot: true,
      pivotPos: [-0.218, -0.074, 0],
    },
    magReleaseGeo,
  );

  // Turned cylindrical flat-topped chamfered barrel lock button (~1.4 mm proud of receiver wall hw=0.0204 -> Z=+0.0218)
  const barrelLockGeo = buildLatheProfile(
    [
      [0.0002, 0.0032],
      [0.0010, 0.0042],
      [0.0212, 0.0042],
      [0.0218, 0.0034],
    ],
    { axis: 'z', segments: 24, center: [0.112, 0.0045, 0], maxAxialStep: 0.0012 },
  );
  registerComponent(
    {
      id: 'barrel_lock_pin_right',
      level: 'micro',
      parent: 'upper_receiver_metal',
      parentSocket: 'barrel_lock_bore',
      socketPos: [0.112, 0.0045, 0.02],
      destructionGroup: 'receiver_group',
      materialId: 'mat_receiver_anodized',
    },
    barrelLockGeo,
  );

  // Stock cross-pins: pin1 aligned with rear sling swivel (Y=-0.044), pin2 lower rear (Y=-0.130), pin3 discrete behind magwell ([-0.228, -0.064])
  const pin1 = buildLatheProfile(
    [
      [-0.0204, 0.0024],
      [-0.0195, 0.0034],
      [0.0218, 0.0034],
      [0.0224, 0.0022],
    ],
    { axis: 'z', segments: 14, center: [-0.352, -0.044, 0], maxAxialStep: 0.0025 },
  );
  const pin2 = buildLatheProfile(
    [
      [-0.0202, 0.0018],
      [-0.0196, 0.0028],
      [0.0196, 0.0028],
      [0.0202, 0.0018],
    ],
    { axis: 'z', segments: 14, center: [-0.352, -0.130, 0], maxAxialStep: 0.0025 },
  );
  const pin3 = buildLatheProfile(
    [
      [-0.0140, 0.0014],
      [-0.0135, 0.0021],
      [0.0214, 0.0021],
      [0.0218, 0.0014],
    ],
    { axis: 'z', segments: 14, center: [-0.228, -0.064, 0], maxAxialStep: 0.0025 },
  );
  const stockPinsGeo = mergeGeometries([pin1, pin2, pin3]);
  registerComponent(
    {
      id: 'stock_cross_pins',
      level: 'micro',
      parent: 'polymer_stock_chassis',
      parentSocket: 'stock_pin_bores',
      socketPos: [-0.352, -0.06, 0],
      destructionGroup: 'chassis_group',
      materialId: 'mat_barrel_parkerized',
    },
    stockPinsGeo,
  );

  // Left (-Z) vertical latch plate (~10.5x21mm flat plate + raised horizontal top lip + recessed upper hole) & discrete lower stock pin (Y=-0.068)
  const vLatchPlateOutline: Vec2[] = [
    [-0.2196, -0.0495],
    [-0.2104, -0.0495],
    [-0.2098, -0.0487],
    [-0.2098, -0.0293],
    [-0.2104, -0.0285],
    [-0.2196, -0.0285],
    [-0.2202, -0.0293],
    [-0.2202, -0.0487],
  ];
  const vLatchPlateGeo = buildVariableLoft(
    vLatchPlateOutline,
    [],
    (x, y) => {
      const rHole = Math.hypot(x + 0.215, y + 0.0375);
      const holeRecess = 0.0009 * (1 - smoothstep(0.0008, 0.0036, rHole));
      return 0.0054 - holeRecess;
    },
    {
      maxTriangleEdge: 0.0035,
      subdivRounds: 2,
      wallRings: 15,
      rollSpan: 0.0016,
      edgeFactor: 0.86,
      wallCrown: 0,
      zOffset: -0.0176,
    },
  );
  const vLatchUpperLip = buildSharpChamferedBox([-0.215, -0.0303, -0.0239], [0.0108, 0.0034, 0.0014], 0.0004, 6, 2);
  const vLatchLowerPin = buildLatheProfile(
    [
      [-0.0213, 0.0012],
      [-0.0209, 0.0018],
      [-0.0170, 0.0018],
      [-0.0165, 0.0012],
    ],
    { axis: 'z', segments: 16, center: [-0.215, -0.068, 0], maxAxialStep: 0.0012 },
  );
  const leftVerticalLatchGeo = mergeGeometries([vLatchPlateGeo, vLatchUpperLip, vLatchLowerPin]);
  registerComponent(
    {
      id: 'left_stock_vertical_latch',
      level: 'micro',
      parent: 'polymer_stock_chassis',
      parentSocket: 'left_vertical_latch_slot',
      socketPos: [-0.215, -0.048, -0.022],
      destructionGroup: 'chassis_group',
      materialId: 'mat_receiver_anodized',
    },
    leftVerticalLatchGeo,
  );

  root.updateMatrixWorld(true);
  for (const [id, mesh] of Object.entries(meshes)) {
    colliders[id] = computeBoxCollider(mesh);
  }

  const runtime: SculptRuntime = {
    nodes,
    meshes,
    sockets,
    colliders,
    destructionGroups,
    pivots,
  };

  const setMode = (nextMode: RenderMode) => {
    for (const mesh of Object.values(meshes)) {
      const targetMat =
        nextMode === 'clay'
          ? ((mesh.userData.clayMaterial as THREE.Material | THREE.Material[]) ?? clay)
          : (mesh.userData.shadedMaterial as THREE.Material | THREE.Material[]);
      if (targetMat) {
        mesh.material = targetMat;
      }
    }
  };

  const setWireframe = (wireframe: boolean) => {
    clay.wireframe = wireframe;
    for (const m of Object.values(shaded)) {
      if ('wireframe' in m) {
        (m as THREE.MeshStandardMaterial).wireframe = wireframe;
      }
    }
  };

  if (options.wireframe) {
    setWireframe(true);
  }

  root.userData.sculptRuntime = runtime;
  root.userData.renderControls = {
    setMode,
    setWireframe,
    materials: shaded,
    clayMaterial: clay,
  };

  return { root, runtime, textureLibrary };
}
