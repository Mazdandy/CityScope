/**
 * Seeded pseudo-random generation.
 *
 * Determinism is a hard requirement (PRD §15.2 T2.1/T2.5): one seed must yield
 * byte-identical terrain on every browser and every reload. Nothing here may
 * therefore touch `Math.random`, `Date`, or any transcendental `Math` helper
 * whose precision is implementation-defined.
 */

/**
 * mulberry32 — 32-bit state PRNG.
 *
 * Not cryptographic and not chosen for statistical quality: it is five lines,
 * has the full 2^32 period, and uses only `Math.imul` + xor-shift, which are
 * exactly specified by the ECMAScript spec and so give identical output on
 * every engine.
 *
 * @param seed Any 32-bit integer; the full world derives from it.
 * @returns A generator producing successive values in `[0, 1)`.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
