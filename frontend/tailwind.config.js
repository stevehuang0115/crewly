import crewlyPreset from "../packages/ui/tailwind-preset.cjs";

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    // Shared chat-ui package (Max, Week 2) — utility classes live in source
    // files, not compiled CSS, so Tailwind must scan them to emit the classes.
    "../packages/chat-ui/src/**/*.{ts,tsx}",
    // Shared design system (@crewly/ui) — same reason.
    "../packages/ui/src/**/*.{ts,tsx}",
  ],
  // Crewly's colors live in @crewly/ui so the Cloud portal uses the same ones.
  presets: [crewlyPreset],
  darkMode: "class",
  theme: {
    fontFamily: {
      "sans": ["Nunito", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
      "display": ["Nunito", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
      "logo": ["Nunito", "system-ui", "sans-serif"],
      "mono": ["SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", "Courier New", "monospace"]
    },
    extend: {
      borderRadius: {
        "DEFAULT": "0.5rem",
        "lg": "1rem",
        "xl": "1.5rem"
      },
    },
  },
  plugins: [],
}
