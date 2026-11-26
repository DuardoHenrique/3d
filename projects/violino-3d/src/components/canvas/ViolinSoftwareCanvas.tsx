"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { audioEngine, VIOLIN_STRINGS } from "@/lib/audioEngine";
import {
  VIOLIN_CAMERA_PRESETS,
  ViolinCameraPreset,
} from "./violinPresets";

interface RenderTri {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  depth: number;
  fill: string;
}

class ViolinSoftwareRenderer {
  public domElement: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width = 800;
  private height = 600;
  private pixelRatio = 1;
  private triPool: RenderTri[] = [];
  private projScreenMatrix = new THREE.Matrix4();
  private viewMatrix = new THREE.Matrix4();
  private worldPosA = new THREE.Vector3();
  private worldPosB = new THREE.Vector3();
  private worldPosC = new THREE.Vector3();
  private viewPosA = new THREE.Vector3();
  private viewPosB = new THREE.Vector3();
  private viewPosC = new THREE.Vector3();
  private ndcA = new THREE.Vector3();
  private ndcB = new THREE.Vector3();
  private ndcC = new THREE.Vector3();
  private faceNormal = new THREE.Vector3();
  private edge1 = new THREE.Vector3();
  private edge2 = new THREE.Vector3();
  private viewDir = new THREE.Vector3();
  private centroid = new THREE.Vector3();
  private halfVecKey = new THREE.Vector3();

  private keyLightDir = new THREE.Vector3(1.5, 4.5, 6.5).normalize();
  private rimLightDir = new THREE.Vector3(-3.0, 2.0, 4.0).normalize();
  private accentLightDir = new THREE.Vector3(5.0, -0.8, 3.5).normalize();
  private defaultColor = new THREE.Color(0x6b1d12);
  private defaultEmissive = new THREE.Color(0x000000);

