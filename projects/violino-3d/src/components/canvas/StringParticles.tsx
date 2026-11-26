"use client";

import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export interface ParticleBurst {
  id: number;
  position: THREE.Vector3;
  color: THREE.Color;
  time: number;
}

interface StringParticlesProps {
  bursts: ParticleBurst[];
}

export const StringParticles: React.FC<StringParticlesProps> = ({ bursts }) => {
  const pointsRef = useRef<THREE.Points>(null);
  const particleCount = 120;

  // Static random offsets for the particles
  const [positions, velocities, colors] = useMemo(() => {
    const pos = new Float32Array(particleCount * 3);
    const vel = new Float32Array(particleCount * 3);
    const col = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
      pos[i * 3] = 0;
      pos[i * 3 + 1] = 0;
      pos[i * 3 + 2] = 0;

      vel[i * 3] = (Math.random() - 0.5) * 1.5;
      vel[i * 3 + 1] = (Math.random() - 0.5) * 1.5;
      vel[i * 3 + 2] = Math.random() * 1.8 + 0.2;

      col[i * 3] = 0.0;
      col[i * 3 + 1] = 0.96;
      col[i * 3 + 2] = 0.83;
    }
    return [pos, vel, col];
  }, []);

  useFrame((_, delta) => {
    if (!pointsRef.current) return;
    const geo = pointsRef.current.geometry;
    const posAttr = geo.getAttribute("position") as THREE.BufferAttribute;
    const colAttr = geo.getAttribute("color") as THREE.BufferAttribute;

    if (bursts.length > 0) {
      const latest = bursts[bursts.length - 1];
      const age = (performance.now() - latest.time) / 1000;

      if (age < 0.8) {
        for (let i = 0; i < particleCount; i++) {
          posAttr.setXYZ(
            i,
            latest.position.x + velocities[i * 3] * age,
            latest.position.y + velocities[i * 3 + 1] * age,
            latest.position.z + velocities[i * 3 + 2] * age
          );

          colAttr.setXYZ(
            i,
            latest.color.r * (1 - age / 0.8),
            latest.color.g * (1 - age / 0.8),
            latest.color.b * (1 - age / 0.8)
          );
        }
        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
      }
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={particleCount}
          array={positions}
          itemSize={3}
        />
        <bufferAttribute
          attach="attributes-color"
          count={particleCount}
          array={colors}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.06}
        vertexColors
        transparent
        opacity={0.9}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
};
