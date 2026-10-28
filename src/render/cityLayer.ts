import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { ZoneType, type City } from '../world/city';
import type { World } from '../world/world';
import { BUILDING_BASE_OFFSET, buildingFrameIndex, zoneFrameIndex, type Atlas } from './atlas';
import { HALF_TILE_H, HALF_TILE_W, MAX_ELEVATION } from './config';
import { rotateMask, tileToRotated, type Rotation } from './projection';
import type { RenderLayers } from './renderer';

/**
 * The built city on screen (PRD §16.3 T5).
 *
 * One sprite per non-empty tile in each of the renderer's three city bands,
 * driven by `City`'s dirty set rather than by a per-frame scan: an edit touches
 * at most five tiles, so a frame after a click costs at most five sprite
 * updates, and a frame with no edit costs none.
 *
 * ## Two things this layer has to get right
 *
 * - **Zone tint goes under the road.** A tile can be zoned *and* paved — the
 *   two are separate arrays in `City` — so the tint has to be drawn before the
 *   road surface, and both before any building. That is why the renderer has a
 *   `zones` band at all; see {@link RenderLayers}.
 * - **Buildings are placed by their base, not their centre.** Their frames are
 *   taller than a tile so the box can rise out of it, so the sprite is offset
 *   by {@link BUILDING_BASE_OFFSET}.
 *
 * ## Positions are display-space and rotation-free
 *
 * Every sprite sits at its tile's position in the *rotated* grid, in base
 * pixels, relative to the camera container — which is what makes the camera a
 * pure translate + scale (T4.1) and means a pan costs nothing here. Only a
 * rotation moves sprites, and it moves all of them, so it is a full pass rather
 * than a dirty-set pass.
 *
 * Road frames are the one thing that depends on rotation twice over: the mask
 * is stored in world space (so the same city hashes the same at any angle) but
 * the atlas indexes its 16 frames by the compass *as drawn*, so
 * {@link rotateMask} has to run before every lookup.
 *
 * At M1 scale one sprite per built tile is fine — the §4 budget is 5,000
 * citizens, not 262k zone tiles. A brush that covers thousands of tiles in one
 * drag is where this would need chunking, and that is M3's problem, not M1's.
 */

/**
 * What the active tool would place, so the ghost matches the real thing.
 * `null` is the cursor tool: nothing is placed and nothing is previewed.
 */
export type BuildPreview =
  | { readonly kind: 'road' }
  | { readonly kind: 'zone'; readonly zone: ZoneType }
  | { readonly kind: 'bulldoze' }
  | null;

export interface CityLayerOptions {
  readonly world: World;
  readonly city: City;
  readonly atlas: Atlas;
  readonly layers: RenderLayers;
}

export interface CityLayerStats {
  readonly zoneSprites: number;
  readonly roadSprites: number;
  readonly buildingSprites: number;
}

/** Highlight colour when the tool would change the tile. */
const HOVER_OK = 0xbfeadb;
/** Highlight colour when the tool would be a no-op there. */
const HOVER_NOOP = 0xe0726c;
/** Alpha of the ghost preview, so the terrain reads through it. */
const GHOST_ALPHA = 0.6;

export class CityLayer {
  private readonly world: World;
  private readonly city: City;
  private readonly atlas: Atlas;
  private readonly layers: RenderLayers;

  /** Keyed by tile index, so a drain is a lookup per dirty tile and no scan. */
  private readonly zoneSprites = new Map<number, Sprite>();
  private readonly roadSprites = new Map<number, Sprite>();
  private readonly buildingSprites = new Map<number, Sprite>();

  private readonly highlight = new Graphics();
  private readonly ghost = new Sprite();
  private preview: BuildPreview = null;
  private hovered: number | null = null;

  private rotation: Rotation = 0;
  /** Scratch for `tileToRotated`, shared by every placement in a pass. */
  private readonly scratch = { x: 0, z: 0 };

