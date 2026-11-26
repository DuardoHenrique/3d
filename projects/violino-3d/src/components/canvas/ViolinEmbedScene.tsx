"use client";

import React, { useState, useRef, useEffect, Suspense, Component } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Float } from "@react-three/drei";
import * as THREE from "three";
import { ViolinModel } from "./ViolinModel";
import { StringParticles, ParticleBurst } from "./StringParticles";
import { ViolinSoftwareCanvas } from "./ViolinSoftwareCanvas";
import {
  VIOLIN_CAMERA_PRESETS,
  ViolinCameraPreset,
} from "./violinPresets";

export { VIOLIN_CAMERA_PRESETS };
export type { ViolinCameraPreset };

interface WebGLProbe {
  ready: boolean;
  supported: boolean;
  antialias: boolean;
}

function probeWebGLSupport(): { supported: boolean; antialias: boolean } {
  if (typeof document === "undefined") {
    return { supported: false, antialias: false };
  }
  const attempts: { type: string; attrs: WebGLContextAttributes; antialias: boolean }[] = [
    {
      type: "webgl2",
      attrs: { antialias: true, alpha: false, powerPreference: "default" },
      antialias: true,
    },
    {
      type: "webgl2",
      attrs: { antialias: false, alpha: false, failIfMajorPerformanceCaveat: false, powerPreference: "default" },
      antialias: false,
    },
    {
      type: "webgl",
      attrs: { antialias: false, alpha: false, failIfMajorPerformanceCaveat: false },
      antialias: false,
    },
    {
      type: "experimental-webgl",
      attrs: { antialias: false, alpha: false, failIfMajorPerformanceCaveat: false },
      antialias: false,
    },
  ];

  for (const attempt of attempts) {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext(attempt.type, attempt.attrs);
      if (gl) {
        return { supported: true, antialias: attempt.antialias };
      }
    } catch {
      // try next attempt
    }
  }
  return { supported: false, antialias: false };
}

class CanvasErrorBoundary extends Component<
  { fallback: React.ReactNode; onError: () => void; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: {
    fallback: React.ReactNode;
    onError: () => void;
    children: React.ReactNode;
  }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(err: unknown) {
    console.warn("WebGL Canvas failed, switching to Software 3D:", err);
    this.props.onError();
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

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
    const aspect =
      typeof window !== "undefined"
        ? window.innerWidth / Math.max(1, window.innerHeight)
        : 1;
    const distScale = aspect < 0.85 ? 1.18 : 1.0;
    const tx = config.target[0];
    const ty = config.target[1];
    const tz = config.target[2];
    desiredPos.current.set(
      tx + (config.position[0] - tx) * distScale,
      ty + (config.position[1] - ty) * distScale,
      tz + (config.position[2] - tz) * distScale
    );
    desiredTarget.current.set(tx, ty, tz);
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
  onSoftwareMode?: () => void;
}

export const ViolinEmbedScene: React.FC<ViolinEmbedSceneProps> = ({
  preset,
  resetToken,
  floating,
  externalPulse = null,
  onHoverString,
  setIsOverString,
  onSoftwareMode,
}) => {
  const [bursts, setBursts] = useState<ParticleBurst[]>([]);
  const [webgl, setWebgl] = useState<WebGLProbe>({
    ready: false,
    supported: true,
    antialias: true,
  });
  const controlsRef = useRef<React.ElementRef<typeof OrbitControls> | null>(null);

  useEffect(() => {
    const res = probeWebGLSupport();
    setWebgl({ ready: true, supported: res.supported, antialias: res.antialias });
  }, []);

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

  const softwareFallback = (
    <ViolinSoftwareCanvas
      preset={preset}
      resetToken={resetToken}
      floating={floating}
      externalPulse={externalPulse}
      onHoverString={onHoverString}
      setIsOverString={setIsOverString}
      onSoftwareMode={onSoftwareMode}
    />
  );

  if (!webgl.ready) {
    return <div className="w-full h-full bg-void" />;
  }

  if (!webgl.supported) {
    return softwareFallback;
  }

  return (
    <div className="w-full h-full">
      <CanvasErrorBoundary
        fallback={softwareFallback}
        onError={() =>
          setWebgl({ ready: true, supported: false, antialias: false })
        }
      >
        <Canvas
          shadows={webgl.antialias}
          gl={{
            antialias: webgl.antialias,
            alpha: false,
            powerPreference: "default",
            failIfMajorPerformanceCaveat: false,
          }}
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
      </CanvasErrorBoundary>
    </div>
  );
};
