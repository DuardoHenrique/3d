"use client";

import React, { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import {
  Volume2,
  VolumeX,
  RotateCcw,
  Sparkles,
  Music2,
  Pause,
  Play,
} from "lucide-react";
import { audioEngine, VIOLIN_STRINGS } from "@/lib/audioEngine";
import { AudioController } from "@/components/ui/AudioController";
import {
  VIOLIN_CAMERA_PRESETS,
  ViolinCameraPreset,
} from "@/components/canvas/violinPresets";

const ViolinEmbedScene = dynamic(
  () =>
    import("@/components/canvas/ViolinEmbedScene").then(
      (mod) => mod.ViolinEmbedScene
    ),
  { ssr: false }
);

export default function ViolinEmbedPage() {
  const [activeStringId, setActiveStringId] = useState<string | null>(null);
  const [isOverString, setIsOverString] = useState(false);
  const [isAudioActive, setIsAudioActive] = useState(false);
  const [preset, setPreset] = useState<ViolinCameraPreset>("overview");
  const [resetToken, setResetToken] = useState(0);
  const [floating, setFloating] = useState(true);
  const [externalPulse, setExternalPulse] = useState<{
    stringId: string;
    nonce: number;
  } | null>(null);

  const handleHoverString = useCallback(
    (stringId: string | null) => {
      setActiveStringId(stringId);
      if (stringId && audioEngine.getIsReady() && !audioEngine.getIsMuted()) {
        setIsAudioActive(true);
      }
    },
    []
  );

  const handleToggleAudio = async () => {
    if (!audioEngine.getIsReady()) {
      const ok = await audioEngine.init();
      setIsAudioActive(ok);
    } else {
      const active = audioEngine.toggleMute();
      setIsAudioActive(active);
    }
  };

  const triggerPadString = useCallback(async (stringId: string) => {
    if (!audioEngine.getIsReady()) {
      const ok = await audioEngine.init();
      setIsAudioActive(ok);
    } else if (!audioEngine.getIsMuted()) {
      setIsAudioActive(true);
    }
    audioEngine.playString(stringId, "2n");
    setExternalPulse({ stringId, nonce: Date.now() + Math.random() });
    setActiveStringId(stringId);
    window.setTimeout(() => {
      setActiveStringId((curr) => (curr === stringId ? null : curr));
    }, 600);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const key = e.key.toUpperCase();
      let target: string | null = null;
      if (key === "1" || key === "G") target = "String_G";
      else if (key === "2" || key === "D") target = "String_D";
      else if (key === "3" || key === "A") target = "String_A";
      else if (key === "4" || key === "E") target = "String_E";

      if (target) {
        triggerPadString(target);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [triggerPadString]);

  const activeNote = activeStringId ? VIOLIN_STRINGS[activeStringId] : null;

  return (
    <main
      className={`violin-embed-stage relative w-screen h-dvh overflow-hidden bg-void select-none ${
        isOverString ? "is-over-string" : ""
      }`}
    >
      {/* Fullscreen Interactive 3D Violin Canvas */}
      <div className="absolute inset-0 z-0">
        <ViolinEmbedScene
          preset={preset}
          resetToken={resetToken}
          floating={floating}
          externalPulse={externalPulse}
          onHoverString={handleHoverString}
          setIsOverString={setIsOverString}
        />
      </div>

      {/* Compact Top Overlay HUD */}
      <div className="pointer-events-none absolute top-4 left-4 right-4 z-20 flex flex-wrap items-start justify-between gap-3">
        <div className="pointer-events-auto rounded-2xl bg-void/75 backdrop-blur-md border border-white/10 px-4 py-2.5 shadow-xl">
          <div className="flex items-center gap-2">
            <Music2 className="w-4 h-4 text-cyber-cyan" />
            <h1 className="font-display font-bold text-sm sm:text-base tracking-wide text-white">
              VIOLINO 3D <span className="text-cyber-cyan">INTERATIVO</span>
            </h1>
          </div>
          <p className="text-[11px] font-mono text-white/55 mt-0.5">
            Arraste p/ girar • Scroll p/ zoom • Passe nas cordas ou use 1–4
          </p>
        </div>

        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          {activeNote ? (
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-void/85 border backdrop-blur-md text-xs font-mono font-semibold"
              style={{
                borderColor: activeNote.color,
                color: activeNote.color,
                boxShadow: `0 0 16px ${activeNote.color}40`,
              }}
            >
              <span
                className="w-2 h-2 rounded-full animate-ping"
                style={{ backgroundColor: activeNote.color }}
              />
              <span>{activeNote.name}</span>
            </div>
          ) : (
            <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-void/70 border border-white/10 backdrop-blur-md text-[11px] font-mono text-white/60">
              <Sparkles className="w-3.5 h-3.5 text-cyber-magenta" />
              <span>Passe o mouse nas cordas</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => setFloating((f) => !f)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-void/80 border border-white/15 hover:border-white/35 text-white/80 text-xs font-mono transition"
            title={floating ? "Pausar flutuação suave" : "Ativar flutuação suave"}
          >
            {floating ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span className="hidden md:inline">Flutuar</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setPreset("overview");
              setResetToken((t) => t + 1);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-void/80 border border-white/15 hover:border-cyber-cyan/50 text-white/85 text-xs font-mono transition"
            title="Resetar câmera"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Resetar</span>
          </button>

          <button
            type="button"
            onClick={handleToggleAudio}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-mono font-semibold transition ${
              isAudioActive
                ? "bg-cyber-cyan/20 border border-cyber-cyan/60 text-cyber-cyan shadow-[0_0_12px_rgba(0,245,212,0.3)]"
                : "bg-cyber-magenta text-white hover:bg-cyber-magenta/85 shadow-[0_0_15px_rgba(255,0,85,0.45)]"
            }`}
          >
            {isAudioActive ? (
              <>
                <Volume2 className="w-4 h-4" />
                <span>SOM ATIVO</span>
              </>
            ) : (
              <>
                <VolumeX className="w-4 h-4" />
                <span>ATIVAR SOM</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Bottom Interactive String Pads & Camera Presets */}
      <div className="pointer-events-none absolute bottom-5 left-4 right-4 z-20 flex flex-col items-center gap-2.5 sm:pr-44">
        {/* 4 String Trigger Pads */}
        <div className="pointer-events-auto flex items-center gap-2 px-2.5 py-2 rounded-2xl bg-void/80 backdrop-blur-xl border border-white/15 shadow-2xl">
          {Object.entries(VIOLIN_STRINGS).map(([id, info], idx) => {
            const isActive = activeStringId === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => triggerPadString(id)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-mono font-semibold transition active:scale-95"
                style={{
                  borderColor: isActive ? info.color : "rgba(255,255,255,0.14)",
                  backgroundColor: isActive ? `${info.color}25` : "rgba(255,255,255,0.04)",
                  color: isActive ? "#ffffff" : "rgba(255,255,255,0.85)",
                  boxShadow: isActive ? `0 0 14px ${info.color}55` : "none",
                }}
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: info.color }}
                />
                <span>{info.name}</span>
                <span className="hidden sm:inline text-[10px] text-white/45">
                  [{idx + 1}]
                </span>
              </button>
            );
          })}
        </div>

        {/* Camera Angle Presets */}
        <div className="pointer-events-auto flex flex-wrap justify-center gap-1.5 px-2.5 py-1.5 rounded-full bg-void/75 backdrop-blur-md border border-white/10">
          {(Object.keys(VIOLIN_CAMERA_PRESETS) as ViolinCameraPreset[]).map((key) => {
            const isSelected = preset === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setPreset(key);
                  setResetToken((t) => t + 1);
                }}
                className={`px-3 py-1 rounded-full text-[11px] font-mono transition ${
                  isSelected
                    ? "bg-cyber-cyan text-void font-bold"
                    : "text-white/70 hover:text-white hover:bg-white/10"
                }`}
              >
                {VIOLIN_CAMERA_PRESETS[key].label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Floating Rhythm Loop Controller */}
      <AudioController />
    </main>
  );
}
