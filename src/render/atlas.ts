import { CanvasSource, Rectangle, Texture } from 'pixi.js';
import { BUILDING_VARIANTS, ZoneType } from '../world/city';
import { TILE_H, TILE_W } from './config';

/**
 * The sprite sheet (PRD §16.3 T3.1, §15.2 T3.1).
 *
 * **Decision: still generated at boot from Canvas2D, not loaded from an asset.**
 * M0 drew six flat colour diamonds, and M1 adds roads, zone tints and
 * procedural buildings — all of which are shapes and flat colours, so a PNG
 * would be a network round-trip (§7 budgets a ≤ 10 s cold load) plus a decode
 * step for something the GPU can be handed in well under a millisecond. Asset
 * weight stays at exactly zero and the colours stay in the same file as the
 * code that reads them. When M3 brings real modular art (1→5 building levels)
 * the sheet flips to loaded, and only this file changes — the frame arrays are
 * already the only thing the renderer sees.
 *
 * ## Sheet layout
 *
 * One texture, four bands, 16 columns of `TILE_W`:
 *
 * | band     | row            | frames | height         |
 * |----------|----------------|--------|----------------|
 * | terrain  | `0`            | 6      | `TILE_H`       |
 * | road     | `TILE_H`       | 16     | `TILE_H`       |
 * | zone     | `2 × TILE_H`   | 3      | `TILE_H`       |
 * | building | `3 × TILE_H`   | 12     | `TILE_H + rise`|
 *
 * 1024 × 152 px: inside the §15.2 T3.1 "≤ 2048²" cap with room to spare.
 *
 * **The building band is taller than a tile, and that is the whole reason
 * buildings are not simply drawn inside the diamond.** A sprite is positioned
 * by its centre, so a box that visibly rises out of its tile needs somewhere
 * to rise into; the extra `BUILDING_RISE` rows give it that, and the draw code
 * keeps the tile's own footprint at the bottom of the frame. T5 then places a
 * building sprite by its bottom edge instead of its middle — the one piece of
 * placement that differs from terrain.
 *
 * ## Frame conventions
 *
 * - `terrain` is indexed by `TerrainType`.
 * - `road` is indexed by the **display-space** neighbour mask, so the caller
 *   must run `rotateMask` first (T5.1). The atlas does not know about
 *   rotation; it only knows the compass as it appears on screen.
 * - `zone` is indexed by `ZoneType - 1` (R, C, I).
 * - `building` is indexed by `(family - 1) × BUILDING_VARIANTS + variant`,
 *   matching `City.building`'s `1 + variant` encoding.
 */

/** Extra rows a building frame gets, so a box can stand above its tile. */
export const BUILDING_RISE = 24;
/** Frame height of the building band. */
export const BUILDING_FRAME_H = TILE_H + BUILDING_RISE;

/** Half-size of the diamond a building stands on, in base pixels. */
const BUILDING_HW = 26;
const BUILDING_HH = 13;
/** Rows of margin below a footprint, so neighbouring tiles keep a seam. */
const BUILDING_MARGIN = 2;

/**
 * Distance from a building frame's centre down to its footprint's centre (T5).
 *
 * A sprite is placed by its anchor, and a building's frame carries the rows the
 * box rises into — so anchoring one at its middle would sink it half a rise into
 * the ground. T5 offsets by this instead, which is the one placement difference
 * from terrain; the number is derived here rather than beside the placement code
 * because it is a property of how the frame was drawn.
 */
export const BUILDING_BASE_OFFSET =
  BUILDING_FRAME_H - BUILDING_MARGIN - BUILDING_HH - BUILDING_FRAME_H / 2;

const COLUMNS = 16;
const ROW_ROAD = TILE_H;
const ROW_ZONE = TILE_H * 2;
const ROW_BUILDING = TILE_H * 3;
const SHEET_W = COLUMNS * TILE_W;
const SHEET_H = ROW_BUILDING + BUILDING_FRAME_H;

