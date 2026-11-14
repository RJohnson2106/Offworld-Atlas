import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Run `npm run build` first: this suite tests the production build. */

const SHOTS = 'screenshots';

interface Camera {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

const phase = (page: Page) => page.getByTestId('atlas').getAttribute('data-phase');
const waitForPhase = (page: Page, value: string, timeout = 8000) =>
  expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', value, { timeout });

const camera = (page: Page): Promise<Camera> =>
  page.evaluate(() => (window as any).__atlas.director.getCamera());

const setCamera = (page: Page, next: Camera) =>
  page.evaluate((c) => (window as any).__atlas.map.jumpTo(c), next);

const tilesReady = (page: Page) =>
  page.waitForFunction(() => {
    const { map } = (window as any).__atlas;
    return map.loaded() && map.areTilesLoaded() && !map.isMoving();
  }, undefined, { timeout: 30_000 });

async function open(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).__atlas?.map.loaded(), undefined, { timeout: 30_000 });
  await tilesReady(page);
  await page.evaluate(() => document.fonts.ready);
  return errors;
}

function expectCameraClose(actual: Camera, expected: Camera) {
  expect(actual.center[0]).toBeCloseTo(expected.center[0], 4);
  expect(actual.center[1]).toBeCloseTo(expected.center[1], 4);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 4);
  expect(actual.pitch).toBeCloseTo(expected.pitch, 3);
  expect(actual.bearing).toBeCloseTo(expected.bearing, 3);
}

test('marker opens the site, local controls work, and back restores the map', async ({ page }) => {
  const errors = await open(page);
  await expect(page.getByText('Prototype · Demo sites')).toBeVisible();
  await expect(page.getByText('Demo placement')).toHaveCount(3);
  await page.screenshot({ path: `${SHOTS}/overview.png` });

  const before: Camera = { center: [-20, 20], zoom: 1.7, pitch: 12, bearing: -9 };
  await setCamera(page, before);
  await tilesReady(page);

  // Record where the site is drawn on every frame of the flight.
  await page.evaluate(() => {
    const { map } = (window as any).__atlas;
    const trace: { t: number; x: number; y: number }[] = [];
    (window as any).__trace = trace;
    const tick = () => {
      const p = map.project([52.2, 29.6]);
      trace.push({ t: performance.now(), x: p.x, y: p.y });
      if (document.querySelector('[data-testid=atlas]')?.getAttribute('data-phase') !== 'local') {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });

  await page.getByTestId('marker-ridge-02').click();
  await waitForPhase(page, 'departing', 1000);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/flight-midpoint.png` });
  await waitForPhase(page, 'local');

  const trace: { t: number; x: number; y: number }[] = await page.evaluate(() => (window as any).__trace);
  const duration = trace[trace.length - 1].t - trace[0].t;
  expect(duration).toBeGreaterThan(1500);
  expect(duration).toBeLessThan(3200);
  const start = trace[0];
  const end = trace[trace.length - 1];
  const total = Math.hypot(end.x - start.x, end.y - start.y);
  for (const point of trace) {
    expect(Math.hypot(point.x - start.x, point.y - start.y)).toBeLessThan(total + 30);
  }

  const panel = page.getByTestId('site-panel');
  await expect(panel.getByRole('heading', { name: 'Ridge 02' })).toBeVisible();
  await expect(panel.getByText('Demo ID FA-D02')).toBeVisible();
  await expect(panel.getByText('Moon placeholder')).toBeVisible();
  await expect(panel.getByText('Pending research')).toHaveCount(1);
  await expect(page.locator('.cartouche')).toHaveCSS('opacity', '0');

  await tilesReady(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/site-view.png` });

  const marker = await page.getByTestId('marker-ridge-02').locator('svg').boundingBox();
  expect(marker!.x + marker!.width).toBeLessThan(1440 - 340);

  const home = await camera(page);
  await page.getByTestId('zoom-in').click();
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(home.zoom + 0.5);
  await page.getByTestId('rotate-right').click();
  await expect.poll(async () => Math.abs((await camera(page)).bearing - home.bearing)).toBeGreaterThan(20);

  await page.mouse.move(500, 500);
  await page.mouse.down();
  await page.mouse.move(380, 440, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const panned = await camera(page);
      return Math.abs(panned.center[0] - home.center[0]) + Math.abs(panned.center[1] - home.center[1]);
    })
    .toBeGreaterThan(0.05);
  await page.waitForFunction(() => !(window as any).__atlas.map.isMoving());

  await page.getByTestId('reset-view').click();
  await page.waitForTimeout(900);
  await page.waitForFunction(() => !(window as any).__atlas.map.isMoving());
  expectCameraClose(await camera(page), home);

  await page.getByTestId('back-to-map').click();
  await waitForPhase(page, 'overview');
  expectCameraClose(await camera(page), before);
  await expect(page.locator('.cartouche')).toHaveCSS('opacity', '1', { timeout: 2000 });
  expect(errors).toEqual([]);
});

