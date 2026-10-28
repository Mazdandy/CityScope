/**
 * Isometric projection and view rotation.
 *
 * The palette of operations is deliberately tiny: every tile is drawn as a
 * fixed 2:1 diamond, so the only thing a rotation changes is *which* tile
 * coordinate lands where. Rotating the world is therefore a permutation of the
 * tile grid, not a change to the projection itself — which is what lets the
 * world `height`/`terrain` arrays stay untouched (§15.2 T3.6).
 */

/** Quarter turns, clockwise. `0` is north-up. */
export type Rotation = 0 | 1 | 2 | 3;

/** Inclusive tile rectangle. */
export interface TileRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/**
 * Map a tile rectangle from world space into rotated space.
 *
 * Every rotation here is an axis-aligned permutation of the grid, so the
 * bounding box of the result is exact — no rounding, no expansion.
 */
export function toRotatedRect(rect: TileRect, size: number, rotation: Rotation): TileRect {
  const { x0, z0, x1, z1 } = rect;
  const last = size - 1;
  switch (rotation) {
    case 0:
      return { x0, z0, x1, z1 };
    case 1:
      return { x0: last - z1, z0: x0, x1: last - z0, z1: x1 };
    case 2:
      return { x0: last - x1, z0: last - z1, x1: last - x0, z1: last - z0 };
    case 3:
      return { x0: z0, z0: last - x1, x1: z1, z1: last - x0 };
  }
}

/**
 * Inverse of {@link toRotatedRect}. `toRotated` composes rotations, so the
 * inverse of turn `r` is simply turn `4 - r`.
 */
export function fromRotatedRect(rect: TileRect, size: number, rotation: Rotation): TileRect {
  return toRotatedRect(rect, size, ((4 - rotation) % 4) as Rotation);
}

/**
 * Forward point mapping: world tile coordinates into rotated space. This is
 * the same permutation {@link toRotatedRect} applies to a rectangle, written
 * point-wise and accepting fractional input so the camera anchor can be
 * converted too. It writes into `out` because the chunk builder calls it once
 * per tile.
 */
export function tileToRotated(
  x: number,
  z: number,
  size: number,
  rotation: Rotation,
  out: { x: number; z: number },
): void {
  const last = size - 1;
  switch (rotation) {
    case 0:
      out.x = x;
      out.z = z;
      return;
    case 1:
      out.x = last - z;
      out.z = x;
      return;
    case 2:
      out.x = last - x;
      out.z = last - z;
      return;
    case 3:
      out.x = z;
      out.z = last - x;
      return;
  }
}

/**
 * Inverse point mapping: rotated tile coordinates back to world tile
 * coordinates — what the chunk builder needs, since it walks the *display*
 * grid and asks which world tile lands on each cell.
 */
export function tileFromRotated(
  rx: number,
  rz: number,
  size: number,
  rotation: Rotation,
  out: { x: number; z: number },
): void {
  tileToRotated(rx, rz, size, ((4 - rotation) % 4) as Rotation, out);
}

/**
 * Permute a 4-bit neighbour mask from world space into display space (T3.1,
 * T5.1).
 *
 * The bits and their meanings are stated in `world/city.ts`: `1` north, `2`
 * east, `4` south, `8` west, and a road stores its mask in **world** space
 * because rotation is a render-time permutation. An atlas frame, though, is
 * drawn for a fixed direction on screen, so the mask has to be turned before
 * it can index one.
 *
 * The permutation falls straight out of {@link tileToRotated}: at turn 1 a
 * world step east becomes a display step south, south becomes west, and so on
 * — i.e. the bits shift by one position per turn. Rotating the world
 * clockwise therefore turns the compass counter-clockwise.
 */
export function rotateMask(mask: number, rotation: Rotation): number {
  if (rotation === 0) return mask & 0xf;
  return ((mask << rotation) | (mask >> (4 - rotation))) & 0xf;
}
