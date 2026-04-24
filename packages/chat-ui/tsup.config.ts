import { defineConfig } from 'tsup';

/**
 * Library build configuration for @crewly/chat-ui.
 *
 * Outputs ESM + CJS + .d.ts files so both the OSS frontend (Vite)
 * and the Portal (Next.js / Vite) can import the package without friction.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  external: ['react', 'react-dom'],
  treeshake: true,
});
