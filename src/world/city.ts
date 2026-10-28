import { TerrainType } from './terrain';
import type { World } from './world';

/**
 * The city layer: what the player built on top of the terrain (PRD §16.3 T1).
 *
 * Three flat `Uint8Array`s over the same 512² grid as {@link World}, plus a
 * dirty set. SoA with no per-tile objects, for the same reason the terrain is
 * (§7) — the arrays are 786 KB total and an edit touches at most five bytes.
 *
 * ## The two encodings worth knowing
 *
 * - **Roads** — `road[i]` is `0` for no road, otherwise `1 + mask`, where the
 *   mask is the 4-bit neighbour mask the atlas indexes its 16 frames with
 *   (T3.1). The offset exists so that *an isolated road* (mask `0`) is still
 *   distinguishable from *no road*; without it those two would collide. The
 *   mask is stored in **world tile space**, not display space: rotation is a
 *   permutation applied at render time (§15.2 T3.6), and baking it into the
 *   data would make the same city hash differently at different camera angles.
 * - **Buildings** — `building[i]` is `0` for none, otherwise `1 + variant`.
 *   Buildings are **derived, never stored** (T1.3, T2.1): the byte is a cache
 *   of {@link City.buildingVariantAt} so the renderer does not have to re-hash
 *   a tile every frame. Nothing is lost when it is recomputed, which is why
 *   the save format does not carry it.
 *
 * Both family ids and the rule that produces a building live here and nowhere
 * else, so "same seed, same city" is checkable in one file.
 */

/**
 * Zone families (§6.3). Stored one byte per tile in `City.zone`.
 *
 * As with {@link TerrainType}, these ids are part of the save format and must
 * never be renumbered.
 */
export enum ZoneType {
  None = 0,
  Residential = 1,
  Commercial = 2,
  Industrial = 3,
}

/** `City.road` value meaning "no road here". */
export const ROAD_NONE = 0;
/** Added to a road's neighbour mask, so presence is testable on its own. */
const ROAD_BASE = 1;

/** Neighbour-mask bits, world tile space. Atlas frame order must match (T3.1). */
export const MASK_N = 1;
export const MASK_E = 2;
export const MASK_S = 4;
export const MASK_W = 8;

/**
 * How many drawn variants each family has. The variant is data, not art: the
 * atlas is asked for `frame = family × BUILDING_VARIANTS + variant` (T3.1).
 */
export const BUILDING_VARIANTS = 4;

/**
 * The building rule's only random-looking input (T1.3): a hash of the tile
 * index and the world seed. Same seed and same index always give the same
 * variant, on every browser — so a reloaded city looks identical without the
 * variants ever being saved.
 *
 * FNV-style mixing over `Math.imul` and shifts only, for the same reason
 * `rng.ts` avoids transcendentals: those operations are exactly specified by
 * ECMAScript, so the result cannot drift between engines.
 */
function variantHash(index: number, seed: number): number {
  let h = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ seed, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 13;
  return h >>> 0;
}

export class City {
  readonly world: World;
  readonly size: number;
  readonly tileCount: number;
  /** `ZoneType` per tile. */
  readonly zone: Uint8Array;
  /** `0` = no road, else `1 + neighbour mask` — see the file header. */
  readonly road: Uint8Array;
  /** `0` = no building, else `1 + variant`. Derived; safe to discard. */
  readonly building: Uint8Array;

  /** Tiles changed since the last {@link drainDirty}. */
  private readonly dirtyTiles = new Set<number>();

  constructor(world: World) {
    this.world = world;
    this.size = world.config.size;
    this.tileCount = world.tileCount;
    this.zone = new Uint8Array(this.tileCount);
    this.road = new Uint8Array(this.tileCount);
    this.building = new Uint8Array(this.tileCount);
  }

  /** Tiles waiting to be re-drawn (T5's flush reads this). */
  get dirtyCount(): number {
    return this.dirtyTiles.size;
  }

  /**
   * Hand the pending tile indices to the renderer and forget them. The caller
   * owns the array; the set is empty on return, so a flush that throws loses
   * only that frame's redraw.
   */
  drainDirty(): number[] {
    const out = [...this.dirtyTiles];
    this.dirtyTiles.clear();
    return out;
  }

  /** True when a road occupies this tile (as opposed to its mask being `0`). */
  hasRoad(index: number): boolean {
    return this.road[index] !== ROAD_NONE;
  }

  /** This tile's neighbour mask, or `0` when there is no road here. */
  roadMask(index: number): number {
    return this.hasRoad(index) ? this.road[index] - ROAD_BASE : 0;
  }

  /**
   * Zone one tile (T1.2). Repainting the same family is a no-op so a drag that
   * stays inside one tile neither re-hashes it nor re-dirties it.
   */
  paintZone(index: number, zone: ZoneType): void {
    this.assertIndex(index);
    if (this.zone[index] === zone) return;
    this.zone[index] = zone;
    this.reevaluateAround(index);
  }

  /**
   * Lay road on one tile (T1.2). Roads are one 8 m tile with a 4-bit mask, not
   * §6.1's two-tile carriageway — see §16.2.
   */
  placeRoad(index: number): void {
    this.assertIndex(index);
    if (this.hasRoad(index)) return;
    // Presence first: `reevaluate` only computes a mask for a tile that
    // already reads as a road.
    this.road[index] = ROAD_BASE;
    this.reevaluateAround(index);
  }

