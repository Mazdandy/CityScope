import type { WorldRenderer } from '../render/renderer';

/**
 * Camera and input layer (T4).
 *
 * Owns every way the camera can be moved and nothing else: it reads DOM events,
 * drives {@link WorldRenderer}'s camera API, and reports input→response latency.
 * It does not render and it does not own a frame loop — the app calls
 * {@link beginFrame} then {@link update} from its ticker, which is what keeps the
 * whole camera drivable from a test harness without synthesising mouse motions
 * (§15.3 A2).
 *
 * **Every action has a keyboard path** (§6.2 acceptance): pan is WASD/arrows,
 * zoom is the wheel or `-`/`=`, rotation is `Q`/`E`, and recentre is `0`. Drag,
 * wheel and edge scroll are the pointer conveniences on top, not the only way
 * in.
 *
 * **`1`–`9` belongs to the tool bar** (§6.2), so zoom gave up `1`–`4` when M1's
 * tools landed (T6.3). The wheel was already a full substitute; `-`/`=` is the
 * keyboard one.
 *
 * **The left button is not always a pan.** With a build tool active it paints,
 * and this class asks {@link CameraInputOptions.isBuildMode} before claiming it
 * — see `src/ui/tools.ts`, which owns that decision.
 *
 * **Anchor snapping (T4.4).** §6.2 asks for the anchor to snap to tile centres,
 * but snapping *continuously* would make a drag step tile by tile — up to 64 px
 * at the closest zoom step. Instead the anchor is free while the camera is being
 * moved and is rounded onto the grid when the movement stops, so motion stays
 * smooth and the invariant holds at rest.
 */

/** Screen px per second while a pan key is held or an edge scroll is active. */
const PAN_SPEED = 1200;
/** Distance from the viewport edge, in px, that starts an edge scroll. */
const EDGE_SIZE = 24;
/** Wheel delta equal to one zoom step. One mouse notch reports 100 in Chrome. */
const WHEEL_STEP = 100;
/** Latency samples retained. p95 needs far fewer; a ring makes this free. */
const LATENCY_SAMPLES = 240;

const PAN_KEYS = new Set([
  'w',
  'a',
  's',
  'd',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
]);

export interface InputLatencyStats {
  /** Median ms from the DOM event to the frame that consumed it. */
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly samples: number;
  readonly dragging: boolean;
  readonly edgeScroll: boolean;
}

export interface CameraInputOptions {
  readonly view: WorldRenderer;
  /** Element that receives pointer and wheel events — the renderer's canvas. */
  readonly surface: HTMLElement;
  /** Called after a discrete camera change so the HUD can re-render. */
  readonly onSignal?: () => void;
  /**
   * True while a build tool owns the left button. Read per press rather than
   * captured, so the tool bar can switch mid-drag without re-attaching anything.
   */
  readonly isBuildMode?: () => boolean;
}

export class CameraInput {
  private readonly view: WorldRenderer;
  private readonly surface: HTMLElement;
  private readonly onSignal: (() => void) | undefined;
  private readonly isBuildMode: () => boolean;

  private readonly held = new Set<string>();
  /** Event timestamps seen since the last frame, awaiting a latency score. */
  private readonly pending: number[] = [];
  private readonly latencies: number[] = [];
  private latencyCursor = 0;

  /** Pointer id while a pan drag is in progress, else null. */
  private dragPointer: number | null = null;
  private dragX = 0;
  private dragY = 0;

  private readonly edge = { x: 0, y: 0 };
  private pointerInside = false;
  private wheelAcc = 0;
  private wasPanning = false;

  constructor(options: CameraInputOptions) {
    this.view = options.view;
    this.surface = options.surface;
    this.onSignal = options.onSignal;
    this.isBuildMode = options.isBuildMode ?? (() => false);
  }

