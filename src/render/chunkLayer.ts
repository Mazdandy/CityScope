import { Container, RenderTexture, Sprite, type Renderer } from 'pixi.js';
import type { World } from '../world/world';
import type { Atlas } from './atlas';
import {
  HALF_TILE_H,
  HALF_TILE_W,
  MAX_CHUNK_TEXTURE_PX,
  MAX_ELEVATION,
  MIN_BAKE_RESOLUTION,
  TILE_H,
  TILE_W,
} from './config';
import { tileFromRotated, type Rotation } from './projection';

/**
 * Chunk streamer (T3.2).
 *
 * The renderer's whole job is: derive the needed chunk set from the camera,
 * build the ones that are missing, recycle the ones that left. The three
 * strategies below exist because §14 left their questions unanswered; §15.4
 * picks each from evidence, so all three ship behind a toggle and one has been
 * settled:
 *
 * - {@link ChunkStrategy} — `live` (one sprite per tile) vs `cached` (the chunk
 *   baked once into a RenderTexture, then one sprite). PRD §14.5 mitigation 1.
 *   **Decided: `cached`** (see the type's own doc for the measurement).
 * - {@link CullingGranularity} — whole-chunk visibility vs per-tile visibility.
 *   Evidence favours `chunk` (§15.5); the toggle stays for re-checking.
 * - {@link RotationMode} — throw the views away and rebuild vs re-project the
 *   existing sprites onto the new tile permutation (T3.6). Open — T7.2.
 *
 * **Coordinate model.** All geometry is authored at *base scale* — one tile is
 * `TILE_W × TILE_H` pixels — and the camera container scales it. That means a
 * zoom change never invalidates chunk geometry, only (for `cached`) the
 * density the RenderTextures were baked at. Positions are "display pixels":
 * base-scale pixels of the *rotated* grid, which is the space the camera rect
 * lives in.
 *
 * Rotation is a permutation of the tile grid, so the chunk grid is stable in
 * display space and only the world indices under it move.
 */

/**
 * `live` keeps every tile as its own sprite; `cached` bakes each chunk into a
 * RenderTexture and draws that instead.
 *
 * `cached` is the default: §15.4's gate was decided on measurement, not on the
 * mitigation ladder's ordering. At the widest zoom it costs 1,024× fewer
 * drawables and 2.2× less update time (T3 A/B), and — the number that actually
 * settled it — it holds §6.2's input budget through a zoom change where `live`
 * does not (T4: app-side response p95 15.8 ms vs 19.8 ms, wheel p95 6.0 ms vs
 * 15.6 ms). The toggle stays so T7 can re-check both.
 */
export type ChunkStrategy = 'live' | 'cached';

/** `chunk` tests one AABB per chunk; `sprite` adds a test per tile. */
export type CullingGranularity = 'chunk' | 'sprite';

/** How a rotation is applied to the resident set (T3.6). */
export type RotationMode = 'rebuild' | 'reproject';

/** Axis-aligned rectangle in display pixels. */
export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ChunkStreamerStats {
  readonly chunks: number;
  readonly sprites: number;
  readonly visibleSprites: number;
  readonly pendingBakes: number;
}

export interface ChunkStreamerOptions {
  readonly world: World;
  readonly atlas: Atlas;
  /** Used only for baking; the streamer never drives the frame loop. */
  readonly renderer: Renderer;
  /** Container the chunk views are parented to. */
  readonly layer: Container;
}

interface Bounds {
  /** Display-pixel AABB of the chunk's tile diamonds, elevation included. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Display-pixel position of the chunk's origin tile (its `(cx,cz)` cell). */
  originX: number;
  originY: number;
}

interface ChunkView {
  readonly cx: number;
  readonly cz: number;
  readonly originX: number;
  readonly originY: number;
  readonly container: Container;
  /** Live strategy only: one sprite per tile, in display-tile walk order. */
  readonly sprites: Sprite[];
  /** Cached strategy only: the one sprite that shows the baked texture. */
  display: Sprite | null;
  /** Cached strategy only. */
  rt: RenderTexture | null;
}

/** Chunks kept resident beyond the view rect, so a pan does not pop at the edge. */
const CHUNK_MARGIN = 1;

/**
 * Cached chunks re-baked per frame. A zoom or quality change re-bakes every
 * resident chunk, and doing that in one frame would be a stall — §15.4 fails on
 * any hitch > 50 ms, so the re-bakes are spread and a stale chunk keeps showing
 * its previous bake until its turn comes. The artifact is a moment of softness
 * at the edge of a zoom, which is the right thing to trade for the budget.
 */