  constructor(options: CityLayerOptions) {
    this.world = options.world;
    this.city = options.city;
    this.atlas = options.atlas;
    this.layers = options.layers;

    // A building rises into the tiles behind it, so within the band it has to
    // be drawn back-to-front. Terrain gets this for free from the chunk
    // streamer's iteration order; a dirty set has no order at all, so the
    // buildings band sorts on a depth key instead.
    this.layers.buildings.sortableChildren = true;

    this.ghost.anchor.set(0.5);
    this.ghost.alpha = GHOST_ALPHA;
    this.ghost.visible = false;
    this.highlight.visible = false;
    this.layers.overlays.addChild(this.ghost, this.highlight);
  }

  get stats(): CityLayerStats {
    return {
      zoneSprites: this.zoneSprites.size,
      roadSprites: this.roadSprites.size,
      buildingSprites: this.buildingSprites.size,
    };
  }

  /** The bands this layer drives, in §7's order. */
  get bands(): { readonly zones: Container; readonly roads: Container; readonly buildings: Container } {
    return {
      zones: this.layers.zones,
      roads: this.layers.roads,
      buildings: this.layers.buildings,
    };
  }

  /**
   * Draw whatever changed, and re-place everything if the camera turned.
   *
   * Called once per frame from the owner of the ticker; does nothing at all on
   * a frame where the player neither edited nor rotated.
   */
  sync(rotation: Rotation): void {
    if (rotation !== this.rotation) {
      this.rotation = rotation;
      this.replaceAll();
    }
    for (const index of this.city.drainDirty()) {
      this.refresh(index);
    }
    this.layoutOverlays();
  }

  /** The active tool, so the ghost previews what a click would place (T5.2). */
  setPreview(preview: BuildPreview): void {
    this.preview = preview;
    this.layoutOverlays();
  }

  /** The tile under the cursor, or `null` when the pointer is off the map. */
  setHover(tile: { readonly x: number; readonly z: number } | null): void {
    this.hovered = tile ? tile.z * this.city.size + tile.x : null;
    this.layoutOverlays();
  }

  destroy(): void {
    for (const map of [this.zoneSprites, this.roadSprites, this.buildingSprites]) {
      for (const sprite of map.values()) sprite.destroy();
      map.clear();
    }
    this.ghost.destroy();
    this.highlight.destroy();
  }

  // --- sprites --------------------------------------------------------------

  /**
   * Bring one tile's three sprites in line with its three bytes. A `null`
   * frame means "nothing here", which removes the sprite — that is the whole
   * of the no-leak guarantee: presence is decided from the array, never from
   * what happened to be on screen already.
   */
  private refresh(index: number): void {
    const zone = this.city.zone[index];
    this.setSprite(
      this.zoneSprites,
      this.layers.zones,
      index,
      zone === ZoneType.None ? null : this.atlas.zone[zoneFrameIndex(zone)],
      0,
    );

    this.setSprite(
      this.roadSprites,
      this.layers.roads,
      index,
      this.city.hasRoad(index) ? this.atlas.road[rotateMask(this.city.roadMask(index), this.rotation)] : null,
      0,
    );

    const building = this.city.building[index];
    this.setSprite(
      this.buildingSprites,
      this.layers.buildings,
      index,
      building === 0 ? null : this.atlas.building[buildingFrameIndex(zone, building)],
      BUILDING_BASE_OFFSET,
    );
  }

  /**
   * Re-place every sprite. Only a rotation needs this, and it is the only pass
   * that is not proportional to the edit size — a rotation changes which tile
   * is drawn where, and with `reproject` it also changes the road frames'
   * compass.
   */
  private replaceAll(): void {
    for (const [index, sprite] of this.zoneSprites) this.place(index, sprite, 0);
    for (const [index, sprite] of this.roadSprites) {
      sprite.texture = this.atlas.road[rotateMask(this.city.roadMask(index), this.rotation)];
      this.place(index, sprite, 0);
    }
    for (const [index, sprite] of this.buildingSprites) this.place(index, sprite, BUILDING_BASE_OFFSET);
  }

  private setSprite(
    map: Map<number, Sprite>,
    band: Container,
    index: number,
    frame: Texture | null,
    lift: number,
  ): void {
    const existing = map.get(index);
    if (frame === null) {
      if (!existing) return;
      map.delete(index);
      existing.destroy();
      return;
    }
    const sprite = existing ?? this.create(map, band, index, frame);
    sprite.texture = frame;
    this.place(index, sprite, lift);
  }

