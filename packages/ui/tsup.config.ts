import { defineConfig } from 'tsup';

/**
 * Library build for @crewly/ui: ESM + CJS + .d.ts, React and lucide left to
 * the host app. Class names stay as strings in the output, so the host's
 * Tailwind must scan dist/ (theme.css does that for Tailwind v4; the v3
 * preset's users add dist/ to `content`).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  external: ['react', 'react-dom', 'lucide-react'],
  treeshake: true,
});
