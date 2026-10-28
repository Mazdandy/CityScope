import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the build works from any static host sub-path
  // (GitHub Pages serves from /<repo>/ — see PRD §4).
  base: './',
  server: { port: 5175, open: false },
  resolve: {
    alias: {
      // pixi.js imports @xmldom/xmldom from its Node/WebWorker adapter only.
      // The real package is CJS-only (and its lib/ is missing entities.js here),
      // which breaks Vite's dependency optimizer. Point it at an ESM stub.
      // Carried over verbatim from the spike — without it the build breaks.
      '@xmldom/xmldom': fileURLToPath(new URL('./src/xmldom-stub.ts', import.meta.url)),
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
