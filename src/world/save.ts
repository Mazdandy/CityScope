import type { City } from './city';
import type { TerrainEdit, World } from './world';

/**
 * Persistence (PRD §16.3 T2).
 *
 * One IndexedDB database, one object store, **one slot**. §16.1 keeps §6.12's
 * storage choice — IndexedDB rather than localStorage — so the save format is
 * not rewritten when multi-slot rotation, autosave cadence and `.cityscope`
 * export arrive in M4. What is stored is deliberately the *minimum* that
 * cannot be recomputed:
 *
 * | field          | why |
 * |----------------|-----|
 * | `zone`, `road` | player intent — nothing else can reproduce it |
 * | `seed`, `size` | identity of the map those arrays were painted on (T2.3) |
 * | `edits`        | `World`'s sparse terrain diffs; the slot is kept (§16.2) though M1 has no terrain tools, so this is always empty |
 * | `version`      | format version, so a future change is refused instead of misread |
 *
 * **Buildings are not stored** (T2.1). They are derived from `zone` + `road` +
 * terrain by one rule (T1.3), so a reload recomputes them instead of trusting
 * a stored copy — one less thing that can disagree with the rule.
 */

const DB_NAME = 'cityscope';
const DB_VERSION = 1;
const STORE = 'saves';
/** The single slot (§16.1). Named so M4 can add `city-2`… without a migration. */
const SLOT = 'city';
/** Format version of the record itself, distinct from the database version. */
export const SAVE_VERSION = 1;
/** How long after the last edit an autosave runs (T2.2). */
export const AUTOSAVE_DELAY_MS = 800;

/** The record shape as it sits in IndexedDB. */
export interface CitySave {
  readonly version: number;
  readonly seed: number;
  readonly size: number;
  readonly zone: Uint8Array;
  readonly road: Uint8Array;
  readonly edits: readonly TerrainEdit[];
}

export type DiscardReason = 'version' | 'seed' | 'size' | 'shape' | 'error';

/** What boot learned (T2.3). `message` is the "say so" half of the rule. */
export type LoadOutcome =
  | { readonly status: 'empty' | 'restored'; readonly message: string }
  | { readonly status: 'discarded'; readonly reason: DiscardReason; readonly message: string };

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this context'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
  return dbPromise;
}

/** Run one request against the slot store and settle on its result. */
function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'));
      }),
  );
}

/**
 * Snapshot the live city into a record. The typed arrays are handed over
 * unwrapped: structured clone copies them at `put` time, so no defensive
 * `slice()` — and no chance of the browser aliasing the live simulation.
 *
 * `edits` comes from `World`, which is also where T2.4's replay lives, so the
 * two halves of a save are gathered in the one place that owns each.
 */
export function snapshot(world: World, city: City): CitySave {
  return {
    version: SAVE_VERSION,
    seed: world.config.seed,
    size: world.config.size,
    zone: city.zone,
    road: city.road,
    edits: world.serialize().edits,
  };
}

/** Persist a record. Resolves `false` rather than throwing: a full disk or a
 * private-mode context must not take the running game down (T2.2). */
export async function writeCity(save: CitySave): Promise<boolean> {
  try {
    await withStore('readwrite', (store) => store.put(save, SLOT));
    return true;
  } catch (error) {
    console.warn('[cityscope] save failed:', error);
    return false;
  }
}

/** Read the slot, or `null` when there is nothing to read. */
export async function readCity(): Promise<CitySave | null> {
  try {
    return (await withStore<CitySave | undefined>('readonly', (store) => store.get(SLOT))) ?? null;
  } catch (error) {
    console.warn('[cityscope] load failed:', error);
    return null;
  }
}

/** Delete the slot. Used by the debug helpers, not by boot. */
export async function clearCity(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(SLOT));
}

/**
 * Boot path (T2.3): read the slot, check it belongs to *this* world, and apply
 * it. A save whose seed, size or version disagrees is **discarded, not
 * merged** — replaying another map's roads onto this one would produce a city
 * that is neither. It is also not deleted: refusing to use it is recoverable,
 * destroying it is not, and the next edit overwrites the slot anyway.
 */
export async function loadCity(world: World, city: City): Promise<LoadOutcome> {
  const save = await readCity();
  if (!save) return { status: 'empty', message: 'no saved city' };

  const discard = (reason: DiscardReason, message: string): LoadOutcome => {
    console.warn(`[cityscope] ${message} — starting a new city`);
    return { status: 'discarded', reason, message };
  };

  if (save.version !== SAVE_VERSION) {
    return discard('version', `save is format v${save.version}, this build writes v${SAVE_VERSION}`);
  }
  if (save.seed !== world.config.seed) {
    return discard('seed', `save belongs to seed ${save.seed}, this world is seed ${world.config.seed}`);
  }
  if (save.size !== world.config.size) {
    return discard('size', `save is ${save.size}², this world is ${world.config.size}²`);
  }
  if (!(save.zone instanceof Uint8Array) || !(save.road instanceof Uint8Array)) {
    return discard('shape', 'save does not carry the two tile arrays');
  }

  try {
    city.restore(save.zone, save.road);
  } catch (error) {
    return discard('shape', `save could not be applied: ${String(error)}`);
  }

  return { status: 'restored', message: `restored ${save.size}² city from seed ${save.seed}` };
}

/**
 * Autosave (T2.2): debounced after the last edit, plus a flush on `pagehide`.
 *
 * The debounce is what keeps a drag from writing once per tile — a 20-tile
 * road stroke would otherwise be 20 structured clones of a 512 KB record.
 * `pagehide` rather than `beforeunload` because it is the one that also fires
 * on mobile Safari, which never gets a `beforeunload` it can act on.
 */
export class Autosave {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly source: () => CitySave,
    private readonly delayMs: number = AUTOSAVE_DELAY_MS,
  ) {}

  /** Call after every edit. Restarts the delay. */
  schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void writeCity(this.source());
    }, this.delayMs);
  }

  /** Save immediately, cancelling any pending debounce. */
  async saveNow(): Promise<boolean> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return writeCity(this.source());
  }

  /** True while an edit is waiting on the debounce. */
  get pending(): boolean {
    return this.timer !== null;
  }

  /**
   * Flush on page hide. The write is not awaited — nothing after `pagehide` is
   * guaranteed to run — so this is best-effort by construction; the debounce
   * is what makes it a small window rather than a large one.
   */
  attachPagehide(target: Window = window): () => void {
    const onHide = (): void => {
      void this.saveNow();
    };
    target.addEventListener('pagehide', onHide);
    return () => target.removeEventListener('pagehide', onHide);
  }
}
