'use strict';

const { test, expect } = require('@playwright/test');

// Every test starts from a fresh browser profile, so the example plan loads.
test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

const device = (page, name) => page.locator(`.scene .dev[aria-label^="${name},"]`);
const devices = (page) => page.locator('.scene .dev');
const status = (page) => page.locator('#status');
const app = (page, fn, arg) => page.evaluate(fn, arg);

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

test('focus goes back to a menu’s button after a pick, and on where the work goes on', async ({ page }) => {
  await page.focus('#btn-theme');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#menu-theme')).toBeHidden();
  await expect(page.locator('#btn-theme')).toBeFocused();

  await page.focus('#btn-row');
  await page.keyboard.press('Enter');
  await page.locator('#menu-row [data-row="row2"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await expect(page.locator('#btn-row')).toBeFocused();

  // A dialog opened from a menu gives focus back to the menu's button.
  await page.focus('#btn-export');
  await page.keyboard.press('Enter');
  await page.locator('[data-export="print"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog[open]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#btn-export')).toBeFocused();

  // The last row disables Next row: the row picker takes focus.
  await page.focus('#btn-row-next');
  await page.keyboard.press('Enter');
  await expect(page.locator('#btn-row-next')).toBeDisabled();
  await expect(page.locator('#btn-row')).toBeFocused();
});

test('the row picker takes focus from a row button that the last row disables, also where the browser drops it at once', async ({ page }) => {
  // Some versions of Chromium move the focus of a button to the page as soon as it is disabled.
  await app(page, () => {
    const d = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'disabled');
    Object.defineProperty(HTMLButtonElement.prototype, 'disabled', {
      configurable: true,
      get: d.get,
      set(v) {
        d.set.call(this, v);
        if (v && document.activeElement === this) this.blur();
      },
    });
  });
  await page.focus('#btn-row-next');
  await page.keyboard.press('Enter');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await expect(page.locator('#btn-row-next')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#btn-row-next')).toBeDisabled();
  await expect(page.locator('#btn-row')).toBeFocused();
  await page.focus('#btn-row-prev');
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  await expect(page.locator('#btn-row-prev')).toBeDisabled();
  await expect(page.locator('#btn-row')).toBeFocused();

  // [ and ] typed with the focus elsewhere leave it there.
  await page.focus('#btn-theme');
  await page.keyboard.press(']');
  await page.keyboard.press(']');
  await expect(page.locator('#btn-row-next')).toBeDisabled();
  await expect(page.locator('#btn-theme')).toBeFocused();
});

test('a rack opened from the floor map or the overview takes focus in its name field', async ({ page }) => {
  await page.keyboard.press('m');
  await page.locator('.fm-rack[data-rack="r5"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#scene')).toBeVisible();
  await expect(page.locator('#insp-rack-name')).toBeFocused();
  await expect(page.locator('#insp-rack-name')).toHaveValue('Rack B02');

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('.rack-bar[data-rack="r4"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#insp-rack-name')).toBeFocused();
  await expect(page.locator('#insp-rack-name')).toHaveValue('Rack B01');
});

