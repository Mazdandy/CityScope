import { detectCapabilities } from './core/capabilities';
import { createApp } from './render/app';
import { CityLayer } from './render/cityLayer';
import { ZOOM_STEPS } from './render/config';
import { QUALITY_PRESETS, resolveResolution } from './render/quality';
import { WorldRenderer } from './render/renderer';
import { Hud } from './ui/hud';
import { CameraInput } from './ui/input';
import { TOOLS, ToolController } from './ui/tools';
import { showUnsupportedScreen } from './ui/unsupported';
import { City } from './world/city';
import { WORLD_CONFIG } from './world/config';
import { Autosave, loadCity, snapshot, type LoadOutcome } from './world/save';
import { World, type WorldTelemetry } from './world/world';

declare global {
  interface Window {
    /**
     * Verification hook. Determinism (T2.5) reads `telemetry.hash`; the renderer
     * is exposed so §15.3's scripted A2 sweep and the T3.2/T3.6 A/B comparisons
     * can be driven from a harness instead of by hand, the input layer so
     * T4.5's latency can be read after real (CDP-dispatched) input, and the city
     * plus its layer and tools so T5/T6's checks can compare what is drawn
     * against the arrays after real pointer input. The HUD is exposed so T7's
     * checks can compare what the panel *says* against the arrays too.
     */
    cityscope: {
      world: World;
      telemetry: WorldTelemetry;
      view: WorldRenderer;
      input: CameraInput;
      city: City;
      layer: CityLayer;
      tools: ToolController;
      hud: Hud;
      /** Exposed so §16.4's reload check can flush instead of racing the debounce. */
      autosave: Autosave;
    };
  }
}

/** HUD refresh. Laying out the readout is a DOM reflow, so not per frame. */
const HUD_INTERVAL_MS = 200;

const BOOT_QUALITY = 'Med' as const;

function readoutLines(
  view: WorldRenderer,
  telemetry: WorldTelemetry,
  input: CameraInput,
  layer: CityLayer,
  tools: ToolController,
  load: LoadOutcome,
): string[] {
  const stats = view.stats;
  const latency = input.stats;
  const drawn = layer.stats;
  return [
    'CityScope — M1 · T7 HUD',
    `world ${WORLD_CONFIG.size}×${WORLD_CONFIG.size} · seed ${telemetry.seed} · hash ${telemetry.hash} · build ${telemetry.buildMs.toFixed(0)} ms`,
    // T2.3's "discard it and say so": whatever boot did with the slot is stated
    // on screen, not only in the console.
    `save ${load.status} — ${load.message}`,
    `zoom step ${stats.zoomIndex + 1}/4 (${ZOOM_STEPS[stats.zoomIndex]} px/tile) · scale ${stats.pixelScale}× · rot ${stats.rotation * 90}° · res ${stats.resolution.toFixed(2)}`,
    `chunks ${stats.chunks} · sprites ${stats.visibleSprites}/${stats.sprites} visible · pending bakes ${stats.pendingBakes}`,
    // The tally T7.2 asks for. Population is the building count, said out loud
    // rather than left for the reader to infer from the HUD.
    `city tally — zones ${drawn.zoneSprites} · roads ${drawn.roadSprites} · buildings ${drawn.buildingSprites} · population ${drawn.buildingSprites}`,
    `quality ${stats.quality} · chunk strategy ${stats.strategy} · culling ${stats.culling} · rotation ${stats.rotationMode}`,
    `input latency p50 ${latency.p50Ms} ms · p95 ${latency.p95Ms} ms · max ${latency.maxMs} ms (${latency.samples} samples)`,
    `tool ${tools.active.label} (slot ${tools.active.slot}) · click the palette or press its key`,
    'pan WASD/arrows · middle-drag · edge scroll · zoom wheel / - = · rotate Q/E · 0 recentre',
    'debug (shift): M quality · C chunk strategy · V culling · R rotation mode',
  ];
}

/**
 * T3 A/B toggles, kept because §15.4's pick is confirmed by re-measuring at
 * T7.1/T7.2 and the alternatives have to stay reachable until then. T7 turns
 * this into the real debug overlay; the camera keys that used to live here are
 * now {@link CameraInput}'s.
 *
 * These sit behind **Shift** because M1's tools claimed `C` (zone C) and `R`
 * (zone R) — a debug toggle that also paints is a bug, and the product keys win.
 */
