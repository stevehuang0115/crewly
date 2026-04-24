/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Shared chat-ui package (Week 2). Test runner uses its own config, so
      // the alias must be mirrored from vite.config.ts.
      '@crewly/chat-ui': path.resolve(
        __dirname,
        '../packages/chat-ui/src/index.ts'
      ),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
  },
})