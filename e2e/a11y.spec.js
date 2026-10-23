'use strict';

const { test, expect } = require('@playwright/test');

// Every test starts from a fresh browser profile, so the example plan loads.
test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

const device = (page, name) => page.locator(`.scene .dev[aria-label^="${name},"]`);
const status = (page) => page.locator('#status');

/** Contrast ratio of two CSS colors as the page computes them. */
function contrastOf(page, sel, fg, bg) {
  return page.evaluate(
    ({ sel, fg, bg }) => {
      const probe = document.createElement('i');
      document.querySelector(sel).appendChild(probe);
      const rgb = (v) => {
        probe.style.color = v;
        return getComputedStyle(probe).color.match(/\d+/g).slice(0, 3).map(Number);
      };
      const lum = (c) => {
        const [r, g, b] = c.map((x) => {
          const s = x / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const a = lum(rgb(fg));
      const b = lum(rgb(bg));
      probe.remove();
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    },
    { sel, fg, bg }
  );
}

for (const theme of ['light', 'dark']) {
  test(`secondary text reads at 4.5:1 in the ${theme} theme`, async ({ page }) => {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    expect(await contrastOf(page, 'body', 'var(--ink-3)', 'var(--surface)')).toBeGreaterThanOrEqual(4.5);
    expect(await contrastOf(page, 'body', 'var(--ink-3)', 'var(--surface-2)')).toBeGreaterThanOrEqual(4.5);
  });
}

test.describe('in a dark system theme', () => {
  test.use({ colorScheme: 'dark' });
  test('secondary text reads at 4.5:1 too', async ({ page }) => {
    expect(await contrastOf(page, 'body', 'var(--ink-3)', 'var(--surface)')).toBeGreaterThanOrEqual(4.5);
    expect(await contrastOf(page, 'body', 'var(--ink-3)', 'var(--surface-2)')).toBeGreaterThanOrEqual(4.5);
  });
});

test('the focus ring of a segment stands out from it, pressed or not', async ({ page }) => {
  await page.focus('#plan-name');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const cabling = page.locator('.ws-switch [data-workspace="cabling"]');
  await expect(cabling).toBeFocused();
  const look = (loc) => loc.evaluate((e) => ({ ring: getComputedStyle(e).outlineColor, ink: getComputedStyle(document.body).color }));
  const off = await look(cabling);
  expect(off.ring).toBe(off.ink);
  await page.keyboard.press('Shift+Tab');
  const racks = page.locator('.ws-switch [data-workspace="racks"]');
  await expect(racks).toBeFocused();
  const on = await look(racks);
  expect(on.ring).not.toBe(on.ink);
  expect(await contrastOf(page, 'body', on.ring, 'var(--ink)')).toBeGreaterThanOrEqual(3);
});

test('[ and ] step rows when typed with AltGr or Option', async ({ page }) => {
  await expect(page.locator('#row-label')).toHaveText('Row A');
  // Windows reports AltGr as Ctrl+Alt, macOS Option as Alt.
  await page.keyboard.press('Control+Alt+BracketRight');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await page.keyboard.press('Alt+BracketLeft');
  await expect(page.locator('#row-label')).toHaveText('Row A');
  // Ctrl alone with a bracket is not a row step.
  await page.keyboard.press('Control+BracketRight');
  await expect(page.locator('#row-label')).toHaveText('Row A');
});

test('the plan name is the page’s heading; the schedule’s arrow column says “to”', async ({ page }) => {
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1 #plan-name')).toHaveCount(1);
  await page.click('.ws-switch [data-workspace="cabling"]');
  await page.click('[data-cab-view="schedule"]');
  await expect(page.locator('#sc-table thead th.sc-arrow')).toHaveText('to');
});

test('the inspector is quiet; a status line says what keys and clicks did', async ({ page }) => {
  await expect(page.locator('#inspector')).not.toHaveAttribute('aria-live', /.*/);
  await expect(status(page)).toHaveAttribute('role', 'status');
  await device(page, 'cn-001').click();
  await device(page, 'cn-002').click({ modifiers: ['Shift'] });
  await expect(status(page)).toHaveText('2 devices selected');
  await page.keyboard.press('ArrowDown');
  await expect(status(page)).toHaveText('Moved 2 devices');
  await device(page, 'sw-mgmt-a01').click();
  await page.keyboard.press('ArrowDown');
  await expect(status(page)).toHaveText(/^Moved sw-mgmt-a01 to Rack A01 · U\d+$/);
  await page.keyboard.press('m');
  await expect(status(page)).toHaveText('Floor map of Ground floor');
  await page.keyboard.press('c');
  await expect(status(page)).toHaveText('Cabling workspace');
});

test('the status line names the view shown', async ({ page }) => {
  await page.click('#btn-views');
  await page.click('#view-copy');
  await page.click('#dlg-views [data-close]');
  await page.keyboard.press('v');
  await expect(status(page)).toHaveText(/^View: /);
  const shown = await page.locator('#clusters-view').textContent();
  await expect(status(page)).toHaveText(`View: ${shown}`);
});
