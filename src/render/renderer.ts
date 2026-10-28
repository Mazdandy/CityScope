import { Container, type Application, type Renderer } from 'pixi.js';
import type { World } from '../world/world';
import { buildAtlas, type Atlas } from './atlas';
import {
  ChunkStreamer,
  type ChunkStrategy,
  type ChunkStreamerStats,
  type CullingGranularity,
  type RotationMode,
} from './chunkLayer';
import { DEFAULT_ZOOM_INDEX, HALF_TILE_H, HALF_TILE_W, TILE_H, TILE_W, ZOOM_STEPS } from './config';
import { QUALITY_ORDER, QUALITY_PRESETS, resolveResolution, type QualityTier } from './quality';
import { tileFromRotated, tileToRotated, type Rotation } from './projection';

/**
 * Renderer core (T3).
 *
 * Owns the scene graph, the camera transform and the chunk streamer. It has no
 * input handling and no frame loop of its own: `update()` is called by whoever
 * owns the ticker (today `main.ts`, later the T5 shell), which keeps the camera
 * drivable from a test harness — §15.3's A2 sweep is a scripted pan, not a
 * mouse.
 *
 * **Camera model.** The camera anchor is a fractional *world tile* coordinate,
 * not a pixel. Pixels would be ambiguous under rotation — a screen position
 * means a different place after a quarter turn — so the anchor is kept in the
 * space that rotation does not distort, and projected fresh every frame.
 */

/**
 * Layer order is §7's, with one M1 insertion: terrain → **zones** → roads →
 * buildings → agents → overlays.
 *
 * Zone tint is a ground-plane overlay — it has to sit *under* the road on a
 * zoned tile that carries one, and under any building, so it cannot live in
 * `overlays` (which §7 draws last, over everything). Adding a band for it is
 * what keeps T5 from having to special-case a tile that is both zoned and
 * paved.
 */
export interface RenderLayers {
  /** T3.3 — the generated terrain, baked into chunk textures. */
  readonly terrain: Container;
  /** M1: zone tints, one sprite per zoned tile. */
  readonly zones: Container;
  /** M1: roads, one sprite per road tile. */
  readonly roads: Container;
  /** M1: buildings, one sprite per built tile. */
  readonly buildings: Container;
  /** Reserved for M2's agents. */
  readonly agents: Container;
  /** M1: hover highlight and the active tool's ghost preview. */
  readonly overlays: Container;
}

export interface CameraState {
  /** Anchor in world tile coordinates. Fractional, so panning is smooth. */
  readonly x: number;
  readonly z: number;
  readonly zoomIndex: number;
  readonly rotation: Rotation;
}

export interface RenderStats extends ChunkStreamerStats {
  readonly quality: QualityTier;
  readonly strategy: ChunkStrategy;
  readonly culling: CullingGranularity;
  readonly rotationMode: RotationMode;
  readonly zoomIndex: number;
  readonly rotation: Rotation;
  /** Screen pixels per base pixel. */
  readonly pixelScale: number;
  readonly resolution: number;
}

export interface WorldRendererOptions {
  readonly app: Application;
  readonly world: World;
  readonly quality?: QualityTier;
}

/** A tile in world coordinates. */
export interface TilePoint {
  readonly x: number;
  readonly z: number;
}

export class WorldRenderer {
  private readonly app: Application;
  private readonly world: World;
  private readonly atlasSheet: Atlas;
  private readonly streamer: ChunkStreamer;
  private readonly scratch = { x: 0, z: 0 };
  /** Kept apart from {@link scratch} so picking never disturbs the camera. */
  private readonly pickScratch = { x: 0, z: 0 };

  /** Camera transform. Chunk geometry is authored in base pixels under it. */
  private readonly cameraRoot = new Container();
  private readonly layerMap: RenderLayers;

  private camera: CameraState = { x: 0, z: 0, zoomIndex: DEFAULT_ZOOM_INDEX, rotation: 0 };
  private qualityTier: QualityTier = 'Med';