const HALF_W = TILE_W / 2;
const HALF_H = TILE_H / 2;

/** Fill colour per terrain class, indexed by `TerrainType`. */
const TERRAIN_FILL: readonly [string, string, string, string, string, string] = [
  '#2f6fb3', // Water
  '#d9c48c', // Sand
  '#6fa74e', // Grass
  '#3f7f36', // Forest
  '#8d8a86', // Rock
  '#e8eef2', // Snow
];

/** How far the top vertex is mixed toward white. Gives relief without shading. */
const TOP_LIGHTEN = 0.22;

const ROAD_FILL = '#454a4d';
/** Width of a road arm, in base pixels. */
const ROAD_ARM_W = 13;
/** Half-size of the junction hub: fills a junction and gives mask 0 a body. */
const ROAD_HUB_W = 11;
const ROAD_HUB_H = 5.5;

/** Zone tint per family, indexed by `ZoneType - 1`. */
const ZONE_TINT: readonly [string, string, string] = ['#7ed957', '#4aa8e8', '#e8b84a'];
const ZONE_ALPHA = 0.42;

interface BuildingStyle {
  /** Roof plate. */
  readonly roof: string;
  /** Wall facing up-left, which the iso camera sees lit. */
  readonly wall: string;
  /** Wall facing down-right, in shade. */
  readonly wallDark: string;
  readonly window: string;
  readonly windowRows: number;
  readonly windowCols: number;
}

/** One entry per zone family, indexed by `ZoneType - 1`. */
const BUILDING_STYLE: readonly [BuildingStyle, BuildingStyle, BuildingStyle] = [
  { roof: '#c98d6a', wall: '#e0b48c', wallDark: '#a96f52', window: '#4b3a30', windowRows: 1, windowCols: 2 },
  { roof: '#6f8fa8', wall: '#a8c8dd', wallDark: '#54748c', window: '#e8f4ff', windowRows: 2, windowCols: 3 },
  { roof: '#8a8f94', wall: '#b6bbc0', wallDark: '#6d7276', window: '#3f4a52', windowRows: 1, windowCols: 4 },
];

/**
 * Box height per variant, in base pixels. Kept under `BUILDING_RISE` minus the
 * half-height of the roof, so no variant can clip its own frame.
 */
const VARIANT_RISE: readonly number[] = [16, 22, 12, 19];

export interface Atlas {
  /** The whole sheet, kept so the renderer can dispose the source in one call. */
  readonly texture: Texture;
  /** One frame per `TerrainType`. */
  readonly terrain: readonly Texture[];
  /** One frame per display-space neighbour mask, `0..15`. */
  readonly road: readonly Texture[];
  /** One frame per zone family, `ZoneType - 1`. */
  readonly zone: readonly Texture[];
  /** One frame per family × variant. */
  readonly building: readonly Texture[];
}

/** Mix a `#rrggbb` colour toward white by `amount` (0–1). */
function lighten(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  const mix = (channel: number): number => Math.round(channel + (255 - channel) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/** Trace a 2:1 diamond centred on `(cx, cy)`. Leaves the path current. */
function diamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, hw: number, hh: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - hh);
  ctx.lineTo(cx + hw, cy);
  ctx.lineTo(cx, cy + hh);
  ctx.lineTo(cx - hw, cy);
  ctx.closePath();
}

/** Fill one tile-shaped diamond with the same top-lit gradient terrain uses. */
function fillDiamond(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  fill: string,
): void {
  diamond(ctx, cx, cy, hw, hh);
  const gradient = ctx.createLinearGradient(0, cy - hh, 0, cy + hh);
  gradient.addColorStop(0, lighten(fill, TOP_LIGHTEN));
  gradient.addColorStop(1, fill);
  ctx.fillStyle = gradient;
  ctx.fill();
}

