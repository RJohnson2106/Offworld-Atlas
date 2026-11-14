import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/** Every view at a spread of window shapes, from phones to ultrawide monitors. */

const SIZES: [number, number][] = [
  [360, 640],
  [390, 844],
  [844, 390],
  [820, 1180],
  [851, 931],
  [1024, 640],
  [1280, 720],
  [1440, 900],
  [1704, 930],
  [1920, 1080],
  [2560, 1440],
  [3440, 1440],
];

const box = async (locator: Locator) => (await locator.boundingBox())!;
const overlap = (a: any, b: any) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function expectInside(page: Page, locator: Locator, label: string) {
  const size = page.viewportSize()!;
  const b = await box(locator);
  expect(b.x, `${label} left`).toBeGreaterThanOrEqual(-0.5);
  expect(b.y, `${label} top`).toBeGreaterThanOrEqual(-0.5);
  expect(b.x + b.width, `${label} right`).toBeLessThanOrEqual(size.width + 0.5);
  expect(b.y + b.height, `${label} bottom`).toBeLessThanOrEqual(size.height + 0.5);
}

async function expectClear(a: Locator, b: Locator, label: string) {
  expect(overlap(await box(a), await box(b)), label).toBe(false);
}

const ready = (page: Page) =>
  page.waitForFunction(() => (window as any).__atlas?.map.loaded(), undefined, { timeout: 30_000 });

for (const [width, height] of SIZES) {
  test(`fits at ${width} x ${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**://tiles.maps.eox.at/**', (route) => route.abort());
    await page.goto('/?e2e');
    await ready(page);

    const canvas = page.locator('.map-canvas canvas').first();
    const rect = await box(canvas);
    expect(rect.width).toBeCloseTo(width, 0);
    expect(rect.height).toBeCloseTo(height, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    const cartouche = page.locator('.cartouche');
    const instruments = page.locator('.instruments');
    await expectInside(page, cartouche, 'title block');
    await expectInside(page, instruments, 'instruments');
    await expectClear(cartouche, instruments, 'title block and instruments');
    const dataLayers = page.getByTestId('data-layers');
    await expectInside(page, dataLayers, 'data layers');
    await expectClear(dataLayers, cartouche, 'data layers and title block');
    await expectClear(dataLayers, instruments, 'data layers and instruments');
    for (const id of ['basin-01', 'ridge-02', 'icefield-03']) {
      const marker = page.getByTestId(`marker-${id}`);
      await expectInside(page, marker.locator('svg'), `${id} mark`);
      await expectClear(marker, cartouche, `${id} and title block`);
      await expectClear(marker, instruments, `${id} and instruments`);
      await expectClear(marker.locator('svg'), dataLayers, `${id} and data layers`);
    }

    await page.getByTestId('index-basin-01').click();
    await expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', 'local');
    const panel = page.getByTestId('site-panel');
    const back = page.getByTestId('back-to-map');
    const controls = page.locator('.local-controls__strip');
    const glyph = page.getByTestId('marker-basin-01').locator('svg');
    await expectInside(page, panel, 'panel');
    await expectInside(page, controls, 'controls');
    await expectInside(page, glyph, 'selected site');
    await expectClear(glyph, panel, 'selected site and panel');
    await expectClear(glyph, controls, 'selected site and controls');
    await expectClear(back, instruments, 'back and instruments');
    await expectClear(controls, instruments, 'controls and instruments');
    await expectClear(controls, panel, 'controls and panel');
    await expectClear(back, panel, 'back and panel');
    await expectClear(instruments, panel, 'instruments and panel');
    await expectClear(dataLayers, back, 'data layers and back');
    await expectClear(dataLayers, panel, 'data layers and panel');
    await expectClear(dataLayers, controls, 'data layers and controls');
    await expectClear(dataLayers, instruments, 'data layers and instruments');

    const enter = page.getByTestId('enter-drone');
    await enter.scrollIntoViewIfNeeded();
    await enter.click();
    await expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', 'drone', { timeout: 30_000 });

    const droneCanvas = page.locator('.drone__stage canvas');
    const droneRect = await box(droneCanvas);
    expect(droneRect.width).toBeCloseTo(width, 0);
    expect(droneRect.height).toBeCloseTo(height, 0);

    const exit = page.getByTestId('exit-drone');
    const readout = page.locator('.drone__readout');
    const title = page.locator('.drone__title');
    await expectInside(page, exit, 'exit');
    await expectInside(page, readout, 'readout');
    await expectInside(page, page.getByTestId('drone-credits'), 'credits');
    await expectClear(readout, page.getByTestId('drone-credits'), 'readout and credits');
    await expectClear(exit, readout, 'exit and readout');
    await expectClear(exit, title, 'exit and title');
    await expectClear(readout, title, 'readout and title');
    const hint = page.locator('.drone__hint');
    if (await hint.isVisible()) await expectClear(hint, readout, 'hint and readout');
  });
}

test('the map follows the window when it is resized', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto('/?e2e');
  await ready(page);
  await page.setViewportSize({ width: 1800, height: 1000 });
  // The globe is sized from the window's shorter side, now 1000 px.
  await expect
    .poll(() => page.evaluate(() => (window as any).__atlas.map.getZoom()))
    .toBeCloseTo(Math.log2((1000 * 0.46 * 2 * Math.PI * Math.cos((16 * Math.PI) / 180)) / 512), 2);
  const rect = await box(page.locator('.map-canvas canvas').first());
  expect(rect.width).toBeCloseTo(1800, 0);
  expect(rect.height).toBeCloseTo(1000, 0);
});
