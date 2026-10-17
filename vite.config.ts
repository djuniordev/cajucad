import { defineConfig } from 'vite';

export default defineConfig({
  // manifold-3d ships its own .wasm; keep it out of dependency pre-bundling.
  optimizeDeps: { exclude: ['manifold-3d'] },
  build: { target: 'es2022' },
  server: { port: 5173 },
});
