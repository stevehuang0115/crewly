/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // Shared packages resolve to source, so HMR works without a build step.
      { find: '@crewly/chat-ui', replacement: path.resolve(__dirname, '../packages/chat-ui/src/index.ts') },
      // @crewly/ui: the design system shared with the Cloud portal. Bare
      // import → index; '@crewly/ui/Button' → that component's file.
      { find: /^@crewly\/ui$/, replacement: path.resolve(__dirname, '../packages/ui/src/index.ts') },
      { find: /^@crewly\/ui\/(.*)$/, replacement: path.resolve(__dirname, '../packages/ui/src') + '/$1' },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
  },
})