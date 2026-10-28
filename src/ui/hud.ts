import type { Tool, ToolId } from './tools';

/**
 * The HUD and the tool palette (PRD §16.3 T7).
 *
 * M1 has no clock, no money and no demand model (§16.2), so §6.11's field list
 * is *split* rather than filled in: the fields the build can compute are
 * computed, and the rest render as a dash and carry `data-placeholder="true"`.
 * That marker is the point — it turns "this is not a number yet" into a
 * property a check can read, instead of a promise in a comment, which is what
 * §16.3's verify line ("the HUD never presents a number M1 did not compute")
 * needs to be testable at all.
 *
 * The palette is generated from `TOOLS` — the same table the keyboard reads —
 * and a click calls the same `select()` a hotkey does. There is one description
 * of what a tool is and one route to activating it, so the two input paths
 * cannot drift.
 *
 * The overlay is `pointer-events: none` apart from the buttons (index.html):
 * it sits over the canvas, and a HUD that swallowed a drag would break painting
 * beneath it (T6.2).
 */

/** Rendered in a placeholder value slot. Deliberately not a digit. */
const NO_VALUE = '—';

/**
 * §6.11 fields M1 cannot compute, each with the reason it cannot — shown as a
 * tooltip so "why is this blank" is answerable from the screen.
 */
interface PlaceholderSpec {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  /** §6.11's demand bars: three empty meters, drawn because the field exists. */
  readonly bars?: boolean;
}

const PLACEHOLDER_FIELDS: readonly PlaceholderSpec[] = [
  {
    id: 'money',
    label: 'Money',
    note: 'Free build in M1 — money arrives with the budget model in M3 (§16.2).',
  },
  { id: 'date', label: 'Date', note: 'M1 has no clock, so there is no date to show (§16.2).' },
  {
    id: 'speed',
    label: 'Speed',
    note: 'M1 has no clock and nothing to step at another rate (§16.2).',
  },
  {
    id: 'demand',
    label: 'Demand',
    note: 'M1 has no RCI demand model, so the bars stay empty (§16.2).',
    bars: true,
  },
  {
    id: 'alerts',
    label: 'Alerts',
    note: 'M1 has no notification system yet, so there is nothing to badge.',
  },
];

/** What the HUD needs each refresh. */
export interface HudState {
  /** The active tool, so the palette and the keyboard agree visibly. */
  readonly tool: ToolId;
  /**
   * The one city-wide figure M1 can compute (T7.2): tiles carrying a building.
   * Buildings are derived from `zone` + `road` + terrain (T1.3), so this is
   * recomputed by the same rule the map was drawn with, not a stored count.
   */
  readonly population: number;
  /** Debug lines — the road/zone/building tally is one of them. */
  readonly readout: readonly string[];
}

export interface HudOptions {
  /** The tool bar, in slot order. Same table the keys are read from. */
  readonly tools: readonly Tool[];
  /** Called when a palette button is clicked. */
  readonly onSelect: (id: ToolId) => void;
}

interface Field {
  readonly root: HTMLElement;
  readonly value: HTMLElement;
}

function makeField(id: string, label: string): Field {
  const root = document.createElement('span');
  root.className = 'hud-field';
  root.dataset.field = id;

  const labelEl = document.createElement('span');
  labelEl.className = 'hud-field-label';
  labelEl.textContent = label;

  const value = document.createElement('span');
  value.className = 'hud-field-value';

  root.append(labelEl, value);
  return { root, value };
}

/** Three empty meters, labelled R / C / I. No value is drawn into them. */
function demandBars(): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'hud-bars';
  for (const family of ['R', 'C', 'I']) {
    const bar = document.createElement('span');
    bar.className = 'hud-bar';
    bar.title = `${family} demand — placeholder, no demand model in M1`;
    wrap.appendChild(bar);
  }
  return wrap;
}

export class Hud {
  private readonly buttons = new Map<ToolId, HTMLButtonElement>();
  private readonly populationValue: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly onSelect: (id: ToolId) => void;
  /** Last readout text, so an unchanged frame does not touch the DOM. */
  private lastReadout = '';

  constructor(options: HudOptions) {
    this.onSelect = options.onSelect;

    const root = document.createElement('div');
    root.id = 'hud';

    const stats = document.createElement('section');
    stats.className = 'hud-stats';
    stats.setAttribute('aria-label', 'City status');

    const population = makeField('population', 'Population');
    this.populationValue = population.value;
    stats.appendChild(population.root);

    for (const spec of PLACEHOLDER_FIELDS) {
      const field = makeField(spec.id, spec.label);
      field.root.dataset.placeholder = 'true';
      field.root.title = spec.note;
      if (spec.bars) field.value.appendChild(demandBars());
      else field.value.textContent = NO_VALUE;
      stats.appendChild(field.root);
    }

    const palette = document.createElement('nav');
    palette.className = 'hud-palette';
    palette.setAttribute('aria-label', 'Build tools');

    for (const tool of options.tools) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hud-tool';
      button.dataset.tool = tool.id;
      button.title = `${tool.label} — key ${tool.key}`;

      const slot = document.createElement('span');
      slot.className = 'hud-tool-slot';
      slot.textContent = String(tool.slot);

      const label = document.createElement('span');
      label.className = 'hud-tool-label';
      label.textContent = tool.label;

      const key = document.createElement('span');
      key.className = 'hud-tool-key';
      key.textContent = tool.key;

      button.append(slot, label, key);
      button.addEventListener('click', (event) => {
        this.onSelect(tool.id);
        // A click *from a pointer* must not leave the button focused: the
        // canvas listens on the window, and a focused button would swallow the
        // first Space (a pan key, T6.2) and re-fire its own click on keyup.
        // `detail > 0` is a pointer click; a keyboard activation keeps focus.
        if (event.detail > 0) button.blur();
      });

      this.buttons.set(tool.id, button);
      palette.appendChild(button);
    }

    this.readout = document.createElement('pre');
    this.readout.className = 'hud-readout';
    this.readout.setAttribute('aria-label', 'Debug readout');

    root.append(stats, palette, this.readout);
    document.body.appendChild(root);
  }

  update(state: HudState): void {
    this.populationValue.textContent = String(state.population);

    for (const [id, button] of this.buttons) {
      const active = id === state.tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    const text = state.readout.join('\n');
    if (text !== this.lastReadout) {
      this.lastReadout = text;
      this.readout.textContent = text;
    }
  }
}
