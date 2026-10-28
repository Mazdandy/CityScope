import type { TerrainBands } from './config';

/**
 * Terrain classes, stored one byte per tile (`World.terrain`).
 *
 * These ids are part of the save format: a saved tile's terrain byte refers to
 * one of these values, so they must never be renumbered.
 *
 * Note this is a *class*, not a texture atlas frame — the mapping from class
 * to sprite is the renderer's business (PRD §15.2 T2.2).
 */
export enum TerrainType {
  Water = 0,
  Sand = 1,
  Grass = 2,
  Forest = 3,
  Rock = 4,
  Snow = 5,
}

/**
 * Classify one normalised height into a terrain class.
 *
 * The thresholds come in as a parameter rather than being read here so that
 * `config.bands` stays the only definition of them (T2.3).
 */
export function classify(height: number, bands: TerrainBands): TerrainType {
  if (height < bands.water) return TerrainType.Water;
  if (height < bands.sand) return TerrainType.Sand;
  if (height < bands.grass) return TerrainType.Grass;
  if (height < bands.forest) return TerrainType.Forest;
  if (height < bands.rock) return TerrainType.Rock;
  return TerrainType.Snow;
}
