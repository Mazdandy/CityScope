/**
 * Value-noise fBm on an integer lattice.
 *
 * Every operation is exact under IEEE 754 (`+ - * /`, `Math.floor`,
 * `Math.imul`, xor-shift) so the same seed produces the same field on any
 * engine. The usual `Math.sin(dot) * 43758.5453` hash is deliberately avoided:
 * its result depends on the engine's sine precision, which would break the
 * cross-browser determinism check in PRD §15.2 T2.5.
 */

export interface FbmParams {
  /** Lattice cells across one unit of input. Higher = smaller base features. */
  readonly frequency: number;
  readonly octaves: number;
  /** Frequency multiplier per octave. */
  readonly lacunarity: number;
  /** Amplitude multiplier per octave. */
  readonly gain: number;
}

/** 32-bit integer hash of a lattice point to `[0, 1)`. */
function hash2(x: number, y: number, seed: number): number {
  let h = seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Quintic smoothstep — C2-continuous, so fBm has no visible lattice creases. */
function smooth(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Single-octave value noise in `[-1, 1]`. */
export function valueNoise2d(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);

  const bottom = hash2(x0, y0, seed) + (hash2(x0 + 1, y0, seed) - hash2(x0, y0, seed)) * tx;
  const top = hash2(x0, y0 + 1, seed) + (hash2(x0 + 1, y0 + 1, seed) - hash2(x0, y0 + 1, seed)) * tx;
  return (bottom + (top - bottom) * ty) * 2 - 1;
}

/**
 * Fractal Brownian motion over `valueNoise2d`. Amplitudes are normalised, so
 * the result stays within roughly `[-1, 1]` regardless of the octave count.
 */
export function fbm2d(x: number, y: number, params: FbmParams, seed: number): number {
  let amplitude = 1;
  let frequency = params.frequency;
  let sum = 0;
  let norm = 0;

  for (let octave = 0; octave < params.octaves; octave++) {
    sum += valueNoise2d(x * frequency, y * frequency, seed + Math.imul(octave, 0x9e3779b9)) * amplitude;
    norm += amplitude;
    amplitude *= params.gain;
    frequency *= params.lacunarity;
  }

  return sum / norm;
}