const BAKES_PER_FRAME = 2;

/**
 * Chunks built per frame. Panning only ever brings a couple of new chunks into
 * view, but a zoom step re-derives the whole resident set at once: zooming out
 * from step 1 to step 0 wants ~70 chunks where 24 were, and building 70 × 1024
 * sprites inside one frame is a ~50 ms main-thread hitch (measured — it was the
 * largest single frame in the T4 latency run, and it is our own `update`, not
 * the renderer). Spreading the builds costs a fraction of a second of pop-in on
 * the chunks at the edge of the new view; `BAKES_PER_FRAME` above makes the same
 * trade for the same reason.
 */
const VIEWS_PER_FRAME = 4;

export class ChunkStreamer {
  private readonly world: World;
  private readonly atlas: Atlas;
  private readonly renderer: Renderer;
  private readonly layer: Container;

  private readonly views = new Map<number, ChunkView>();
  /** Keys wanted this frame. Reused so a steady camera allocates nothing. */
  private readonly wanted = new Set<number>();
  private readonly pending = new Set<number>();
  private readonly scratch = { x: 0, z: 0 };

  private strategy: ChunkStrategy = 'cached';
  private culling: CullingGranularity = 'chunk';
  private rotation: Rotation = 0;
  private rotationMode: RotationMode = 'rebuild';
  /** Screen pixels per base pixel, i.e. the camera zoom. */
  private pixelScale = 1;
  private resolution = 1;
  private view: ViewRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private summary: ChunkStreamerStats = { chunks: 0, sprites: 0, visibleSprites: 0, pendingBakes: 0 };

  constructor(options: ChunkStreamerOptions) {
    this.world = options.world;
    this.atlas = options.atlas;
    this.renderer = options.renderer;
    this.layer = options.layer;
    // Chunks overlap where a raised tile reaches into its neighbour, so the
    // draw order has to follow the painter's order across chunks as well as
    // within them.
    this.layer.sortableChildren = true;
  }

  get stats(): ChunkStreamerStats {
    return this.summary;
  }

  get currentStrategy(): ChunkStrategy {
    return this.strategy;
  }

  get currentCulling(): CullingGranularity {
    return this.culling;
  }

  get currentRotationMode(): RotationMode {
    return this.rotationMode;
  }

  setStrategy(strategy: ChunkStrategy): void {
    if (strategy === this.strategy) return;
    this.strategy = strategy;
    this.releaseAll();
  }

  setCulling(culling: CullingGranularity): void {
    this.culling = culling;
  }

  setRotation(rotation: Rotation, mode: RotationMode): void {
    if (rotation === this.rotation && mode === this.rotationMode) return;
    this.rotation = rotation;
    this.rotationMode = mode;

    if (mode === 'rebuild') {
      this.releaseAll();
      return;
    }
    if (this.strategy === 'live') {
      for (const view of this.views.values()) this.reproject(view);
    } else {
      // A bake is pixels, not geometry: there is nothing to re-project, so even
      // in 'reproject' mode a cached chunk has to be re-baked. Recorded in
      // §15.5 rather than hidden.
      for (const key of this.views.keys()) this.pending.add(key);
    }
  }

  /** Camera zoom, as screen pixels per base pixel. */
  setPixelScale(scale: number): void {
    if (scale === this.pixelScale) return;
    this.pixelScale = scale;
    // Live sprites are scaled by the camera container and do not care; cached
    // chunks were baked at the old density and do.
    this.markAllDirty();
  }

  /** Renderer resolution; a cached bake's density is derived from it. */
  setResolution(resolution: number): void {
    if (resolution === this.resolution) return;
    this.resolution = resolution;
    this.markAllDirty();
  }

  setViewRect(rect: ViewRect): void {
    this.view = rect;
  }

  /** One frame: reconcile the resident set, then make progress on bakes. */
  update(): void {
    this.collectWanted();
    this.reconcile();
    this.bakeSome();
    this.measure();
  }

  destroy(): void {
    this.releaseAll();
  }

  // --- resident set ---------------------------------------------------------

