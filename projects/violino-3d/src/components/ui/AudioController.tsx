"use client";

import React, { useState } from "react";
import { Music, Play, Square, Activity } from "lucide-react";
import { audioEngine } from "@/lib/audioEngine";

interface AudioControllerProps {
  className?: string;
  compact?: boolean;
}

export const AudioController: React.FC<AudioControllerProps> = ({
  className = "fixed bottom-6 right-6 z-40 flex items-center gap-3",
  compact = false,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);

  const handleToggleRhythm = () => {
    const playing = audioEngine.toggleRhythmLoop(116);
    setIsPlaying(playing);
  };

  return (
    <div className={className}>
      {/* Rhythm Loop Player */}
      <button
        onClick={handleToggleRhythm}
        className={`group flex items-center gap-2.5 ${
          compact ? "px-3 py-1.5" : "px-4 py-2.5"
        } rounded-full backdrop-blur-xl border transition-all duration-300 shadow-xl ${
          isPlaying
            ? "bg-cyber-magenta/20 border-cyber-magenta text-cyber-magenta shadow-[0_0_20px_rgba(255,0,85,0.4)]"
            : "bg-void/80 border-white/15 text-white/80 hover:border-cyber-cyan/50 hover:text-cyber-cyan"
        }`}
      >
        <div
          className={`${compact ? "w-6 h-6" : "w-7 h-7"} rounded-full flex items-center justify-center transition-all ${
            isPlaying ? "bg-cyber-magenta text-void animate-spin" : "bg-white/10 text-white"
          }`}
          style={{ animationDuration: "3s" }}
        >
          {isPlaying ? <Square className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current ml-0.5" />}
        </div>
        <div className="text-left">
          <div className="text-[11px] font-mono tracking-wider font-semibold uppercase whitespace-nowrap">
            {isPlaying ? "Groove 116 BPM" : "Base Rítmica"}
          </div>
          {!compact && (
            <div className="text-[9px] text-white/50 font-mono">
              {isPlaying ? "LOOP ATIVO" : "CLIQUE P/ TOCAR JUNTO"}
            </div>
          )}
        </div>
        {isPlaying && <Activity className="w-4 h-4 text-cyber-magenta animate-pulse" />}
      </button>
    </div>
  );
};
