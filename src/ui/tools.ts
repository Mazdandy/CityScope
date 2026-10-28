import type { BuildPreview, CityLayer } from '../render/cityLayer';
import type { TilePoint, WorldRenderer } from '../render/renderer';
import { ZoneType, type City } from '../world/city';

/**
 * Tool state machine and pointer routing (PRD §16.3 T6).
 *
 * A tool is a *preview* plus the write it performs, and both are read from the
 * same {@link Tool} record. That is deliberate: the ghost the player sees and
 * the byte a click writes cannot drift apart, because there is only one
 * description of each tool, and adding one is adding a row to {@link TOOLS}.
 *
 * ## Routing
 *
 * With the cursor tool the left button pans, exactly as it did before M1. With
 * a build tool active the left button paints and the **middle** button still
 * pans, so the camera is never unreachable while building. That decision is
 * {@link buildMode}: `CameraInput` asks, and stands down from the left button
 * while it is true, so the two never fight over the same press.
 *
 * The hovered tile is recomputed every frame rather than only on `pointermove`,
 * because panning or zooming under a stationary pointer changes which tile is
 * under it. It is written to the layer only when the tile actually changed, so
 * a still pointer over a still camera costs nothing.
 *
 * ## Drags
 *
 * A drag paints a **line**, not the sequence of tiles the pointer happened to
 * be sampled over — a fast drag would otherwise leave gaps in a road. Each step
 * of Bresenham's line moves at most one tile on each axis, so the painted run
 * is **8-connected**: no tile between two sampled points is skipped, and a
 * diagonal step touches corner-to-corner rather than leaving a hole. It is
 * deliberately *not* 4-connected — a drag that runs diagonally paints a
 * diagonal, which is what a straight drag should look like, and widening it
 * into a staircase would paint tiles the player never traced. A straight
 * world-space line is also a straight display-space line, because rotation is a
 * permutation of the grid, so the road the player sees being dragged is the one
 * they traced.
 */

export type ToolId = 'cursor' | 'road' | 'zone-r' | 'zone-c' | 'zone-i' | 'bulldoze';

export interface Tool {
  readonly id: ToolId;
  /** Position in §6.2's `1`–`9` tool bar. */
  readonly slot: number;
  /** Shown in the HUD, and in T7's palette. */
  readonly label: string;
  /** Letter alias. */
  readonly key: string;
  /** What the layer previews while this tool is active; `null` = no preview. */
  readonly preview: BuildPreview;
}

/**
 * The tool bar (§6.2 reserves `1`–`9`; M1 uses six). Order is the order the
 * keys are laid out in, so slot `n` is key `n`.
 */
export const TOOLS: readonly Tool[] = [
  { id: 'cursor', slot: 1, label: 'Cursor', key: 'Esc', preview: null },
  { id: 'road', slot: 2, label: 'Road', key: 'T', preview: { kind: 'road' } },
  {
    id: 'zone-r',
    slot: 3,
    label: 'Zone R',
    key: 'R',
    preview: { kind: 'zone', zone: ZoneType.Residential },
  },
  {
    id: 'zone-c',
    slot: 4,
    label: 'Zone C',
    key: 'C',
    preview: { kind: 'zone', zone: ZoneType.Commercial },
  },
  {
    id: 'zone-i',
    slot: 5,
    label: 'Zone I',
    key: 'I',
    preview: { kind: 'zone', zone: ZoneType.Industrial },
  },
  { id: 'bulldoze', slot: 6, label: 'Bulldoze', key: 'B', preview: { kind: 'bulldoze' } },
];

export interface ToolControllerOptions {
  readonly view: WorldRenderer;
  readonly city: City;
  readonly layer: CityLayer;
  /** Element that receives pointer events — the renderer's canvas. */
  readonly surface: HTMLElement;
  /** Called after a discrete change so the HUD can re-render. */
  readonly onSignal?: () => void;
  /**
   * Called when a tool has written to a tile, so the owner can autosave (T2.2).
   * Fired per tile rather than per stroke: the debounce downstream is what
   * collapses a drag into one write, and keeping the signal honest here means
   * the schedule is never missed.
   */
  readonly onEdit?: () => void;
}

export class ToolController {
  private readonly view: WorldRenderer;
  private readonly city: City;
  private readonly layer: CityLayer;
  private readonly surface: HTMLElement;
  private readonly onSignal: (() => void) | undefined;
  private readonly onEdit: (() => void) | undefined;

  private current: Tool = TOOLS[0];
  /** Pointer position in canvas-local CSS px, or `null` when it is off the map. */
  private pointer: { x: number; y: number } | null = null;
  private hoverKey: number | null = null;

  /** Pointer id while a paint drag is in progress, else `null`. */
  private paintPointer: number | null = null;
  /** The tile the current drag last painted, so the next move can join to it. */
  private lastPaint: { x: number; z: number } | null = null;

  constructor(options: ToolControllerOptions) {
    this.view = options.view;
    this.city = options.city;
    this.layer = options.layer;
    this.surface = options.surface;
    this.onSignal = options.onSignal;
    this.onEdit = options.onEdit;
  }