test('C keeps keyboard focus on the drawing', async ({ page }) => {
  await device(page, 'cn-001').focus();
  await page.keyboard.press('c');
  await expect(page.locator('.ws-switch [data-workspace="cabling"]')).toHaveAttribute('aria-pressed', 'true');
  const inStage = () => app(page, () => document.querySelector('#canvas').contains(document.activeElement));
  expect(await inStage()).toBe(true);
  await page.keyboard.press('c');
  await expect(page.locator('.ws-switch [data-workspace="racks"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await inStage()).toBe(true);
});

test('rack labels are buttons in the Tab order that open the rack', async ({ page }) => {
  const head = page.locator('.rack-head[data-rack="r1"]');
  await expect(head).toHaveAttribute('role', 'button');
  await expect(head).toHaveAttribute('aria-label', /^Rack A01, \d+ of 47 U used, [\d.]+ of [\d.]+ kW$/);
  await head.focus();
  await page.keyboard.press('Tab');
  await expect(device(page, 'sw-mgmt-a01')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(head).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#insp-rack-name')).toHaveValue('Rack A01');
  await expect(head).toBeFocused();
});

test('a device is placed with the keyboard: Enter on a type opens the place dialog at the first free slot', async ({ page }) => {
  await page.click('#btn-start-empty');
  await expect(devices(page)).toHaveCount(0);
  const card = page.locator('.part[data-type="compute-node"]');
  await expect(card).toHaveAttribute('aria-label', /Press Enter to choose a slot/);
  await card.focus();
  await page.keyboard.press('Enter');

  await expect(page.locator('#dlg-place')).toBeVisible();
  await expect(page.locator('#place-name')).toBeFocused();
  await expect(page.locator('#place-rack')).toHaveValue('r1');
  await expect(page.locator('#place-pos option:checked')).toHaveText('U1–2');
  await expect(page.locator('#place-where')).toContainText('Rack A01 · U1–2');

  // Another rack takes its free slot nearest to the one picked; the position is any free one.
  await page.selectOption('#place-rack', 'r2');
  await expect(page.locator('#place-pos option:checked')).toHaveText('U1–2');
  await expect(page.locator('#place-spread-wrap')).toBeVisible();
  await page.selectOption('#place-pos', 'u:10');
  await expect(page.locator('#place-where')).toContainText('Rack A02 · U10–11');
  await page.focus('#place-qty');
  await page.fill('#place-qty', '2');
  await expect(page.locator('#place-preview')).toContainText('U10–13');
  await page.keyboard.press('Enter');

  await expect(page.locator('#dlg-place')).toBeHidden();
  await expect(devices(page)).toHaveCount(2);
  const locs = await app(page, () => window.RP.app.project().devices.map((d) => `${d.loc.rack} ${d.loc.at}`));
  expect(locs).toEqual(['r2 10', 'r2 12']);
  await expect(card).toBeFocused();
});

test('Enter on a type of side-slot devices opens the place dialog at a free side slot', async ({ page }) => {
  await page.locator('.part[data-type="pdu"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#dlg-place')).toBeVisible();
  await expect(page.locator('#place-rack')).toHaveValue('r1');
  await expect(page.locator('#place-pos option:checked')).toHaveText('Side slot V2');
  await expect(page.locator('#place-where')).toContainText('Rack A01 · side slot V2');
});

test('with a type armed, Enter places it in the rack of the focused label', async ({ page }) => {
  await page.click('.part[data-type="compute-node"]');
  await expect(page.locator('#armed-hint')).toContainText('or press Enter to choose one');
  await page.locator('.rack-head[data-rack="r2"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#dlg-place')).toBeVisible();
  await expect(page.locator('#place-rack')).toHaveValue('r2');
  const first = await app(page, () => {
    const M = window.RP.model;
    const p = window.RP.app.project();
    return M.formatPosition(p, M.firstFreeLoc(p, 'compute-node', ['r2']), 'compute-node');
  });
  await expect(page.locator('#place-pos option:checked')).toHaveText(first);
  await expect(page.locator('#armed-hint')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#dlg-place')).toBeHidden();
});

test('a full plan says so instead of opening the place dialog', async ({ page }) => {
  await page.click('#btn-start-empty');
  await app(page, () => {
    const p = window.RP.app.project();
    for (const r of p.floors[0].rows[0].racks) p.devices.push(window.RP.model.newDevice({ type: 'reserved', name: 'full', height: 47, loc: { rack: r.id, kind: 'u', at: 1 } }));
  });
  await page.locator('.part[data-type="compute-node"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#dlg-place')).toBeHidden();
  await expect(page.locator('.toast.warn')).toHaveText('No rack has room for a compute node');
});

test('? and the help button open the how-tos and every shortcut of the workspace shown', async ({ page }) => {
  await expect(page.locator('#example-notice a')).toHaveAttribute('href', 'media/');
  await page.keyboard.press('?');
  const help = page.locator('#dlg-help');
  await expect(help).toBeVisible();
  await expect(page.locator('#help-title')).toHaveText('Racks: how-tos and shortcuts');
  await expect(help.locator('.howto dt').first()).toHaveText('Place a device');
  await expect(help.locator('.keys')).toContainText('Rename the selected device');
  await expect(help.locator('.keys')).toContainText('Bare devices');
  await expect(help.locator('a[href="media/"]')).toHaveText('Watch the 50-second intro video');
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  // A question mark typed in a field is just text.
  await page.focus('#search');
  await page.keyboard.press('?');
  await expect(help).toBeHidden();
  await expect(page.locator('#search')).toHaveValue('?');
  await page.keyboard.press('Escape');

  await page.click('.ws-switch [data-workspace="cabling"]');
  await page.click('#btn-help');
  await expect(page.locator('#help-title')).toHaveText('Cabling: how-tos and shortcuts');
  await expect(help.locator('.keys')).toContainText('Connect a breakout cable with the legs set so far');
  await expect(help.locator('.keys')).not.toContainText('Bare devices');
  await page.click('#dlg-help button[value="ok"]');
  await expect(help).toBeHidden();
  await expect(page.locator('#btn-help')).toBeFocused();
});
