import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Run `npm run build` first: this suite tests the production build. */

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function openMap(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).__atlas?.map.loaded(), undefined, { timeout: 30_000 });
}

const hasOverlay = (page: Page) => page.evaluate(() => Boolean((window as any).__atlas.map.getLayer('data-overlay')));

const screenPoint = (page: Page, lng: number, lat: number) =>
  page.evaluate(([x, y]) => {
    const point = (window as any).__atlas.map.project([x, y]);
    return { x: point.x, y: point.y };
  }, [lng, lat]);

test('world heat maps show a legend and a value on hover', async ({ page }) => {
  const errors = watchErrors(page);
  await openMap(page);
  expect(await hasOverlay(page)).toBe(false);

  const picker = page.getByTestId('layer-picker');
  for (const id of ['temperature', 'precipitation', 'remoteness']) {
    await picker.selectOption(id);
    await expect(page.getByTestId('layer-legend')).toBeVisible();
    expect(await hasOverlay(page)).toBe(true);
    await page.waitForTimeout(500);

    // Over the middle of Africa, which has data in every layer.
    const { x, y } = await screenPoint(page, 22, 5);
    await page.mouse.move(x - 2, y);
    await page.mouse.move(x, y);
    await expect(page.getByTestId('map-tip')).toBeVisible();
    await expect(page.getByTestId('map-tip').locator('strong')).not.toBeEmpty();
    await page.mouse.move(5, 5);
  }

  await picker.selectOption('none');
  expect(await hasOverlay(page)).toBe(false);
  await expect(page.getByTestId('layer-legend')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('volcano markers switch on and name themselves', async ({ page }) => {
  const errors = watchErrors(page);
  await openMap(page);

  const visibility = () =>
    page.evaluate(() => (window as any).__atlas.map.getLayoutProperty('points-volcanoes', 'visibility'));
  expect(await visibility()).toBe('none');

  await page.getByTestId('points-volcanoes').check();
  expect(await visibility()).toBe('visible');

  // Etna, which sits on its own in the Mediterranean.
  await page.waitForTimeout(800);
  const { x, y } = await screenPoint(page, 15.0, 37.75);
  await page.mouse.move(x - 1, y);
  await page.mouse.move(x, y);
  await expect(page.getByTestId('map-tip')).toBeVisible();

  // Markers belong to the world view.
  await page.getByTestId('index-ridge-02').click();
  await expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', 'local');
  expect(await visibility()).toBe('none');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', 'overview');
  expect(await visibility()).toBe('visible');
  expect(errors).toEqual([]);
});

for (const id of ['basin-01', 'ridge-02', 'icefield-03']) {
  test(`${id} has site overlays and charts`, async ({ page }) => {
    const errors = watchErrors(page);
    await openMap(page);
    await page.getByTestId('layer-picker').selectOption('temperature');
    await page.getByTestId(`index-${id}`).click();
    await expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', 'local');

    // The world layer doesn't follow you in.
    expect(await hasOverlay(page)).toBe(false);

    const picker = page.getByTestId('layer-picker');
    for (const layer of ['slope', 'roughness', 'landcover', 'water']) {
      await picker.selectOption(layer);
      await expect(page.getByTestId('layer-legend')).toBeVisible();
      expect(await hasOverlay(page)).toBe(true);
    }

    const panel = page.getByTestId('site-panel');
    await expect(panel.locator('.comparison figure')).toHaveCount(2);
    const climate = panel.locator('details.measure').filter({ hasText: 'Temperature and sunlight' });
    await climate.locator('summary').first().click();
    await expect(climate.locator('figure')).toHaveCount(2);
    await climate.getByText('Show table').first().click();
    await expect(climate.locator('figure table').first().locator('tbody tr')).toHaveCount(12);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', 'overview');
    await expect.poll(() => hasOverlay(page)).toBe(true); // back to the world layer
    expect(errors).toEqual([]);
  });
}

test('the local view is 3D and the marker sits on the real ground', async ({ page }) => {
  await openMap(page);
  await page.getByTestId('index-basin-01').click();
  await expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', 'local');
  await page.waitForFunction(() => {
    const { map } = (window as any).__atlas;
    return map.terrain && map.areTilesLoaded() && !map.isMoving() && map.terrain.getElevationForLngLatZoom !== undefined;
  }, undefined, { timeout: 30_000 });

  // The marker must match where the map draws that coordinate, including its height.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { map } = (window as any).__atlas;
        const glyph = document.querySelector('[data-testid=marker-basin-01] svg')!.getBoundingClientRect();
        const point = map.project([-67.85, -20.9]);
        return Math.hypot(glyph.x + glyph.width / 2 - point.x, glyph.y + glyph.height / 2 - point.y);
      }),
    )
    .toBeLessThan(2);

  const ground = () =>
    page.evaluate(() => {
      const { map } = (window as any).__atlas;
      return map.terrain.exaggeration as number;
    });
  expect(await ground()).toBe(4);
  await page.getByTestId('height-1').click();
  expect(await ground()).toBe(1);
  await expect(page.getByTestId('height-1')).toHaveAttribute('aria-pressed', 'true');

  // Flat again on the world map.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', 'overview');
  expect(await page.evaluate(() => (window as any).__atlas.map.getTerrain())).toBeFalsy();
});

test('the slope chart follows the comparison picker', async ({ page }) => {
  await openMap(page);
  await page.getByTestId('index-ridge-02').click();
  await expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', 'local');
  const chart = page.getByTestId('comparison').locator('figure').first();
  await expect(chart.locator('.chart__legend')).toContainText('Malapert region');
  await page.getByTestId('compare-reference').selectOption('gale');
  await expect(chart.locator('.chart__legend')).toContainText('Gale Crater');
});
