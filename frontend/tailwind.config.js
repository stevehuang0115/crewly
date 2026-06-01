/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    // Shared chat-ui package (Max, Week 2) — utility classes live in source
    // files, not compiled CSS, so Tailwind must scan them to emit the classes.
    "../packages/chat-ui/src/**/*.{ts,tsx}",
  ],
  darkMode: "class",
  theme: {
    fontFamily: {
      "sans": ["Nunito", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
      "display": ["Nunito", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
      "logo": ["Nunito", "system-ui", "sans-serif"],
      "mono": ["SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", "Courier New", "monospace"]
    },
    extend: {
      colors: {
        "primary": "#2a73ea",
        "background-dark": "#111721",
        "surface-dark": "#1a222c",
        "text-primary-dark": "#f6f7f8",
        "text-secondary-dark": "#9ab0d9",
        "border-dark": "#313a48",
      },
      borderRadius: {
        "DEFAULT": "0.5rem",
        "lg": "1rem",
        "xl": "1.5rem"
      },
    },
  },
  plugins: [],
}
