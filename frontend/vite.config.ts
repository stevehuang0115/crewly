import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Shared chat-ui package (Week 2). Resolve to source so HMR works and
      // we don't need a separate build step during dev.
      '@crewly/chat-ui': path.resolve(
        __dirname,
        '../packages/chat-ui/src/index.ts'
      ),
    },
  },
  server: {
    host: true,
    port: 8788,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        ws: true,
        configure: (proxy, _options) => {
          // Suppress EPIPE/ECONNRESET errors from abrupt WebSocket disconnections
          proxy.on('error', (err, _req, _res) => {
            const code = (err as NodeJS.ErrnoException).code;
            // Silently ignore broken pipe errors (happen on browser refresh/close)
            if (code === 'EPIPE' || code === 'ECONNRESET') {
              return;
            }
            console.error('[WS Proxy Error]', err.message);
          });
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', (err) => {
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== 'EPIPE' && code !== 'ECONNRESET') {
                console.error('[WS Socket Error]', err.message);
              }
            });
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});