/**
 * Arm directions from the tile centre to each shared edge's midpoint, in mask
 * bit order (N, E, S, W).
 *
 * Derived from the projection in `chunkLayer.walkTiles`
 * (`x = (dx - dz) × HALF_W`, `y = (dx + dz) × HALF_H`) together with
 * `City.maskAt`'s bit assignment (`MASK_N` is the `z - 1` neighbour, `MASK_E`
 * the `x + 1` one):
 *
 * | bit | neighbour | screen offset            |
 * |-----|-----------|--------------------------|
 * | N   | `z - 1`   | `(+HALF_W, −HALF_H)` up-right |
 * | E   | `x + 1`   | `(+HALF_W, +HALF_H)` down-right |
 * | S   | `z + 1`   | `(−HALF_W, +HALF_H)` down-left |
 * | W   | `x - 1`   | `(−HALF_W, −HALF_H)` up-left |
 *
 * N/E and S/W are opposite in both axes, so `N|S` and `E|W` draw straight
 * carriageways. An order that swaps N and W still produces plausible-looking
 * tiles — which is exactly why this is worth stating: it silently turns every
 * straight road into a dogleg, so the T3 harness probes each single-bit arm's
 * screen quadrant rather than trusting the picture.
 */
const ROAD_ARMS: readonly (readonly [number, number])[] = [
  [HALF_W / 2, -HALF_H / 2],
  [HALF_W / 2, HALF_H / 2],
  [-HALF_W / 2, HALF_H / 2],
  [-HALF_W / 2, -HALF_H / 2],
];

/**
 * Draw one road frame: a junction hub plus an arm for every connected
 * neighbour.
 *
 * The hub is deliberately much smaller than the tile. A full-tile asphalt
 * diamond would make all sixteen masks look almost identical — every road
 * would read as a paved plaza rather than as a carriageway — so the arms carry
 * the connectivity and the hub only fills the junction between them (and gives
 * `mask 0`, an isolated road stub, something visible to draw).
 *
 * Arms are stroked first and the hub drawn over them. Where two neighbouring
 * tiles' arms meet they are mirror images about the shared edge, so they join
 * flush; the hub stays a flat colour at the junction.
 */
function drawRoad(ctx: CanvasRenderingContext2D, x: number, row: number, mask: number): void {
  const cx = x + HALF_W;
  const cy = row + HALF_H;

  ctx.strokeStyle = ROAD_FILL;
  ctx.lineWidth = ROAD_ARM_W;
  ctx.lineCap = 'butt';
  for (let bit = 0; bit < 4; bit++) {
    if ((mask & (1 << bit)) === 0) continue;
    const arm = ROAD_ARMS[bit];
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + arm[0], cy + arm[1]);
    ctx.stroke();
  }

  fillDiamond(ctx, cx, cy, ROAD_HUB_W, ROAD_HUB_H, ROAD_FILL);
}