  /**
   * Clear whatever is on one tile (T1.2). Zoning is cleared along with the
   * road rather than kept, so bulldoze means "gone", and the tile comes back
   * only by painting it again.
   */
  bulldoze(index: number): void {
    this.assertIndex(index);
    if (this.zone[index] === ZoneType.None && !this.hasRoad(index)) return;
    this.zone[index] = ZoneType.None;
    this.road[index] = ROAD_NONE;
    this.reevaluateAround(index);
  }

  /**
   * FNV-1a over the three arrays, in the same shape as `World.contentHash`.
   * T1's verify ("the same sequence twice yields byte-identical arrays") and
   * §16.4's reload comparison both reduce to comparing this string.
   */
  contentHash(): string {
    let hash = 0x811c9dc5;
    for (const array of [this.zone, this.road, this.building]) {
      for (let i = 0; i < array.length; i++) {
        hash = Math.imul(hash ^ array[i], 0x01000193);
      }
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * Re-evaluate one tile **and its four neighbours** (T1.2).
   *
   * Every edit goes through here because every edit is contagious in both
   * directions: placing a road rewrites its neighbours' masks, and removing
   * one can orphan the buildings they were allowed to have. Recomputing the
   * edited tile as well as the ring keeps this a single code path instead of
   * one fast path plus one correct path.
   */
  private reevaluateAround(index: number): void {
    this.reevaluate(index);
    const { size, tileCount } = this;
    const x = index % size;
    if (index >= size) this.reevaluate(index - size);
    if (index < tileCount - size) this.reevaluate(index + size);
    if (x > 0) this.reevaluate(index - 1);
    if (x < size - 1) this.reevaluate(index + 1);
  }

  /** Bring one tile's derived bytes (its mask, its building) back in line. */
  private reevaluate(index: number): void {
    this.derive(index);
    this.dirtyTiles.add(index);
  }

  /**
   * Recompute one tile's derived bytes. Split out from {@link reevaluate} so
   * {@link restore} can derive the whole map in one pass without paying for a
   * dirty entry per tile.
   */
  private derive(index: number): void {
    if (this.hasRoad(index)) {
      this.road[index] = ROAD_BASE + this.maskAt(index);
    }
    this.building[index] = this.buildingVariantAt(index);
  }

  private maskAt(index: number): number {
    const { size, tileCount } = this;
    const x = index % size;
    let mask = 0;
    if (index >= size && this.hasRoad(index - size)) mask |= MASK_N;
    if (x < size - 1 && this.hasRoad(index + 1)) mask |= MASK_E;
    if (index < tileCount - size && this.hasRoad(index + size)) mask |= MASK_S;
    if (x > 0 && this.hasRoad(index - 1)) mask |= MASK_W;
    return mask;
  }

  /**
   * The building rule (T1.3), stated once: a tile carries a building **iff**
   * it is zoned, is not water, has at least one road neighbour, and is not
   * itself a road.
   *
   * The last clause is the one the tile arrays make necessary rather than the
   * prose rule: zoning and roads are separate arrays, so a zoned tile can also
   * be a road tile. Reading it as "a road tile carries no building" is what
   * keeps a road drawn through a zoned block from growing a house underneath
   * it — and it means that bulldozing just the road brings the building back,
   * with no extra state to keep in sync.
   *
   * @returns `0` for none, otherwise `1 + variant`.
   */
  private buildingVariantAt(index: number): number {
    if (this.zone[index] === ZoneType.None) return 0;
    if (this.world.terrain[index] === TerrainType.Water) return 0;
    if (this.hasRoad(index)) return 0;
    if (this.maskAt(index) === 0) return 0;
    return 1 + (variantHash(index, this.world.config.seed) % BUILDING_VARIANTS);
  }

  /**
   * Replace the whole city (T2.3's load path) and rebuild everything derived
   * from it — masks and buildings both. This is the only way in that is not an
   * edit, so it is also the only place the derivation has to run over the
   * whole map; keeping it here rather than letting the loader poke the arrays
   * is what makes "buildings are derived" (T1.3) true on load as well as on
   * edit.
   *
   * The masks are recomputed in one pass after both arrays are in place.
   * Order does not matter: a mask reads its neighbours' *presence*, never
   * their masks, so no tile depends on a tile derived before it.
   *
   * Only tiles that carry something are marked dirty. The renderer draws
   * nothing for an all-zero tile, and dirtying all 262k of them would cost
   * more than the draw.
   */
  restore(zone: Uint8Array, road: Uint8Array): void {
    if (zone.length !== this.tileCount || road.length !== this.tileCount) {
      throw new RangeError(
        `restore expects ${this.tileCount}-tile arrays, got ${zone.length}/${road.length}`,
      );
    }
    this.zone.set(zone);
    this.road.set(road);
    for (let index = 0; index < this.tileCount; index++) {
      this.derive(index);
      if (this.zone[index] !== ZoneType.None || this.hasRoad(index)) {
        this.dirtyTiles.add(index);
      }
    }
  }

  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.tileCount) {
      throw new RangeError(`tile index ${index} is outside 0..${this.tileCount - 1}`);
    }
  }
}