function installDebugKeys(view: WorldRenderer, refresh: () => void): void {
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (!event.shiftKey) return;

    switch (event.key.toLowerCase()) {
      case 'm':
        view.cycleQuality();
        break;
      case 'c':
        view.setChunkStrategy(view.stats.strategy === 'live' ? 'cached' : 'live');
        break;
      case 'v':
        view.setCullingGranularity(view.stats.culling === 'chunk' ? 'sprite' : 'chunk');
        break;
      case 'r':
        view.setRotationMode(view.stats.rotationMode === 'rebuild' ? 'reproject' : 'rebuild');
        break;
      default:
        return;
    }
    refresh();
  });
}

async function boot(): Promise<void> {
  // §11 R6 / §16.3 T8.1: ask for exactly what the renderer needs *before*
  // anything else is constructed. Nothing above this guard touches PixiJS,
  // which is the point — it runs precisely when the renderer cannot be created,
  // and its job is to leave a legible page where the alternative is a black
  // canvas that looks the same as a crash (T8.2).
  const capabilities = detectCapabilities();
  if (!capabilities.ok) {
    showUnsupportedScreen(capabilities);
    return;
  }

  const world = new World();
  const app = await createApp({
    background: 0x0b1412,
    resolution: resolveResolution(QUALITY_PRESETS[BOOT_QUALITY].renderScale, window.devicePixelRatio),
  });

  const view = new WorldRenderer({ app, world, quality: BOOT_QUALITY });

  // The player's edits live in `City`; `CityLayer` is the only thing that turns
  // them into sprites. It shares the renderer's atlas rather than building one,
  // so the terrain and the city can never disagree about what a frame is.
  const city = new City(world);

  // T2.3's boot path, run **before** the layer and the HUD exist: the first
  // sync then already sees the player's city rather than an empty grid that
  // fills in a frame later, and the first readout can report what loaded.
  const load = await loadCity(world, city);
  if (load.status === 'discarded') console.warn(`[cityscope] ${load.message}`);

  const layer = new CityLayer({ world, city, atlas: view.atlas, layers: view.layers });

  // T2.2: one debounced write after the last edit, plus a flush on `pagehide`.
  // The debounce is what keeps a twenty-tile drag from being twenty structured
  // clones of a 512 KB record.
  const autosave = new Autosave(() => snapshot(world, city));
  autosave.attachPagehide();

  // The HUD is DOM, not a PixiJS `Text`: it must not pan or scale with the
  // camera, and the palette buttons need to be real clickable elements (T7.1).
  // It reaches the tool bar through the same `select()` the keys do, so a click
  // and a hotkey land in exactly the same place (T7.1's verify).
  const hud = new Hud({
    tools: TOOLS,
    onSelect: (id) => tools.select(id),
  });

  const refresh = (): void => {
    hud.update({
      tool: tools.active.id,
      // The building count *is* the population in M1 (T7.2) — one derived
      // figure, not an invented multiplier.
      population: layer.stats.buildingSprites,
      readout: readoutLines(view, world.telemetry, input, layer, tools, load),
    });
  };

  // The tool layer owns the §6.2 tool bar and the left button; the camera layer
  // asks it whether the left button is a pan or a paint, so the two cannot both
  // claim the same press.
  const tools = new ToolController({
    view,
    city,
    layer,
    surface: app.canvas,
    onSignal: refresh,
    onEdit: () => autosave.schedule(),
  });
  const input = new CameraInput({
    view,
    surface: app.canvas,
    onSignal: refresh,
    isBuildMode: () => tools.buildMode,
  });
  input.attach();
  tools.attach();
  window.cityscope = { world, telemetry: world.telemetry, view, input, city, layer, tools, hud, autosave };

  refresh();
  installDebugKeys(view, refresh);

  let sinceHud = 0;

  app.ticker.add((ticker) => {
    // Order matters: input is scored before it is consumed, then applied, then
    // the camera reaches the scene in the same frame.
    input.beginFrame();
    input.update(ticker.deltaMS);
    view.update();
    // After `view.update()`: the hovered tile is picked from the transform the
    // renderer just applied, so a pan under a still pointer re-picks correctly.
    tools.update();
    // And the layer syncs last, so the rotation it reads is the one the camera
    // just applied and the sprites land in the same frame as the terrain.
    layer.sync(view.state.rotation);

    sinceHud += ticker.deltaMS;
    if (sinceHud >= HUD_INTERVAL_MS) {
      sinceHud = 0;
      refresh();
    }
  });
}

void boot();
