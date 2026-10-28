import type { Capabilities } from '../core/capabilities';

/**
 * The unsupported-browser screen (§16 T8.2, PRD §11 R6).
 *
 * The only screen this app shows instead of the game. It exists so a failure is
 * *legible*: the alternative — an empty page where the canvas would be — is
 * indistinguishable from a crash, and that was exactly the report that cost a
 * debugging round when the build was first opened from `file://` (ES modules
 * need an http origin; the page is fine, the loading is not).
 *
 * Deliberately plain DOM and no PixiJS: this runs precisely when the renderer
 * could not be created.
 */
export function showUnsupportedScreen(capabilities: Capabilities): void {
  const hud = document.getElementById('hud');
  if (hud) hud.remove();

  const missing = capabilities.missing.map((name) => `• ${name}`).join('\n');

  const screen = document.createElement('main');
  screen.className = 'unsupported';

  const title = document.createElement('h1');
  title.textContent = 'CityScope cannot run in this browser';

  const lead = document.createElement('p');
  lead.textContent =
    'The game renders with WebGL2 in a Web Worker and needs both. This browser reports that it is missing:';

  const list = document.createElement('pre');
  list.className = 'unsupported-list';
  list.textContent = missing;

  const advice = document.createElement('p');
  advice.className = 'unsupported-advice';
  advice.textContent =
    'A recent desktop Chrome, Edge, Firefox or Safari will run it. If this is a desktop browser, check that hardware acceleration is enabled.';

  screen.append(title, lead, list, advice);
  document.body.appendChild(screen);
}
