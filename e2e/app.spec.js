'use strict';

const fs = require('node:fs');
const { test, expect } = require('@playwright/test');

// Every test starts from a fresh browser profile, so the example plan loads.
test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

const device = (page, name) => page.locator(`.scene .dev[aria-label^="${name},"]`);
const devices = (page) => page.locator('.scene .dev');
const racks = (page) => page.locator('.scene .rack-head');
const where = (page) => page.locator('.insp-where');
const planDevices = (page) => page.evaluate(() => window.RP.app.project().devices.length);

/** Screen position of the centre of a device of `typeId` placed at `loc` on the shown row. */
function spot(page, typeId, loc, height) {
  return page.evaluate(
    ({ typeId, loc, height }) => {
      const svg = document.querySelector('#scene');
      const box = svg.getBoundingClientRect();
      const zoom = box.width / svg.viewBox.baseVal.width;
      const r = window.RP.render.locRect(window.RP.app.project(), loc, typeId, height);
      return { x: box.left + (r.x + r.w / 2) * zoom, y: box.top + (r.y + r.h / 2) * zoom };
    },
    { typeId, loc, height }
  );
}

/** Starts dragging a device type from the parts bin and hovers `point`. */
async function dragPart(page, typeId, point) {
  const card = page.locator(`.part[data-type="${typeId}"]`);
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + 40, { steps: 3 });
  await page.mouse.move(point.x, point.y, { steps: 10 });
}

async function exportFile(page, kind) {
  const download = page.waitForEvent('download');
  await page.click('#btn-export');
  await page.click(`[data-export="${kind}"]`);
  return download;
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
  await expect(page.locator('.multi-title')).toHaveText('3 devices');
});

