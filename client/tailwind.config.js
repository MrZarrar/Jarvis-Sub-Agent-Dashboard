/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // HUD surface scale — deep blue-black, brightening with elevation.
        surface: {
          0: "#020609",
          1: "#040b14",
          2: "#08121f",
          3: "#0b1a2b",
          4: "#102338",
          5: "#162e47",
        },
        // Accent + borders are CSS variables so the HUD personality can flip
        // at runtime (JARVIS cyan ↔ ULTRON crimson) via [data-theme] on <html>.
        border: {
          DEFAULT: "rgb(var(--hud-border) / <alpha-value>)",
          light: "rgb(var(--hud-border-light) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--hud-accent) / <alpha-value>)",
          hover: "rgb(var(--hud-accent-hover) / <alpha-value>)",
          muted: "rgb(var(--hud-accent) / 0.15)",
        },
        // Secondary HUD tone for highlights/callouts (validated gold).
        hud: {
          gold: "#b3871d",
          "gold-bright": "#f0c040",
        },
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        display: ["Rajdhani", "Inter", "sans-serif"],
        wordmark: ["Orbitron", "Rajdhani", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "Consolas", "monospace"],
      },
      boxShadow: {
        glow: "0 0 12px rgb(var(--hud-accent) / 0.35), 0 0 32px rgb(var(--hud-accent) / 0.12)",
        "glow-sm": "0 0 6px rgb(var(--hud-accent) / 0.3)",
        "glow-inset": "inset 0 1px 0 rgb(var(--hud-accent) / 0.15)",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-in": "fadeIn 0.3s ease-out",
        "slide-up": "slideUp 0.3s ease-out",
        "hud-sweep": "hudSweep 4s linear infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        hudSweep: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
    },
  },
  plugins: [],
};
