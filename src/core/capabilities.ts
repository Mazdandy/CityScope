/**
 * Boot feature detection (§16 T8.1, PRD §11 R6).
 *
 * §11 R6 is Safari/iOS WebGL2 quirks, and the mitigation is to refuse to guess:
 * ask for exactly what the renderer needs, and if it is missing, say so on a
 * page the player can read instead of leaving them a black canvas.
 *
 * This is also where §14.7's open question closed. The deleted spike shipped a
 * hand-rolled Canvas2D blitter purely to test whether a second renderer was
 * worth keeping; it was never measured, and M0's own chunk-strategy pick
 * (`cached` RenderTextures, §15.4) is WebGL2-specific, so a Canvas2D path would
 * be a permanent second renderer that the chosen design cannot even share code
 * with. **Decision: no blitter — the unsupported screen is the fallback.**
 */

export interface Capabilities {
  readonly webgl2: boolean;
  readonly worker: boolean;
  /** True when every requirement is present and boot may continue. */
  readonly ok: boolean;
  /** Human-readable names of what is missing, for the screen to list. */
  readonly missing: readonly string[];
}

/**
 * A WebGL2 context is requested on a throwaway canvas and immediately dropped.
 * Browsers cap the number of live contexts, so it is not retained.
 */
function hasWebGL2(): boolean {
  try {
    const probe = document.createElement('canvas');
    return probe.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

export function detectCapabilities(): Capabilities {
  const webgl2 = hasWebGL2();
  const worker = typeof Worker !== 'undefined';

  const missing: string[] = [];
  if (!webgl2) missing.push('WebGL2');
  if (!worker) missing.push('Web Workers');

  return { webgl2, worker, ok: missing.length === 0, missing };
}
