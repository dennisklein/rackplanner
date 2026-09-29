'use strict';

const fs = require('node:fs');
const { test, expect } = require('@playwright/test');

// Every test starts from a fresh browser profile, so the example plan loads.
test.beforeEach(async ({ page }) => {
  // Keep the tests independent of the network; the app falls back to system fonts.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await page.goto('/index.html');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

const device = (page, name) => page.locator(`.scene .dev[aria-label^="${name},"]`);
const devices = (page) => page.locator('.scene .dev');
const where = (page) => page.locator('.insp-where');

/** Screen position of the centre of a device of `typeId` placed at `loc`. */
function spot(page, typeId, loc) {
  return page.evaluate(
    ({ typeId, loc }) => {
      const svg = document.querySelector('#scene');
      const box = svg.getBoundingClientRect();
      const zoom = box.width / svg.viewBox.baseVal.width;
      const racks = Array.from({ length: 5 }, (_, i) => ({ id: `r${i + 1}` }));
      const r = window.RP.render.locRect({ racks }, typeId, loc);
      return { x: box.left + (r.x + r.w / 2) * zoom, y: box.top + (r.y + r.h / 2) * zoom };
    },
    { typeId, loc }
  );
}

/** Starts dragging a device type from the parts bin and hovers `point`. */
async function dragPart(page, typeId, point) {
  const card = await page.locator(`.part[data-type="${typeId}"]`).boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + 20);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 + 40, card.y + 40, { steps: 3 });
  await page.mouse.move(point.x, point.y, { steps: 10 });
}

test('numbers units from U1 at the top', async ({ page }) => {
  await device(page, 'sw-mgmt-a01').click();
  await expect(where(page)).toHaveText('Rack A01 · U1');
  await device(page, 'cn-001').click();
  await expect(where(page)).toHaveText('Rack A01 · U4–5');
  const first = await device(page, 'cn-001').boundingBox();
  const second = await device(page, 'cn-002').boundingBox();
  expect(first.y).toBeLessThan(second.y);
});

test('places several devices by dragging from the parts bin', async ({ page }) => {
  await dragPart(page, 'compute-node', await spot(page, 'compute-node', { rack: 'r1', kind: 'u', at: 30 }));
  await expect(page.locator('#drag-chip')).toContainText('Rack A01 · U30–31');
  await page.mouse.up();

  await expect(page.locator('#dlg-place')).toBeVisible();
  await expect(page.locator('#place-name')).toHaveValue('cn-013');
  await expect(page.locator('input[name="place-cluster"][value="c-kestrel"]')).toBeChecked();
  await page.fill('#place-qty', '3');
  await expect(page.locator('#place-preview')).toHaveText('cn-013 … cn-015 · U30–35');
  await page.click('#place-submit');

  await expect(page.locator('#dlg-place')).toBeHidden();
  await expect(devices(page)).toHaveCount(40);
  await expect(where(page)).toHaveText('Rack A01 · U30–31');
});

test('Enter activates a focused button while a device is selected', async ({ page }) => {
  await device(page, 'cn-001').click();
  await page.locator('#insp-dup').focus();
  await page.keyboard.press('Enter');
  await expect(devices(page)).toHaveCount(38);
  await expect(page.locator('.toast').last()).toContainText('Added cn-013');

  // On the device itself, Enter still jumps to its name.
  await device(page, 'cn-002').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#insp-name')).toBeFocused();
  await expect(page.locator('#insp-name')).toHaveValue('cn-002');
});

test('rack count buttons add and remove racks, with undo', async ({ page }) => {
  const racks = page.locator('.rack-head');
  const count = (n) => page.locator(`#rack-count button[data-count="${n}"]`);
  await expect(count(3)).toHaveAttribute('aria-pressed', 'true');

  // Arrow keys don't change the count.
  await count(3).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expect(racks).toHaveCount(3);

  await count(5).click();
  await expect(racks).toHaveCount(5);
  await expect(count(5)).toHaveAttribute('aria-pressed', 'true');

  await count(1).click();
  await expect(page.locator('#confirm-title')).toHaveText('Remove 4 racks?');
  await page.click('#dlg-confirm button[value="cancel"]');
  await expect(racks).toHaveCount(5);

  await count(1).click();
  await page.click('#confirm-ok');
  await expect(racks).toHaveCount(1);
  await expect(devices(page)).toHaveCount(15);

  await page.keyboard.press('Control+z');
  await expect(racks).toHaveCount(5);
  await expect(devices(page)).toHaveCount(37);
});