  constructor(options: WorldRendererOptions) {
    this.app = options.app;
    this.world = options.world;

    const half = this.world.config.size / 2;
    this.camera = { ...this.camera, x: half, z: half };

    this.cameraRoot.label = 'camera';
    this.layerMap = {
      terrain: label(new Container(), 'terrain'),
      zones: label(new Container(), 'zones'),
      roads: label(new Container(), 'roads'),
      buildings: label(new Container(), 'buildings'),
      agents: label(new Container(), 'agents'),
      overlays: label(new Container(), 'overlays'),
    };
    this.cameraRoot.addChild(
      this.layerMap.terrain,
      this.layerMap.zones,
      this.layerMap.roads,
      this.layerMap.buildings,
      this.layerMap.agents,
      this.layerMap.overlays,
    );
    this.app.stage.addChild(this.cameraRoot);

    this.atlasSheet = buildAtlas();
    this.streamer = new ChunkStreamer({
      world: this.world,
      atlas: this.atlasSheet,
      renderer: this.app.renderer,
      layer: this.layerMap.terrain,
    });

    this.setQuality(options.quality ?? 'Med');
    this.applyCamera();
  }

  get renderer(): Renderer {
    return this.app.renderer;
  }

  get layers(): RenderLayers {
    return this.layerMap;
  }

  /**
   * The frame sheet the city layers draw from. Exposed rather than rebuilt:
   * a second `buildAtlas()` would upload a second 1024×152 texture for the same
   * pixels, and the two would then be free to drift apart.
   */
  get atlas(): Atlas {
    return this.atlasSheet;
  }

  get state(): CameraState {
    return this.camera;
  }

  get stats(): RenderStats {
    return {
      ...this.streamer.stats,
      quality: this.qualityTier,
      strategy: this.streamer.currentStrategy,
      culling: this.streamer.currentCulling,
      rotationMode: this.streamer.currentRotationMode,
      zoomIndex: this.camera.zoomIndex,
      rotation: this.camera.rotation,
      pixelScale: this.pixelScale,
      resolution: this.app.renderer.resolution,
    };
  }

  get pixelScale(): number {
    return ZOOM_STEPS[this.camera.zoomIndex] / TILE_W;
  }

  // --- camera ---------------------------------------------------------------

  /**
   * Move the camera by a screen-space delta, so panning feels identical at
   * every zoom step. The delta is converted into display tiles (the rotated
   * grid) and then back into world tiles, because the anchor lives in world
   * space.
   */
  panByScreen(deltaX: number, deltaY: number): void {
    const scale = this.pixelScale;
    const drx = deltaX / (TILE_W * scale) + deltaY / (TILE_H * scale);
    const drz = deltaY / (TILE_H * scale) - deltaX / (TILE_W * scale);

    let dx = 0;
    let dz = 0;
    switch (this.camera.rotation) {
      case 0:
        dx = drx;
        dz = drz;
        break;
      case 1:
        dx = drz;
        dz = -drx;
        break;
      case 2:
        dx = -drx;
        dz = -drz;
        break;
      case 3:
        dx = -drz;
        dz = drx;
        break;
    }

    this.setCamera({ x: this.camera.x + dx, z: this.camera.z + dz });
  }

  setCamera(next: Partial<CameraState>): void {
    const last = this.world.config.size - 1;
    const clamp = (value: number): number => Math.min(Math.max(value, 0), last);
    this.camera = {
      x: clamp(next.x ?? this.camera.x),
      z: clamp(next.z ?? this.camera.z),
      zoomIndex: next.zoomIndex ?? this.camera.zoomIndex,
      rotation: next.rotation ?? this.camera.rotation,
    };
    // The transform is applied in `update()`, once per frame: camera setters can
    // fire many times between frames (a drag, a held key, a scripted sweep) and
    // reconciling the chunk set per call would be wasted work.
  }

  recentre(): void {
    const half = this.world.config.size / 2;
    this.setCamera({ x: half, z: half });
  }

  /**
   * T4.4: settle the anchor onto the tile grid.
   *
   * The anchor is a tile coordinate whose integer values are tile centres, so
   * rounding it is the whole operation. The input layer calls this when camera
   * movement stops rather than on every change — see `src/ui/input.ts` for why
   * snapping continuously would make a drag step tile by tile.
   */
  snapAnchor(): void {
    this.setCamera({ x: Math.round(this.camera.x), z: Math.round(this.camera.z) });
  }

  /** `Q`/`E` in T4.3; here it is the T3.6 rotation A/B's driver. */
  rotate(delta: number): void {
    const rotation = (((this.camera.rotation + delta) % 4) + 4) % 4;
    this.setCamera({ rotation: rotation as Rotation });
  }

  setZoomIndex(index: number): void {
    const clamped = Math.min(Math.max(index, 0), ZOOM_STEPS.length - 1);
    this.setCamera({ zoomIndex: clamped });
  }

