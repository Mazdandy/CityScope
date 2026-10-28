/** Pixels per tile at 1× — also the atlas frame size. 2:1 iso diamond (PRD §4). */
export const TILE_W = 64;
export const TILE_H = 32;
/** Base-scale half extents. Every chunk placement is authored against these. */
export const HALF_TILE_W = TILE_W / 2;
export const HALF_TILE_H = TILE_H / 2;

/**
 * Elevation is drawn as a vertical offset of `tileW * HEIGHT_RATIO` across the
 * full 0→1 height range. Kept as a ratio so relief keeps its proportions at
 * every zoom step instead of flattening out when zoomed out.
 */
export const HEIGHT_RATIO = 0.3;
/** Largest vertical lift any tile can have, in base-scale pixels. */
export const MAX_ELEVATION = TILE_W * HEIGHT_RATIO;

/**
 * Discrete zoom steps, measured as tile width in screen pixels (§6.2 asks for
 * four steps). Index 0 is the widest view, which is where the worst frame
 * almost always is (§15.3).
 */
export const ZOOM_STEPS = [16, 32, 64, 128] as const;
/**
 * Default is step 64 — the atlas is authored 1:1 at `TILE_W`, so this is the
 * only step with neither upscaling nor wasted texels.
 */
export const DEFAULT_ZOOM_INDEX = 2;

/**
 * Largest chunk texture edge, in pixels. Cached chunks are baked at the
 * camera's pixel density, and this caps that density: a chunk is 32 × 64 =
 * 2048 base pixels wide, so at the closest zoom (128, i.e. 2× base) an
 * uncapped bake would want 4096² and cost four times the VRAM for no visible
 * gain on flat-colour terrain. Beyond the cap the texture is undersampled
 * rather than enlarged.
 */
export const MAX_CHUNK_TEXTURE_PX = 2048;

/**
 * Lowest density a chunk bake may use. Chunks are baked at
 * `renderer resolution × camera pixel scale`; at the widest zoom that product
 * is 0.25, and this keeps a degenerate value from producing a texture too
 * coarse to read.
 */
export const MIN_BAKE_RESOLUTION = 0.25;
