import { defineConfig, createLogger } from 'vite';
import react from '@vitejs/plugin-react';

// Vite logs WebSocket proxy errors from a listener attached directly to the
// socket (`proxyReqWs` event), not from `proxy.on('error')` — so they cannot be
// absorbed via `configure`. ECONNRESET/EPIPE here are normal teardown of the
// Socket.IO WS (page reload, StrictMode mounting→unmounting→remounting the effect in dev):
// the connection re-establishes and notifications keep working. We filter the noise
// upstream with the customLogger, letting other WS proxy errors through.
const logger = createLogger();
const baseError = logger.error.bind(logger);
logger.error = (msg, options) => {
  if (typeof msg === 'string' && msg.includes('ws proxy socket error')) return;
  baseError(msg, options);
};

export default defineConfig({
  customLogger: logger,
  plugins: [react()],
  server: {
    port: 5173,
    host: true,          // exposes on 0.0.0.0 → reachable from other devices on the LAN
    proxy: {
      // SSE stream: bypass proxy, direct connection to the backend
      '/api/chats': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // disabilita il buffering per SSE
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Socket.IO (notifiche real-time): va inoltrato come WebSocket (ws: true),
      // altrimenti il socket /notifications non si connette in dev e le notifiche
      // arrivano solo al reload (via HTTP).
      '/socket.io': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
