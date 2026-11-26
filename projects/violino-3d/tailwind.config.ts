import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        void: "#080318",
        "void-light": "#140a33",
        cyber: {
          magenta: "#FF0055",
          cyan: "#00F5D4",
          amber: "#FF7B00",
          violet: "#7B2CBF",
        },
      },
      fontFamily: {
        display: ["var(--font-syne)", "sans-serif"],
        sans: ["var(--font-jakarta)", "sans-serif"],
      },
      animation: {
        "pulse-slow": "pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "glow-cyan": "glowCyan 2s ease-in-out infinite alternate",
      },
      keyframes: {
        glowCyan: {
          "0%": { filter: "drop-shadow(0 0 5px rgba(0,245,212,0.4))" },
          "100%": { filter: "drop-shadow(0 0 20px rgba(0,245,212,0.8))" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
