import * as THREE from 'three';
import GUI from 'lil-gui';
import { createAugA1Model, RenderMode } from './createAugA1Model';
import { exportAugA1ToGLB } from './exportGLB';
import { countDistinctZ } from './geometryHelpers';
import { LightingPreset, setupAugScene, SetViewOptions, ViewName } from './scene';

function showError(msg: string) {
  console.error('[AUG A1 Error]:', msg);
  const banner = document.getElementById('error-banner');
  if (banner) {
    banner.style.display = 'block';
    banner.textContent = `Aviso: ${msg}`;
  }
}

window.addEventListener('error', (e) => showError(e.message));
window.addEventListener('unhandledrejection', (e) => showError(String(e.reason)));

type ActionState = {
  foregripFold: number;
  magEject: number;
  chargingPull: number;
  triggerPull: number;
  safetySafe: boolean;
};

const PART_LABELS_PT: Record<string, string> = {
  polymer_stock_chassis: 'Coronha Monobloco Polímero Bullpup',
  rubber_buttpad: 'Soleira de Borracha Estriada',
  enlarged_trigger_guard_loop: 'Guarda-Mato Envolvente Ampliado',
  waffle_magazine_assembly: 'Carregador Waffle Translúcido (30 rnd)',
  mag_floorplate: 'Basepad do Carregador',
  mag_internal_stack: 'Mecanismo Interno (Mola, Seguidor e Cartuchos 5.56)',
  waffle_rib_grid_right: 'Grade Waffle 3D Direita',
  waffle_rib_grid_left: 'Grade Waffle 3D Esquerda',
  ejection_port_right: 'Janela de Ejeção e Defletor (Direita)',
  ejection_blanking_plate_left: 'Tampa de Ejeção Fechada (Esquerda)',
  rear_sling_swivel_left: 'Zarelho Traseiro de Bandoleira (Esquerda)',
  progressive_trigger: 'Gatilho Progressivo (Semi / Auto)',
  crossbolt_safety: 'Trava de Segurança Transversal',
  receiver_takedown_latch: 'Trava de Desmontagem do Receptor',
  magazine_release_paddle: 'Retém do Carregador',
  stock_cross_pins: 'Pinos Transversais da Coronha',
  left_stock_vertical_latch: 'Trava Vertical Traseira (Esquerda)',
  upper_receiver_metal: 'Receptor Superior em Alumínio Forjado',
  integrated_optic_carry_handle: 'Alça de Transporte / Base Óptica Integrada',
  optic_rear_strut: 'Suporte Traseiro da Luneta',
  optic_front_strut: 'Suporte Frontal da Luneta',
  optic_main_tube: 'Tubo Principal da Luneta Swarovski 1.5×',
  optic_ocular_bell: 'Sino Ocular Traseiro da Luneta',
  optic_turret_housing: 'Torres de Ajuste (Elevação / Deriva)',
  optic_lenses: 'Lentes Ópticas Revestidas',
  backup_iron_sights: 'Miras Metálicas de Emergência',
  barrel_gas_muzzle_assembly: 'Cano Flutuante 508 mm (Troca Rápida)',
  gas_regulator_block: 'Bloco Regulador de Gases',
  barrel_clamp_lug: 'Braçadeira / Suporte do Cano',
  tulip_flash_hider: 'Quebra-Chamas Tulipa (3 Fendas)',
  flash_hider_slots: 'Aletas do Quebra-Chamas Tulipa',
  folding_vertical_foregrip: 'Empunhadura Frontal Vertical Dobrável',
  foregrip_hinge_bracket: 'Garfo e Pino da Dobradiça do Foregrip',
  left_charging_handle_assembly: 'Alavanca de Manejo Dobrável (Esquerda)',
  barrel_lock_pin_right: 'Botão de Trava Rápida do Cano (Direita)',
};

const MATERIAL_LABELS_PT: Record<string, string> = {
  mat_polymer_od: 'Polímero OD Fosco Texturizado',
  mat_receiver_anodized: 'Alumínio Anodizado Grafite',
  mat_optic_worn_metal: 'Liga Óptica Pintada c/ Desgaste',
  mat_barrel_parkerized: 'Aço Fosfatizado (Parkerized)',
  mat_mag_translucent: 'Polímero Âmbar Translúcido',
  mat_mag_floorplate: 'Polímero Basepad Escuro',
  mat_rubber_buttpad: 'Borracha / Polímero Preto Fosco',
  mat_optic_glass: 'Vidro Óptico Multicamada',
  mat_mag_internals: 'Latão / Cobre / Aço da Mola',
};

