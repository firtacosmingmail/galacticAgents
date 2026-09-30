import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development Vite serves the page and proxies the server's endpoints, so the browser talks
// to one origin: no CORS, and the WebSocket upgrade carries an allowed Origin.
const serverPort = process.env['GALACTIC_PORT'] ?? '4321';
const target = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target, ws: true, changeOrigin: false },
      '/health': { target },
      '/dev': { target },
    },
  },
});
