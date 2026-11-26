"use client";

import React, { useState, useRef, useEffect, Suspense } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Float } from "@react-three/drei";
import * as THREE from "three";
import { ViolinModel } from "./ViolinModel";
import { StringParticles, ParticleBurst } from "./StringParticles";

export type ViolinCameraPreset = "overview" | "strings" | "scroll" | "bridge" | "profile";

export const VIOLIN_CAMERA_PRESETS: Record<
  ViolinCameraPreset,
  { label: string; position: [number, number, number]; target: [number, number, number] }
> = {
  overview: {
    label: "Visão Geral",
    position: [0.6, 0.35, 8.6],
    target: [0, 0.05, 0],
  },
  strings: {
    label: "Cordas (Frente)",
    position: [0.0, 0.45, 5.2],
    target: [0, 0.35, 0.2],
  },
  scroll: {
    label: "Voluta & Cravelhas",
    position: [1.4, 2.7, 3.3],
    target: [0, 2.4, 0],
  },
  bridge: {
    label: "Cavalete & Efes",
    position: [2.2, -0.7, 3.2],
    target: [0, -1.0, 0.2],
  },
  profile: {
    label: "Perfil Lateral",
    position: [7.8, 0.2, 0.4],
    target: [0, 0.05, 0],
  },
};

interface CameraPresetRigProps {
  preset: ViolinCameraPreset;
  resetToken: number;
  controlsRef: React.RefObject<React.ElementRef<typeof OrbitControls> | null>;
}

const CameraPresetRig: React.FC<CameraPresetRigProps> = ({
  preset,
  resetToken,
  controlsRef,
}) => {
  const { camera } = useThree();
  const isAnimating = useRef(false);
  const desiredPos = useRef(new THREE.Vector3(...VIOLIN_CAMERA_PRESETS.overview.position));
  const desiredTarget = useRef(new THREE.Vector3(...VIOLIN_CAMERA_PRESETS.overview.target));

  useEffect(() => {
    const config = VIOLIN_CAMERA_PRESETS[preset];
    desiredPos.current.set(...config.position);
    desiredTarget.current.set(...config.target);
    isAnimating.current = true;
  }, [preset, resetToken]);

  useFrame((_, delta) => {
    if (!isAnimating.current || !controlsRef.current) return;

    const alpha = 1 - Math.exp(-8 * delta);
    camera.position.lerp(desiredPos.current, alpha);
    controlsRef.current.target.lerp(desiredTarget.current, alpha);
    controlsRef.current.update();

    if (
      camera.position.distanceTo(desiredPos.current) < 0.02 &&
      controlsRef.current.target.distanceTo(desiredTarget.current) < 0.02
    ) {
      camera.position.copy(desiredPos.current);
      controlsRef.current.target.copy(desiredTarget.current);
      controlsRef.current.update();
      isAnimating.current = false;
    }
  });

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const stopAnim = () => {
      isAnimating.current = false;
    };
    controls.addEventListener("start", stopAnim);
    return () => controls.removeEventListener("start", stopAnim);
  }, [controlsRef]);

  return null;
};

interface ViolinEmbedSceneProps {
  preset: ViolinCameraPreset;
  resetToken: number;
  floating: boolean;
  externalPulse?: { stringId: string; nonce: number } | null;
  onHoverString?: (stringId: string | null, color: string | null) => void;
  setIsOverString?: (over: boolean) => void;
}

export const ViolinEmbedScene: React.FC<ViolinEmbedSceneProps> = ({
  preset,
  resetToken,
  floating,
  externalPulse = null,
  onHoverString,
  setIsOverString,
}) => {
  const [bursts, setBursts] = useState<ParticleBurst[]>([]);
  const controlsRef = useRef<React.ElementRef<typeof OrbitControls> | null>(null);

  const handleParticleBurst = (burst: ParticleBurst) => {
    setBursts((prev) => [...prev.slice(-10), burst]);
  };

  const handleHoverString = (stringId: string | null, color: string | null) => {
    if (setIsOverString) {
      setIsOverString(Boolean(stringId));
    }
    if (onHoverString) {
      onHoverString(stringId, color);
    }
  };

  return (
    <div className="w-full h-full">
      <Canvas
        shadows
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
        camera={{
          fov: 42,
          near: 0.1,
          far: 60,
          position: VIOLIN_CAMERA_PRESETS.overview.position,
        }}
      >
        <color attach="background" args={["#080318"]} />

        <ambientLight intensity={2.8} color="#200d35" />

        <spotLight
          position={[1.5, 4.5, 6.5]}
          intensity={2.0}
          angle={0.9}
          penumbra={1.0}
          color="#FFEEDC"
          castShadow
        />

        <directionalLight position={[0.5, 1.5, 5.5]} intensity={1.8} color="#FFAA77" />

        <spotLight
          position={[-3.0, 2.0, 4.0]}
          intensity={3.5}
          angle={0.8}
          penumbra={0.75}
          color="#00F5D4"
        />

        <pointLight position={[5.0, -0.8, 3.5]} intensity={3.0} color="#FF0055" />
        <pointLight position={[2.0, 2.0, -2.5]} intensity={2.6} color="#7B2CBF" />

        <Suspense fallback={null}>
          <group position={[0, 0, 0]} scale={1.15}>
            <Float
              speed={floating ? 1.1 : 0}
              rotationIntensity={floating ? 0.04 : 0}
              floatIntensity={floating ? 0.08 : 0}
            >
              <ViolinModel
                onHoverString={handleHoverString}
                onParticleBurst={handleParticleBurst}
                ignoreWhileDragging
                externalPulse={externalPulse}
              />
            </Float>
          </group>
          <StringParticles bursts={bursts} />
        </Suspense>

        <OrbitControls
          ref={controlsRef}
          makeDefault
          enableDamping
          dampingFactor={0.07}
          minDistance={2.0}
          maxDistance={15.0}
          target={VIOLIN_CAMERA_PRESETS.overview.target}
        />

        <CameraPresetRig
          preset={preset}
          resetToken={resetToken}
          controlsRef={controlsRef}
        />
      </Canvas>
    </div>
  );
};