  /**
   * Tile under a screen point (T4.1), or `null` when the point falls off the
   * map.
   *
   * The camera root is a pure translate + scale, so the inverse is arithmetic
   * rather than a matrix read — no `toLocal`, no rounding through a container.
   * Undoing the translate and the scale leaves display pixels, and those are
   * `rx·u + rz·v` for the rotated-grid basis `u = (HALF_W, HALF_H)` and
   * `v = (−HALF_W, HALF_H)` — the screen images of a `+x` and a `+z` step — so
   * two divisions recover the fractional rotated tile.
   *
   * Rounding, not flooring: a tile's integer coordinate *is* its centre, and
   * because the projection is linear, "inside the drawn diamond" and "inside
   * the unit square around the centre in `(rx, rz)`" are the same test. The
   * nearest integer in the basis is therefore exact, at every rotation and
   * every zoom.
   *
   * Reads the camera transform as last applied by {@link update}, which is what
   * makes the answer the tile *drawn* under the point rather than the tile a
   * pending camera change would imply.
   */
  pickTile(screenX: number, screenY: number): TilePoint | null {
    const { size } = this.world.config;
    const scale = this.pixelScale;
    const baseX = (screenX - this.cameraRoot.position.x) / scale;
    const baseY = (screenY - this.cameraRoot.position.y) / scale;

    const rx = Math.round((baseX / HALF_TILE_W + baseY / HALF_TILE_H) / 2);
    const rz = Math.round((baseY / HALF_TILE_H - baseX / HALF_TILE_W) / 2);
    if (rx < 0 || rz < 0 || rx >= size || rz >= size) return null;

    const scratch = this.pickScratch;
    tileFromRotated(rx, rz, size, this.camera.rotation, scratch);
    return { x: scratch.x, z: scratch.z };
  }

  // --- renderer controls ----------------------------------------------------

  setQuality(tier: QualityTier): void {
    this.qualityTier = tier;
    // The device pixel ratio is read fresh each time: a window dragged between
    // displays (or a browser zoom) changes it, and T3.5's policy is relative to
    // it, not to a value captured at boot.
    this.app.renderer.resolution = resolveResolution(
      QUALITY_PRESETS[tier].renderScale,
      window.devicePixelRatio,
    );
  }

  cycleQuality(): QualityTier {
    const index = QUALITY_ORDER.indexOf(this.qualityTier);
    const next = QUALITY_ORDER[(index + 1) % QUALITY_ORDER.length];
    this.setQuality(next);
    return next;
  }

  setChunkStrategy(strategy: ChunkStrategy): void {
    this.streamer.setStrategy(strategy);
  }

  setCullingGranularity(culling: CullingGranularity): void {
    this.streamer.setCulling(culling);
  }

  setRotationMode(mode: RotationMode): void {
    this.streamer.setRotation(this.camera.rotation, mode);
  }

  // --- frame ----------------------------------------------------------------

  /** Called once per rendered frame, before the draw. */
  update(): void {
    this.applyCamera();
  }

  destroy(): void {
    this.streamer.destroy();
    this.atlasSheet.texture.destroy(true);
    this.cameraRoot.destroy({ children: true });
  }

  private applyCamera(): void {
    const { size } = this.world.config;
    const scale = this.pixelScale;
    const scratch = this.scratch;
    tileToRotated(this.camera.x, this.camera.z, size, this.camera.rotation, scratch);

    const px = (scratch.x - scratch.z) * HALF_TILE_W * scale;
    const py = (scratch.x + scratch.z) * HALF_TILE_H * scale;
    const screen = this.app.screen;
    this.cameraRoot.position.set(screen.width / 2 - px, screen.height / 2 - py);
    this.cameraRoot.scale.set(scale);

    // Visible region in display pixels — the space the chunk streamer works in.
    const originX = -this.cameraRoot.position.x / scale;
    const originY = -this.cameraRoot.position.y / scale;
    this.streamer.setPixelScale(scale);
    this.streamer.setResolution(this.app.renderer.resolution);
    // Rotation is the camera's, but the tile contents belong to the streamer —
    // it has to be told, and it is the call that also applies the T3.6 rebuild
    // vs re-project choice. It no-ops when neither rotation nor mode moved.
    this.streamer.setRotation(this.camera.rotation, this.streamer.currentRotationMode);
    this.streamer.setViewRect({
      x0: originX,
      y0: originY,
      x1: originX + screen.width / scale,
      y1: originY + screen.height / scale,
    });
    this.streamer.update();
  }
}

function label(container: Container, name: string): Container {
  container.label = name;
  return container;
}
