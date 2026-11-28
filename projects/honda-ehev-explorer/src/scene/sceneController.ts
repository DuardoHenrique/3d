import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ENGINE_PARTS, EnginePartMetadata } from '../data/partsMetadata';
import {
  createHondaEngineBayModel,
  HondaEngineBayAssembly,
} from './createHondaEngineBayModel';
import { MaterialController, VisualPartMode } from './materialController';

export interface SceneSnapshot {
  selectedId: string | null;
  hoveredId: string | null;
  explodeFactor: number;
  isBaseVisible: boolean;
  showAllLabels: boolean;
  inspectedUseRealistic: boolean;
}

export interface ProjectedLabel {
  id: string;
  nome: string;
  nomeCurto: string;
  cor: string;
  x: number;
  y: number;
  visible: boolean;
  isHovered: boolean;
  isSelected: boolean;
}

interface CameraTween {
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  startTarget: THREE.Vector3;
  endTarget: THREE.Vector3;
  elapsed: number;
  duration: number;
}

const DEFAULT_CAMERA_POS = new THREE.Vector3(0.24, 1.42, 1.80);
const DEFAULT_CAMERA_TARGET = new THREE.Vector3(0.21, 0.15, 0.02);

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export class SceneController {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly assembly: HondaEngineBayAssembly;
  private readonly materialCtrl: MaterialController;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();

  private readonly stageTarget: THREE.Vector3;
  private readonly guideLine: THREE.Line;
  private readonly guideLineMat: THREE.LineDashedMaterial;
  private readonly originRing: THREE.Mesh;
  private readonly originRingMat: THREE.MeshBasicMaterial;
  private readonly contactShadow: THREE.Mesh;

  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private explodeTarget = 0;
  private explodeCurrent = 0;
  private isBaseVisible = true;
  private baseFadeCurrent = 1;
  private showAllLabels = false;
  private inspectedUseRealistic = false;

  private cameraTween: CameraTween | null = null;
  private pointerDownPos: { x: number; y: number } | null = null;
  private isPointerInsideCanvas = false;
  private rafId = 0;
  private lastFrameTime = performance.now();

  private readonly onStateChange: (snapshot: SceneSnapshot) => void;
  private readonly onLabelsUpdate: (labels: ProjectedLabel[]) => void;

  constructor(
    container: HTMLElement,
    onStateChange: (snapshot: SceneSnapshot) => void,
    onLabelsUpdate: (labels: ProjectedLabel[]) => void
  ) {
    this.container = container;
    this.onStateChange = onStateChange;
    this.onLabelsUpdate = onLabelsUpdate;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    container.appendChild(this.renderer.domElement);

    // Scene & PMREM Environment
    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const roomEnv = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(roomEnv, 0.04).texture;
    roomEnv.dispose();
    pmrem.dispose();

    // Camera & OrbitControls
    const aspect = Math.max(0.1, container.clientWidth / Math.max(1, container.clientHeight));
    this.camera = new THREE.PerspectiveCamera(40, aspect, 0.05, 40);
    this.camera.position.copy(this.getDefaultCameraPos());

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.target.copy(DEFAULT_CAMERA_TARGET);
    this.controls.minDistance = 0.42;
    this.controls.maxDistance = 5.5;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    // Adjustment #1: cancel camera tween immediately when user interacts
    this.controls.addEventListener('start', () => {
      this.cameraTween = null;
    });

    this.setupLighting();

    // Build 10-part procedural Honda e:HEV bay
    this.assembly = createHondaEngineBayModel();
    this.scene.add(this.assembly.root);
    this.materialCtrl = new MaterialController(this.assembly.parts);

    // Adjustment #2: elevated stage safely above max exploded height
    const stageY = Math.max(1.24, this.assembly.maxExplodedSceneY + 0.36);
    this.stageTarget = new THREE.Vector3(0, stageY, 0.04);

    // Subtle ground contact shadow beneath engine bay
    this.contactShadow = this.createContactShadow();
    this.scene.add(this.contactShadow);

    // Dashed guide line + origin anchor ring for stage inspection
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(0, 1, 0),
    ]);
    this.guideLineMat = new THREE.LineDashedMaterial({
      color: 0xffffff,
      dashSize: 0.04,
      gapSize: 0.025,
      transparent: true,
      opacity: 0.78,
    });
    this.guideLine = new THREE.Line(lineGeo, this.guideLineMat);
    this.guideLine.visible = false;
    this.scene.add(this.guideLine);

    this.originRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
    });
    this.originRing = new THREE.Mesh(
      new THREE.RingGeometry(0.032, 0.048, 24),
      this.originRingMat
    );
    this.originRing.rotation.x = -Math.PI / 2;
    this.originRing.visible = false;
    this.scene.add(this.originRing);

    // Bind events & start loop
    this.bindEvents();
    this.refreshMaterials();
    this.emitSnapshot();
    this.animate();

    // Expose read-only inspection hooks for img2threejs verification
    (window as unknown as Record<string, unknown>).__HONDA_EXPLORER__ = {
      getAssemblyRoot: () => this.assembly.root,
      getPartsCount: () => this.assembly.orderedParts.length,
      getStageTarget: () => this.stageTarget.toArray(),
      selectPart: (id: string | null) => this.selectPart(id),
      setExplodeFactor: (v: number) => this.setExplodeFactor(v),
      setBaseVisible: (v: boolean) => this.setBaseVisible(v),
    };
  }

  private setupLighting(): void {
    const keyLight = new THREE.DirectionalLight(0xfffbf2, 2.05);
    keyLight.position.set(2.2, 4.2, 2.8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 12;
    keyLight.shadow.camera.left = -1.8;
    keyLight.shadow.camera.right = 1.8;
    keyLight.shadow.camera.top = 1.8;
    keyLight.shadow.camera.bottom = -1.8;
    keyLight.shadow.bias = -0.0005;
    this.scene.add(keyLight);

    const fillLight = new THREE.HemisphereLight(0xdce8f7, 0x1a1e26, 1.05);
    this.scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xbbd6ff, 0.9);
    rimLight.position.set(-2.8, 2.4, -2.5);
    this.scene.add(rimLight);
  }

  private createContactShadow(): THREE.Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createRadialGradient(128, 128, 12, 128, 128, 124);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
      grad.addColorStop(0.65, 'rgba(0, 0, 0, 0.22)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 256);
    }
    const tex = new THREE.CanvasTexture(canvas);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 1.85),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, -0.075, 0.02);
    return mesh;
  }

  private bindEvents(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', this.handlePointerMove);
    el.addEventListener('pointerdown', this.handlePointerDown);
    el.addEventListener('pointerup', this.handlePointerUp);
    el.addEventListener('pointerleave', this.handlePointerLeave);
    window.addEventListener('resize', this.handleResize);
  }

  public dispose(): void {
    cancelAnimationFrame(this.rafId);
    const el = this.renderer.domElement;
    el.removeEventListener('pointermove', this.handlePointerMove);
    el.removeEventListener('pointerdown', this.handlePointerDown);
    el.removeEventListener('pointerup', this.handlePointerUp);
    el.removeEventListener('pointerleave', this.handlePointerLeave);
    window.removeEventListener('resize', this.handleResize);
    this.controls.dispose();
    this.renderer.dispose();
  }

  // Public API for HUD
  public getSnapshot(): SceneSnapshot {
    return {
      selectedId: this.selectedId,
      hoveredId: this.hoveredId,
      explodeFactor: this.explodeTarget,
      isBaseVisible: this.isBaseVisible,
      showAllLabels: this.showAllLabels,
      inspectedUseRealistic: this.inspectedUseRealistic,
    };
  }

  public getPartMetadata(id: string): EnginePartMetadata | undefined {
    return this.assembly.parts.get(id)?.metadata;
  }

  public selectPart(id: string | null): void {
    if (id !== null && !this.assembly.parts.has(id)) return;
    if (id === 'base-cofre' && !this.isBaseVisible) {
      this.isBaseVisible = true;
    }
    if (this.selectedId === id) return;

    this.selectedId = id;
    this.inspectedUseRealistic = false;
    this.updatePolarAngleLimit();
    this.refreshMaterials();

    if (id !== null) {
      const node = this.assembly.parts.get(id)!;
      const dist = this.getResponsiveDistance(node.metadata.raioInspecao);
      // Preserve current azimuth roughly while framing elevated stage
      const offset = this.camera.position.clone().sub(this.controls.target);
      if (offset.lengthSq() < 0.01) {
        offset.set(0.25, 0.45, 1.0);
      }
      offset.y = Math.max(offset.y, 0.28);
      offset.normalize().multiplyScalar(dist);
      const endPos = this.stageTarget.clone().add(offset);
      this.startCameraTween(endPos, this.stageTarget);
    } else {
      const targetY = this.explodeTarget > 0.2 ? 0.28 : DEFAULT_CAMERA_TARGET.y;
      const target = new THREE.Vector3(
        DEFAULT_CAMERA_TARGET.x,
        targetY,
        DEFAULT_CAMERA_TARGET.z
      );
      this.startCameraTween(this.getDefaultCameraPos(), target);
    }

    this.emitSnapshot();
  }

  public cycleSelectedPart(direction: -1 | 1): void {
    const selectable = ENGINE_PARTS.filter(
      (p) => this.isBaseVisible || p.id !== 'base-cofre'
    );
    if (selectable.length === 0) return;
    if (!this.selectedId) {
      this.selectPart(selectable[0].id);
      return;
    }
    const idx = selectable.findIndex((p) => p.id === this.selectedId);
    const nextIdx = (idx + direction + selectable.length) % selectable.length;
    this.selectPart(selectable[nextIdx].id);
  }

  public setHoveredPart(id: string | null): void {
    if (id === 'base-cofre' && !this.isBaseVisible) {
      id = null;
    }
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    this.renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
    this.refreshMaterials();
    this.emitSnapshot();
  }

  public setExplodeFactor(factor: number): void {
    const clamped = THREE.MathUtils.clamp(factor, 0, 1);
    if (Math.abs(this.explodeTarget - clamped) < 0.001) return;
    this.explodeTarget = clamped;
    this.emitSnapshot();
  }

  public setBaseVisible(visible: boolean): void {
    if (this.isBaseVisible === visible) return;
    this.isBaseVisible = visible;
    if (!visible && this.selectedId === 'base-cofre') {
      this.selectPart(null);
    }
    this.updatePolarAngleLimit();
    this.refreshMaterials();
    this.emitSnapshot();
  }

  public setShowAllLabels(show: boolean): void {
    if (this.showAllLabels === show) return;
    this.showAllLabels = show;
    this.emitSnapshot();
  }

  public toggleInspectedRealistic(): void {
    if (!this.selectedId) return;
    this.inspectedUseRealistic = !this.inspectedUseRealistic;
    this.refreshMaterials();
    this.emitSnapshot();
  }

  public resetCamera(): void {
    if (this.selectedId) {
      const node = this.assembly.parts.get(this.selectedId);
      const dist = this.getResponsiveDistance(node ? node.metadata.raioInspecao : 1.25);
      const endPos = this.stageTarget
        .clone()
        .add(new THREE.Vector3(0.25, 0.36, 0.9).normalize().multiplyScalar(dist));
      this.startCameraTween(endPos, this.stageTarget);
    } else {
      this.startCameraTween(this.getDefaultCameraPos(), DEFAULT_CAMERA_TARGET.clone());
    }
  }

  private getResponsiveDistance(baseDist: number): number {
    const aspect = this.camera.aspect || 1;
    if (aspect < 0.95) {
      return baseDist * Math.min(1.85, 1.08 / Math.max(0.45, aspect));
    }
    return baseDist;
  }

  private getDefaultCameraPos(): THREE.Vector3 {
    const pos = DEFAULT_CAMERA_POS.clone();
    const aspect = this.camera.aspect || 1;
    if (aspect < 0.95) {
      pos.multiplyScalar(Math.min(1.65, 1.0 / Math.max(0.55, aspect)));
    }
    return pos;
  }

  private updatePolarAngleLimit(): void {
    // Allow full 360° under-part inspection when inspecting on stage or when base is removed
    const allowFullOrbit = this.selectedId !== null || !this.isBaseVisible;
    this.controls.maxPolarAngle = allowFullOrbit ? Math.PI * 0.96 : Math.PI * 0.49;
  }

  private startCameraTween(endPos: THREE.Vector3, endTarget: THREE.Vector3): void {
    this.cameraTween = {
      startPos: this.camera.position.clone(),
      endPos: endPos.clone(),
      startTarget: this.controls.target.clone(),
      endTarget: endTarget.clone(),
      elapsed: 0,
      duration: 0.55,
    };
  }

  private resolvePartMode(partId: string): VisualPartMode {
    if (this.selectedId !== null) {
      if (partId === this.selectedId) {
        return this.inspectedUseRealistic ? 'inspected-realistic' : 'inspected-color';
      }
      if (partId === this.hoveredId) {
        return 'hovered';
      }
      return 'ghost';
    }
    if (partId === this.hoveredId) {
      return 'hovered';
    }
    return 'realistic';
  }

  private refreshMaterials(): void {
    for (const [partId, node] of this.assembly.parts.entries()) {
      const mode = this.resolvePartMode(partId);
      if (partId === 'base-cofre') {
        this.materialCtrl.applyBaseFade(partId, node, this.baseFadeCurrent, mode);
      } else {
        this.materialCtrl.applyMode(partId, mode);
      }
    }
  }

  private pickPartAtClientPoint(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);

    const targets: THREE.Object3D[] = [];
    for (const node of this.assembly.orderedParts) {
      if (node.group.visible) {
        targets.push(node.group);
      }
    }
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      const pid = hit.object.userData?.partId as string | undefined;
      if (pid) return pid;
    }
    return null;
  }

  private readonly handlePointerMove = (e: PointerEvent): void => {
    this.isPointerInsideCanvas = true;
    if (e.pointerType === 'touch') return;
    const hitId = this.pickPartAtClientPoint(e.clientX, e.clientY);
    this.setHoveredPart(hitId);
  };

  private readonly handlePointerDown = (e: PointerEvent): void => {
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
  };

  private readonly handlePointerUp = (e: PointerEvent): void => {
    if (!this.pointerDownPos) return;
    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    this.pointerDownPos = null;
    // Ignore orbit drags
    if (Math.hypot(dx, dy) > 6) return;

    const hitId = this.pickPartAtClientPoint(e.clientX, e.clientY);
    if (hitId) {
      this.selectPart(hitId);
    } else if (this.selectedId !== null) {
      this.selectPart(null);
    }
  };

  private readonly handlePointerLeave = (): void => {
    this.isPointerInsideCanvas = false;
    if (this.hoveredId !== null) {
      this.setHoveredPart(null);
    }
  };

  private readonly handleResize = (): void => {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private emitSnapshot(): void {
    this.onStateChange(this.getSnapshot());
  }

  private animate = (): void => {
    this.rafId = requestAnimationFrame(this.animate);
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;

    // Smoothly interpolate explode factor
    this.explodeCurrent = THREE.MathUtils.damp(this.explodeCurrent, this.explodeTarget, 9, dt);

    // Smoothly fade removable base-cofre with crisp end-snapping to restore depthWrite/transparent
    const baseTargetAlpha = this.isBaseVisible ? 1 : 0;
    const prevBaseAlpha = this.baseFadeCurrent;
    this.baseFadeCurrent = THREE.MathUtils.damp(this.baseFadeCurrent, baseTargetAlpha, 12, dt);
    if (this.isBaseVisible && this.baseFadeCurrent > 0.985) {
      this.baseFadeCurrent = 1;
    } else if (!this.isBaseVisible && this.baseFadeCurrent < 0.015) {
      this.baseFadeCurrent = 0;
    }
    const baseNode = this.assembly.parts.get('base-cofre');
    if (baseNode && Math.abs(this.baseFadeCurrent - prevBaseAlpha) > 0.0001) {
      this.materialCtrl.applyBaseFade(
        'base-cofre',
        baseNode,
        this.baseFadeCurrent,
        this.resolvePartMode('base-cofre')
      );
    }
    this.contactShadow.visible = this.baseFadeCurrent > 0.05;
    (this.contactShadow.material as THREE.MeshBasicMaterial).opacity =
      0.95 * this.baseFadeCurrent;

    // Interpolate all 10 part positions
    for (const node of this.assembly.orderedParts) {
      const targetPos = node.mountedPosition
        .clone()
        .addScaledVector(node.explodedOffset, this.explodeCurrent);

      if (node.metadata.id === 'base-cofre' && !this.isBaseVisible) {
        targetPos.y -= 0.16;
      }

      if (node.metadata.id === this.selectedId) {
        // Adjustment #4: align Box3 center of selected part directly to STAGE_TARGET
        targetPos.copy(this.stageTarget).sub(node.localBoxCenter);
      }

      node.group.position.x = THREE.MathUtils.damp(node.group.position.x, targetPos.x, 9, dt);
      node.group.position.y = THREE.MathUtils.damp(node.group.position.y, targetPos.y, 9, dt);
      node.group.position.z = THREE.MathUtils.damp(node.group.position.z, targetPos.z, 9, dt);
    }

    // Adjustment #2: update dashed guide line from current mounted/exploded center to current stage center
    if (this.selectedId) {
      const selNode = this.assembly.parts.get(this.selectedId);
      if (selNode) {
        const currentSlotCenter = selNode.mountedPosition
          .clone()
          .addScaledVector(selNode.explodedOffset, this.explodeCurrent)
          .add(selNode.localBoxCenter);
        const currentStageCenter = selNode.group.position
          .clone()
          .add(selNode.localBoxCenter);

        const posAttr = this.guideLine.geometry.getAttribute('position') as THREE.BufferAttribute;
        posAttr.setXYZ(0, currentSlotCenter.x, currentSlotCenter.y, currentSlotCenter.z);
        posAttr.setXYZ(1, currentStageCenter.x, currentStageCenter.y, currentStageCenter.z);
        posAttr.needsUpdate = true;
        this.guideLine.computeLineDistances();

        const partColor = new THREE.Color(selNode.metadata.cor);
        this.guideLineMat.color.copy(partColor);
        this.originRingMat.color.copy(partColor);
        this.originRing.position.set(
          currentSlotCenter.x,
          currentSlotCenter.y,
          currentSlotCenter.z
        );

        this.guideLine.visible = true;
        this.originRing.visible = true;
      }
    } else {
      this.guideLine.visible = false;
      this.originRing.visible = false;
    }

    // Adjustment #1: one-shot camera tween (cancelled immediately on OrbitControls 'start')
    if (this.cameraTween) {
      this.cameraTween.elapsed += dt;
      const rawT = Math.min(1, this.cameraTween.elapsed / this.cameraTween.duration);
      const t = easeOutCubic(rawT);
      this.camera.position.lerpVectors(
        this.cameraTween.startPos,
        this.cameraTween.endPos,
        t
      );
      this.controls.target.lerpVectors(
        this.cameraTween.startTarget,
        this.cameraTween.endTarget,
        t
      );
      if (rawT >= 1) {
        this.cameraTween = null;
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.emitProjectedLabels();
  };

  private emitProjectedLabels(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w <= 0 || h <= 0) return;

    const labels: ProjectedLabel[] = [];
    const worldVec = new THREE.Vector3();

    for (const node of this.assembly.orderedParts) {
      const id = node.metadata.id;
      if (id === 'base-cofre' && !this.isBaseVisible) continue;

      const isHovered = id === this.hoveredId;
      const isSelected = id === this.selectedId;
      if (isSelected) continue;
      // Show label when hovered, or when showAllLabels is enabled
      const shouldDisplay = isHovered || this.showAllLabels;
      if (!shouldDisplay) continue;

      // Project using current group position + local label anchor offset
      const anchorOffset = new THREE.Vector3(...node.metadata.ancoraRotulo).sub(
        node.mountedPosition
      );
      worldVec.copy(node.group.position).add(anchorOffset);
      worldVec.project(this.camera);

      if (worldVec.z > 1) continue;
      const x = (worldVec.x * 0.5 + 0.5) * w;
      const y = (-worldVec.y * 0.5 + 0.5) * h;

      labels.push({
        id,
        nome: node.metadata.nome,
        nomeCurto: node.metadata.nomeCurto,
        cor: node.metadata.cor,
        x,
        y,
        visible: x >= 24 && x <= w - 24 && y >= 24 && y <= h - 24,
        isHovered: isHovered || this.isPointerInsideCanvas && isHovered,
        isSelected,
      });
    }

    this.onLabelsUpdate(labels);
  }
}