test('keyboard selection, Escape, and focus return', async ({ page }) => {
  await open(page);
  const entry = page.getByTestId('index-basin-01');
  await entry.focus();
  await page.keyboard.press('Enter');
  await waitForPhase(page, 'local');
  await expect(page.getByTestId('back-to-map')).toBeFocused();
  await page.keyboard.press('Escape');
  await waitForPhase(page, 'overview');
  await expect(entry).toBeFocused();

  // Tab reaches the index from the page start without a pointer.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  let reached = false;
  for (let i = 0; i < 12 && !reached; i += 1) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'index-icefield-03');
  }
  expect(reached).toBe(true);
});

test('interrupted and rapid input leave a clean state', async ({ page }) => {
  const errors = await open(page);
  const before = await camera(page);

  // Escape partway through the flight reverses it.
  await page.getByTestId('index-basin-01').click();
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');
  await waitForPhase(page, 'returning', 500);
  await page.keyboard.press('Escape');
  await waitForPhase(page, 'overview');
  expectCameraClose(await camera(page), before);

  // Rapid clicks: the first choice wins.
  await page.evaluate(() => {
    const a = document.querySelector<HTMLElement>('[data-testid=index-icefield-03]')!;
    const b = document.querySelector<HTMLElement>('[data-testid=index-ridge-02]')!;
    a.click();
    b.click();
    a.click();
  });
  await waitForPhase(page, 'local');
  await expect(page.getByTestId('atlas')).toHaveAttribute('data-site', 'icefield-03');
  await expect(page.getByTestId('site-panel').getByRole('heading', { name: 'Icefield 03' })).toBeVisible();

  // Back is usable as soon as it appears, and repeat presses do nothing extra.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await waitForPhase(page, 'overview');
  expectCameraClose(await camera(page), before);

  // Map input works again afterwards.
  await page.mouse.move(800, 300);
  await page.mouse.down();
  await page.mouse.move(700, 300, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.abs((await camera(page)).center[0] - before.center[0]))
    .toBeGreaterThan(0.1);
  expect(errors).toEqual([]);
});

test('reduced motion jumps straight to the site and back', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const before = await camera(page);

  await page.evaluate(() => {
    const seen: string[] = [];
    (window as any).__phases = seen;
    new MutationObserver(() => {
      seen.push(document.querySelector('[data-testid=atlas]')!.getAttribute('data-phase')!);
    }).observe(document.querySelector('[data-testid=atlas]')!, { attributes: true, attributeFilter: ['data-phase'] });
  });

  await page.getByTestId('index-ridge-02').click();
  await waitForPhase(page, 'local', 400);
  await page.keyboard.press('Escape');
  await waitForPhase(page, 'overview', 400);
  expectCameraClose(await camera(page), before);
  const seen: string[] = await page.evaluate(() => (window as any).__phases);
  expect(seen).not.toContain('departing');
  expect(seen).not.toContain('arriving');
});

test('narrow mobile layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await open(page);
  await page.screenshot({ path: `${SHOTS}/mobile-overview.png` });

  for (const id of ['basin-01', 'ridge-02', 'icefield-03']) {
    const box = await page.getByTestId(`marker-${id}`).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);

  await page.getByTestId('marker-basin-01').click();
  await waitForPhase(page, 'local');
  await tilesReady(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/mobile-site.png` });

  const panel = await page.getByTestId('site-panel').boundingBox();
  const marker = await page.getByTestId('marker-basin-01').boundingBox();
  const controls = await page.locator('.local-controls').boundingBox();
  expect(panel!.width).toBeLessThanOrEqual(390);
  expect(marker!.y + marker!.height).toBeLessThan(controls!.y);
  expect(controls!.y + controls!.height).toBeLessThanOrEqual(panel!.y);
  expect(controls!.x + controls!.width).toBeLessThanOrEqual(390);

  await page.getByTestId('back-to-map').click();
  await waitForPhase(page, 'overview');
  expect(errors).toEqual([]);
});

test('without WebGL the index and details still work', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) {
      if (type.startsWith('webgl')) return null;
      return original.call(this, type as '2d', ...(rest as []));
    } as typeof original;
  });
  await page.goto('/');
  await expect(page.getByTestId('atlas')).toHaveAttribute('data-map', 'unavailable');
  await page.getByTestId('index-basin-01').click();
  await expect(page.getByTestId('site-panel').getByRole('heading', { name: 'Basin 01' })).toBeVisible();
  await expect(page.getByTestId('site-panel').getByText('Pending research')).toHaveCount(1);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/no-webgl.png` });
  await page.keyboard.press('Escape');
  await waitForPhase(page, 'overview');
  await expect(page.getByTestId('index-basin-01')).toBeVisible();
});
