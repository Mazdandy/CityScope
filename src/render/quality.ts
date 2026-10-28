/**
 * Quality ladder (T3.4) and resolution policy (T3.5).
 *
 * The ladder only changes **render scale** in M0. The other §14.5 mitigation
 * steps (RT-cached chunks, agent dots, overlay rate) are either a strategy
 * toggle (T3.2) or need things M0 does not have, so folding them in here would
 * be pretending to a control that does not exist yet.
 */

export type QualityTier = 'Low' | 'Med' | 'High';

export interface QualityPreset {
  readonly tier: QualityTier;
  /**
   * Multiplier applied to the device pixel ratio. §14.5 ladder: 0.6 / 0.85 / 1.0.
   * Below 1 the backing store is smaller than the CSS box, so the browser
   * upscales — cheaper fragment work at some sharpness cost.
   */
  readonly renderScale: number;
}

export const QUALITY_PRESETS: Readonly<Record<QualityTier, QualityPreset>> = {
  Low: { tier: 'Low', renderScale: 0.6 },
  Med: { tier: 'Med', renderScale: 0.85 },
  High: { tier: 'High', renderScale: 1.0 },
};

/** Cycle order for the live quality switch. */
export const QUALITY_ORDER: readonly QualityTier[] = ['Low', 'Med', 'High'];

/**
 * Highest device pixel ratio the renderer will ever use (T3.5).
 *
 * The policy is "1× devicePixelRatio by default", and this caps it: a 3×
 * phone would otherwise allocate nine times the pixels of a 1× display for a
 * desktop-first city sim, and §7's memory budget is the thing that pays.
 */
export const MAX_DEVICE_PIXEL_RATIO = 2;

export function resolveResolution(renderScale: number, devicePixelRatio: number): number {
  const dpr = Math.min(Math.max(devicePixelRatio || 1, 1), MAX_DEVICE_PIXEL_RATIO);
  return dpr * renderScale;
}

export function nextQuality(tier: QualityTier): QualityTier {
  const index = QUALITY_ORDER.indexOf(tier);
  return QUALITY_ORDER[(index + 1) % QUALITY_ORDER.length];
}
