import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Run `npm run build` first: this suite tests the production build. */

async function openSite(page: Page, id: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).__atlas?.map.loaded(), undefined, { timeout: 30_000 });
  await page.getByTestId(`index-${id}`).click();
  await expect(page.getByTestId('atlas')).toHaveAttribute('data-phase', 'local');
}

for (const [id, world, defaultReference] of [
  ['basin-01', 'Mars', 'jezero'],
  ['ridge-02', 'Moon', 'malapert'],
  ['icefield-03', 'Mars', 'jezero'],
] as const) {
  test(`${id} shows measurements and a matched comparison`, async ({ page }) => {
    await openSite(page, id);

    const sections = page.getByTestId('measurements').locator('details.measure');
    await expect(sections).toHaveCount(8);
    await expect(sections.filter({ hasText: 'Terrain and topography' }).getByText('Relief')).toBeVisible();

    const comparison = page.getByTestId('comparison');
    const picker = page.getByTestId('compare-reference');
    await expect(comparison.getByRole('heading', { level: 3 })).toHaveText(
      world === 'Moon' ? 'Compare with the Moon' : 'Compare with Mars',
    );
    await expect(picker).toHaveValue(defaultReference);
    await expect(comparison.locator(':scope > table tbody tr')).toHaveCount(8);

    const grid = world === 'Moon' ? '118 m grid' : '463 m grid';
    // Every place in the picker shows its closest trait, and every trait is listed below.
    await expect(picker.locator('option')).toHaveCount(7);
    for (const option of await picker.locator('option').all()) {
      await expect(option).toHaveText(/, \d{1,3}% [a-z ]+$/);
    }
    const traits = page.getByTestId('trait-match');
    await expect(traits).toContainText('Closest trait');
    await expect(traits).toContainText('Least alike');
    await expect(traits.locator('.traits li')).toHaveCount(11);
    await expect(traits).toContainText('not the chance');

    const note = comparison.locator('.comparison__note');
    await expect(note).toContainText(grid);

    // Switching world changes the grid, because Earth is re-gridded to match each map.
    await picker.selectOption(world === 'Moon' ? 'gale' : 'apollo-17');
    await expect(note).toContainText(world === 'Moon' ? '463 m grid' : '118 m grid');

    await expect(page.getByTestId('data-sources').getByRole('link').first()).toBeVisible();
    await expect(page.getByTestId('data-sources')).toContainText('NASA Planetary Fact Sheets');
  });
}

test('the analog explanation stays open for the team', async ({ page }) => {
  await openSite(page, 'ridge-02');
  await expect(page.getByTestId('site-panel').getByText('Pending research')).toHaveCount(1);
});
