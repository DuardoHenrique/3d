export type ViolinCameraPreset =
  | "overview"
  | "strings"
  | "scroll"
  | "bridge"
  | "profile";

export const VIOLIN_CAMERA_PRESETS: Record<
  ViolinCameraPreset,
  {
    label: string;
    position: [number, number, number];
    target: [number, number, number];
  }
> = {
  overview: {
    label: "Visão Geral",
    position: [0.55, 0.25, 10.2],
    target: [0, 0.0, 0],
  },
  strings: {
    label: "Cordas (Frente)",
    position: [0.0, 0.45, 5.8],
    target: [0, 0.35, 0.2],
  },
  scroll: {
    label: "Voluta & Cravelhas",
    position: [1.4, 2.7, 3.6],
    target: [0, 2.4, 0],
  },
  bridge: {
    label: "Cavalete & Efes",
    position: [2.2, -0.7, 3.5],
    target: [0, -1.0, 0.2],
  },
  profile: {
    label: "Perfil Lateral",
    position: [8.8, 0.2, 0.4],
    target: [0, 0.0, 0],
  },
};