test('spreads new devices evenly across the racks of a row', async ({ page }) => {
  await dragPart(page, 'compute-node', await spot(page, 'compute-node', { rack: 'r1', kind: 'u', at: 30 }));
  await page.mouse.up();
  await page.fill('#place-qty', '6');
  await page.check('#place-spread');
  await expect(page.locator('#place-racks input:checked')).toHaveCount(3);
  await expect(page.locator('#place-preview')).toHaveText('cn-013 … cn-018 · A01 ×2, A02 ×2, A03 ×2');
  await page.click('#place-submit');
  await expect(devices(page)).toHaveCount(43);
  await device(page, 'cn-016').click();
  await expect(where(page)).toHaveText('Rack A02 · U38–39', { timeout: 2000 });
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

test('racks can be added, reordered, inserted and deleted, with undo', async ({ page }) => {
  await page.locator('.scene .add-rack').click();
  await expect(racks(page)).toHaveCount(4);
  await expect(page.locator('.toast').last()).toContainText('Added Rack A04');

  await page.locator('.rack-head[data-rack="r1"]').click();
  await expect(page.locator('#insp-rack-name')).toHaveValue('Rack A01');
  await page.click('[data-rack-act="right"]');
  await expect(racks(page).first()).toHaveAttribute('data-rack', 'r2');
  await page.click('[data-rack-act="insert-left"]');
  await expect(racks(page)).toHaveCount(5);
  await expect(racks(page).nth(1)).not.toHaveAttribute('data-rack', 'r1');

  await page.locator('.rack-head[data-rack="r1"]').click();
  await page.click('#insp-del-rack');
  await expect(page.locator('#confirm-title')).toHaveText('Delete Rack A01?');
  await page.click('#confirm-ok');
  await expect(racks(page)).toHaveCount(4);
  await expect(devices(page)).toHaveCount(37 - 15);

  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
  await expect(racks(page)).toHaveCount(3);
  await expect(devices(page)).toHaveCount(37);
  await expect(racks(page).first()).toHaveAttribute('data-rack', 'r1');
});

test('the row stepper asks before removing racks with devices', async ({ page }) => {
  await page.click('#btn-row');
  await page.click('[data-row-action="settings"]');
  await expect(page.locator('#insp-row-name')).toHaveValue('Row A');
  await page.click('#row-more');
  await expect(racks(page)).toHaveCount(4);
  await page.click('#row-less');
  await expect(racks(page)).toHaveCount(3);
  await page.click('#row-less');
  await expect(page.locator('#confirm-title')).toHaveText('Remove Rack A03?');
  await page.click('#confirm-ok');
  await expect(racks(page)).toHaveCount(2);
  await expect(devices(page)).toHaveCount(28);
  await page.keyboard.press('Control+z');
  await expect(devices(page)).toHaveCount(37);
});

test('navigates floors and rows and finds devices, racks and floors by search', async ({ page }) => {
  await page.click('.ftab:has-text("First floor")');
  await expect(page.locator('#row-label')).toHaveText('Row A');
  await expect(racks(page)).toHaveCount(2);
  await expect(page.locator('.rack-head').first()).toContainText('Rack 2A01');
  await expect(page.locator('#btn-row-next')).toBeDisabled();

  await page.locator('#scene').focus();
  await page.keyboard.press('[');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await expect(page.locator('.ftab[aria-pressed="true"]')).toHaveText('Ground floor');

  await page.keyboard.press('/');
  await expect(page.locator('#search')).toBeFocused();
  await page.keyboard.type('gpu-srv-05');
  await expect(page.locator('.sr-item')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('#insp-name')).toHaveValue('gpu-srv-05');
  await expect(where(page)).toHaveText('Rack B03 · U7–10');

  // Search from another row jumps back to the device's row.
  await page.click('.ftab:has-text("First floor")');
  await page.fill('#search', 'cn-004');
  await page.keyboard.press('Enter');
  await expect(page.locator('#row-label')).toHaveText('Row A');
  await expect(device(page, 'cn-004')).toHaveClass(/is-selected/);
  // Other devices are dimmed while the search is on; Escape clears it.
  await expect(device(page, 'cn-005')).toHaveAttribute('opacity', '0.2');
  await page.locator('#scene').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('#search')).toHaveValue('');
  await expect(device(page, 'cn-005')).not.toHaveAttribute('opacity', '0.2');

  await page.fill('#search', 'b02');
  await page.keyboard.press('Enter');
  await expect(page.locator('#insp-rack-name')).toHaveValue('Rack B02');

  await page.fill('#search', 'first');
  await expect(page.locator('.sr-group').first()).toContainText('Floors');
  await page.keyboard.press('Enter');
  await expect(page.locator('#floormap')).toBeVisible();
  await expect(page.locator('.fm-title h2')).toHaveText('First floor');
  await expect(page.locator('#insp-floor-name')).toHaveValue('First floor');
});

test('the floor map shows every row and opens a clicked rack', async ({ page }) => {
  await page.keyboard.press('m');
  await expect(page.locator('#floormap')).toBeVisible();
  await expect(page.locator('#scene')).toBeHidden();
  await expect(page.locator('.fm-row')).toHaveCount(2);
  await expect(page.locator('.fm-rack')).toHaveCount(6);

  await page.click('.fm-metric [data-metric="power"]');
  await expect(page.locator('.fm-rack[data-rack="r6"] .fm-val')).toHaveText('15.4 kW');

  await page.click('.fm-rack[data-rack="r5"]');
  await expect(page.locator('#scene')).toBeVisible();
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await expect(page.locator('#insp-rack-name')).toHaveValue('Rack B02');

  await page.click('.view-toggle [data-view="map"]');
  await page.click('[data-add-row]');
  await expect(page.locator('.fm-row')).toHaveCount(3);
  await expect(page.locator('.fm-row.is-current .fm-row-open')).toHaveText('Row C');
});

test('floors can be added and deleted', async ({ page }) => {
  await page.click('[data-add-floor]');
  await expect(page.locator('.ftab[data-floor]')).toHaveCount(3);
  await expect(page.locator('.ftab[aria-pressed="true"]')).toHaveText('Floor 3');
  await expect(racks(page)).toHaveCount(3);
  await page.click('.ftab[aria-pressed="true"]');
  await expect(page.locator('#insp-floor-name')).toHaveValue('Floor 3');
  await page.fill('#insp-floor-name', 'Basement');
  await expect(page.locator('.ftab[aria-pressed="true"]')).toHaveText('Basement');
  await page.click('#floor-del');
  await page.click('#confirm-ok');
  await expect(page.locator('.ftab[data-floor]')).toHaveCount(2);
});

test('a custom device type appears in the parts bin and can be placed', async ({ page }) => {
  await page.click('#btn-catalog');
  await page.click('#cat-new');
  await page.click('[data-template="0"]');
  await expect(page.locator('#cat-label')).toHaveValue('1U server');
  await page.fill('#cat-label', 'Edge box');
  await page.press('#cat-label', 'Tab');
  await page.fill('#cat-height', '3');
  await page.press('#cat-height', 'Tab');
  await page.selectOption('#cat-face', 'ups');
  await expect(page.locator('.cat-item[aria-selected="true"] .cat-sub')).toHaveText('3U · 10 bays');
  await page.click('#dlg-catalog [data-close]');

  const card = page.locator('.part:has-text("Edge box")');
  await expect(card).toBeVisible();
  const typeId = await card.getAttribute('data-type');
  await dragPart(page, typeId, await spot(page, typeId, { rack: 'r1', kind: 'u', at: 30 }));
  await expect(page.locator('#drag-chip')).toContainText('Rack A01 · U30–32');
  await page.mouse.up();
  await expect(page.locator('#place-title')).toHaveText('Edge box');
  await expect(page.locator('#place-name')).toHaveValue('srv-01');
  await page.click('#place-submit');
  await expect(devices(page)).toHaveCount(38);

  // A type in use refuses a height its devices can't take.
  await page.click('#btn-catalog');
  await page.click(`.cat-item[data-id="compute-node"]`);
  await page.fill('#cat-height', '3');
  await page.press('#cat-height', 'Tab');
  await expect(page.locator('#cat-error')).toContainText('does not fit');
  await expect(page.locator('#cat-height')).toHaveValue('2');
});

test('rack types set height and budgets; racks over budget are flagged', async ({ page }) => {
  await page.locator('.rack-head[data-rack="r1"]').click();
  await page.selectOption('#insp-rack-type', 'rack-42');
  await expect(page.locator('.rack-head[data-rack="r1"]')).toContainText('26/42 U');

  await page.click('#insp-rack-types');
  await expect(page.locator('#cat-tab-racks')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#cat-units')).toHaveValue('42');
  await page.fill('#cat-units', '20');
  await page.press('#cat-units', 'Tab');
  await expect(page.locator('#cat-error')).toContainText('would stick out below U20');
  await page.fill('#cat-rpower', '5');
  await page.press('#cat-rpower', 'Tab');
  await page.click('#dlg-catalog [data-close]');
  await expect(page.locator('.rack-head[data-rack="r1"]')).toContainText('9.1/5.0 kW !');
  await expect(page.locator('.meter.is-over')).toHaveCount(1);
  await page.keyboard.press('m');
  await page.click('.fm-metric [data-metric="power"]');
  await expect(page.locator('.fm-rack.is-over')).toHaveCount(1);
});

test('several devices can be selected and moved together', async ({ page }) => {
  await device(page, 'cn-001').click();
  await device(page, 'cn-002').click({ modifiers: ['Shift'] });
  await expect(page.locator('.multi-title')).toHaveText('2 devices');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.contents .u').first()).toHaveText('A01 U28–29');
  await page.keyboard.press('Control+z');

  // Drag the pair to another rack; both keep their spacing.
  const from = await device(page, 'cn-001').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  const to = await spot(page, 'compute-node', { rack: 'r3', kind: 'u', at: 30 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await expect(page.locator('#drag-chip')).toContainText('Move 2 devices');
  await page.mouse.up();
  await expect(page.locator('.contents .u')).toHaveText(['A03 U30–31', 'A03 U32–33']);

  // Shift-drag on the empty sheet selects an area; the cluster applies to all.
  await page.keyboard.press('Escape');
  const a = await device(page, 'gpu-001').boundingBox();
  const b = await device(page, 'gpu-003').boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(a.x - 30, a.y + 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 10, b.y + b.height - 2, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(page.locator('.multi-title')).toHaveText('3 devices');
  await page.click('label.chip:has(input[name="multi-cluster"][value="c-kestrel"]) span');
  await expect(device(page, 'gpu-002')).toHaveAttribute('aria-label', /cluster Kestrel HPC/);
  await page.fill('#multi-rename', 'gpu-101');
  await page.click('#multi-rename-go');
  await expect(device(page, 'gpu-103')).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(devices(page)).toHaveCount(34);
});

test('reserved space gets its own height and counts in the rack stats', async ({ page }) => {
  await dragPart(page, 'reserved', await spot(page, 'reserved', { rack: 'r1', kind: 'u', at: 30 }, 2));
  await page.mouse.up();
  await expect(page.locator('#place-height-field')).toBeVisible();
  await page.fill('#place-height', '20');
  await expect(page.locator('#place-preview')).toHaveText('A 20U device must sit within U1–47');
  await expect(page.locator('#place-submit')).toBeDisabled();
  await page.fill('#place-height', '6');
  await page.fill('#place-name', 'Future storage');
  await page.click('#place-submit');
  await expect(where(page)).toHaveText('Rack A01 · U30–35');
  await page.locator('.rack-head[data-rack="r1"]').click();
  await expect(page.locator('.stats div:has(dt:text("Reserved")) dd')).toHaveText('6 U');
  await expect(page.locator('.rack-head[data-rack="r1"]')).toContainText('32/47 U');
});

test('device fields are saved and found by search', async ({ page }) => {
  await device(page, 'cn-007').click();
  await page.fill('#insp-f-serial', 'SN-777');
  await page.fill('#insp-f-owner', 'Team Kestrel');
  await page.fill('#insp-power', '950');
  await page.press('#insp-power', 'Tab');
  await page.locator('#scene').focus();
  await page.keyboard.press('Escape');
  await page.fill('#search', 'sn-777');
  await expect(page.locator('.sr-item .sr-name')).toHaveText(['cn-007']);
  const csv = fs.readFileSync(await (await exportFile(page, 'csv')).path(), 'utf8');
  expect(csv).toContain('Ground floor,Row A,Rack A01,U16-17,2,Compute node,cn-007,Kestrel HPC,SN-777,,,Team Kestrel,950,25,');
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

test('plans are kept in the browser and can be switched', async ({ page }) => {
  await device(page, 'cn-001').click();
  await page.keyboard.press('Delete');
  await page.click('#btn-new');
  await page.click('[data-new="layout"]');
  await expect(devices(page)).toHaveCount(0);
  await expect(racks(page)).toHaveCount(3);
  await expect(page.locator('#plan-name')).toHaveValue('Hall 2 expansion (layout)');
  await page.fill('#plan-name', 'Hall 3');

  await page.reload();
  await expect(page.locator('#plan-name')).toHaveValue('Hall 3');
  await page.click('#btn-plans');
  await expect(page.locator('.plan-item')).toHaveCount(2);
  await page.click('.plan-item:has-text("Hall 2 expansion") [data-plan-act="open"]');
  await expect(devices(page)).toHaveCount(36);

  await page.click('#btn-plans');
  await page.click('.plan-item:has-text("Hall 3") [data-plan-act="del"]');
  await page.click('#confirm-ok');
  await expect(page.locator('.plan-item')).toHaveCount(1);
});

test('a share link opens the plan in another browser', async ({ page, browser }) => {
  await device(page, 'cn-001').click();
  await page.fill('#insp-name', 'shared-node');
  await page.click('#btn-export');
  await page.click('[data-export="share"]');
  const url = await page.locator('#share-url').inputValue();
  expect(url).toMatch(/#plan=z[\w-]+$/);

  const other = await browser.newContext();
  const page2 = await other.newPage();
  await page2.goto(url);
  await expect(page2.locator('.toast').first()).toContainText('Opened the shared plan Hall 2 expansion');
  await expect(page2.locator('.scene .dev[aria-label^="shared-node,"]')).toBeVisible();
  expect(new URL(page2.url()).hash).toBe('');
  await page2.click('#btn-plans');
  await expect(page2.locator('.plan-item')).toHaveCount(2, { timeout: 2000 });
  await other.close();
});

test('a CSV export opens as a new plan', async ({ page }) => {
  const csv = await exportFile(page, 'csv');
  expect(csv.suggestedFilename()).toBe('hall-2-expansion.csv');
  await page.click('#btn-open');
  const chooser = page.waitForEvent('filechooser');
  await page.click('#open-file');
  await (await chooser).setFiles({ name: 'Hall 2 inventory.csv', mimeType: 'text/csv', buffer: fs.readFileSync(await csv.path()) });
  await expect(page.locator('#dlg-report')).toBeVisible();
  await expect(page.locator('#report-list li')).toHaveCount(3);
  await page.click('#dlg-report button[value="ok"]');
  await expect(page.locator('#plan-name')).toHaveValue('Hall 2 inventory');
  expect(await planDevices(page)).toBe(65);
  await expect(page.locator('.ftab[data-floor]')).toHaveCount(2);
});

test('a plan file opens next to the current plan', async ({ page }) => {
  const json = await exportFile(page, 'json');
  const text = fs.readFileSync(await json.path(), 'utf8');
  await page.click('#btn-new');
  await page.click('[data-new="empty"]');
  await page.click('#btn-open');
  await page.fill('#open-text', text.replace('"Hall 2 expansion"', '"Pasted"'));
  await page.click('#open-form button[type="submit"]');
  await expect(page.locator('#plan-name')).toHaveValue('Pasted');
  await expect(devices(page)).toHaveCount(37);
  await expect(page.locator('#example-notice')).toBeHidden();
});

test('prints one sheet per row', async ({ page }) => {
  await page.evaluate(() => {
    window.print = () => {
      window.__sheets = document.querySelectorAll('#print-root .print-page').length;
      window.__page = document.querySelector('#print-page-style').textContent;
    };
  });
  await page.click('#btn-export');
  await page.click('[data-export="print"]');
  await page.check('input[name="print-scope"][value="all"]');
  await page.selectOption('#print-paper', 'A3');
  await page.click('#print-form button[type="submit"]');
  await expect.poll(() => page.evaluate(() => window.__sheets)).toBe(3);
  expect(await page.evaluate(() => window.__page)).toContain('size: A3 landscape');
});

test('a 4U device over a side slot is refused and its preview stays in the slot', async ({ page }) => {
  await dragPart(page, 'storage-node', await spot(page, 'switch-rj45', { rack: 'r1', kind: 'side', at: 1 }));
  await expect(page.locator('#drag-chip')).toContainText('Side slots take 1U devices only');
  const [width, slot] = await page.evaluate(() => [document.querySelector('#ghost-layer').getBBox().width, window.RP.render.geometry.SLOT_W]);
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

test('exports the shown row as SVG in fallback fonts and as PNG', async ({ page }) => {
  const svg = await exportFile(page, 'svg');
  expect(svg.suggestedFilename()).toBe('hall-2-expansion-ground-floor-row-a.svg');
  const text = fs.readFileSync(await svg.path(), 'utf8');
  expect(text).toContain('<title>Hall 2 expansion · Ground floor · Row A</title>');
  expect(text).not.toMatch(/Plex|Barlow/);

  const png = await exportFile(page, 'png');
  expect(png.suggestedFilename()).toBe('hall-2-expansion-ground-floor-row-a.png');
  expect(fs.statSync(await png.path()).size).toBeGreaterThan(50000);
});

test.describe('offline', () => {
  test.use({ serviceWorkers: 'allow' });

  test('loads nothing from other hosts and caches the app for offline use', async ({ page }) => {
    const external = [];
    page.on('request', (r) => {
      if (!r.url().startsWith('http://127.0.0.1')) external.push(r.url());
    });
    await page.reload();
    await expect(devices(page)).toHaveCount(37);
    expect(await page.evaluate(() => document.fonts.check('600 12px "IBM Plex Mono"'))).toBe(true);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cached = await page.evaluate(async () => {
      const keys = await (await caches.open('rackplanner-v3')).keys();
      return keys.map((r) => new URL(r.url).pathname);
    });
    expect(cached).toEqual(expect.arrayContaining(['/index.html', '/js/app.js', '/js/io.js', '/css/fonts.css', '/fonts/ibm-plex-mono-latin-600-normal.woff2']));
    expect(external).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('fits the screen and places a device by tapping', async ({ page }) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const offscreen = await page.evaluate(
      () =>
        [...document.querySelectorAll('.topbar button, .topbar input, .nav button')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width && (r.left < 0 || r.right > window.innerWidth);
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
