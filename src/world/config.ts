import type { FbmParams } from '../core/noise';

/**
 * Terrain classification bands — the single place terrain thresholds exist
 * (PRD §15.2 T2.3).
 *
 * Each number is the **lower bound** of its class, so one ordered scan over
 * these five numbers covers all six classes:
 *
 * | condition        | class   |
 * |------------------|---------|
 * | `h < water`      | Water   |
 * | `h < sand`       | Sand    |
 * | `h < grass`      | Grass   |
 * | `h < forest`     | Forest  |
 * | `h < rock`       | Rock    |
 * | otherwise        | Snow    |
 *
 * Heights are normalised to `[0, 1]` across the generated map, so these are
 * relative bands rather than metres — see `World.generate`.
 */
export interface TerrainBands {
  /** Sea level: everything below it is the Water class. */
  readonly water: number;
  readonly sand: number;
  readonly grass: number;
  readonly forest: number;
  /** Lower bound of Snow, i.e. the Rock/Snow divide. */
  readonly rock: number;
}

export interface WorldConfig {
  /** The entire generated world derives from this. Save = seed + edits (T2.4). */
  readonly seed: number;
  /** Tiles per side. Standard 512 is the only v1 map size (§13 Q2). */
  readonly size: number;
  /** Tiles per chunk side; the renderer's culling unit (§6.1). */
  readonly chunkSize: number;
  readonly bands: TerrainBands;
  readonly relief: FbmParams;
  /**
   * Depth of the edge falloff, `0..1`. At the very border elevation is scaled
   * by `1 - edgeFalloff`, so anything above 0 guarantees the map ends in water
   * instead of being an arbitrary crop out of the noise field (§6.1).
   */
  readonly edgeFalloff: number;
  /**
   * Where the falloff starts, as a fraction of the distance from the centre to
   * the border. Below this the generated terrain is left untouched, which is
   * what keeps the interior from being dragged toward sea level.
   */
  readonly edgeInner: number;
}

export const WORLD_CONFIG: WorldConfig = {
  seed: 20261028,
  size: 512,
  chunkSize: 32,
  bands: { water: 0.3, sand: 0.35, grass: 0.55, forest: 0.72, rock: 0.88 },
  relief: { frequency: 0.0125, octaves: 5, lacunarity: 2, gain: 0.5 },
  edgeFalloff: 0.9,
  edgeInner: 0.68,
};
