import { Application } from 'pixi.js';

export interface AppOptions {
  /** Clear colour behind the map. */
  background: number;
  /**
   * Backing-store scale. T3.5's policy lives in `quality.ts`; this is just the
   * value to boot with, and `WorldRenderer.setQuality` owns it afterwards.
   */
  resolution: number;
}

/**
 * Creates the PixiJS application and mounts its canvas.
 *
 * `autoDensity` keeps the canvas CSS box at CSS-pixel size while the backing
 * store follows `resolution`, which is what lets the quality ladder drop below
 * 1 and have the browser upscale instead of the layout changing size.
 */
export async function createApp(options: AppOptions): Promise<Application> {
  const app = new Application();
  await app.init({
    background: options.background,
    resizeTo: window,
    resolution: options.resolution,
    autoDensity: true,
  });
  document.body.appendChild(app.canvas);
  return app;
}