/** Draw one zone tint frame: a slightly inset diamond, translucent. */
function drawZone(ctx: CanvasRenderingContext2D, x: number, row: number, colour: string): void {
  ctx.save();
  ctx.globalAlpha = ZONE_ALPHA;
  ctx.fillStyle = colour;
  diamond(ctx, x + HALF_W, row + HALF_H, HALF_W - 3, HALF_H - 2);
  ctx.fill();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw one building: an iso box standing on the tile's footprint, with the
 * footprint pinned to the bottom of the (taller) frame.
 *
 * The two walls are parallelograms, so `ctx.transform` maps a unit square onto
 * the visible wall and the windows are drawn as ordinary rectangles inside it.
 */
function drawBuilding(ctx: CanvasRenderingContext2D, x: number, family: number, variant: number): void {
  const style = BUILDING_STYLE[family];
  const rise = VARIANT_RISE[variant % VARIANT_RISE.length];
  const hw = BUILDING_HW;
  const hh = BUILDING_HH;
  // Footprint pinned to the bottom of the (taller) frame, leaving a margin so a
  // building never touches the frame edge and neighbouring tiles keep a seam.
  const cyBase = ROW_BUILDING + BUILDING_FRAME_H - BUILDING_MARGIN - hh;
  const cx = x + HALF_W;

  // Left wall (up-left face).
  ctx.fillStyle = style.wall;
  ctx.beginPath();
  ctx.moveTo(cx - hw, cyBase);
  ctx.lineTo(cx, cyBase + hh);
  ctx.lineTo(cx, cyBase + hh - rise);
  ctx.lineTo(cx - hw, cyBase - rise);
  ctx.closePath();
  ctx.fill();

  // Right wall (down-right face, in shade) with its windows.
  ctx.fillStyle = style.wallDark;
  ctx.beginPath();
  ctx.moveTo(cx, cyBase + hh);
  ctx.lineTo(cx + hw, cyBase);
  ctx.lineTo(cx + hw, cyBase - rise);
  ctx.lineTo(cx, cyBase + hh - rise);
  ctx.closePath();
  ctx.fill();

  ctx.save();
  ctx.clip();
  ctx.transform(hw, -hh, 0, -rise, cx, cyBase + hh);
  ctx.fillStyle = style.window;
  for (let row = 0; row < style.windowRows; row++) {
    for (let col = 0; col < style.windowCols; col++) {
      ctx.fillRect(0.14 + col * (0.72 / style.windowCols), 0.22 + row * 0.32, 0.14, 0.14);
    }
  }
  ctx.restore();

  // Roof plate, top-lit like terrain so the box reads as iso rather than flat.
  fillDiamond(ctx, cx, cyBase - rise, hw, hh, style.roof);
}

/** Frame rectangle for one cell: `column` across, `row` down, `height` tall. */
function cell(column: number, row: number, height: number): Rectangle {
  return new Rectangle(column * TILE_W, row, TILE_W, height);
}

export function buildAtlas(): Atlas {
  const canvas = document.createElement('canvas');
  canvas.width = SHEET_W;
  canvas.height = SHEET_H;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable — cannot build the atlas');
  }

  for (let frame = 0; frame < TERRAIN_FILL.length; frame++) {
    fillDiamond(ctx, frame * TILE_W + HALF_W, HALF_H, HALF_W, HALF_H, TERRAIN_FILL[frame]);
  }
  for (let mask = 0; mask < 16; mask++) {
    drawRoad(ctx, mask * TILE_W, ROW_ROAD, mask);
  }
  for (let family = 0; family < ZONE_TINT.length; family++) {
    drawZone(ctx, family * TILE_W, ROW_ZONE, ZONE_TINT[family]);
  }
  for (let family = 0; family < BUILDING_STYLE.length; family++) {
    for (let variant = 0; variant < BUILDING_VARIANTS; variant++) {
      drawBuilding(ctx, (family * BUILDING_VARIANTS + variant) * TILE_W, family, variant);
    }
  }

  const source = new CanvasSource({ resource: canvas });
  const texture = new Texture({ source });
  const frames = (count: number, row: number, height: number): Texture[] =>
    Array.from(
      { length: count },
      (_unused, column) => new Texture({ source, frame: cell(column, row, height) }),
    );

  return {
    texture,
    terrain: frames(TERRAIN_FILL.length, 0, TILE_H),
    road: frames(16, ROW_ROAD, TILE_H),
    zone: frames(ZONE_TINT.length, ROW_ZONE, TILE_H),
    building: frames(BUILDING_STYLE.length * BUILDING_VARIANTS, ROW_BUILDING, BUILDING_FRAME_H),
  };
}

/** Frame index for a zoned tile, from its `ZoneType`. */
export function zoneFrameIndex(zone: ZoneType): number {
  return zone - 1;
}

/** Frame index for a built tile, from its `City.building` byte. */
export function buildingFrameIndex(zone: ZoneType, building: number): number {
  return (zone - 1) * BUILDING_VARIANTS + (building - 1);
}
