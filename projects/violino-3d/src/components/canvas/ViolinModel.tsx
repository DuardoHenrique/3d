"use client";

import React, { useRef, useMemo, useEffect } from "react";
import { useFrame, ThreeEvent } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { audioEngine, VIOLIN_STRINGS } from "@/lib/audioEngine";
import { ParticleBurst } from "./StringParticles";

interface ViolinModelProps {
  onHoverString?: (stringId: string | null, color: string | null) => void;
  onParticleBurst?: (burst: ParticleBurst) => void;
  setIsOverViolin?: (over: boolean) => void;
  ignoreWhileDragging?: boolean;
  externalPulse?: { stringId: string; nonce: number } | null;
}

interface StringVibrationState {
  amplitude: number;
  frequency: number;
  startTime: number;
  color: THREE.Color;
  initialX: number;
}

export const ViolinModel: React.FC<ViolinModelProps> = ({
  onHoverString,
  onParticleBurst,
  setIsOverViolin,
  ignoreWhileDragging = false,
  externalPulse = null,
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const gltf = useGLTF("/models/violin.glb");

  const vibrations = useRef<Record<string, StringVibrationState>>({
    String_G: { amplitude: 0, frequency: 196, startTime: 0, color: new THREE.Color("#FF0055"), initialX: 0 },
    String_D: { amplitude: 0, frequency: 293.66, startTime: 0, color: new THREE.Color("#00F5D4"), initialX: 0 },
    String_A: { amplitude: 0, frequency: 440, startTime: 0, color: new THREE.Color("#FF7B00"), initialX: 0 },
    String_E: { amplitude: 0, frequency: 659.25, startTime: 0, color: new THREE.Color("#7B2CBF"), initialX: 0 },
  });

  const stringMeshes = useRef<Record<string, THREE.Mesh>>({});

  const clonedScene = useMemo(() => {
    const scene = gltf.scene.clone(true);

    scene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        const name = mesh.name;
        const lowerName = name.toLowerCase();
        const existingMat = mesh.material as any;
        const textureMap = existingMat?.map || null;

        // 1. Strings
        if (name.startsWith("String_")) {
          stringMeshes.current[name] = mesh;
          vibrations.current[name] = {
            ...vibrations.current[name],
            initialX: mesh.position.x,
          };
          mesh.material = new THREE.MeshStandardMaterial({
            color: new THREE.Color("#FFFFFF"),
            roughness: 0.08,
            metalness: 0.98,
          });
        }
        // 2. Invisible Hitboxes (7x radius)
        else if (name.startsWith("Hitbox_")) {
          mesh.material = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 0.0,
            depthWrite: false,
          });
        }
        // 3. Meshes with Photogrammetric Texture Map from GLB
        else if (textureMap) {
          textureMap.colorSpace = THREE.SRGBColorSpace;
          mesh.material = new THREE.MeshPhysicalMaterial({
            map: textureMap,
            roughness: 0.42,
            metalness: 0.01,
            clearcoat: 0.20,
            clearcoatRoughness: 0.45,
            ior: 1.45,
          });
        }
        // 4. Ebony Fingerboard & Nut
        else if (lowerName.includes("fingerboard") || lowerName.includes("nut")) {
          mesh.material = new THREE.MeshStandardMaterial({
            color: new THREE.Color("#121216"),
            roughness: 0.35,
            metalness: 0.04,
          });
        }
        // 5. Boxwood Pegs & Accessories
        else if (lowerName.includes("peg") || lowerName.includes("boxwood")) {
          mesh.material = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color("#7A3214"),
            roughness: 0.28,
            clearcoat: 0.55,
            clearcoatRoughness: 0.15,
          });
        }
        // 6. Flamed Maple Varnish (Neck, Ribs, Back, Pegbox)
        else {
          mesh.material = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color("#48120b"),
            roughness: 0.38,
            metalness: 0.02,
            clearcoat: 0.25,
            clearcoatRoughness: 0.35,
          });
        }
      }
    });

    return scene;
  }, [gltf]);

  const handleTriggerString = (stringId: string, point?: THREE.Vector3) => {
    const stringData = VIOLIN_STRINGS[stringId];
    if (!stringData) return;

    audioEngine.playString(stringId, "4n");

    const vib = vibrations.current[stringId];
    if (vib) {
      vib.amplitude = 0.045;
      vib.startTime = performance.now();
    }

    if (onParticleBurst && point) {
      onParticleBurst({
        id: Math.random(),
        position: point.clone(),
        color: new THREE.Color(stringData.color),
        time: performance.now(),
      });
    }

    if (onHoverString) {
      onHoverString(stringId, stringData.color);
    }
  };

  useEffect(() => {
    if (!externalPulse) return;
    const vib = vibrations.current[externalPulse.stringId];
    if (vib) {
      vib.amplitude = 0.045;
      vib.startTime = performance.now();
    }
  }, [externalPulse]);

  useFrame(() => {
    const now = performance.now();

    Object.entries(vibrations.current).forEach(([id, vib]) => {
      const mesh = stringMeshes.current[id];
      if (!mesh) return;

      if (vib.amplitude > 0.0005) {
        const elapsed = (now - vib.startTime) / 1000;
        const currentAmp = vib.amplitude * Math.exp(-7.5 * elapsed);
        const displacement = currentAmp * Math.sin(vib.frequency * elapsed * 0.15);

        mesh.position.x = vib.initialX + displacement;

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
      }
    });
  });

  const stringList = ["String_G", "String_D", "String_A", "String_E"];

  return (
    <group
      ref={groupRef}
      onPointerEnter={() => setIsOverViolin && setIsOverViolin(true)}
      onPointerLeave={() => {
        if (setIsOverViolin) setIsOverViolin(false);
        if (onHoverString) onHoverString(null, null);
      }}
    >
      <primitive object={clonedScene} />

      {/* 4 Paired Invisible Hitboxes (Technical Adjustment 1) */}
      {stringList.map((strId) => {
        const xPos = {
          String_G: -0.15,
          String_D: -0.05,
          String_A: 0.05,
          String_E: 0.15,
        }[strId] || 0;

        return (
          <mesh
            key={strId}
            position={[xPos, 1.45, 0.45]}
            rotation={[0, 0, 0]}
            onPointerEnter={(e: ThreeEvent<PointerEvent>) => {
              e.stopPropagation();
              if (ignoreWhileDragging && e.buttons !== 0) return;
              if (setIsOverViolin) setIsOverViolin(true);
              handleTriggerString(strId, e.point);
            }}
            onPointerMove={(e: ThreeEvent<PointerEvent>) => {
              e.stopPropagation();
              if (ignoreWhileDragging && e.buttons !== 0) return;
              if (setIsOverViolin) setIsOverViolin(true);
              const vib = vibrations.current[strId];
              if (vib && vib.amplitude < 0.008) {
                handleTriggerString(strId, e.point);
              }
            }}
            onClick={(e: ThreeEvent<MouseEvent>) => {
              e.stopPropagation();
              handleTriggerString(strId, e.point);
            }}
          >
            <cylinderGeometry args={[0.085, 0.085, 3.2, 16]} />
            <meshBasicMaterial transparent opacity={0.0} depthWrite={false} />
          </mesh>
        );
      })}
    </group>
  );
};

useGLTF.preload("/models/violin.glb");