  private create(map: Map<number, Sprite>, band: Container, index: number, frame: Texture): Sprite {
    const sprite = new Sprite(frame);
    sprite.anchor.set(0.5);
    map.set(index, sprite);
    band.addChild(sprite);
    return sprite;
  }

  /**
   * Put a sprite at its tile's display position, lifted by the tile's terrain
   * height so the city sits on the ground rather than through it.
   *
   * @param lift extra base pixels to raise the sprite by, for a building whose
   * frame carries its rise below its middle.
   */
  private place(index: number, sprite: Sprite, lift: number): void {
    const size = this.city.size;
    const scratch = this.scratch;
    tileToRotated(index % size, (index / size) | 0, size, this.rotation, scratch);
    sprite.position.set(
      (scratch.x - scratch.z) * HALF_TILE_W,
      (scratch.x + scratch.z) * HALF_TILE_H - this.world.height[index] * MAX_ELEVATION - lift,
    );
    // Depth within the band: further down the screen is nearer the camera.
    if (lift !== 0) sprite.zIndex = scratch.x + scratch.z;
  }

  // --- overlays -------------------------------------------------------------

  /**
   * Position the hover highlight and the tool's ghost.
   *
   * Colour is feedback, not decoration: the highlight only brightens when the
   * tool would actually change the tile, so a drag over an existing road or an
   * already-zoned block shows that the input is being ignored — which is the
   * cheapest way to make "nothing happened" distinguishable from "the click
   * missed".
   *
   * With no tool active (the cursor tool) there is nothing to place and nothing
   * to warn about, so both overlays stay hidden rather than showing a highlight
   * that promises a change no click would make.
   */
  private layoutOverlays(): void {
    const index = this.hovered;
    if (index === null || this.preview === null) {
      this.highlight.visible = false;
      this.ghost.visible = false;
      return;
    }

    const ok = this.wouldChange(index);
    const scratch = this.scratch;
    const size = this.city.size;
    tileToRotated(index % size, (index / size) | 0, size, this.rotation, scratch);
    const x = (scratch.x - scratch.z) * HALF_TILE_W;
    const y = (scratch.x + scratch.z) * HALF_TILE_H - this.world.height[index] * MAX_ELEVATION;

    this.highlight
      .clear()
      .moveTo(x, y - HALF_TILE_H)
      .lineTo(x + HALF_TILE_W, y)
      .lineTo(x, y + HALF_TILE_H)
      .lineTo(x - HALF_TILE_W, y)
      .closePath()
      .stroke({ width: 1.5, color: ok ? HOVER_OK : HOVER_NOOP, alpha: 0.9 });
    this.highlight.visible = true;

    const frame = this.ghostFrame();
    this.ghost.visible = frame !== null;
    if (frame) {
      this.ghost.texture = frame;
      this.ghost.position.set(x, y);
    }
  }

  /** The frame the ghost draws, or `null` when the tool has no preview. */
  private ghostFrame(): Texture | null {
    switch (this.preview?.kind) {
      case 'road':
        // The hub frame: the mask would depend on neighbours that do not exist
        // yet, so the ghost shows the tile being paved, not the final shape.
        return this.atlas.road[rotateMask(0, this.rotation)];
      case 'zone':
        return this.atlas.zone[zoneFrameIndex(this.preview.zone)];
      default:
        // Bulldoze has no shape to preview — the red highlight is the preview,
        // because what the tool does is remove rather than place.
        return null;
    }
  }

  /** Would the active tool actually change this tile? */
  private wouldChange(index: number): boolean {
    switch (this.preview?.kind) {
      case 'road':
        return !this.city.hasRoad(index);
      case 'zone':
        return this.city.zone[index] !== this.preview.zone;
      case 'bulldoze':
        return this.city.zone[index] !== ZoneType.None || this.city.hasRoad(index);
      default:
        // Only reachable with no tool, which the caller has already handled.
        return false;
    }
  }
}