  constructor(width: number, height: number) {
    this.domElement = document.createElement("canvas");
    const context = this.domElement.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Canvas 2D context unavailable");
    }
    this.ctx = context;
    this.setSize(width, height);
  }

  public setPixelRatio(pr: number) {
    this.pixelRatio = Math.min(Math.max(1, pr), 1.25);
    this.setSize(this.width, this.height);
  }

  public setSize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.domElement.width = Math.floor(this.width * this.pixelRatio);
    this.domElement.height = Math.floor(this.height * this.pixelRatio);
    this.domElement.style.width = `${this.width}px`;
    this.domElement.style.height = `${this.height}px`;
  }

  private getTri(index: number): RenderTri {
    if (index >= this.triPool.length) {
      this.triPool.push({
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        depth: 0,
        fill: "",
      });
    }
    return this.triPool[index];
  }

  public render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const ctx = this.ctx;
    const W = this.domElement.width;
    const H = this.domElement.height;
    const halfW = W * 0.5;
    const halfH = H * 0.5;

    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    this.viewMatrix.copy(camera.matrixWorldInverse);
    this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, this.viewMatrix);
    const camPos = camera.position;

    const grad = ctx.createRadialGradient(
      halfW,
      halfH * 0.85,
      20,
      halfW,
      halfH,
      Math.max(W, H) * 0.75
    );
    grad.addColorStop(0, "#190a3b");
    grad.addColorStop(0.55, "#0c0424");
    grad.addColorStop(1, "#080318");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    let triCount = 0;

    scene.traverse((obj) => {
      if (!obj.visible || !(obj instanceof THREE.Mesh)) return;
      const mat = obj.material as THREE.MeshStandardMaterial;
      if (!mat) return;
      if (mat.transparent && (mat.opacity ?? 1) <= 0.02) return;

      const geo = obj.geometry as THREE.BufferGeometry;
      const posAttr = geo.getAttribute("position");
      if (!posAttr) return;

      const indexAttr = geo.index;
      const worldMat = obj.matrixWorld;
      const detSign = worldMat.determinant() < 0 ? -1 : 1;
      const isDoubleSide = mat.side === THREE.DoubleSide;

      const baseColor = mat.color ?? this.defaultColor;
      const emissiveColor = mat.emissive ?? this.defaultEmissive;
      const emissiveIntensity = mat.emissiveIntensity ?? 0;
      const metalness = mat.metalness ?? 0.05;

      const rBase = baseColor.r * 255;
      const gBase = baseColor.g * 255;
      const bBase = baseColor.b * 255;
      const rEm = emissiveColor.r * 255 * emissiveIntensity;
      const gEm = emissiveColor.g * 255 * emissiveIntensity;
      const bEm = emissiveColor.b * 255 * emissiveIntensity;

      const processTriangle = (i0: number, i1: number, i2: number) => {
        this.worldPosA.fromBufferAttribute(posAttr, i0).applyMatrix4(worldMat);
        this.worldPosB.fromBufferAttribute(posAttr, i1).applyMatrix4(worldMat);
        this.worldPosC.fromBufferAttribute(posAttr, i2).applyMatrix4(worldMat);

        this.viewPosA.copy(this.worldPosA).applyMatrix4(this.viewMatrix);
        this.viewPosB.copy(this.worldPosB).applyMatrix4(this.viewMatrix);
        this.viewPosC.copy(this.worldPosC).applyMatrix4(this.viewMatrix);

        if (
          this.viewPosA.z > -0.1 ||
          this.viewPosB.z > -0.1 ||
          this.viewPosC.z > -0.1
        ) {
          return;
        }

        this.ndcA.copy(this.worldPosA).applyMatrix4(this.projScreenMatrix);
        this.ndcB.copy(this.worldPosB).applyMatrix4(this.projScreenMatrix);
        this.ndcC.copy(this.worldPosC).applyMatrix4(this.projScreenMatrix);

        const x0 = (this.ndcA.x + 1) * halfW;
        const y0 = (-this.ndcA.y + 1) * halfH;
        const x1 = (this.ndcB.x + 1) * halfW;
        const y1 = (-this.ndcB.y + 1) * halfH;
        const x2 = (this.ndcC.x + 1) * halfW;
        const y2 = (-this.ndcC.y + 1) * halfH;

        const cross2D = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
        if (!isDoubleSide && cross2D * detSign >= 0) return;
        if (Math.abs(cross2D) < 0.25) return;

        this.edge1.subVectors(this.worldPosB, this.worldPosA);
        this.edge2.subVectors(this.worldPosC, this.worldPosA);
        this.faceNormal.crossVectors(this.edge1, this.edge2).normalize();

        this.centroid
          .copy(this.worldPosA)
          .add(this.worldPosB)
          .add(this.worldPosC)
          .multiplyScalar(0.333333);
        this.viewDir.subVectors(camPos, this.centroid).normalize();
        if (this.faceNormal.dot(this.viewDir) < 0) {
          this.faceNormal.negate();
        }

        const ndotlKey = Math.max(0, this.faceNormal.dot(this.keyLightDir));
        const ndotlRim = Math.max(0, this.faceNormal.dot(this.rimLightDir));
        const ndotlAcc = Math.max(0, this.faceNormal.dot(this.accentLightDir));

        this.halfVecKey.addVectors(this.keyLightDir, this.viewDir).normalize();
        const spec = Math.pow(Math.max(0, this.faceNormal.dot(this.halfVecKey)), 18);

        const diff = 0.36 + 0.62 * ndotlKey;
        const r = Math.min(
          255,
          Math.max(0, rBase * diff + ndotlAcc * 45 + rEm + spec * (60 + metalness * 140))
        ) | 0;
        const g = Math.min(
          255,
          Math.max(0, gBase * diff + ndotlRim * 45 + gEm + spec * (55 + metalness * 130))
        ) | 0;
        const b = Math.min(
          255,
          Math.max(0, bBase * diff + ndotlRim * 55 + ndotlAcc * 25 + bEm + spec * (50 + metalness * 130))
        ) | 0;

        const tri = this.getTri(triCount++);
        tri.x0 = x0;
        tri.y0 = y0;
        tri.x1 = x1;
        tri.y1 = y1;
        tri.x2 = x2;
        tri.y2 = y2;
        tri.depth = (this.viewPosA.z + this.viewPosB.z + this.viewPosC.z) * 0.333333;
        tri.fill = `rgb(${r},${g},${b})`;
      };

      if (indexAttr) {
        const count = indexAttr.count;
        for (let i = 0; i < count; i += 3) {
          processTriangle(indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2));
        }
      } else {
        const count = posAttr.count;
        for (let i = 0; i < count; i += 3) {
          processTriangle(i, i + 1, i + 2);
        }
      }
    });

    const activeTris = this.triPool.slice(0, triCount);
    activeTris.sort((a, b) => a.depth - b.depth);

    for (let i = 0; i < triCount; i++) {
      const t = activeTris[i];
      ctx.beginPath();
      ctx.moveTo(t.x0, t.y0);
      ctx.lineTo(t.x1, t.y1);
      ctx.lineTo(t.x2, t.y2);
      ctx.closePath();
      ctx.fillStyle = t.fill;
      ctx.fill();
    }
  }
}