  private collectWanted(): void {
    const { chunkSize } = this.world.config;
    const marginX = chunkSize * TILE_W * CHUNK_MARGIN;
    const marginY = chunkSize * TILE_H * CHUNK_MARGIN;
    const view = this.view;
    const x0 = view.x0 - marginX;
    const y0 = view.y0 - marginY;
    const x1 = view.x1 + marginX;
    const y1 = view.y1 + marginY;

    this.wanted.clear();
    for (let cz = 0; cz < this.world.chunksY; cz++) {
      for (let cx = 0; cx < this.world.chunksX; cx++) {
        const b = this.boundsOf(cx, cz);
        if (b.x0 <= x1 && b.x1 >= x0 && b.y0 <= y1 && b.y1 >= y0) {
          this.wanted.add(cz * this.world.chunksX + cx);
        }
      }
    }
  }

  private reconcile(): void {
    for (const [key, view] of this.views) {
      if (!this.wanted.has(key)) {
        this.release(view);
        this.views.delete(key);
        this.pending.delete(key);
      }
    }
    let budget = VIEWS_PER_FRAME;
    for (const key of this.wanted) {
      if (this.views.has(key)) continue;
      if (budget-- <= 0) break;
      const cz = Math.floor(key / this.world.chunksX);
      const cx = key - cz * this.world.chunksX;
      this.views.set(key, this.createView(cx, cz));
    }
  }

  private createView(cx: number, cz: number): ChunkView {
    const bounds = this.boundsOf(cx, cz);
    const container = new Container();
    container.position.set(bounds.originX, bounds.originY);
    container.zIndex = cx + cz;
    container.label = `chunk ${cx},${cz}`;

    const view: ChunkView = {
      cx,
      cz,
      originX: bounds.originX,
      originY: bounds.originY,
      container,
      sprites: [],
      display: null,
      rt: null,
    };

    if (this.strategy === 'live') {
      this.walkTiles(cx, cz, (_index, frame, sx, sy) => {
        const sprite = new Sprite(this.atlas.terrain[frame]);
        sprite.anchor.set(0.5);
        sprite.position.set(sx, sy);
        view.sprites.push(sprite);
        container.addChild(sprite);
      });
    } else {
      this.pending.add(cz * this.world.chunksX + cx);
    }

    this.layer.addChild(container);
    return view;
  }

  private release(view: ChunkView): void {
    view.container.destroy({ children: true });
    if (view.rt) {
      view.rt.destroy(true);
      view.rt = null;
    }
    view.sprites.length = 0;
    view.display = null;
  }

  private releaseAll(): void {
    for (const view of this.views.values()) this.release(view);
    this.views.clear();
    this.pending.clear();
  }

  private markAllDirty(): void {
    if (this.strategy !== 'cached') return;
    for (const key of this.views.keys()) this.pending.add(key);
  }

  // --- building -------------------------------------------------------------

  /**
   * Walk the chunk's display-space tile cells and hand each one's placement to
   * `apply`: the atlas frame, and the position relative to the chunk origin.
   *
   * Iteration is row-major over `(rx, rz)`, so both coordinates only increase:
   * the emission order is already back-to-front for the painter's algorithm,
   * and it is stable across rotations, which is what lets `reproject` write
   * into an existing sprite array.
   */
  private walkTiles(
    cx: number,
    cz: number,
    apply: (index: number, frame: number, sx: number, sy: number) => void,
  ): void {
    const { chunkSize, size } = this.world.config;
    const ox = cx * chunkSize;
    const oz = cz * chunkSize;
    const scratch = this.scratch;
    let index = 0;

    for (let dz = 0; dz < chunkSize; dz++) {
      const rz = oz + dz;
      if (rz >= size) break;
      for (let dx = 0; dx < chunkSize; dx++) {
        const rx = ox + dx;
        if (rx >= size) break;
        tileFromRotated(rx, rz, size, this.rotation, scratch);
        const tile = scratch.z * size + scratch.x;
        apply(
          index++,
          this.world.terrain[tile],
          (dx - dz) * HALF_TILE_W,
          (dx + dz) * HALF_TILE_H - this.world.height[tile] * MAX_ELEVATION,
        );
      }
    }
  }

  /** Re-place a live view's sprites onto the new rotation without rebuilding them. */
  private reproject(view: ChunkView): void {
    this.walkTiles(view.cx, view.cz, (index, frame, sx, sy) => {
      const sprite = view.sprites[index];
      if (!sprite) return;
      sprite.texture = this.atlas.terrain[frame];
      sprite.position.set(sx, sy);
    });
  }

