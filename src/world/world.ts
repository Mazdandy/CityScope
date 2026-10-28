import { fbm2d } from '../core/noise';
import { WORLD_CONFIG, type WorldConfig } from './config';
import { TerrainType, classify } from './terrain';

/** One sparse terrain change: a tile that differs from what the seed generates. */
export interface TerrainEdit {
  /** Row-major tile index, `y * size + x`. */
  readonly index: number;
  readonly height: number;
  readonly terrain: TerrainType;
}

/**
 * What a save actually stores (T2.4): the seed plus the sparse diffs the
 * player made. The 262k-tile height/terrain arrays are never serialised —
 * they are regenerated and the diffs replayed on load.
 */
export interface WorldSave {
  readonly seed: number;
  readonly edits: readonly TerrainEdit[];
}

/** T2.5 — the numbers a run has to report so two runs can be compared. */
export interface WorldTelemetry {
  readonly seed: number;
  readonly tiles: number;
  /** Wall-clock milliseconds spent generating the map (§6.1: must be < 3000). */
  readonly buildMs: number;
  readonly waterRatio: number;
  /** Content hash of the height + terrain arrays; equal seeds must agree. */
  readonly hash: string;
}

/**
 * The deterministic terrain, in structure-of-arrays typed arrays (PRD §7, §8).
 *
 * There is deliberately no per-tile object: the whole map is two flat arrays,
 * which is what keeps generation and later per-tile work cheap enough to fit
 * M0's budget.
 */
export class World {
  readonly config: WorldConfig;
  /** Normalised elevation per tile, `0` = lowest point on this map, `1` = highest. */
  readonly height: Float32Array;
  /** `TerrainType` per tile. */
  readonly terrain: Uint8Array;
  readonly tileCount: number;
  readonly chunksX: number;
  readonly chunksY: number;

  /** Sparse player edits, keyed by tile index so repeated edits coalesce. */
  private readonly edits = new Map<number, TerrainEdit>();
  private buildMs = 0;
  private snapshot: WorldTelemetry;

  constructor(config: WorldConfig = WORLD_CONFIG) {
    const { size, chunkSize } = config;
    this.config = config;
    this.tileCount = size * size;
    this.chunksX = Math.ceil(size / chunkSize);
    this.chunksY = Math.ceil(size / chunkSize);
    this.height = new Float32Array(this.tileCount);
    this.terrain = new Uint8Array(this.tileCount);
    this.snapshot = { seed: config.seed, tiles: this.tileCount, buildMs: 0, waterRatio: 0, hash: '' };
    this.generate();
  }

  get telemetry(): WorldTelemetry {
    return this.snapshot;
  }

  /** True when this world still matches what its seed generates. */
  get isPristine(): boolean {
    return this.edits.size === 0;
  }

  /**
   * Regenerate every tile from the seed and replay the stored edits. This is
   * the load path: `new World(config)` then `setTile` per saved diff, or
   * `generate()` again on an existing world.
   */
  generate(): void {
    const started = performance.now();
    const { size, seed, relief, edgeFalloff, edgeInner, bands } = this.config;
    const half = size * 0.5;

    // Pass 1 — raw fBm, tracking the practical range. The range is not
    // [-1, 1] in practice, and normalising against it is what makes the band
    // thresholds in config.bands meaningful for any relief tuning (T2.3).
    let min = Infinity;
    let max = -Infinity;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const value = fbm2d(x, y, relief, seed);
        this.height[y * size + x] = value;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    const span = max - min || 1;

    // Pass 2 — normalise to [0, 1], sink the border toward water, classify.
    // The falloff uses Chebyshev distance so the coastline follows the square
    // map edge, and only bites outside `edgeInner` so the interior is not
    // dragged down with it.
    const innerSpan = 1 - edgeInner;
    for (let y = 0; y < size; y++) {
      const dy = Math.abs((y - half) / half);
      for (let x = 0; x < size; x++) {
        const dx = Math.abs((x - half) / half);
        const edge = Math.max(dx, dy);
        const t = Math.max(0, (edge - edgeInner) / innerSpan);
        const index = y * size + x;
        const height = ((this.height[index] - min) / span) * (1 - edgeFalloff * t * t);
        this.height[index] = height;
        this.terrain[index] = classify(height, bands);
      }
    }

    for (const edit of this.edits.values()) {
      this.height[edit.index] = edit.height;
      this.terrain[edit.index] = edit.terrain;
    }

    this.buildMs = performance.now() - started;
    this.refreshTelemetry();
  }

  /**
   * Change one tile. The only way terrain mutates after generation, so every
   * change is automatically captured as a diff — nothing can silently escape
   * the save (T2.4).
   */
  setTile(index: number, height: number, terrain: TerrainType): void {
    if (index < 0 || index >= this.tileCount) {
      throw new RangeError(`tile index ${index} is outside 0..${this.tileCount - 1}`);
    }
    this.height[index] = height;
    this.terrain[index] = terrain;
    this.edits.set(index, { index, height, terrain });
    this.refreshTelemetry();
  }

  /** The save payload: seed + diffs (T2.4). */
  serialize(): WorldSave {
    return { seed: this.config.seed, edits: [...this.edits.values()] };
  }

  private refreshTelemetry(): void {
    let water = 0;
    for (let i = 0; i < this.tileCount; i++) {
      if (this.terrain[i] === TerrainType.Water) water++;
    }
    this.snapshot = {
      seed: this.config.seed,
      tiles: this.tileCount,
      buildMs: this.buildMs,
      waterRatio: water / this.tileCount,
      hash: this.contentHash(),
    };
  }

  /**
   * FNV-1a over the bytes of both arrays. Typed-array views use platform byte
   * order, which is little-endian on every browser in §3's baseline, so the
   * hash is directly comparable across them — which is exactly the check
   * T2.5 asks for.
   */
  private contentHash(): string {
    let hash = 0x811c9dc5;
    const heightBytes = new Uint8Array(this.height.buffer);
    for (let i = 0; i < heightBytes.length; i++) {
      hash = Math.imul(hash ^ heightBytes[i], 0x01000193);
    }
    for (let i = 0; i < this.terrain.length; i++) {
      hash = Math.imul(hash ^ this.terrain[i], 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
}
