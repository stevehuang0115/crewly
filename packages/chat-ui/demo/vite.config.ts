import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Demo-app Vite config. Runs the chat UI against the in-memory mock
 * client so Max can iterate on the package without any backend running.
 *
 * Usage: `npm run demo` from packages/chat-ui (serves on :5180).
 */
export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  resolve: {
    alias: {
      '@crewly/chat-ui': path.resolve(__dirname, '../src/index.ts'),
    },
  },
  server: {
    port: 5180,
    host: true,
  },
});