test('asks before replacing an edited example, not an untouched one', async ({ page }) => {
  await page.click('#btn-new');
  await page.click('[data-new="empty"]');
  await expect(devices(page)).toHaveCount(0);
  await expect(page.locator('#dlg-confirm')).toBeHidden();

  await page.click('#btn-new');
  await page.click('[data-new="example"]');
  await expect(devices(page)).toHaveCount(37);
  await device(page, 'cn-001').click();
  await page.keyboard.press('Delete');
  await expect(devices(page)).toHaveCount(36);

  await page.click('#btn-start-empty');
  await expect(page.locator('#dlg-confirm')).toBeVisible();
  await page.click('#dlg-confirm button[value="cancel"]');
  await expect(devices(page)).toHaveCount(36);
});

test('dismissing the example notice is part of the undo history', async ({ page }) => {
  await device(page, 'cn-001').click();
  await page.keyboard.press('Delete');
  await page.click('#btn-keep-example');
  await expect(page.locator('#example-notice')).toBeHidden();

  await page.keyboard.press('Control+z');
  await expect(page.locator('#example-notice')).toBeVisible();
  await expect(devices(page)).toHaveCount(36);
  await page.keyboard.press('Control+z');
  await expect(devices(page)).toHaveCount(37);
});

test('a 4U device over a side slot is refused and its preview stays in the slot', async ({ page }) => {
  await dragPart(page, 'storage-node', await spot(page, 'switch-rj45', { rack: 'r1', kind: 'side', at: 1 }));
  await expect(page.locator('#drag-chip')).toContainText('Side slots take 1U devices only');
  const [width, slot] = await page.evaluate(() => [
    document.querySelector('#ghost-layer').getBBox().width,
    window.RP.render.geometry.SLOT_W,
  ]);
  expect(width).toBeLessThanOrEqual(slot + 3);
  await page.mouse.up();
  await expect(page.locator('#dlg-place')).toBeHidden();
  await expect(devices(page)).toHaveCount(37);
});

test('undo works right after picking a cluster', async ({ page }) => {
  await device(page, 'cn-001').click();
  await page.click('label.chip:has(input[name="insp-cluster"][value="c-osprey"]) span');
  await expect(device(page, 'cn-001')).toHaveAttribute('aria-label', /cluster Osprey GPU/);
  await page.keyboard.press('Control+z');
  await expect(device(page, 'cn-001')).toHaveAttribute('aria-label', /cluster Kestrel HPC/);
});

test('exports an SVG in fallback fonts and a PNG', async ({ page }) => {
  const exportFile = async (kind) => {
    const download = page.waitForEvent('download');
    await page.click('#btn-export');
    await page.click(`[data-export="${kind}"]`);
    return download;
  };
  const svg = await exportFile('svg');
  expect(svg.suggestedFilename()).toBe('hall-2-row-a.svg');
  const text = fs.readFileSync(await svg.path(), 'utf8');
  expect(text).toContain('<title>Hall 2, row A</title>');
  expect(text).not.toMatch(/Plex|Barlow/);

  const png = await exportFile('png');
  expect(png.suggestedFilename()).toBe('hall-2-row-a.png');
  expect(fs.statSync(await png.path()).size).toBeGreaterThan(50000);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('fits the screen and places a device by tapping', async ({ page }) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const offscreen = await page.evaluate(
      () =>
        [...document.querySelectorAll('.topbar button, .topbar input')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.left < 0 || r.right > window.innerWidth;
        }).length
    );
    expect(offscreen).toBe(0);

    await page.locator('.part[data-type="switch-qsfp"]').tap();
    await expect(page.locator('#armed-hint')).toBeVisible();
    await page.evaluate(() => document.querySelector('#stage').scrollIntoView({ block: 'start' }));
    const target = await spot(page, 'switch-qsfp', { rack: 'r1', kind: 'u', at: 30 });
    await page.touchscreen.tap(target.x, target.y);
    await expect(page.locator('#dlg-place')).toBeVisible();
    await expect(page.locator('#place-where')).toContainText('Rack A01 · U30');
  });
});