  private bakeSome(): void {
    if (this.pending.size === 0) return;
    let budget = BAKES_PER_FRAME;
    for (const key of this.pending) {
      if (budget-- <= 0) break;
      this.pending.delete(key);
      const view = this.views.get(key);
      if (!view) continue;
      this.bake(view);
    }
  }

  private bake(view: ChunkView): void {
    const { chunkSize } = this.world.config;
    const width = Math.ceil(chunkSize * TILE_W);
    const height = Math.ceil(chunkSize * TILE_H + MAX_ELEVATION);
    const bounds = this.boundsOf(view.cx, view.cz);

    if (view.rt) {
      view.rt.destroy(true);
      view.rt = null;
    }
    const rt = RenderTexture.create({
      width,
      height,
      resolution: this.bakeResolution(width, height),
      label: `chunk ${view.cx},${view.cz}`,
    });
    view.rt = rt;

    // Build the chunk's geometry into a detached container shifted so its
    // bounds start at the texture's origin, then draw that container once.
    const bakeContainer = new Container();
    bakeContainer.position.set(bounds.originX - bounds.x0, bounds.originY - bounds.y0);
    this.walkTiles(view.cx, view.cz, (_index, frame, sx, sy) => {
      const sprite = new Sprite(this.atlas.terrain[frame]);
      sprite.anchor.set(0.5);
      sprite.position.set(sx, sy);
      bakeContainer.addChild(sprite);
    });
    this.renderer.render({
      container: bakeContainer,
      target: rt,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
    bakeContainer.destroy({ children: true });

    const centreX = bounds.x0 - bounds.originX + width / 2;
    const centreY = bounds.y0 - bounds.originY + height / 2;
    let display = view.display;
    if (!display) {
      display = new Sprite(rt);
      display.anchor.set(0.5);
      view.display = display;
      view.container.addChild(display);
    }
    display.texture = rt;
    display.position.set(centreX, centreY);
  }

  /**
   * Texture density for a bake: the density the chunk occupies on screen,
   * capped by VRAM rather than by quality.
   */
  private bakeResolution(width: number, height: number): number {
    const wanted = this.resolution * this.pixelScale;
    const cap = Math.min(MAX_CHUNK_TEXTURE_PX / width, MAX_CHUNK_TEXTURE_PX / height);
    return Math.max(MIN_BAKE_RESOLUTION, Math.min(wanted, cap));
  }

  // --- culling & reporting --------------------------------------------------

  /**
   * Apply the culling A/B (T3.2) and report the frame's counts.
   *
   * `chunk` leaves the whole resident set visible — the resident set is chosen
   * from the view rect *plus* {@link CHUNK_MARGIN}, so this deliberately draws
   * the margin's overshoot, which is the cost the toggle exists to measure.
   * `sprite` pays a test per tile to drop it.
   *
   * In `cached` there is one drawable per chunk, so the two granularities
   * coincide; the toggle is only meaningful in `live`.
   */
  private measure(): void {
    const view = this.view;
    const perSprite = this.culling === 'sprite';
    let sprites = 0;
    let visible = 0;

    for (const chunk of this.views.values()) {
      const display = chunk.display;
      if (display) {
        sprites++;
        display.visible = true;
        visible++;
        continue;
      }

      for (const sprite of chunk.sprites) {
        sprites++;
        if (!perSprite) {
          sprite.visible = true;
          visible++;
          continue;
        }
        const x = chunk.originX + sprite.x;
        const y = chunk.originY + sprite.y;
        const on =
          x + HALF_TILE_W >= view.x0 &&
          x - HALF_TILE_W <= view.x1 &&
          y + HALF_TILE_H >= view.y0 &&
          y - HALF_TILE_H <= view.y1;
        sprite.visible = on;
        if (on) visible++;
      }
    }

    this.summary = {
      chunks: this.views.size,
      sprites,
      visibleSprites: visible,
      pendingBakes: this.pending.size,
    };
  }

  private boundsOf(cx: number, cz: number): Bounds & { originX: number; originY: number } {
    const { chunkSize } = this.world.config;
    const ox = cx * chunkSize;
    const oz = cz * chunkSize;
    const originX = (ox - oz) * HALF_TILE_W;
    const originY = (ox + oz) * HALF_TILE_H;
    return {
      originX,
      originY,
      x0: originX - chunkSize * HALF_TILE_W,
      y0: originY - MAX_ELEVATION - HALF_TILE_H,
      x1: originX + chunkSize * HALF_TILE_W,
      y1: originY + chunkSize * TILE_H - HALF_TILE_H,
    };
  }
}
