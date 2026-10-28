/**
 * Browser stub for `@xmldom/xmldom`.
 *
 * PixiJS only imports that package from its Node / WebWorker environment
 * adapter (`environment-webworker/WebWorkerAdapter.mjs`), which is dead code in
 * a browser build. The real package is CommonJS-only and this install is
 * missing `lib/entities.js`, so Vite's dependency optimizer cannot bundle it.
 * `vite.config.ts` aliases the import here to keep the graph ESM-clean.
 */
export class DOMParser {
  parseFromString(): never {
    throw new Error('@xmldom/xmldom is not available in the browser');
  }
}
