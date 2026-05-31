import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const emitSourceMaps = process.env.NEWAMP_SOURCE_MAPS === '1';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'shared'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: emitSourceMaps,
    rollupOptions: {
      input: {
        // Main renderer.
        main: resolve(__dirname, 'index.html'),
        // Sandboxed Butterchurn/Milkdrop frame — the only eval surface.
        butterchurn: resolve(__dirname, 'butterchurn-iframe.html'),
        // Detached Eviland visualizer window (pop-out to projector / 2nd monitor).
        detached: resolve(__dirname, 'detached.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