interface ViolinSoftwareCanvasProps {
  preset: ViolinCameraPreset;
  resetToken: number;
  floating: boolean;
  externalPulse?: { stringId: string; nonce: number } | null;
  onHoverString?: (stringId: string | null, color: string | null) => void;
  setIsOverString?: (over: boolean) => void;
  onSoftwareMode?: () => void;
}

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
const VIOLIN_MODEL_URL = `${BASE_PATH}/models/violin.glb`;

export const ViolinSoftwareCanvas: React.FC<ViolinSoftwareCanvasProps> = ({
  preset,
  resetToken,
  floating,
  externalPulse = null,
  onHoverString,
  setIsOverString,
  onSoftwareMode,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const floatingRef = useRef(floating);
  floatingRef.current = floating;

  const presetTargetRef = useRef<{
    pos: THREE.Vector3;
    target: THREE.Vector3;
    animating: boolean;
  }>({
    pos: new THREE.Vector3(...VIOLIN_CAMERA_PRESETS.overview.position),
    target: new THREE.Vector3(...VIOLIN_CAMERA_PRESETS.overview.target),
    animating: false,
  });

  const vibrationsRef = useRef<
    Record<
      string,
      {
        amplitude: number;
        frequency: number;
        startTime: number;
        color: THREE.Color;
        initialX: number;
      }
    >
  >({
    String_G: { amplitude: 0, frequency: 196, startTime: 0, color: new THREE.Color("#FF0055"), initialX: 0 },
    String_D: { amplitude: 0, frequency: 293.66, startTime: 0, color: new THREE.Color("#00F5D4"), initialX: 0 },
    String_A: { amplitude: 0, frequency: 440, startTime: 0, color: new THREE.Color("#FF7B00"), initialX: 0 },
    String_E: { amplitude: 0, frequency: 659.25, startTime: 0, color: new THREE.Color("#7B2CBF"), initialX: 0 },
  });

  useEffect(() => {
    onSoftwareMode?.();
  }, [onSoftwareMode]);

  useEffect(() => {
    const cfg = VIOLIN_CAMERA_PRESETS[preset];
    const aspect =
      typeof window !== "undefined"
        ? (containerRef.current?.clientWidth || window.innerWidth) /
          Math.max(1, containerRef.current?.clientHeight || window.innerHeight)
        : 1;
    const distScale = aspect < 0.85 ? 1.18 : 1.0;
    const tx = cfg.target[0];
    const ty = cfg.target[1];
    const tz = cfg.target[2];
    presetTargetRef.current.pos.set(
      tx + (cfg.position[0] - tx) * distScale,
      ty + (cfg.position[1] - ty) * distScale,
      tz + (cfg.position[2] - tz) * distScale
    );
    presetTargetRef.current.target.set(tx, ty, tz);
    presetTargetRef.current.animating = true;
  }, [preset, resetToken]);

  useEffect(() => {
    if (!externalPulse) return;
    const vib = vibrationsRef.current[externalPulse.stringId];
    if (vib) {
      vib.amplitude = 0.045;
      vib.startTime = performance.now();
    }
  }, [externalPulse]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || window.innerWidth || 800;
    const height = container.clientHeight || window.innerHeight || 600;

    const renderer = new ViolinSoftwareRenderer(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 60);
    camera.position.set(...VIOLIN_CAMERA_PRESETS.overview.position);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 2.0;
    controls.maxDistance = 15.0;
    controls.target.set(...VIOLIN_CAMERA_PRESETS.overview.target);
    controls.update();

    let dirty = true;
    controls.addEventListener("start", () => {
      presetTargetRef.current.animating = false;
      dirty = true;
    });
    controls.addEventListener("change", () => {
      dirty = true;
    });

    const rootGroup = new THREE.Group();
    rootGroup.scale.setScalar(1.15);
    scene.add(rootGroup);

    const stringMeshes: Record<string, THREE.Mesh> = {};
    const hitboxMeshes: THREE.Mesh[] = [];

    const stringSpecs = [
      { id: "String_G", x: -0.15 },
      { id: "String_D", x: -0.05 },
      { id: "String_A", x: 0.05 },
      { id: "String_E", x: 0.15 },
    ];
    for (const s of stringSpecs) {
      const hitMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.085, 0.085, 3.2, 8),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      );
      hitMesh.position.set(s.x, 1.45, 0.45);
      hitMesh.userData.stringId = s.id;
      rootGroup.add(hitMesh);
      hitboxMeshes.push(hitMesh);
    }

    const loader = new GLTFLoader();
    loader.load(
      VIOLIN_MODEL_URL,
      (gltf) => {
        gltf.scene.traverse((child) => {
          if (!(child as THREE.Mesh).isMesh) return;
          const mesh = child as THREE.Mesh;
          const name = mesh.name;
          const lower = name.toLowerCase();

          if (name.startsWith("String_")) {
            stringMeshes[name] = mesh;
            if (vibrationsRef.current[name]) {
              vibrationsRef.current[name].initialX = mesh.position.x;
            }
            mesh.material = new THREE.MeshStandardMaterial({
              color: new THREE.Color("#FFFFFF"),
              metalness: 0.95,
              roughness: 0.1,
            });
          } else if (name.startsWith("Hitbox_")) {
            mesh.material = new THREE.MeshBasicMaterial({
              transparent: true,
              opacity: 0,
              depthWrite: false,
            });
          } else if (lower.includes("fingerboard") || lower.includes("nut")) {
            mesh.material = new THREE.MeshStandardMaterial({
              color: new THREE.Color("#141418"),
              metalness: 0.05,
            });
          } else if (lower.includes("peg") || lower.includes("boxwood")) {
            mesh.material = new THREE.MeshStandardMaterial({
              color: new THREE.Color("#8B3A18"),
              metalness: 0.05,
            });
          } else if (lower.includes("bridge")) {
            mesh.material = new THREE.MeshStandardMaterial({
              color: new THREE.Color("#D4A76A"),
              metalness: 0.02,
            });
          } else if (lower.includes("tuner")) {
            mesh.material = new THREE.MeshStandardMaterial({
              color: new THREE.Color("#D4AF37"),
              metalness: 0.9,
            });
          } else {
            mesh.material = new THREE.MeshStandardMaterial({
              color: new THREE.Color("#7B2412"),
              metalness: 0.05,
            });
          }
        });
        rootGroup.add(gltf.scene);
        dirty = true;
      },
      undefined,
      (err) => {
        console.error("Failed to load violin GLB in software mode:", err);
        setLoadError("Não foi possível carregar o modelo 3D do violino.");
      }
    );

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let lastHoveredId: string | null = null;

    const triggerString = (strId: string) => {
      const info = VIOLIN_STRINGS[strId];
      if (!info) return;
      audioEngine.playString(strId, "4n");
      const vib = vibrationsRef.current[strId];
      if (vib) {
        vib.amplitude = 0.045;
        vib.startTime = performance.now();
      }
      onHoverString?.(strId, info.color);
      dirty = true;
    };

    const pickString = (ev: PointerEvent | MouseEvent): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(hitboxMeshes, false);
      return (hits[0]?.object?.userData?.stringId as string) || null;
    };

    const handlePointerMove = (ev: PointerEvent) => {
      if (ev.buttons !== 0) return;
      const hitId = pickString(ev);
      setIsOverString?.(Boolean(hitId));
      if (hitId && hitId !== lastHoveredId) {
        lastHoveredId = hitId;
        triggerString(hitId);
      } else if (!hitId && lastHoveredId) {
        lastHoveredId = null;
        onHoverString?.(null, null);
      }
    };

    const handleClick = (ev: MouseEvent) => {
      const hitId = pickString(ev);
      if (hitId) triggerString(hitId);
    };

    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("click", handleClick);

    const handleResize = () => {
      const w = container.clientWidth || window.innerWidth || 800;
      const h = container.clientHeight || window.innerHeight || 600;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      dirty = true;
    };
    window.addEventListener("resize", handleResize);

    let rafId = 0;
    let lastNow = performance.now();
    const startClock = lastNow;

    const animate = (now: number) => {
      rafId = requestAnimationFrame(animate);
      const dt = Math.min(0.05, Math.max(0.001, (now - lastNow) / 1000));
      lastNow = now;

      if (presetTargetRef.current.animating) {
        const alpha = 1 - Math.exp(-8 * dt);
        camera.position.lerp(presetTargetRef.current.pos, alpha);
        controls.target.lerp(presetTargetRef.current.target, alpha);
        if (
          camera.position.distanceTo(presetTargetRef.current.pos) < 0.02 &&
          controls.target.distanceTo(presetTargetRef.current.target) < 0.02
        ) {
          camera.position.copy(presetTargetRef.current.pos);
          controls.target.copy(presetTargetRef.current.target);
          presetTargetRef.current.animating = false;
        }
        dirty = true;
      }

      if (floatingRef.current) {
        const t = (now - startClock) / 1000;
        rootGroup.position.y = Math.sin(t * 1.1) * 0.05;
        rootGroup.rotation.y = Math.sin(t * 0.55) * 0.04;
        dirty = true;
      }

      Object.entries(vibrationsRef.current).forEach(([id, vib]) => {
        const mesh = stringMeshes[id];
        if (!mesh) return;
        if (vib.amplitude > 0.0005) {
          const elapsed = (now - vib.startTime) / 1000;
          const currentAmp = vib.amplitude * Math.exp(-7.5 * elapsed);
          mesh.position.x = vib.initialX + currentAmp * Math.sin(vib.frequency * elapsed * 0.15);
          const mat = mesh.material as THREE.MeshStandardMaterial;
          if (mat) {
            mat.emissive = vib.color;
            mat.emissiveIntensity = currentAmp * 45;
          }
          if (currentAmp <= 0.0005) {
            vib.amplitude = 0;
            mesh.position.x = vib.initialX;
            if (mat) mat.emissiveIntensity = 0;
          }
          dirty = true;
        }
      });

      const moved = controls.update();
      if (moved || dirty) {
        dirty = false;
        renderer.render(scene, camera);
      }
    };

    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("click", handleClick);
      controls.dispose();
    };
  }, [onHoverString, setIsOverString]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-void/90 text-sm text-red-300 font-mono">
          {loadError}
        </div>
      )}
    </div>
  );
};
