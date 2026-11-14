import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Run `npm run build` first: this suite tests the production build. */

const SHOTS = 'screenshots';

const waitForPhase = (page: Page, value: string, timeout = 30_000) =>
  expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', value, { timeout });

const camera = (page: Page) => page.evaluate(() => (window as any).__atlas.director.getCamera());
const drone = (page: Page) => page.evaluate(() => (window as any).__drone.getState());

/** A one-pixel stand-in, so a test run doesn't send hundreds of requests to the imagery service. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const stubImagery = (page: Page) =>
  page.route('**://tiles.maps.eox.at/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: PIXEL,
    }),
  );

async function openRidge(page: Page) {
  await stubImagery(page);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).__atlas?.map.loaded(), undefined, { timeout: 30_000 });
  await page.getByTestId('index-ridge-02').click();
  await waitForPhase(page, 'local');
  // The view makes a final small correction once elevation has loaded.
  await page.waitForFunction(() => {
    const { map } = (window as any).__atlas;
    return map.areTilesLoaded() && !map.isMoving();
  }, undefined, { timeout: 30_000 });
  await page.waitForTimeout(400);
  return errors;
}

async function enterDrone(page: Page) {
  await page.getByTestId('enter-drone').click();
  await waitForPhase(page, 'drone');
  await page.waitForFunction(() => !(window as any).__drone.getState().revealing, undefined, { timeout: 20_000 });
}

function expectSameCamera(actual: any, expected: any) {
  expect(actual.center[0]).toBeCloseTo(expected.center[0], 4);
  expect(actual.center[1]).toBeCloseTo(expected.center[1], 4);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 4);
  expect(actual.pitch).toBeCloseTo(expected.pitch, 3);
  expect(actual.bearing).toBeCloseTo(expected.bearing, 3);
}

test('enter, fly over terrain, stay above ground, and exit to the same map view', async ({ page }) => {
  const errors = await openRidge(page);
  const local = await camera(page);

  await enterDrone(page);
  await expect(page.getByTestId('site-panel')).toBeHidden();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/drone-view.png` });

  const start = await drone(page);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyW');
  const moved = await drone(page);
  expect(Math.hypot(moved.x - start.x, moved.z - start.z)).toBeGreaterThan(20);

  // Holding "down" must never put the drone into the ground.
  await page.keyboard.down('KeyQ');
  await page.waitForTimeout(3500);
  const low = await drone(page);
  await page.keyboard.up('KeyQ');
  expect(low.y - low.ground).toBeGreaterThanOrEqual(25);
  await expect(page.getByTestId('drone-clearance')).toHaveText(/^\d[\d,]* m$/);

  // Drag to look.
  const box = await page.getByTestId('drone-view').boundingBox();
  await page.mouse.move(box!.width / 2, box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.width / 2 + 160, box!.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(Math.abs((await drone(page)).yaw - low.yaw)).toBeGreaterThan(0.1);

  await page.keyboard.press('Escape');
  await waitForPhase(page, 'local');
  expectSameCamera(await camera(page), local);
  await expect(page.getByTestId('site-panel').getByRole('heading', { name: 'Ridge 02' })).toBeVisible();
  await expect(page.getByTestId('drone-view')).toHaveCount(0);

  // A second Escape leaves the site, as usual.
  await page.keyboard.press('Escape');
  await waitForPhase(page, 'overview');
  expect(errors).toEqual([]);
});

test('escape during the dive comes straight back', async ({ page }) => {
  const errors = await openRidge(page);
  const local = await camera(page);
  await page.getByTestId('enter-drone').click();
  await waitForPhase(page, 'diving');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await waitForPhase(page, 'local');
  expectSameCamera(await camera(page), local);
  await expect(page.getByTestId('atlas')).toHaveAttribute('data-site', 'ridge-02');
  expect(errors).toEqual([]);
});

for (const id of ['basin-01', 'ridge-02', 'icefield-03']) {
  test(`drone view flies at ${id}`, async ({ page }, testInfo) => {
    // Real imagery in one browser only, to keep the load on the service small.
    const realImagery = testInfo.project.name === 'chromium';
    if (!realImagery) await stubImagery(page);
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/?e2e');
    await page.waitForFunction(() => (window as any).__atlas?.map.loaded(), undefined, { timeout: 30_000 });
    await page.getByTestId(`index-${id}`).click();
    await waitForPhase(page, 'local');
    await enterDrone(page);
    await page.waitForFunction(() => (window as any).__drone.hasImagery(), undefined, { timeout: 45_000 });
    await expect(page.getByTestId('drone-credits')).toContainText('EOxCloudless');
    await page.waitForTimeout(1800);
    if (realImagery) await page.screenshot({ path: `${SHOTS}/drone-${id}.png` });

    const state = await drone(page);
    expect(state.y - state.ground).toBeGreaterThan(100);

    const start = await drone(page);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyW');
    const moved = await drone(page);
    expect(Math.hypot(moved.x - start.x, moved.z - start.z)).toBeGreaterThan(10);
    await page.keyboard.press('Escape');
    await waitForPhase(page, 'local');
    expect(errors).toEqual([]);
  });
}

test('reduced motion cuts straight in and out', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openRidge(page);
  const local = await camera(page);
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as any).__phases = seen;
    const root = document.querySelector('[data-testid=atlas]')!;
    new MutationObserver(() => seen.push(root.getAttribute('data-phase')!)).observe(root, {
      attributes: true,
      attributeFilter: ['data-phase'],
    });
  });
  await page.getByTestId('enter-drone').click();
  await waitForPhase(page, 'drone');
  expect((await drone(page)).revealing).toBe(false);
  await page.keyboard.press('Escape');
  await waitForPhase(page, 'local', 1000);
  expectSameCamera(await camera(page), local);
  const seen: string[] = await page.evaluate(() => (window as any).__phases);
  expect(seen).not.toContain('diving');
  expect(seen).not.toContain('surfacing');
});

test('with no imagery service the drone view still works, without the imagery credit', async ({ page }) => {
  await page.route('**://tiles.maps.eox.at/**', (route) => route.abort());
  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).__atlas?.map.loaded(), undefined, { timeout: 30_000 });
  await page.getByTestId('index-ridge-02').click();
  await waitForPhase(page, 'local');
  await enterDrone(page);
  expect(await page.evaluate(() => (window as any).__drone.hasImagery())).toBe(false);
  await expect(page.getByTestId('drone-credits')).not.toContainText('EOxCloudless');
});

test('missing terrain leaves you on the map with a clear message', async ({ page }) => {
  await page.route('**/terrain/**', (route) => route.abort());
  await openRidge(page);
  const local = await camera(page);
  await page.getByTestId('enter-drone').click();
  await expect(page.getByRole('alert')).toContainText("The terrain didn't load");
  await expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', 'local');
  expectSameCamera(await camera(page), local);
  await expect(page.getByTestId('enter-drone')).toBeEnabled();
});

test('narrow mobile drone layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await openRidge(page);
  await enterDrone(page);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/mobile-drone.png` });

  const exit = await page.getByTestId('exit-drone').boundingBox();
  const readout = await page.locator('.drone__readout').boundingBox();
  const pad = await page.locator('.drone__pad').boundingBox();
  expect(exit!.x + exit!.width).toBeLessThanOrEqual(readout!.x);
  expect(pad!.x).toBeGreaterThanOrEqual(0);
  expect(pad!.x + pad!.width).toBeLessThanOrEqual(390);

  const start = await drone(page);
  const forward = page.getByRole('button', { name: 'Fly forward' });
  const padButton = await forward.boundingBox();
  await page.mouse.move(padButton!.x + 20, padButton!.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(2500);
  await page.mouse.up();
  const moved = await drone(page);
  expect(Math.hypot(moved.x - start.x, moved.z - start.z)).toBeGreaterThan(20);

  await page.getByTestId('exit-drone').click();
  await waitForPhase(page, 'local');
  expect(errors).toEqual([]);
});
