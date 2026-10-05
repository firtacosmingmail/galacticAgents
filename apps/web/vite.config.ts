import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { serviceWorkerPlugin } from './src/pwa/build-plugin.js';

// In development Vite serves the page and proxies the server's endpoints, so the browser talks
// to one origin: no CORS, and the WebSocket upgrade carries an allowed Origin.
const serverPort = process.env['GALACTIC_PORT'] ?? '4321';
const target = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  // The service worker (P7-01) is written next to the build; development never registers one.
  plugins: [react(), serviceWorkerPlugin()],
  // The solar-system scene (P3-01) is its own lazily loaded chunk, and three.js alone is about
  // 0.7 MB minified: warn only past what that chunk is expected to weigh.
  build: { chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target, ws: true, changeOrigin: false },
      '/health': { target },
      '/dev': { target },
      '/api': { target },
    },
  },
});