  attach(): void {
    const surface = this.surface;
    surface.addEventListener('pointerdown', this.onPointerDown);
    surface.addEventListener('pointermove', this.onPointerMove);
    surface.addEventListener('pointerup', this.onPointerUp);
    surface.addEventListener('pointercancel', this.onPointerUp);
    surface.addEventListener('pointerleave', this.onPointerLeave);
    surface.addEventListener('mousedown', this.onMouseDown);
    surface.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  destroy(): void {
    const surface = this.surface;
    surface.removeEventListener('pointerdown', this.onPointerDown);
    surface.removeEventListener('pointermove', this.onPointerMove);
    surface.removeEventListener('pointerup', this.onPointerUp);
    surface.removeEventListener('pointercancel', this.onPointerUp);
    surface.removeEventListener('pointerleave', this.onPointerLeave);
    surface.removeEventListener('mousedown', this.onMouseDown);
    surface.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.held.clear();
    this.pending.length = 0;
  }

  get stats(): InputLatencyStats {
    const n = this.latencies.length;
    const sorted = n ? [...this.latencies].sort((a, b) => a - b) : [];
    return {
      p50Ms: n ? +percentile(sorted, 0.5).toFixed(2) : 0,
      p95Ms: n ? +percentile(sorted, 0.95).toFixed(2) : 0,
      maxMs: n ? +sorted[n - 1].toFixed(2) : 0,
      samples: n,
      dragging: this.dragPointer !== null,
      edgeScroll: this.edge.x !== 0 || this.edge.y !== 0,
    };
  }

  /** Drop the latency ring so a measurement starts from empty. */
  resetLatency(): void {
    this.latencies.length = 0;
    this.latencyCursor = 0;
    this.pending.length = 0;
  }

  // --- frame ----------------------------------------------------------------

  /**
   * Called at the very top of the frame, before the camera is applied: it scores
   * every input that arrived since the previous frame. The measured quantity is
   * therefore the real one — how long an event waited for the frame that acts on
   * it — and not a timer started after the work was already done.
   */
  beginFrame(): void {
    if (this.pending.length === 0) return;
    const now = performance.now();
    for (const stamp of this.pending) this.pushLatency(now - stamp);
    this.pending.length = 0;
  }

  /** Apply held keys and edge scroll, then settle the anchor if panning stopped. */
  update(deltaMS: number): void {
    const step = (PAN_SPEED * deltaMS) / 1000;
    let dx = 0;
    let dy = 0;

    if (this.held.has('a') || this.held.has('arrowleft')) dx -= step;
    if (this.held.has('d') || this.held.has('arrowright')) dx += step;
    if (this.held.has('w') || this.held.has('arrowup')) dy -= step;
    if (this.held.has('s') || this.held.has('arrowdown')) dy += step;

    dx += this.edge.x * step;
    dy += this.edge.y * step;

    if (dx !== 0 || dy !== 0) this.view.panByScreen(dx, dy);

    const panning =
      this.dragPointer !== null ||
      this.edge.x !== 0 ||
      this.edge.y !== 0 ||
      [...this.held].some((key) => PAN_KEYS.has(key));

    // T4.4: the anchor is snapped once the camera comes to rest, never while it
    // is moving. `wasPanning` makes this a transition, so it cannot re-fire on
    // every idle frame.
    if (this.wasPanning && !panning) this.view.snapAnchor();
    this.wasPanning = panning;
  }

  // --- pointer --------------------------------------------------------------

  private readonly onPointerDown = (event: PointerEvent): void => {
    // The middle button always pans. The left button pans only while no tool
    // owns it — with a build tool active it belongs to `ToolController`, and
    // claiming it here would pan the map out from under every click.
    if (event.button === 0 && this.isBuildMode()) return;
    if (event.button !== 0 && event.button !== 1) return;
    this.dragPointer = event.pointerId;
    this.dragX = event.clientX;
    this.dragY = event.clientY;
    this.surface.setPointerCapture(event.pointerId);
    this.mark(event.timeStamp);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointerInside = true;
    this.updateEdge(event.clientX, event.clientY);

    if (this.dragPointer !== event.pointerId) return;
    this.view.panByScreen(event.clientX - this.dragX, event.clientY - this.dragY);
    this.dragX = event.clientX;
    this.dragY = event.clientY;
    this.mark(event.timeStamp);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.dragPointer !== event.pointerId) return;
    this.dragPointer = null;
    if (this.surface.hasPointerCapture(event.pointerId)) {
      this.surface.releasePointerCapture(event.pointerId);
    }
  };

