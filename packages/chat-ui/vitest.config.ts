/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Test runner config for @crewly/chat-ui.
 *
 * Uses the same vitest+jsdom stack as the OSS frontend to keep a single
 * mental model across projects.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