const LEVEL_LABELS_PT: Record<string, string> = {
  macro: 'MACRO',
  meso: 'MESO',
  micro: 'MICRO',
};

function smoothstep(edge0: number, edge1: number, x: number): number {
  const span = edge1 - edge0;
  if (Math.abs(span) < 1e-8) return x >= edge0 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / span));
  return t * t * (3 - 2 * t);
}

const urlParams = new URLSearchParams(window.location.search);
const initialMode: RenderMode = urlParams.get('mode') === 'clay' ? 'clay' : 'shaded';
const initialBg = urlParams.get('bg')
  ? `#${urlParams.get('bg')!.replace(/^#/, '')}`
  : initialMode === 'clay'
    ? '#ffffff'
    : '#eef1f4';
const initialView = (urlParams.get('view') as ViewName | null) ?? 'three_quarter_front';

(window as any).__interactive = false;
(window as any).__READY__ = false;
(window as any).__TEXTURES_LOADED__ = false;

try {
  const container = document.getElementById('canvas-container') as HTMLElement;
  if (!container) {
    throw new Error('Elemento #canvas-container não encontrado');
  }

  const ctx = setupAugScene(container);
  const { root, runtime, textureLibrary } = createAugA1Model({ mode: initialMode });
  (window as any).__TEXTURES_LOADED__ = Boolean(textureLibrary?.allLoaded);
  ctx.scene.add(root);

  const renderControls = root.userData.renderControls as {
    setMode: (mode: RenderMode) => void;
    setWireframe: (wireframe: boolean) => void;
  };

  // Precompute explode rest state in world space & topological order
  root.updateMatrixWorld(true);
  const overallBox = new THREE.Box3().setFromObject(root);
  const modelCenter = overallBox.getCenter(new THREE.Vector3());

  const restLocalPos: Record<string, THREE.Vector3> = {};
  const partWorldCenter: Record<string, THREE.Vector3> = {};
  const topoOrder: string[] = [];

  const childrenByParent: Record<string, string[]> = {};
  for (const [id, mesh] of Object.entries(runtime.meshes)) {
    const parentId = String(mesh.userData.sculptComponent?.parent ?? 'root');
    (childrenByParent[parentId] ??= []).push(id);
  }
  const queue = ['root'];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr !== 'root') topoOrder.push(curr);
    for (const child of childrenByParent[curr] ?? []) {
      queue.push(child);
    }
  }

  for (const id of topoOrder) {
    const node = runtime.nodes[id];
    const mesh = runtime.meshes[id];
    if (!node || !mesh) continue;
    restLocalPos[id] = node.position.clone();
    const b = new THREE.Box3().setFromObject(mesh);
    partWorldCenter[id] = b.isEmpty() ? modelCenter.clone() : b.getCenter(new THREE.Vector3());
  }

  const fanDirections: Record<string, THREE.Vector3> = {
    upper_receiver_metal: new THREE.Vector3(0, 0.045, 0),
    integrated_optic_carry_handle: new THREE.Vector3(0, 0.08, 0),
    optic_main_tube: new THREE.Vector3(0, 0.12, 0),
    optic_ocular_bell: new THREE.Vector3(-0.07, 0.12, 0),
    optic_front_strut: new THREE.Vector3(0.03, 0.09, 0.025),
    optic_rear_strut: new THREE.Vector3(-0.02, 0.09, -0.025),
    optic_turret_housing: new THREE.Vector3(0, 0.155, 0),
    optic_lenses: new THREE.Vector3(0, 0.12, 0.03),
    backup_iron_sights: new THREE.Vector3(0, 0.16, 0),
    ejection_port_right: new THREE.Vector3(0, 0.02, 0.065),
    ejection_blanking_plate_left: new THREE.Vector3(0, 0.02, -0.065),
    left_charging_handle_assembly: new THREE.Vector3(0.02, 0.05, -0.075),
    rear_sling_swivel_left: new THREE.Vector3(-0.03, 0, -0.065),
    barrel_lock_pin_right: new THREE.Vector3(0.01, 0.03, 0.06),
    receiver_takedown_latch: new THREE.Vector3(0, -0.04, -0.055),
    left_stock_vertical_latch: new THREE.Vector3(0, -0.02, -0.065),
    crossbolt_safety: new THREE.Vector3(0, -0.01, 0.055),
    progressive_trigger: new THREE.Vector3(0.01, -0.05, 0.035),
    stock_cross_pins: new THREE.Vector3(-0.02, -0.02, 0.06),
    mag_internal_stack: new THREE.Vector3(0, -0.02, 0.065),
    mag_floorplate: new THREE.Vector3(0.01, -0.08, 0),
    foregrip_hinge_bracket: new THREE.Vector3(0, -0.03, 0.045),
    gas_regulator_block: new THREE.Vector3(0.03, -0.045, 0),
    barrel_clamp_lug: new THREE.Vector3(0.05, 0.04, 0),
    tulip_flash_hider: new THREE.Vector3(0.11, 0, 0),
  };

  // Mechanical action state (target + smooth current)
  const MAG_EJECT_DIR = new THREE.Vector3(
    -Math.sin(THREE.MathUtils.degToRad(17)),
    -Math.cos(THREE.MathUtils.degToRad(17)),
    0,
  );
  const actionTarget: ActionState = {
    foregripFold: 0,
    magEject: 0,
    chargingPull: 0,
    triggerPull: 0,
    safetySafe: false,
  };
  const actionCurrent = {
    foregripFold: 0,
    magEject: 0,
    chargingPull: 0,
    triggerPull: 0,
    safetyBlend: 0,
  };
  let explodeAmount = 0;
  let wireframeEnabled = false;
  let currentMode: RenderMode = initialMode;
  let isActionAnimating = false;

  const guiParams = {
    modo: initialMode,
    iluminacao: 'reference-match' as LightingPreset,
    fundo: initialBg,
    explodir: 0.0,
    malha: false,
    yawEsquerda: 5.0,
    foregripFold: false,
    magEject: false,
    chargingPull: false,
    triggerPull: false,
    safetySafe: false,
  };

  function getActionOffsetForId(id: string): THREE.Vector3 {
    if (id === 'waffle_magazine_assembly') {
      return MAG_EJECT_DIR.clone().multiplyScalar(0.135 * actionCurrent.magEject);
    }
    if (id === 'left_charging_handle_assembly') {
      return new THREE.Vector3(-0.072 * actionCurrent.chargingPull, 0, 0);
    }
    if (id === 'progressive_trigger') {
      return new THREE.Vector3(-0.007 * actionCurrent.triggerPull, 0, 0);
    }
    if (id === 'crossbolt_safety') {
      return new THREE.Vector3(0, 0, -0.0032 * actionCurrent.safetyBlend);
    }
    return new THREE.Vector3();
  }

  function applyArticulationsAndExplode(renderFrame = true) {
    const a = Math.max(0, explodeAmount);
    const desiredWorldShift: Record<string, THREE.Vector3> = {
      root: new THREE.Vector3(0, 0, 0),
    };

    for (const id of topoOrder) {
      const node = runtime.nodes[id];
      const mesh = runtime.meshes[id];
      if (!node || !mesh) continue;
      const parentId = String(mesh.userData.sculptComponent?.parent ?? 'root');
      const parentShift = desiredWorldShift[parentId] ?? new THREE.Vector3();

      let explodeLocalDelta = new THREE.Vector3();
      if (a <= 1e-5) {
        desiredWorldShift[id] = new THREE.Vector3();
      } else if (mesh.userData.explodeWithParent) {
        desiredWorldShift[id] = parentShift.clone();
      } else {
        const radial = partWorldCenter[id].clone().sub(modelCenter).multiplyScalar(a * 1.15);
        const fan = (fanDirections[id] ?? new THREE.Vector3()).clone().multiplyScalar(a);
        const worldShift = radial.add(fan);
        desiredWorldShift[id] = worldShift;
        explodeLocalDelta = worldShift.clone().sub(parentShift);
      }

      const actionOffset = getActionOffsetForId(id);
      node.position.copy(restLocalPos[id]).add(explodeLocalDelta).add(actionOffset);
    }

    const foregripPivot = runtime.pivots.pivot_foregrip ?? runtime.pivots.folding_vertical_foregrip;
    if (foregripPivot) {
      foregripPivot.rotation.set(0, 0, 1.46 * actionCurrent.foregripFold);
    }
    const chargingPivot =
      runtime.pivots.pivot_charging_handle ?? runtime.pivots.left_charging_handle_assembly;
    if (chargingPivot) {
      const lockTilt = -0.18 * smoothstep(0.75, 1.0, actionCurrent.chargingPull);
      chargingPivot.rotation.set(lockTilt, 0, 0);
    }

    root.updateMatrixWorld(true);
    if (renderFrame) {
      ctx.renderOnce();
    }
  }

  function syncActionButtonsAndGui() {
    guiParams.foregripFold = actionTarget.foregripFold >= 0.5;
    guiParams.magEject = actionTarget.magEject >= 0.5;
    guiParams.chargingPull = actionTarget.chargingPull >= 0.5;
    guiParams.triggerPull = actionTarget.triggerPull >= 0.5;
    guiParams.safetySafe = actionTarget.safetySafe;
    guiParams.explodir = explodeAmount;

    const btnFg = document.getElementById('btn-foregrip');
    const stFg = document.getElementById('state-foregrip');
    btnFg?.classList.toggle('active', guiParams.foregripFold);
    if (stFg) stFg.textContent = guiParams.foregripFold ? 'Dobrado' : 'Aberto';

    const btnMag = document.getElementById('btn-mag');
    const stMag = document.getElementById('state-mag');
    btnMag?.classList.toggle('active', guiParams.magEject);
    if (stMag) stMag.textContent = guiParams.magEject ? 'Ejetado' : 'Inserido';

    const btnCh = document.getElementById('btn-charging');
    const stCh = document.getElementById('state-charging');
    btnCh?.classList.toggle('active', guiParams.chargingPull);
    if (stCh) stCh.textContent = guiParams.chargingPull ? 'Travada' : 'Fechada';

    const btnTr = document.getElementById('btn-trigger');
    const stTr = document.getElementById('state-trigger');
    btnTr?.classList.toggle('active', guiParams.triggerPull);
    if (stTr) stTr.textContent = guiParams.triggerPull ? 'Acionado' : 'Repouso';

    const btnSf = document.getElementById('btn-safety');
    const stSf = document.getElementById('state-safety');
    btnSf?.classList.toggle('active', guiParams.safetySafe);
    if (stSf) stSf.textContent = guiParams.safetySafe ? 'Seguro' : 'Fogo';
  }

  function setActionState(patch: Partial<ActionState>, animateSmooth = false) {
    if (patch.foregripFold !== undefined) {
      actionTarget.foregripFold = THREE.MathUtils.clamp(patch.foregripFold, 0, 1);
    }
    if (patch.magEject !== undefined) {
      actionTarget.magEject = THREE.MathUtils.clamp(patch.magEject, 0, 1);
    }
    if (patch.chargingPull !== undefined) {
      actionTarget.chargingPull = THREE.MathUtils.clamp(patch.chargingPull, 0, 1);
    }
    if (patch.triggerPull !== undefined) {
      actionTarget.triggerPull = THREE.MathUtils.clamp(patch.triggerPull, 0, 1);
    }
    if (patch.safetySafe !== undefined) {
      actionTarget.safetySafe = Boolean(patch.safetySafe);
    }

    syncActionButtonsAndGui();

    if (animateSmooth) {
      isActionAnimating = true;
      (window as any).__interactive = true;
    } else {
      actionCurrent.foregripFold = actionTarget.foregripFold;
      actionCurrent.magEject = actionTarget.magEject;
      actionCurrent.chargingPull = actionTarget.chargingPull;
      actionCurrent.triggerPull = actionTarget.triggerPull;
      actionCurrent.safetyBlend = actionTarget.safetySafe ? 1 : 0;
      isActionAnimating = false;
      applyArticulationsAndExplode(true);
    }
  }

  function setExplode(amount: number) {
    explodeAmount = Math.max(0, amount);
    guiParams.explodir = explodeAmount;
    applyArticulationsAndExplode(true);
  }

  // Clickable Part Selection (Raycaster + floating PT-BR inspector)
  let selectedPartId: string | null = null;
  const HIGHLIGHT_EMISSIVE = new THREE.Color('#7ca83e');

  function clearMaterialHighlight(mesh: THREE.Mesh) {
    const saved = mesh.userData.savedBeforeSelectMaterial;
    if (!saved) return;
    const current = mesh.material;
    mesh.material = saved;
    delete mesh.userData.savedBeforeSelectMaterial;
    if (Array.isArray(current)) {
      current.forEach((m) => m.dispose());
    } else if (current) {
      current.dispose();
    }
  }

  function applyMaterialHighlight(mesh: THREE.Mesh) {
    if (mesh.userData.savedBeforeSelectMaterial) return;
    const orig = mesh.material;
    mesh.userData.savedBeforeSelectMaterial = orig;
    const cloneWithHighlight = (mat: THREE.Material): THREE.Material => {
      const cloned = mat.clone();
      if (cloned instanceof THREE.MeshStandardMaterial) {
        cloned.emissive.copy(HIGHLIGHT_EMISSIVE);
        cloned.emissiveIntensity = 0.24;
      }
      return cloned;
    };
    mesh.material = Array.isArray(orig) ? orig.map(cloneWithHighlight) : cloneWithHighlight(orig);
  }

  function updateInspectorUI(id: string | null) {
    const card = document.getElementById('part-inspector');
    if (!card) return;
    if (!id || !runtime.meshes[id]) {
      card.classList.remove('visible');
      return;
    }

    const mesh = runtime.meshes[id];
    const sc = mesh.userData.sculptComponent ?? {};
    const geo = mesh.geometry as THREE.BufferGeometry;
    const idx = geo.getIndex();
    const pos = geo.getAttribute('position');
    const triCount = idx ? Math.floor(idx.count / 3) : pos ? Math.floor(pos.count / 3) : 0;
    const matId = String(mesh.userData.materialId ?? sc.material ?? 'mat_polymer_od');
    const level = String(sc.level ?? 'meso');
    const group = String(sc.destructionGroup ?? 'default');

    const elLevel = document.getElementById('inspector-level');
    const elTitle = document.getElementById('inspector-title');
    const elId = document.getElementById('inspector-id');
    const elMat = document.getElementById('inspector-material');
    const elGrp = document.getElementById('inspector-group');
    const elTris = document.getElementById('inspector-tris');

    if (elLevel) elLevel.textContent = LEVEL_LABELS_PT[level] ?? level.toUpperCase();
    if (elTitle) elTitle.textContent = PART_LABELS_PT[id] ?? id;
    if (elId) elId.textContent = id;
    if (elMat) elMat.textContent = `${MATERIAL_LABELS_PT[matId] ?? matId} (${matId})`;
    if (elGrp) elGrp.textContent = group;
    if (elTris) elTris.textContent = triCount.toLocaleString('pt-BR');

    card.classList.add('visible');
  }

  function selectPart(id: string | null) {
    if (selectedPartId && runtime.meshes[selectedPartId]) {
      clearMaterialHighlight(runtime.meshes[selectedPartId]);
    }
    if (id && runtime.meshes[id]) {
      selectedPartId = id;
      applyMaterialHighlight(runtime.meshes[id]);
    } else {
      selectedPartId = null;
    }
    updateInspectorUI(selectedPartId);
    ctx.renderOnce();
  }

  function setMode(mode: RenderMode) {
    const prevSelected = selectedPartId;
    if (prevSelected && runtime.meshes[prevSelected]) {
      clearMaterialHighlight(runtime.meshes[prevSelected]);
    }
    currentMode = mode;
    guiParams.modo = mode;
    renderControls.setMode(mode);
    ctx.setLightingForMode(mode);
    if (prevSelected && runtime.meshes[prevSelected]) {
      applyMaterialHighlight(runtime.meshes[prevSelected]);
    }
    ctx.renderOnce();
  }

  function setView(name: ViewName, opts?: SetViewOptions) {
    ctx.setView(name, opts);
    document.querySelectorAll<HTMLButtonElement>('.view-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === name);
    });
    const closeupSelect = document.getElementById('closeup-select') as HTMLSelectElement | null;
    if (closeupSelect) {
      const isCloseup = Array.from(closeupSelect.options).some((opt) => opt.value === name);
      closeupSelect.value = isCloseup ? name : '';
      closeupSelect.classList.toggle('active', isCloseup);
    }
  }

  function setBackground(hex: string) {
    ctx.setBackground(hex);
  }

  function setLightingPreset(preset: LightingPreset) {
    guiParams.iluminacao = preset;
    ctx.setLightingPreset(preset);
  }

  async function runExportGLB(download = true): Promise<number> {
    const savedExplode = explodeAmount;
    const savedWireframe = wireframeEnabled;
    const savedSelected = selectedPartId;
    const savedMode = currentMode;
    const savedActionTarget = { ...actionTarget };
    const savedActionCurrent = { ...actionCurrent };

    try {
      if (savedSelected) selectPart(null);
      if (savedWireframe) {
        renderControls.setWireframe(false);
      }
      if (savedMode !== 'shaded') {
        renderControls.setMode('shaded');
      }
      explodeAmount = 0;
      actionCurrent.foregripFold = 0;
      actionCurrent.magEject = 0;
      actionCurrent.chargingPull = 0;
      actionCurrent.triggerPull = 0;
      actionCurrent.safetyBlend = 0;
      applyArticulationsAndExplode(false);

      const bytes = await exportAugA1ToGLB(root, {
        fileName: 'steyr-aug-a1.glb',
        download,
      });
      return bytes;
    } finally {
      explodeAmount = savedExplode;
      actionTarget.foregripFold = savedActionTarget.foregripFold;
      actionTarget.magEject = savedActionTarget.magEject;
      actionTarget.chargingPull = savedActionTarget.chargingPull;
      actionTarget.triggerPull = savedActionTarget.triggerPull;
      actionTarget.safetySafe = savedActionTarget.safetySafe;
      actionCurrent.foregripFold = savedActionCurrent.foregripFold;
      actionCurrent.magEject = savedActionCurrent.magEject;
      actionCurrent.chargingPull = savedActionCurrent.chargingPull;
      actionCurrent.triggerPull = savedActionCurrent.triggerPull;
      actionCurrent.safetyBlend = savedActionCurrent.safetyBlend;
      applyArticulationsAndExplode(false);
      if (savedMode !== 'shaded') {
        renderControls.setMode(savedMode);
      }
      if (savedWireframe) {
        renderControls.setWireframe(true);
      }
      if (savedSelected) {
        selectPart(savedSelected);
      }
      ctx.renderOnce();
    }
  }

  function exportDiagnostics() {
    root.updateMatrixWorld(true);
    let unnamedMeshes = 0;
    const parts: any[] = [];
    const meshesData: any[] = [];
    const measuredAnchors: Record<string, [number, number, number]> = {};

    const normalMat = new THREE.Matrix3();
    const vTmp = new THREE.Vector3();
    const nTmp = new THREE.Vector3();

    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (!obj.name || obj.name.trim() === '') {
        unnamedMeshes += 1;
        return;
      }
      const sc = obj.userData.sculptComponent ?? {};
      const geo = obj.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position');
      const norm = geo.getAttribute('normal');
      const idx = geo.getIndex();
      if (!pos) return;

      normalMat.getNormalMatrix(obj.matrixWorld);

      const vertices: [number, number, number][] = [];
      const normals: [number, number, number][] = [];
      const zSet = new Set<number>();

      let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
      let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;

      for (let i = 0; i < pos.count; i += 1) {
        vTmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(obj.matrixWorld);
        vertices.push([vTmp.x, vTmp.y, vTmp.z]);
        zSet.add(Math.round(vTmp.z * 1000));
        if (vTmp.x < minX) minX = vTmp.x;
        if (vTmp.y < minY) minY = vTmp.y;
        if (vTmp.z < minZ) minZ = vTmp.z;
        if (vTmp.x > maxX) maxX = vTmp.x;
        if (vTmp.y > maxY) maxY = vTmp.y;
        if (vTmp.z > maxZ) maxZ = vTmp.z;

        if (norm) {
          nTmp.set(norm.getX(i), norm.getY(i), norm.getZ(i)).applyMatrix3(normalMat).normalize();
          normals.push([nTmp.x, nTmp.y, nTmp.z]);
        }
      }

      const indices: number[] = [];
      if (idx) {
        for (let i = 0; i < idx.count; i += 1) {
          indices.push(idx.getX(i));
        }
      } else {
        for (let i = 0; i < pos.count; i += 1) {
          indices.push(i);
        }
      }

      const triCount = Math.floor(indices.length / 3);
      const distinctZ = zSet.size;

      parts.push({
        name: obj.name,
        kind: obj.userData.explodeWithParent ? 'relief' : 'part',
        module: sc.destructionGroup ?? 'default',
        parent: sc.parent ?? 'root',
        level: sc.level ?? 'meso',
        triangles: triCount,
        distinctZ,
        explodeWithParent: Boolean(obj.userData.explodeWithParent),
      });

      meshesData.push({
        id: obj.name,
        name: obj.name,
        vertices,
        normals,
        indices,
        triangleCount: triCount,
        distinctZ,
        bounds: {
          min: [minX, minY, minZ],
          max: [maxX, maxY, maxZ],
        },
      });

      measuredAnchors[obj.name] = [
        (minX + maxX) * 0.5,
        (minY + maxY) * 0.5,
        (minZ + maxZ) * 0.5,
      ];
    });

    return {
      partsManifest: {
        model: 'steyr-aug-a1',
        parts,
        unnamedMeshes,
        integralMeshes: parts.length,
      },
      meshesData: {
        model: 'steyr-aug-a1',
        meshes: meshesData,
      },
      measuredAnchors,
    };
  }

  // Raycaster click picking on canvas (distinguishing click from orbit drag < 5px)
  const raycaster = new THREE.Raycaster();
  const pointerDownPos = { x: 0, y: 0, active: false };
  const pickTargets = Object.values(runtime.meshes);

  ctx.renderer.domElement.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    pointerDownPos.x = ev.clientX;
    pointerDownPos.y = ev.clientY;
    pointerDownPos.active = true;
  });

  ctx.renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!pointerDownPos.active || ev.button !== 0) return;
    pointerDownPos.active = false;
    const dist = Math.hypot(ev.clientX - pointerDownPos.x, ev.clientY - pointerDownPos.y);
    if (dist >= 5) return;

    const rect = ctx.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, ctx.getActiveCamera());
    const hits = raycaster.intersectObjects(pickTargets, false);
    if (hits.length > 0 && hits[0].object instanceof THREE.Mesh) {
      const hitId = hits[0].object.name;
      selectPart(hitId === selectedPartId ? null : hitId);
    } else {
      selectPart(null);
    }
  });

  // Expose deterministic API on window
  (window as any).__SET_VIEW__ = setView;
  (window as any).__SET_MODE__ = setMode;
  (window as any).__SET_BG__ = setBackground;
  (window as any).__SET_EXPLODE__ = setExplode;
  (window as any).__SET_LIGHTING_PRESET__ = setLightingPreset;
  (window as any).__SET_ACTION_STATE__ = (patch: Partial<ActionState>) =>
    setActionState(patch, false);
  (window as any).__SELECT_PART__ = (id: string | null) => selectPart(id);
  (window as any).__EXPORT_GLB_TEST__ = () => runExportGLB(false);
  (window as any).__EXPORT_DIAGNOSTICS__ = exportDiagnostics;
  (window as any).__AUG_MODEL__ = { root, runtime, textureLibrary, countDistinctZ };

  // Bind HTML UI controls
  document.querySelectorAll<HTMLButtonElement>('.view-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view as ViewName | undefined;
      if (view) setView(view);
    });
  });

  const closeupSelect = document.getElementById('closeup-select') as HTMLSelectElement | null;
  closeupSelect?.addEventListener('change', () => {
    const val = closeupSelect.value as ViewName | '';
    if (val) setView(val);
  });

  document.getElementById('clear-selection-btn')?.addEventListener('click', () => {
    selectPart(null);
  });

  document.getElementById('btn-foregrip')?.addEventListener('click', () => {
    setActionState({ foregripFold: actionTarget.foregripFold >= 0.5 ? 0 : 1 }, true);
  });
  document.getElementById('btn-mag')?.addEventListener('click', () => {
    setActionState({ magEject: actionTarget.magEject >= 0.5 ? 0 : 1 }, true);
  });
  document.getElementById('btn-charging')?.addEventListener('click', () => {
    setActionState({ chargingPull: actionTarget.chargingPull >= 0.5 ? 0 : 1 }, true);
  });
  document.getElementById('btn-trigger')?.addEventListener('click', () => {
    setActionState({ triggerPull: actionTarget.triggerPull >= 0.5 ? 0 : 1 }, true);
  });
  document.getElementById('btn-safety')?.addEventListener('click', () => {
    setActionState({ safetySafe: !actionTarget.safetySafe }, true);
  });
  document.getElementById('btn-export-glb')?.addEventListener('click', () => {
    void runExportGLB(true).catch((err) => showError(err?.message || String(err)));
  });

  const refToggle = document.getElementById('ref-toggle');
  const refOverlay = document.getElementById('ref-overlay') as HTMLImageElement | null;
  let refVisible = false;
  refToggle?.addEventListener('click', () => {
    refVisible = !refVisible;
    if (refOverlay) refOverlay.style.opacity = refVisible ? '0.45' : '0';
    if (refToggle) {
      refToggle.textContent = refVisible ? 'Ocultar Referência' : 'Overlay Ref. Direita';
    }
    if (refVisible) {
      setView('right');
    }
  });

  // Setup organized lil-gui folders
  try {
    const gui = new GUI({ title: 'Steyr AUG A1 • Controles' });

    const actionsFolder = gui.addFolder('Ações Mecânicas');
    actionsFolder
      .add(guiParams, 'foregripFold')
      .name('Dobrar Foregrip')
      .listen()
      .onChange((v: boolean) => setActionState({ foregripFold: v ? 1 : 0 }, true));
    actionsFolder
      .add(guiParams, 'magEject')
      .name('Ejetar Carregador')
      .listen()
      .onChange((v: boolean) => setActionState({ magEject: v ? 1 : 0 }, true));
    actionsFolder
      .add(guiParams, 'chargingPull')
      .name('Alavanca Manejo')
      .listen()
      .onChange((v: boolean) => setActionState({ chargingPull: v ? 1 : 0 }, true));
    actionsFolder
      .add(guiParams, 'triggerPull')
      .name('Acionar Gatilho')
      .listen()
      .onChange((v: boolean) => setActionState({ triggerPull: v ? 1 : 0 }, true));
    actionsFolder
      .add(guiParams, 'safetySafe')
      .name('Trava Segura')
      .listen()
      .onChange((v: boolean) => setActionState({ safetySafe: v }, true));
    actionsFolder
      .add(
        {
          reset: () =>
            setActionState(
              { foregripFold: 0, magEject: 0, chargingPull: 0, triggerPull: 0, safetySafe: false },
              true,
            ),
        },
        'reset',
      )
      .name('Resetar Ações');

    const inspectFolder = gui.addFolder('Explosão & Inspeção');
    inspectFolder
      .add(guiParams, 'explodir', 0, 1.4, 0.02)
      .name('Explodir Peças')
      .listen()
      .onChange((v: number) => setExplode(v));
    inspectFolder
      .add(guiParams, 'malha')
      .name('Wireframe')
      .onChange((v: boolean) => {
        wireframeEnabled = v;
        renderControls.setWireframe(v);
        ctx.renderOnce();
      });
    inspectFolder
      .add({ clearSel: () => selectPart(null) }, 'clearSel')
      .name('Limpar Seleção');
    inspectFolder
      .add(
        {
          exportGlb: () => {
            void runExportGLB(true).catch((err) => showError(err?.message || String(err)));
          },
        },
        'exportGlb',
      )
      .name('Exportar .GLB');

    const lookdevFolder = gui.addFolder('Look-Dev PBR');
    lookdevFolder
      .add(guiParams, 'modo', ['shaded', 'clay'])
      .name('Modo Render')
      .listen()
      .onChange((v: RenderMode) => setMode(v));
    lookdevFolder
      .add(guiParams, 'iluminacao', ['reference-match', 'neutral', 'grazing'])
      .name('Iluminação')
      .listen()
      .onChange((v: LightingPreset) => setLightingPreset(v));
    lookdevFolder
      .add(guiParams, 'fundo', ['#eef1f4', '#ffffff', '#1b2028'])
      .name('Fundo')
      .onChange((v: string) => setBackground(v));
    lookdevFolder
      .add(guiParams, 'yawEsquerda', -12, 12, 0.5)
      .name('Yaw Vista Esq (°)')
      .onChange((v: number) => setView('left', { yawDeg: v }));
  } catch (guiErr) {
    console.warn('lil-gui warning:', guiErr);
  }

  // Apply initial state & render deterministically
  syncActionButtonsAndGui();
  setBackground(initialBg);
  setLightingPreset('reference-match');
  setMode(initialMode);
  setView(initialView);
  ctx.renderOnce();
  (window as any).__READY__ = true;

  // Render loop only updates OrbitControls / smooth lerps once user interacts or triggers action
  let lastTime = performance.now();
  function animate(now = performance.now()) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
    lastTime = now;

    if (isActionAnimating) {
      const alpha = 1 - Math.exp(-10 * dt);
      const targetSafety = actionTarget.safetySafe ? 1 : 0;

      actionCurrent.foregripFold = THREE.MathUtils.lerp(
        actionCurrent.foregripFold,
        actionTarget.foregripFold,
        alpha,
      );
      actionCurrent.magEject = THREE.MathUtils.lerp(
        actionCurrent.magEject,
        actionTarget.magEject,
        alpha,
      );
      actionCurrent.chargingPull = THREE.MathUtils.lerp(
        actionCurrent.chargingPull,
        actionTarget.chargingPull,
        alpha,
      );
      actionCurrent.triggerPull = THREE.MathUtils.lerp(
        actionCurrent.triggerPull,
        actionTarget.triggerPull,
        alpha,
      );
      actionCurrent.safetyBlend = THREE.MathUtils.lerp(
        actionCurrent.safetyBlend,
        targetSafety,
        alpha,
      );

      const maxDiff = Math.max(
        Math.abs(actionTarget.foregripFold - actionCurrent.foregripFold),
        Math.abs(actionTarget.magEject - actionCurrent.magEject),
        Math.abs(actionTarget.chargingPull - actionCurrent.chargingPull),
        Math.abs(actionTarget.triggerPull - actionCurrent.triggerPull),
        Math.abs(targetSafety - actionCurrent.safetyBlend),
      );
      if (maxDiff < 1e-4) {
        actionCurrent.foregripFold = actionTarget.foregripFold;
        actionCurrent.magEject = actionTarget.magEject;
        actionCurrent.chargingPull = actionTarget.chargingPull;
        actionCurrent.triggerPull = actionTarget.triggerPull;
        actionCurrent.safetyBlend = targetSafety;
        isActionAnimating = false;
      }
      applyArticulationsAndExplode(false);
    }

    if ((window as any).__interactive) {
      ctx.controls.update();
      ctx.renderOnce();
    }
  }
  animate();
} catch (err: any) {
  showError(err?.message || String(err));
}
