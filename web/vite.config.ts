import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// changeOrigin: false keeps Host = 127.0.0.1:5173, which the server allows only in --dev.
// AOS_API_PORT: point the proxy at a server that isn't on 3000 (dev tooling only, not app config).
const target = `http://127.0.0.1:${process.env.AOS_API_PORT ?? '3000'}`;

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // The server's CSP (server/src/http/headers.ts) doesn't cover pages Vite serves, so dev gets the same one
    // (+ the HMR socket). Without it the sanitizer would be the only defence while you use real data in dev.
    // worker-src blob: is for Vite's HMR client only: when its socket drops (server restart, page put in the
    // back/forward cache) it polls for the server from a blob: SharedWorker; blocked, the page never reconnects.
    headers: {
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173; script-src 'self'; " +
        "worker-src 'self' blob:; " +
        "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    },
    proxy: { '/api': { target, changeOrigin: false }, '/login': { target, changeOrigin: false } },
  },
  test: { environment: 'jsdom' },
});