  private readonly onPointerLeave = (): void => {
    this.pointerInside = false;
    this.edge.x = 0;
    this.edge.y = 0;
  };

  /**
   * Middle-click otherwise starts Chrome's autoscroll and strands the drag, so
   * the default is cancelled on the mouse event rather than on `pointerdown`.
   */
  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button === 1) event.preventDefault();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // Firefox reports a wheel notch in lines, not pixels; without this a notch
    // would be about a sixteenth of a zoom step there.
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    this.wheelAcc += event.deltaY * scale;

    const steps = Math.trunc(this.wheelAcc / WHEEL_STEP);
    if (steps === 0) return;
    this.wheelAcc -= steps * WHEEL_STEP;

    // A positive deltaY is a scroll toward the viewer, i.e. zoom out — and a
    // lower index is a wider view (§6.2 keeps the steps discrete).
    this.view.setZoomIndex(this.view.state.zoomIndex - steps);
    this.mark(event.timeStamp);
    this.onSignal?.();
  };

  private updateEdge(x: number, y: number): void {
    // A drag is an explicit pan; letting edge scroll pull as well would fight it.
    if (this.dragPointer !== null || !this.pointerInside) {
      this.edge.x = 0;
      this.edge.y = 0;
      return;
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.edge.x = x <= EDGE_SIZE ? -1 : x >= width - EDGE_SIZE ? 1 : 0;
    this.edge.y = y <= EDGE_SIZE ? -1 : y >= height - EDGE_SIZE ? 1 : 0;
  }

  // --- keyboard -------------------------------------------------------------

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Ctrl/Cmd combos belong to the browser (Ctrl+S is save, §6.12, not yet).
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();

    if (key === 'arrowup' || key === 'arrowdown' || key === 'arrowleft' ||
        key === 'arrowright' || key === ' ') {
      event.preventDefault();
    }

    if (PAN_KEYS.has(key)) {
      // `held` is a set, so auto-repeat is harmless; it is only marked on the
      // press that actually changed the state.
      if (!this.held.has(key)) this.mark(event.timeStamp);
      this.held.add(key);
      return;
    }

    // Discrete actions ignore auto-repeat: a held `E` must not spin the map.
    if (event.repeat) return;

    switch (key) {
      case 'q':
        this.view.rotate(-1);
        break;
      case 'e':
        this.view.rotate(1);
        break;
      case '0':
        this.view.recentre();
        break;
      case '-':
      case '_':
        // T6.3: `1`-`9` is the §6.2 tool bar now, so zoom moved to the wheel
        // and to these two. `_` and `+` are the shifted forms, which arrive as
        // distinct keys on most layouts.
        this.view.setZoomIndex(this.view.state.zoomIndex - 1);
        break;
      case '=':
      case '+':
        this.view.setZoomIndex(this.view.state.zoomIndex + 1);
        break;
      default:
        return;
    }

    this.mark(event.timeStamp);
    this.onSignal?.();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.key.toLowerCase());
  };

  private readonly onBlur = (): void => {
    this.held.clear();
    this.edge.x = 0;
    this.edge.y = 0;
    this.pointerInside = false;
  };

  // --- latency --------------------------------------------------------------

  private mark(stamp: number): void {
    this.pending.push(stamp);
  }

  private pushLatency(ms: number): void {
    if (this.latencies.length < LATENCY_SAMPLES) {
      this.latencies.push(ms);
      return;
    }
    this.latencies[this.latencyCursor] = ms;
    this.latencyCursor = (this.latencyCursor + 1) % LATENCY_SAMPLES;
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