  attach(): void {
    const surface = this.surface;
    surface.addEventListener('pointerdown', this.onPointerDown);
    surface.addEventListener('pointermove', this.onPointerMove);
    surface.addEventListener('pointerup', this.onPointerUp);
    surface.addEventListener('pointercancel', this.onPointerUp);
    surface.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('keydown', this.onKeyDown);
  }

  destroy(): void {
    const surface = this.surface;
    surface.removeEventListener('pointerdown', this.onPointerDown);
    surface.removeEventListener('pointermove', this.onPointerMove);
    surface.removeEventListener('pointerup', this.onPointerUp);
    surface.removeEventListener('pointercancel', this.onPointerUp);
    surface.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  get active(): Tool {
    return this.current;
  }

  /**
   * True while a tool is active. The left button paints instead of panning —
   * `CameraInput` reads this rather than keeping its own copy of the state.
   */
  get buildMode(): boolean {
    return this.current.preview !== null;
  }

  select(id: ToolId): void {
    const tool = TOOLS.find((candidate) => candidate.id === id);
    if (!tool || tool === this.current) return;
    this.current = tool;
    // The ghost comes from the same record the write does, so the preview is
    // switched by selecting the tool and never separately.
    this.layer.setPreview(tool.preview);
    this.onSignal?.();
  }

  /**
   * Handle one keydown. Returns true when the key selected a tool, so the
   * caller can tell a tool key from one nobody wanted.
   */
  handleKey(key: string): boolean {
    if (key === 'escape') {
      this.select('cursor');
      return true;
    }
    const tool = TOOLS.find(
      (candidate) => candidate.slot === Number(key) || candidate.key.toLowerCase() === key,
    );
    if (!tool) return false;
    this.select(tool.id);
    return true;
  }

  /** Called once per frame, after the renderer has applied the camera. */
  update(): void {
    const pointer = this.pointer;
    if (!pointer) return;
    const tile = this.view.pickTile(pointer.x, pointer.y);
    const key = tile ? tile.z * this.city.size + tile.x : -1;
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.layer.setHover(tile);
  }

  // --- pointer --------------------------------------------------------------

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointer = this.localPoint(event);
    if (event.button !== 0 || !this.buildMode) return;

    const tile = this.view.pickTile(this.pointer.x, this.pointer.y);
    if (!tile) return;
    this.paintPointer = event.pointerId;
    this.surface.setPointerCapture(event.pointerId);
    this.paint(tile, true);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointer = this.localPoint(event);
    if (this.paintPointer !== event.pointerId) return;
    const tile = this.view.pickTile(this.pointer.x, this.pointer.y);
    if (tile) this.paint(tile, false);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.paintPointer !== event.pointerId) return;
    this.paintPointer = null;
    this.lastPaint = null;
    if (this.surface.hasPointerCapture(event.pointerId)) {
      this.surface.releasePointerCapture(event.pointerId);
    }
  };

  private readonly onPointerLeave = (): void => {
    if (this.paintPointer !== null) return;
    this.pointer = null;
    this.hoverKey = null;
    this.layer.setHover(null);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Ctrl/Cmd/Alt combos belong to the browser; a held key must not walk the
    // tool bar.
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (this.handleKey(event.key.toLowerCase())) event.preventDefault();
  };

  /**
   * Canvas-local CSS pixels, which is the space {@link WorldRenderer.pickTile}
   * takes. The canvas happens to sit at the viewport origin today, but reading
   * the box keeps painting correct if that ever stops being true.
   */
  private localPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.surface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  // --- painting -------------------------------------------------------------

  private paint(tile: TilePoint, first: boolean): void {
    const last = this.lastPaint;
    if (first || !last) {
      this.write(tile.x, tile.z);
    } else if (last.x !== tile.x || last.z !== tile.z) {
      for (const step of walkLine(last, tile)) this.write(step.x, step.z);
    }
    this.lastPaint = { x: tile.x, z: tile.z };
  }

  /** Write one tile, according to what the active tool would place there. */
  private write(x: number, z: number): void {
    const index = z * this.city.size + x;
    const preview = this.current.preview;
    switch (preview?.kind) {
      case 'road':
        this.city.placeRoad(index);
        break;
      case 'zone':
        this.city.paintZone(index, preview.zone);
        break;
      case 'bulldoze':
        this.city.bulldoze(index);
        break;
      default:
        // The cursor tool writes nothing, which is also why it has no hover
        // highlight to show.
        return;
    }
    // Only a writing tool reaches here, so this fires per tile of a stroke and
    // the owner's debounce is what turns a drag into a single save (T2.2).
    this.onEdit?.();
  }
}

/** Bresenham's line over world tiles, excluding the start point. */
function* walkLine(from: TilePoint, to: TilePoint): Generator<TilePoint> {
  let x = from.x;
  let z = from.z;
  const dx = Math.abs(to.x - x);
  const sx = x < to.x ? 1 : -1;
  const dz = -Math.abs(to.z - z);
  const sz = z < to.z ? 1 : -1;
  let error = dx + dz;

  while (x !== to.x || z !== to.z) {
    const doubled = 2 * error;
    if (doubled >= dz) {
      error += dz;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      z += sz;
    }
    yield { x, z };
  }
}
