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

/** The top of the stage on the screen, rounded, for expect.poll. */
const stageTop = (page) => () => page.evaluate(() => Math.round(document.querySelector('#stage').getBoundingClientRect().top));

/** Swipes a finger from (`x`, `y`) by `dy` pixels, as a phone's browser scrolls it. */
async function swipe(page, x, y, dy) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let k = 1; k <= 10; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * k) / 10 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(300);
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

test('the place preview shows the blocks devices split into, and ghosts them around the dialog', async ({ page }) => {
  await dragPart(page, 'compute-node', await spot(page, 'compute-node', { rack: 'r2', kind: 'u', at: 20 }));
  await page.mouse.up();
  await expect(page.locator('#dlg-place')).toBeVisible();
  await expect(page.locator('#ghost-layer g[transform]')).toHaveCount(1);
  await page.fill('#place-qty', '4');
  await expect(page.locator('#place-preview')).toHaveText('gpu-009 … gpu-012 · U20–23, U36–39 · skips ceph-01 … ceph-03');
  await expect(page.locator('#ghost-layer g[transform]')).toHaveCount(4);
  // The dialog moves off the rack, so the ghosts are in sight.
  const ghosts = await page.locator('#ghost-layer').boundingBox();
  const dialog = await page.locator('#dlg-place').boundingBox();
  expect(dialog.x >= ghosts.x + ghosts.width || dialog.x + dialog.width <= ghosts.x).toBe(true);
  await page.click('#dlg-place [data-close]');
  await expect(page.locator('#ghost-layer g[transform]')).toHaveCount(0);
});

test('the place dialog follows the Rack field with the name and the cluster, until a cluster is picked', async ({ page }) => {
  await dragPart(page, 'compute-node', await spot(page, 'compute-node', { rack: 'r2', kind: 'u', at: 20 }));
  await page.mouse.up();
  await expect(page.locator('#place-name')).toHaveValue('gpu-009');
  await expect(page.locator('input[name="place-cluster"][value="c-osprey"]')).toBeChecked();
  await page.selectOption('#place-rack', 'r1');
  await expect(page.locator('#place-name')).toHaveValue('cn-013');
  await expect(page.locator('input[name="place-cluster"][value="c-kestrel"]')).toBeChecked();
  // A cluster picked stays.
  await page.locator('input[name="place-cluster"][value="c-osprey"]').check({ force: true });
  await page.selectOption('#place-rack', 'r2');
  await expect(page.locator('#place-name')).toHaveValue('gpu-009');
  await expect(page.locator('input[name="place-cluster"][value="c-osprey"]')).toBeChecked();
  await page.selectOption('#place-rack', 'r1');
  await expect(page.locator('input[name="place-cluster"][value="c-osprey"]')).toBeChecked();
});

test('several side-slot devices fill the free side slots, in the rack or spread over the row', async ({ page }) => {
  await dragPart(page, 'pdu', await spot(page, 'pdu', { rack: 'r2', kind: 'side', at: 0 }));
  await page.mouse.up();
  await expect(page.locator('#dlg-place')).toBeVisible();
  await expect(page.locator('#place-name')).toHaveValue('pdu-a02-a');
  await expect(page.locator('#place-dir-field')).toBeHidden();
  await page.fill('#place-qty', '2');
  await expect(page.locator('#place-preview')).toHaveText('pdu-a02-a … pdu-a02-b · Side slots V1, V2');
  await page.fill('#place-qty', '3');
  await expect(page.locator('#place-preview')).toHaveText('Only 2 side slots are free in this rack.');
  await expect(page.locator('#place-submit')).toBeDisabled();
  // Spread over Row A: A01 and A03 have one free side slot each.
  await page.check('#place-spread');
  await page.locator('#place-racks input[value="r1"]').check({ force: true });
  await page.fill('#place-qty', '4');
  await expect(page.locator('#place-preview')).toHaveText('pdu-a01-a … pdu-a03-a · A01 ×1, A02 ×2, A03 ×1');
  await expect(page.locator('#ghost-layer g[transform]')).toHaveCount(4);
  await page.click('#place-submit');
  await expect(page.locator('#dlg-place')).toBeHidden();
  const placed = await page.evaluate(() =>
    window.RP.app
      .project()
      .devices.filter((d) => d.type === 'pdu' && d.loc.rack[1] < '4')
      .map((d) => `${d.name} ${d.loc.rack} ${d.loc.kind} ${d.loc.at}`)
  );
  expect(placed.sort()).toEqual(['pdu-a01-a r1 side 1', 'pdu-a02-a r2 side 0', 'pdu-a02-b r2 side 1', 'pdu-a03-a r3 side 1']);
});

test('names other devices have are flagged, with a free series to use instead', async ({ page }) => {
  await dragPart(page, 'compute-node', await spot(page, 'compute-node', { rack: 'r1', kind: 'u', at: 32 }));
  await page.mouse.up();
  await page.fill('#place-name', 'cn-001');
  await page.fill('#place-qty', '3');
  const note = page.locator('#place-dup');
  await expect(note).toHaveText('Other devices are named cn-001 … cn-003. Use cn-013 … cn-015');
  // Placing them asks first.
  await page.click('#place-submit');
  await expect(page.locator('#dlg-confirm')).toBeVisible();
  await expect(page.locator('#confirm-title')).toHaveText('Use cn-001 … cn-003 twice?');
  await page.click('#dlg-confirm button[value="cancel"]');
  await expect(page.locator('#dlg-place')).toBeVisible();
  expect(await planDevices(page)).toBe(65);
  await note.locator('button').click();
  await expect(page.locator('#place-name')).toHaveValue('cn-013');
  await expect(note).toBeHidden();
  await page.click('#place-submit');
  await expect(page.locator('#dlg-place')).toBeHidden();
  expect(await planDevices(page)).toBe(68);

  // Rename in series counts the devices renamed as free, and its toast can undo.
  await device(page, 'cn-009').click();
  await device(page, 'cn-010').click({ modifiers: ['Shift'] });
  await page.fill('#multi-rename', 'cn-001');
  await expect(page.locator('#multi-rename-dup')).toHaveText('Other devices are named cn-001, cn-002. Use cn-016, cn-017');
  await page.fill('#multi-rename', 'cn-009');
  await expect(page.locator('#multi-rename-dup')).toBeHidden();
  await page.fill('#multi-rename', 'cn-001');
  await page.click('#multi-rename-go');
  await page.click('#confirm-ok');
  const toast = page.locator('.toast').last();
  await expect(toast).toContainText('Renamed cn-001 … cn-002');
  await toast.locator('button', { hasText: 'Undo' }).click();
  await expect(device(page, 'cn-009')).toHaveCount(1);

  // The inspector flags a taken name as it is typed.
  await device(page, 'cn-009').click();
  await page.fill('#insp-name', 'cn-002');
  await expect(page.locator('#insp-name-dup')).toHaveText('Another device is named cn-002. Use cn-016');
  await page.locator('#insp-name-dup button').click();
  await expect(page.locator('#insp-name')).toHaveValue('cn-016');
  await expect(page.locator('#insp-name-dup')).toBeHidden();
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

test('a new device is in no cluster unless one of its type shows which', async ({ page }) => {
  await page.click('#btn-start-empty');
  const open = async (typeId) => {
    await page.locator(`.part[data-type="${typeId}"]`).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#dlg-place')).toBeVisible();
  };
  const picked = page.locator('input[name="place-cluster"]:checked');
  await open('switch-rj45');
  await expect(picked).toHaveValue('');
  await expect(page.locator('#place-new')).toBeHidden();
  await page.click('label.chip:has(input[name="place-cluster"][value="__new"]) span');
  await page.fill('#place-new-name', 'Core');
  await page.click('#place-submit');

  // Another type does not follow the cluster used last; the same type follows its own.
  await open('compute-node');
  await expect(picked).toHaveValue('');
  await page.click('#dlg-place [data-close]');
  await open('switch-rj45');
  await expect(picked).not.toHaveValue('');
  await expect(page.locator('label.chip:has(input[name="place-cluster"]:checked)')).toHaveText('Core');
  await page.click('#dlg-place [data-close]');

  // With no device of its type left, the cluster last given to the type.
  await page.keyboard.press('Delete');
  expect(await planDevices(page)).toBe(0);
  await open('switch-rj45');
  await expect(page.locator('label.chip:has(input[name="place-cluster"]:checked)')).toHaveText('Core');
});

test('the place dialog mounts a switch with its ports at the rear, as the servers have theirs', async ({ page }) => {
  const open = async (typeId) => {
    await page.locator(`.part[data-type="${typeId}"]`).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#dlg-place')).toBeVisible();
  };
  const reversed = () => page.evaluate(() => window.RP.app.project().devices.map((d) => d.reversed));
  const checked = page.locator('#place-mount label:has(input:checked)');
  // A type without ports keeps Front to front | Back to front; reserved space has neither.
  await open('patch-panel');
  await expect(page.locator('#place-mount-label')).toHaveText('Mounted');
  await expect(checked).toHaveText('Front to front');
  await page.click('#dlg-place [data-close]');
  await open('reserved');
  await expect(page.locator('#place-mount')).toBeEmpty();
  await page.click('#dlg-place [data-close]');

  await page.click('#btn-start-empty');
  await open('switch-rj45');
  await expect(page.locator('#place-mount-label')).toHaveText('Ports at');
  await expect(checked).toHaveText('Rear');
  await page.click('#place-submit');
  await open('compute-node');
  await expect(checked).toHaveText('Rear');
  await page.click('#place-mount label:has-text("Front")');
  await page.click('#place-submit');
  expect(await reversed()).toEqual([true, true]);
  // The inspector asks the same way.
  await expect(page.locator('#insp-mount-label')).toHaveText('Ports at');
  await expect(page.locator('#inspector .seg label:has(input:checked)')).toHaveText('Front');
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

test('the address names the row, the floor map and the workspace; Back and Forward go through them', async ({ page }) => {
  const hash = () => new URL(page.url()).hash;
  await expect.poll(hash).toBe('#row=row1');
  await page.keyboard.press(']');
  await expect.poll(hash).toBe('#row=row2');
  await page.keyboard.press('m');
  await expect.poll(hash).toBe('#row=row2&view=map');
  await page.keyboard.press('c');
  await expect.poll(hash).toBe('#row=row2&view=map&ws=cabling');

  await page.goBack();
  await expect(page.locator('.ws-switch [data-workspace="racks"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#floormap')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#floormap')).toBeHidden();
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await page.goBack();
  await expect(page.locator('#row-label')).toHaveText('Row A');
  await page.goForward();
  await expect(page.locator('#row-label')).toHaveText('Row B');

  // An address opens there; a row the plan does not have opens the row it remembers.
  await page.goto('/index.html#row=row3&ws=cabling');
  await page.reload();
  await expect(page.locator('.ftab[aria-pressed="true"]')).toHaveText('First floor');
  await expect(page.locator('.ws-switch [data-workspace="cabling"]')).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/index.html#row=nowhere');
  await expect.poll(hash).toBe('#row=row3&ws=cabling');
});

test('the floor map shows every row and opens a clicked rack', async ({ page }) => {
  await page.keyboard.press('m');
  await expect(page.locator('#floormap')).toBeVisible();
  await expect(page.locator('#scene')).toBeHidden();
  await expect(page.locator('.fm-row')).toHaveCount(2);
  await expect(page.locator('.fm-rack')).toHaveCount(6);

  await page.click('.fm-metric [data-metric="power"]');
  await expect(page.locator('.fm-rack[data-rack="r6"] .fm-val')).toHaveText('15.9 kW');

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

  // Clicking another type right after editing a field selects it.
  await page.click('#btn-catalog');
  await page.click(`.cat-item[data-id="${typeId}"]`);
  await page.fill('#cat-power', '123');
  await page.click('.cat-item[data-id="storage-node"]');
  await expect(page.locator('#cat-label')).toHaveValue('Storage node');
  await page.click(`.cat-item[data-id="${typeId}"]`);
  await expect(page.locator('#cat-power')).toHaveValue('123');

  // A type in use refuses a height its devices can't take.
  await page.click(`.cat-item[data-id="compute-node"]`);
  await page.fill('#cat-height', '3');
  await page.press('#cat-height', 'Tab');
  await expect(page.locator('#cat-error')).toContainText('does not fit');
  await expect(page.locator('#cat-height')).toHaveValue('2');
});

test('names left empty fall back to a default; title block fields are one undo step', async ({ page }) => {
  await page.fill('#plan-name', '');
  await page.press('#plan-name', 'Enter');
  await expect(page.locator('#plan-name')).toHaveValue('Untitled rack plan');

  await page.locator('.rack-head[data-rack="r2"]').click();
  await page.fill('#insp-rack-name', '');
  await page.press('#insp-rack-name', 'Enter');
  await expect(page.locator('#insp-rack-name')).toHaveValue('Rack A02');
  await page.click('#btn-row');
  await page.click('[data-row-action="settings"]');
  await page.fill('#insp-row-name', '');
  await page.press('#insp-row-name', 'Enter');
  await expect(page.locator('#insp-row-name')).toHaveValue('Row A');
  await expect(page.locator('#row-label')).toHaveText('Row A');
  await page.locator('.ftab[aria-pressed="true"]').click();
  await page.fill('#insp-floor-name', ' ');
  await page.press('#insp-floor-name', 'Enter');
  await expect(page.locator('#insp-floor-name')).toHaveValue('Floor 1');
  await device(page, 'cn-001').click();
  await page.fill('#insp-name', '');
  await page.press('#insp-name', 'Enter');
  await expect(page.locator('#insp-name')).not.toHaveValue('');

  await page.keyboard.press('Escape');
  await page.fill('#info-site', 'Hall 9');
  await page.press('#info-site', 'Enter');
  await expect(page.locator('.scene')).toContainText('Hall 9 · Floor 1 · Row A');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.scene')).toContainText('Hall 2 · Floor 1 · Row A');
});

test('a rack can be emptied and a device type copied, with undo', async ({ page }) => {
  await page.locator('.rack-head[data-rack="r1"]').click();
  await page.click('#insp-clear-rack');
  await page.click('#confirm-ok');
  await expect(devices(page)).toHaveCount(37 - 15);
  await expect(page.locator('#insp-clear-rack')).toBeDisabled();
  await page.keyboard.press('Control+z');
  await expect(devices(page)).toHaveCount(37);

  await page.click('#btn-catalog');
  await page.click('.cat-item[data-id="storage-node"]');
  await page.click('#cat-new');
  await page.click('[data-template="copy"]');
  await expect(page.locator('#cat-label')).toHaveValue('Storage node 2');
  await expect(page.locator('#cat-height')).toHaveValue('4');
  await page.click('#dlg-catalog [data-close]');
  await expect(page.locator('.part:has-text("Storage node 2")')).toBeVisible();
});

test('the closed place dialog ignores the browser’s own undo', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await dragPart(page, 'pdu', await spot(page, 'pdu', { rack: 'r1', kind: 'u', at: 30 }));
  await page.mouse.up();
  await page.fill('#place-name', 'xyz');
  await page.keyboard.press('Escape');
  await page.click('#btn-new');
  await page.click('[data-new="empty"]');
  await page.click('#plan-name');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  expect(errors).toEqual([]);
});

test('a new device type is scrolled into view in the type list', async ({ page }) => {
  await page.click('#btn-catalog');
  await page.click('#cat-new');
  await page.click('[data-template="4"]');
  await expect(page.locator('#cat-label')).toHaveValue('UPS');
  const list = await page.locator('#cat-list').boundingBox();
  const item = await page.locator('#cat-list .cat-item[aria-selected="true"]').boundingBox();
  expect(item.y).toBeGreaterThanOrEqual(list.y);
  expect(item.y + item.height).toBeLessThanOrEqual(list.y + list.height + 0.5);
});

test('device and rack types can be reordered in the catalog', async ({ page }) => {
  const parts = page.locator('.part');
  const items = page.locator('#cat-list .cat-item');
  await page.click('#btn-catalog');

  // Drag the storage enclosure to the top; the devices panel follows.
  const src = await items.filter({ hasText: 'Storage enclosure' }).boundingBox();
  const top = await items.first().boundingBox();
  await page.mouse.move(src.x + 20, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(top.x + 20, top.y + 10, { steps: 8 });
  await expect(items.first()).toHaveClass(/drop-before/);
  await page.mouse.up();
  await expect(items.first()).toContainText('Storage enclosure');
  await expect(items.first()).toHaveAttribute('aria-selected', 'true');
  await expect(parts.first()).toHaveAttribute('data-type', 'storage-enclosure');

  // Keyboard: arrows walk the list, Alt+arrows move the focused type.
  await items.first().focus();
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(items.nth(2)).toContainText('Storage enclosure');
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#cat-label')).toHaveValue('24-port switch');

  // Rack types: the first one is used for new rows.
  await page.click('#cat-tab-racks');
  await page.click('[data-cat-move="1"]');
  await expect(items.nth(0)).toContainText('42U rack');
  await expect(items.nth(1)).toContainText('47U rack');
  await expect(page.locator('[data-cat-move="-1"]')).toBeEnabled();
  await page.click('#dlg-catalog [data-close]');
  await page.click('[data-add-floor]');
  await expect(page.locator('.rack-head').first()).toContainText('/42 U');

  for (let i = 0; i < 5; i++) await page.keyboard.press('Control+z');
  await expect(parts.first()).toHaveAttribute('data-type', 'switch-rj45');
  expect(await page.evaluate(() => window.RP.app.project().rackTypes.map((t) => t.id))).toEqual(['rack-47', 'rack-42', 'rack-48']);
});

test('the compact device list shows most types on a laptop screen, and is kept', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const inView = () =>
    page.evaluate(() => {
      const list = document.querySelector('#parts').getBoundingClientRect();
      return [...document.querySelectorAll('#parts .part')].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.top >= list.top - 0.5 && r.bottom <= list.bottom + 0.5;
      }).length;
    });
  expect(await inView()).toBeLessThan(4);
  await page.click('#btn-parts-compact');
  await expect(page.locator('#btn-parts-compact')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#parts .part-art').first()).toBeHidden();
  expect(await inView()).toBeGreaterThanOrEqual(6);
  await page.reload();
  await expect(page.locator('#btn-parts-compact')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#parts')).toHaveClass(/is-compact/);
  // A compact card still places its type.
  await page.locator('.part[data-type="compute-node"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#dlg-place')).toBeVisible();
});

test('the edge above the Clusters list shares the panel out, and is kept', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const parts = async () => (await page.locator('#parts').boundingBox()).height;
  const start = await parts();
  const bar = page.locator('#racks-clusters-sec .bin-split');
  const box = await bar.boundingBox();
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 120, { steps: 5 });
  await page.mouse.up();
  const dragged = await parts();
  expect(dragged).toBeGreaterThan(start + 100);
  // The clusters keep a few rows in sight, however far it goes.
  expect((await page.locator('#clusters').boundingBox()).height).toBeGreaterThanOrEqual(50);
  await page.reload();
  expect(await parts()).toBe(dragged);
  // The arrow keys move it too; a double-click gives the lists their own heights again.
  await bar.focus();
  await page.keyboard.press('ArrowUp');
  expect(await parts()).toBeLessThan(dragged);
  await bar.dblclick();
  expect(await parts()).toBe(start);
});

test('tall device types fit their card in the parts panel', async ({ page }) => {
  await page.click('#btn-catalog');
  await page.click('#cat-new');
  await page.click('[data-template="1"]');
  await page.fill('#cat-height', '12');
  await page.press('#cat-height', 'Tab');
  await page.click('#dlg-catalog [data-close]');
  for (const card of await page.locator('.part').all()) {
    const [art, svg, box] = await Promise.all(['.part-art', '.part-art svg', ':scope'].map((sel) => card.locator(sel).first().boundingBox()));
    expect(svg.y + svg.height).toBeLessThanOrEqual(art.y + art.height + 0.5);
    expect(svg.x + svg.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
});

test('a placement over a rack’s power budget is shown in amber before and said after', async ({ page }) => {
  await dragPart(page, 'gpu-server', await spot(page, 'gpu-server', { rack: 'r1', kind: 'u', at: 30 }));
  const chip = page.locator('#drag-chip');
  await expect(chip).toHaveClass(/warn/);
  await expect(chip).toContainText('U30–33 · over budget: Rack A01 at 12.1 kW of 12.0 kW');
  await expect(page.locator('#ghost-layer rect[stroke="#d98a00"]')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('#place-budget')).toHaveText('Over budget: Rack A01 will be at 12.1 kW of 12.0 kW');
  await page.click('#place-submit');
  const note = page.locator('.toast').last();
  await expect(note).toContainText('· over budget: Rack A01 is at 12.1 kW of 12.0 kW');
  await expect(note).toHaveClass(/warn/);

  // Within the budget, the chip is green and the dialog says nothing.
  await dragPart(page, 'compute-node', await spot(page, 'compute-node', { rack: 'r3', kind: 'u', at: 40 }));
  await expect(chip).toHaveClass(/ok/);
  await page.mouse.up();
  await expect(page.locator('#place-budget')).toBeHidden();
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
  // They take cables with them, so Delete asks first.
  await page.keyboard.press('Delete');
  await page.click('#confirm-ok');
  await expect(devices(page)).toHaveCount(34);
});

test('duplicates several devices, racks, rows and floors', async ({ page }) => {
  // Two devices: copied as a block below them, with names continuing the series.
  await device(page, 'cn-001').click();
  await device(page, 'cn-002').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+d');
  await expect(devices(page)).toHaveCount(39);
  await expect(page.locator('.multi-title')).toHaveText('2 devices');
  await expect(page.locator('.contents .nm')).toHaveText(['cn-013', 'cn-014']);
  await expect(page.locator('.contents .u')).toHaveText(['A01 U28–29', 'A01 U30–31']);
  await page.click('#multi-dup');
  await expect(devices(page)).toHaveCount(41);
  await expect(page.locator('.contents .nm')).toHaveText(['cn-015', 'cn-016']);

  // A rack: the copy with its devices lands right after it.
  await page.locator('.rack-head[data-rack="r2"]').click();
  await page.keyboard.press('Control+d');
  await expect(racks(page)).toHaveCount(4);
  await expect(racks(page).nth(2)).toContainText('Rack A04');
  await expect(page.locator('#insp-rack-name')).toHaveValue('Rack A04');
  await expect(devices(page)).toHaveCount(41 + 13);
  await expect(device(page, 'gpu-009')).toBeVisible();
  await page.click('#insp-dup-rack');
  await expect(racks(page)).toHaveCount(5);

  // A row and a floor.
  await page.click('#btn-row');
  await page.click('[data-row-action="settings"]');
  await page.click('#row-dup');
  await expect(page.locator('#row-label')).toHaveText('Row C');
  await expect(racks(page)).toHaveCount(5);
  await page.click('.ftab:has-text("First floor")');
  await page.click('.ftab:has-text("First floor")');
  await page.keyboard.press('Control+d');
  await expect(page.locator('.ftab[aria-pressed="true"]')).toHaveText('First floor (copy)');
  await expect(page.locator('.rack-head').first()).toContainText('Rack 3A01');

  for (let i = 0; i < 6; i++) await page.keyboard.press('Control+z');
  expect(await planDevices(page)).toBe(65);
});

test('a copy of a side-slot device goes to a side slot, in the next rack when its own are full', async ({ page }) => {
  await dragPart(page, 'pdu', await spot(page, 'pdu', { rack: 'r1', kind: 'side', at: 1 }));
  await page.mouse.up();
  await expect(page.locator('#place-name')).toHaveValue('pdu-a01-a');
  await page.click('#place-submit');
  await device(page, 'pdu-a01-a').click();
  await page.keyboard.press('Control+d');
  await expect(page.locator('.toast').last()).toContainText('Added pdu-a02-a at Rack A02 · side slot V1');

  // With every side slot taken, no copy goes into the rack units.
  await page.evaluate(() => {
    const M = window.RP.model;
    const p = window.RP.app.project();
    for (const { rack } of M.allRacks(p)) {
      for (let at = 0; at < M.rackSideSlots(p, rack.id); at++) {
        if (!p.devices.some((d) => d.loc.rack === rack.id && d.loc.kind === 'side' && d.loc.at === at)) {
          p.devices.push(M.newDevice({ type: 'pdu', name: `pdu-${rack.id}-${at}`, loc: { rack: rack.id, kind: 'side', at } }));
        }
      }
    }
  });
  const before = await planDevices(page);
  await device(page, 'pdu-a01-a').click();
  await page.keyboard.press('Control+d');
  await expect(page.locator('.toast').last()).toHaveText('No side slot is free for a copy of pdu-a01-a');
  expect(await planDevices(page)).toBe(before);
});

test('reserved space gets its own height and counts in the rack stats', async ({ page }) => {
  await dragPart(page, 'reserved', await spot(page, 'reserved', { rack: 'r1', kind: 'u', at: 30 }, 2));
  await page.mouse.up();
  await expect(page.locator('#place-height-field')).toBeVisible();
  await page.fill('#place-height', '20');
  await expect(page.locator('#place-preview')).toHaveText('A 20U device must sit within U1–47');
  await expect(page.locator('#place-submit')).toBeDisabled();
  // A height that runs out of the rack has no span.
  await expect(page.locator('#place-where')).toHaveText('Rack A01 · does not fit at U30 · 20U · placeholder');
  await expect(page.locator('#place-pos option:checked')).toHaveText('U30 (does not fit)');
  await page.fill('#place-height', '99');
  await expect(page.locator('#place-where')).toHaveText('Rack A01 · does not fit · 99U · placeholder');
  await expect(page.locator('#place-preview')).toHaveText('Rack A01 has 47 units: 99U do not fit.');
  await expect(page.locator('#place-submit')).toBeDisabled();
  await page.fill('#place-height', '6');
  await expect(page.locator('#place-where')).toHaveText('Rack A01 · U30–35 · 6U · placeholder');
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

test('asks before deleting many devices, or several that take cables', async ({ page }) => {
  await device(page, 'cn-005').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  const dlg = page.locator('#dlg-confirm');
  await expect(dlg).toBeVisible();
  await expect(page.locator('#confirm-title')).toHaveText('Delete 37 devices?');
  await expect(page.locator('#confirm-body')).toHaveText(/^This deletes 37 devices and \d+ cables\. Undo brings them back\.$/);
  // Focus starts on Cancel: one more key press keeps the devices.
  await expect(page.locator('#dlg-confirm button[value="cancel"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dlg).toBeHidden();
  await expect(devices(page)).toHaveCount(37);
  await expect(page.locator('.multi-title')).toHaveText('37 devices');
  await page.click('#multi-del');
  await page.click('#confirm-ok');
  await expect(devices(page)).toHaveCount(0);
  // One device goes at once, cables or not: the toast can undo it.
  await page.keyboard.press('Control+z');
  await device(page, 'cn-005').click();
  await page.keyboard.press('Delete');
  await expect(dlg).toBeHidden();
  await expect(devices(page)).toHaveCount(36);
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

test('the Undo of a toast undoes only the step it names', async ({ page }) => {
  await device(page, 'cn-002').click();
  await page.keyboard.press('Delete');
  // Not the toast of what undo did, which names the step too.
  const deleted = page.locator('.toast', { hasText: /^Deleted cn-002/ });
  await expect(deleted.locator('button')).toHaveText('Undo');

  // A newer step takes its Undo away; the toast still says what happened.
  await device(page, 'cn-004').click();
  await page.keyboard.press('ArrowRight');
  await expect(where(page)).toHaveText(/^Rack A02/);
  await expect(deleted).toBeVisible();
  await expect(deleted.locator('button')).toHaveCount(0);

  await page.keyboard.press('Control+z');
  await expect(where(page)).toHaveText('Rack A01 · U10–11');
  await expect(devices(page)).toHaveCount(36);
  // Its step undone at last, the toast without its Undo goes too.
  await expect(deleted).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(devices(page)).toHaveCount(37);
  // Right away, not when its time is up.
  await expect(deleted).toHaveCount(0, { timeout: 1000 });
  await page.keyboard.press('Control+Shift+z');
  await expect(devices(page)).toHaveCount(36);

  // Undoing the step a toast names takes the toast away.
  await device(page, 'cn-003').click();
  await page.keyboard.press('Delete');
  const again = page.locator('.toast', { hasText: /^Deleted cn-003/ });
  await expect(again).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(again).toHaveCount(0, { timeout: 1000 });
  await expect(devices(page)).toHaveCount(36);
});

test('undo and redo say what they revert and go to the row it was in', async ({ page }) => {
  await device(page, 'cn-002').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('#btn-undo')).toHaveAttribute('title', 'Undo: Deleted cn-002 and 3 cables (Ctrl+Z)');
  await page.keyboard.press(']');
  await page.keyboard.press(']');
  await expect(page.locator('.ftab[aria-pressed="true"]')).toHaveText('First floor');

  await page.keyboard.press('Control+z');
  await expect(page.locator('.ftab[aria-pressed="true"]')).toHaveText('Ground floor');
  await expect(page.locator('#row-label')).toHaveText('Row A');
  await expect(devices(page)).toHaveCount(37);
  await expect(page.locator('.toast[data-kind="undo"]')).toHaveText('Undid: Deleted cn-002 and 3 cables (Ground floor · Row A)');
  await expect(page.locator('#btn-redo')).toHaveAttribute('title', 'Redo: Deleted cn-002 and 3 cables (Ctrl+Shift+Z)');
  await expect(page.locator('#btn-undo')).toHaveAttribute('title', 'Undo (Ctrl+Z)');

  // One message says what the last undo or redo did.
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.toast[data-kind="undo"]')).toHaveText('Redid: Deleted cn-002 and 3 cables');
  await expect(devices(page)).toHaveCount(36);

  await device(page, 'cn-004').click();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#btn-undo')).toHaveAttribute('title', 'Undo: Moved cn-004 (Ctrl+Z)');
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

test('deleting the open plan removes it for good; viewing plans does not touch them', async ({ page }) => {
  await page.click('#btn-new');
  await page.click('[data-new="empty"]');
  // Pretend the example was last edited long ago; opening the list must not change that.
  await page.evaluate(() => {
    const key = 'rackplanner.library.v1';
    const index = JSON.parse(localStorage.getItem(key));
    index.plans.forEach((p) => {
      if (p.name === 'Hall 2 expansion') p.updated = Date.UTC(2020, 0, 2);
    });
    localStorage.setItem(key, JSON.stringify(index));
  });
  await page.click('#btn-plans');
  await expect(page.locator('.plan-item:has-text("Hall 2 expansion") .plan-sub')).toContainText('edited 2020-01-02');

  await page.click('.plan-item.is-current [data-plan-act="del"]');
  await page.click('#confirm-ok');
  await expect(page.locator('.plan-item')).toHaveCount(1);
  await expect(page.locator('.plan-item.is-current')).toContainText('Hall 2 expansion');
  await page.click('#dlg-plans button[value="ok"]');
  await expect(devices(page)).toHaveCount(37);
  await page.reload();
  await page.click('#btn-plans');
  await expect(page.locator('.plan-item')).toHaveCount(1);

  // Deleting the only plan leaves one fresh empty plan.
  await page.click('.plan-item.is-current [data-plan-act="del"]');
  await page.click('#confirm-ok');
  await expect(page.locator('.plan-item')).toHaveCount(1);
  await expect(page.locator('.plan-item.is-current')).toContainText('Untitled rack plan');
});

test('plans stay in the list when the list of plans in the browser is lost', async ({ page }) => {
  await page.click('#btn-new');
  await page.click('[data-new="empty"]');
  await page.evaluate(() => localStorage.setItem('rackplanner.library.v1', '{"plans":'));
  await page.reload();
  await page.click('#btn-plans');
  await expect(page.locator('.plan-item')).toHaveCount(2);
  expect((await page.locator('.plan-item .plan-name-l').allInnerTexts()).sort()).toEqual(['Hall 2 expansion', 'Untitled rack plan']);
  // Their times are lost with the list.
  await expect(page.locator('.plan-item:has-text("Hall 2 expansion") .plan-sub')).toHaveText(/^2 floors · 8 racks · 65 devices · \d+ KB$/);
});

test('a saved plan that needed fixing says what was fixed and keeps a backup', async ({ page }) => {
  // Two plans; the one not open gets a device of a type its catalog lacks.
  await page.click('#btn-new');
  await page.click('[data-new="empty"]');
  const broken = await page.evaluate(() => {
    const index = JSON.parse(localStorage.getItem('rackplanner.library.v1'));
    const id = index.plans.find((p) => p.name === 'Hall 2 expansion').id;
    const raw = JSON.parse(localStorage.getItem(`rackplanner.plan.${id}`));
    raw.devices.push({ id: 'x1', type: 'nope', name: 'ghost', loc: { rack: raw.floors[0].rows[0].racks[0].id, kind: 'u', at: 40 } });
    const text = JSON.stringify(raw);
    localStorage.setItem(`rackplanner.plan.${id}`, text);
    return { id, text };
  });
  const report = page.locator('#dlg-report');
  await page.click('#btn-plans');
  await page.click('.plan-item:has-text("Hall 2 expansion") [data-plan-act="open"]');
  await expect(report).toBeVisible();
  await expect(report.locator('#report-title')).toHaveText('Opened Hall 2 expansion');
  await expect(report.locator('#report-sub')).toHaveText('1 thing in the saved plan needed fixing. A backup keeps the plan as it was saved.');
  await expect(report.locator('#report-list li')).toHaveText(['Skipped ghost: unknown device type “nope”.']);
  await report.locator('button[value="ok"]').click();

  // Opened when the page loads, it says so too.
  await page.reload();
  await expect(report).toBeVisible();
  await expect(report.locator('#report-list li')).toHaveText(['Skipped ghost: unknown device type “nope”.']);
  await report.locator('button[value="ok"]').click();
  const backup = () => page.evaluate((id) => localStorage.getItem(`rackplanner.backup.${id}`), broken.id);
  expect(await backup()).toBeNull();

  // The first save over it keeps it as it was.
  await page.fill('#plan-name', 'Hall 2, fixed');
  await page.keyboard.press('Enter');
  await expect.poll(backup).toBe(broken.text);
  await page.reload();
  await expect(devices(page)).toHaveCount(37);
  await expect(report).toBeHidden();

  await page.click('#btn-plans');
  await page.click('.plan-item:has-text("Hall 2, fixed") [data-plan-act="del"]');
  await page.click('#confirm-ok');
  expect(await backup()).toBeNull();
});

test('while the browser storage is full the plan shows it is not saved, and Plans shows the space used', async ({ page }) => {
  await page.click('#btn-plans');
  await expect(page.locator('#plan-unsaved')).toBeHidden();
  await expect(page.locator('#plan-usage')).toHaveText(/^Rackplanner uses \d+ KB of the browser storage, which holds about 5 MB\.$/);
  await expect(page.locator('.plan-item .plan-sub')).toHaveText(/ · \d+ KB$/);
  await page.click('#dlg-plans button[value="ok"]');

  await page.evaluate(() => {
    // Fill the storage to its quota.
    const chunk = 'x'.repeat(1 << 20);
    try {
      for (let i = 0; i < 64; i++) localStorage.setItem(`fill-${i}`, chunk);
    } catch (e) {
      // Full.
    }
    for (let size = 1 << 19; size >= 16; size >>= 1) {
      try {
        localStorage.setItem(`fill-tail-${size}`, 'x'.repeat(size));
      } catch (e) {
        // Full.
      }
    }
  });
  const plans = page.locator('#btn-plans');
  await page.fill('#plan-name', 'Hall 2 expansion, with a much longer name');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast.warn')).toContainText('This browser did not save the plan');
  await expect(plans).toHaveClass(/is-unsaved/);
  await expect(plans).toContainText('Not saved');
  // Each failed save after the first says nothing more; the Plans button keeps saying it.
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await page.fill('#plan-name', 'Hall 2 expansion, with an even much longer name');
  await page.keyboard.press('Enter');
  // After the save that waits for a pause in the typing.
  await page.waitForTimeout(600);
  await expect(page.locator('.toast.warn')).toHaveCount(0);
  await expect(plans).toHaveClass(/is-unsaved/);

  // Closing the tab asks first.
  const asked = new Promise((resolve) => page.once('dialog', (d) => d.dismiss().then(() => resolve(d.type()))));
  await page.close({ runBeforeUnload: true });
  expect(await asked).toBe('beforeunload');

  await plans.click();
  await expect(page.locator('#plan-unsaved')).toHaveText(
    'The latest changes to Hall 2 expansion, with an even much longer name are not saved: the browser storage is full or blocked. Delete plans you no longer need, or export this plan to keep your work.'
  );

  // With room again, the next save goes through.
  await page.evaluate(() => Object.keys(localStorage).forEach((k) => k.startsWith('fill-') && localStorage.removeItem(k)));
  await page.click('#dlg-plans button[value="ok"]');
  await plans.click();
  await expect(page.locator('#plan-unsaved')).toBeHidden();
  await expect(plans).not.toHaveClass(/is-unsaved/);
  await expect(page.locator('.plan-item .plan-name-l')).toHaveText('Hall 2 expansion, with an even much longer name');
});

test('a plan changed in another tab shows there, and a tab with changes of its own asks first', async ({ page, context }) => {
  const other = await context.newPage();
  // Lets the test make this tab miss the saves of the other, as a tab that slept may.
  await other.addInitScript(() => window.addEventListener('storage', (e) => window.missSaves && e.stopImmediatePropagation()));
  await other.goto('/index.html');
  await expect(devices(other)).toHaveCount(37);

  // With nothing of its own to save, the other tab takes up the change at once.
  await device(page, 'cn-001').click();
  await page.keyboard.press('Delete');
  await expect(devices(other)).toHaveCount(36);
  await expect(other.locator('.toast')).toContainText('This plan changed in a different tab');

  // A tab that missed the other's save asks before it saves over it.
  await other.evaluate(() => (window.missSaves = true));
  await device(page, 'cn-002').click();
  await page.keyboard.press('Delete');
  await expect(devices(page)).toHaveCount(35);
  await other.fill('#plan-name', 'Hall 2, tab two');
  const ask = other.locator('#dlg-elsewhere');
  await expect(ask).toBeVisible();
  await expect(ask.locator('h2')).toHaveText('This plan changed in a different tab');
  // Escape does not dismiss it.
  await other.keyboard.press('Escape');
  await expect(ask).toBeVisible();
  await ask.locator('button[value="reload"]').click();
  await expect(devices(other)).toHaveCount(35);
  await expect(other.locator('#plan-name')).toHaveValue('Hall 2 expansion');

  await device(page, 'cn-003').click();
  await page.keyboard.press('Delete');
  await other.fill('#plan-name', 'Hall 2, tab two');
  await expect(ask).toBeVisible();
  await ask.locator('button[value="copy"]').click();
  await expect(other.locator('.toast').last()).toContainText('Kept this tab’s changes as Hall 2, tab two');
  await expect(devices(other)).toHaveCount(35);
  await page.click('#btn-plans');
  await expect(page.locator('.plan-item .plan-name-l')).toHaveText(['Hall 2, tab two', 'Hall 2 expansion']);
  await expect(page.locator('.plan-item.is-current .plan-sub')).toContainText('62 devices');
  await page.click('#dlg-plans button[value="ok"]');
  await expect(devices(page)).toHaveCount(34);
});

test('a share link opens the plan in another browser', async ({ page, browser }) => {
  await device(page, 'cn-001').click();
  await page.fill('#insp-name', 'shared-node');
  await page.click('#btn-export');
  await page.click('[data-export="share"]');
  // The link is filled in once the plan is compressed, which takes a moment.
  await expect(page.locator('#share-url')).toHaveValue(/#plan=z[\w-]+$/);
  const url = await page.locator('#share-url').inputValue();

  const other = await browser.newContext();
  const page2 = await other.newPage();
  await page2.goto(url);
  await expect(page2.locator('.toast').first()).toContainText('Opened the shared plan Hall 2 expansion');
  await expect(page2.locator('.scene .dev[aria-label^="shared-node,"]')).toBeVisible();
  // The address names the row shown now, not the shared plan.
  await expect.poll(() => new URL(page2.url()).hash).toBe('#row=row1');
  // The shared plan comes instead of the example.
  await page2.click('#btn-plans');
  await expect(page2.locator('.plan-item')).toHaveCount(1);
  await page2.click('#dlg-plans button[value="ok"]');

  // The same link again opens that plan, or one more copy under a name of its own.
  await page2.goto(url);
  await expect(page2.locator('#confirm-title')).toHaveText('Open Hall 2 expansion again?');
  await page2.click('#confirm-ok');
  await expect(page2.locator('.toast').last()).toContainText('Hall 2 expansion is open');
  await page2.goto(url);
  await expect(page2.locator('#dlg-confirm button[value="cancel"]')).toHaveText('Open as a copy');
  await page2.click('#dlg-confirm button[value="cancel"]');
  await expect(page2.locator('#plan-name')).toHaveValue('Hall 2 expansion (2)');
  await page2.click('#btn-plans');
  await expect(page2.locator('.plan-item .plan-name-l')).toHaveText(['Hall 2 expansion (2)', 'Hall 2 expansion']);
  await page2.click('#dlg-plans button[value="ok"]');

  // Esc on the question adds no plan: it opens the one there is.
  await page2.goto(url);
  await expect(page2.locator('#confirm-title')).toHaveText(/^Open Hall 2 expansion( \(2\))? again\?$/);
  await page2.keyboard.press('Escape');
  await expect(page2.locator('#dlg-confirm')).toBeHidden();
  await expect(page2.locator('.toast').last()).toContainText(/Hall 2 expansion( \(2\))? is open/);
  await page2.click('#btn-plans');
  await expect(page2.locator('.plan-item')).toHaveCount(2);
  await other.close();
});

test('plans are renamed in the plan list', async ({ page }) => {
  await page.click('#btn-new');
  await page.click('[data-new="empty"]');
  await page.click('#btn-new');
  await page.click('[data-new="empty"]');
  await page.click('#btn-plans');
  // New plans get names of their own.
  await expect(page.locator('.plan-item .plan-name-l')).toHaveText(['Untitled rack plan (2)', 'Untitled rack plan', 'Hall 2 expansion']);

  await page.click('.plan-item:has-text("Hall 2 expansion") [data-plan-act="rename"]');
  const input = page.locator('.plan-item .plan-name-in');
  await expect(input).toBeFocused();
  await input.fill('Hall 2, rev B');
  await input.press('Enter');
  await expect(page.locator('.plan-item .plan-name-l').first()).toHaveText('Hall 2, rev B');

  // A name another plan has takes a number, as new plans do.
  await page.click('.plan-item:has-text("Hall 2, rev B") [data-plan-act="rename"]');
  await input.fill('Untitled rack plan');
  await input.press('Enter');
  await expect(page.locator('.plan-item .plan-name-l')).toHaveText(['Untitled rack plan (3)', 'Untitled rack plan (2)', 'Untitled rack plan']);
  await expect(page.locator('.toast').last()).toHaveText('Named it Untitled rack plan (3): another plan is named Untitled rack plan');

  // Esc keeps the name and the list open.
  await page.click('.plan-item.is-current [data-plan-act="rename"]');
  await input.fill('Nothing');
  await input.press('Escape');
  await expect(page.locator('#dlg-plans')).toBeVisible();
  await expect(page.locator('.plan-item.is-current .plan-name-l')).toHaveText('Untitled rack plan (2)');

  // The open plan is renamed as in the toolbar, with undo.
  await page.click('.plan-item.is-current [data-plan-act="rename"]');
  await input.fill('Row C test');
  await input.press('Enter');
  await page.click('#dlg-plans button[value="ok"]');
  await expect(page.locator('#plan-name')).toHaveValue('Row C test');
  await page.keyboard.press('Control+z');
  await expect(page.locator('#plan-name')).toHaveValue('Untitled rack plan (2)');
});

test('a CSV export opens as a new plan', async ({ page }) => {
  const csv = await exportFile(page, 'csv');
  expect(csv.suggestedFilename()).toBe('hall-2-expansion.csv');
  await page.click('#btn-open');
  const chooser = page.waitForEvent('filechooser');
  await page.click('#open-file');
  await (await chooser).setFiles({ name: 'Hall 2 inventory.csv', mimeType: 'text/csv', buffer: fs.readFileSync(await csv.path()) });
  await expect(page.locator('#dlg-report')).toBeVisible();
  await expect(page.locator('#report-list li')).toHaveCount(4);
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

test('arrow keys go on through the cluster chips and leave the device where it is', async ({ page }) => {
  await device(page, 'cn-001').click();
  const cn = () => page.evaluate(() => window.RP.app.project().devices.find((d) => d.name === 'cn-001'));
  const loc = (await cn()).loc;
  await page.locator('input[name="insp-cluster"]:checked').focus();
  await page.keyboard.press('ArrowRight');
  await expect(device(page, 'cn-001')).toHaveAttribute('aria-label', /cluster Osprey GPU/);
  await expect(page.locator('input[name="insp-cluster"][value="c-osprey"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(device(page, 'cn-001')).toHaveAttribute('aria-label', /cluster Ceph object store/);
  expect((await cn()).loc).toEqual(loc);
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

test('keeps clusters, the placing hint and a selection’s actions in view', async ({ page }) => {
  /** Whether `sel` is fully visible inside the box it scrolls in (or the window). */
  const shown = (sel, box) =>
    page.evaluate(
      ({ sel, box }) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        const b = box ? document.querySelector(box).getBoundingClientRect() : { top: 0, bottom: innerHeight };
        return r.height > 0 && r.top >= b.top && r.bottom <= b.bottom;
      },
      { sel, box }
    );
  // The device list scrolls on its own, so the clusters below it stay on screen.
  expect(await shown('.cl-row')).toBe(true);

  // The plan name reads as a title, not as a second text box next to the search.
  expect(await page.locator('#plan-name').evaluate((e) => getComputedStyle(e).borderTopColor)).toBe('rgba(0, 0, 0, 0)');

  // The click-to-place hint floats over the drawing, below the row picker and the example notice.
  await page.locator('.part[data-type="compute-node"]').click();
  const hint = await page.locator('#armed-hint').boundingBox();
  const notice = await page.locator('#example-notice').boundingBox();
  expect(hint.y).toBeGreaterThanOrEqual(notice.y + notice.height);
  await page.keyboard.press('Escape');

  // Below a device's long form, Duplicate and Delete stay in reach.
  await device(page, 'cn-001').click();
  expect(await shown('#insp-del', '#inspector')).toBe(true);
  await device(page, 'cn-002').click({ modifiers: ['Shift'] });
  expect(await shown('#multi-del', '#inspector')).toBe(true);
});

test('the theme button picks light, dark or the system’s theme, and it is kept', async ({ page }) => {
  const paper = () => page.locator('.scene .sheet').getAttribute('fill');
  const html = page.locator('html');
  const light = '#f8f9fb';
  const dark = '#161b21';
  expect(await paper()).toBe(light);

  await page.click('#btn-theme');
  await expect(page.locator('[data-theme-pick="system"]')).toHaveAttribute('aria-checked', 'true');
  await page.click('[data-theme-pick="dark"]');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect.poll(paper).toBe(dark);
  await expect(page.locator('#btn-theme')).toHaveAttribute('aria-label', 'Theme: dark');

  // Kept across visits, and set before the app's script runs, so pages don't flash light.
  await page.route('**/js/app.js', (route) => route.abort());
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.unroute('**/js/app.js');
  await page.reload();
  await expect.poll(paper).toBe(dark);

  // Matching the system again follows the browser's setting.
  await page.click('#btn-theme');
  await expect(page.locator('[data-theme-pick="dark"]')).toHaveAttribute('aria-checked', 'true');
  await page.click('[data-theme-pick="system"]');
  await expect(html).not.toHaveAttribute('data-theme');
  await expect.poll(paper).toBe(light);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(paper).toBe(dark);
});

test.describe('offline', () => {
  test.use({ serviceWorkers: 'allow' });

  test('loads nothing from other hosts and caches the app for offline use', async ({ page }) => {
    const external = [];
    page.on('request', (r) => {
      if (!r.url().startsWith('http://127.0.0.1')) external.push(r.url());
    });
    // After the first visit, before the worker serves anything, every script
    // the page needs is precached: the planner opens offline from then on.
    await page.evaluate(() => navigator.serviceWorker.ready);
    const precached = await page.evaluate(async () => {
      const keys = await (await caches.open('rackplanner-v5')).keys();
      return keys.map((r) => new URL(r.url).pathname);
    });
    const scripts = await page.evaluate(() => [...document.scripts].filter((s) => s.src).map((s) => new URL(s.src).pathname));
    expect(scripts.length).toBeGreaterThan(4);
    expect(precached).toEqual(expect.arrayContaining(scripts));
    await page.reload();
    await expect(devices(page)).toHaveCount(37);
    expect(await page.evaluate(() => document.fonts.check('600 12px "IBM Plex Mono"'))).toBe(true);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cached = await page.evaluate(async () => {
      const keys = await (await caches.open('rackplanner-v5')).keys();
      return keys.map((r) => new URL(r.url).pathname);
    });
    expect(cached).toEqual(expect.arrayContaining(['/index.html', '/js/app.js', '/js/cabling.js', '/js/io.js', '/css/fonts.css', '/fonts/ibm-plex-mono-latin-600-normal.woff2']));
    expect(external).toEqual([]);
  });
});

test('the menus of the toolbar open inside the window', async ({ page }) => {
  for (const size of [{ width: 1024, height: 768 }, { width: 390, height: 664 }]) {
    await page.setViewportSize(size);
    for (const [btn, menu] of [['#btn-export', '#menu-export'], ['#btn-new', '#menu-new'], ['#btn-theme', '#menu-theme']]) {
      await page.click(btn);
      const box = await page.locator(menu).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
      await page.keyboard.press('Escape');
    }
  }
});

test.describe('on a phone’s screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the menus of the toolbar open inside it, though one past the edge widens the page', async ({ page }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [btn, menu] of [['#btn-export', '#menu-export'], ['#btn-new', '#menu-new'], ['#btn-theme', '#menu-theme']]) {
        await page.locator(btn).tap();
        const box = await page.locator(menu).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await page.keyboard.press('Escape');
      }
    }
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
    // The page scrolls to the drawing, under the devices, with its hint, which names no keys.
    await expect(page.locator('#armed-hint')).toBeInViewport();
    await expect(page.locator('#armed-hint')).toHaveText('Tap a free slot to place a 24-port switch', { useInnerText: true });
    await expect(page.locator('#clusters-hint')).toHaveText('Tap a cluster to highlight its devices in the racks.', { useInnerText: true });
    const note = page.locator('#inspector .insp-note', { hasText: 'Select a device' });
    await expect(note).toContainText('A cluster’s select button selects all its devices.', { useInnerText: true });
    await expect(note).not.toContainText('Shift', { useInnerText: true });
    await expect.poll(stageTop(page)).toBe(0);
    // At 100%, U30 is further down the drawing.
    let target = await spot(page, 'switch-qsfp', { rack: 'r1', kind: 'u', at: 30 });
    await page.evaluate((y) => (document.querySelector('#canvas').scrollTop += y - window.innerHeight / 2), target.y);
    target = await spot(page, 'switch-qsfp', { rack: 'r1', kind: 'u', at: 30 });
    await page.touchscreen.tap(target.x, target.y);
    await expect(page.locator('#dlg-place')).toBeVisible();
    await expect(page.locator('#place-where')).toContainText('Rack A01 · U30');
  });

  test('a swipe past the end of the drawing scrolls the page, and the stage fits a landscape screen', async ({ page }) => {
    await page.locator('#btn-keep-example').tap();
    await page.evaluate(() => document.querySelector('#stage').scrollIntoView({ block: 'start' }));
    const at = () => page.evaluate(() => ({ page: window.scrollY, drawing: document.querySelector('#canvas').scrollTop }));
    const start = await at();
    await swipe(page, 200, 500, -250);
    const once = await at();
    expect(once.drawing).toBeGreaterThan(start.drawing);
    for (let i = 0; i < 6; i++) await swipe(page, 200, 500, -250);
    expect((await at()).page).toBeGreaterThan(start.page);

    await page.setViewportSize({ width: 750, height: 342 });
    const stage = await page.locator('#stage').boundingBox();
    expect(stage.height).toBeLessThanOrEqual(342);
  });

  test('the nav bar stays over the drawing, with Undo and Redo', async ({ page }) => {
    await page.locator('#btn-keep-example').tap();
    await page.fill('#plan-name', 'Hall 3');
    await page.press('#plan-name', 'Enter');
    await page.evaluate(() => document.querySelector('#stage').scrollIntoView({ block: 'start' }));
    const undo = page.locator('#btn-nav-undo');
    await expect(undo).toBeInViewport();
    await expect(undo).toBeEnabled();
    await undo.tap();
    await expect(page.locator('#plan-name')).toHaveValue('Hall 2 expansion');
    await expect(page.locator('#btn-nav-redo')).toBeEnabled();
    await page.locator('#btn-nav-redo').tap();
    await expect(page.locator('#plan-name')).toHaveValue('Hall 3');

    // The schedule is taller than the screen: its nav bar stays at the top.
    await page.locator('.ws-switch [data-workspace="cabling"]').tap();
    await page.locator('#cab-toggle [data-cab-view="schedule"]').tap();
    await page.evaluate(() => {
      document.querySelector('#stage').scrollIntoView({ block: 'start' });
      window.scrollBy(0, 400);
    });
    expect(Math.round((await page.locator('.nav').boundingBox()).y)).toBe(0);
    await expect(undo).toBeInViewport();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(undo).toBeHidden();
  });

  test('a search result and a rack on the floor map bring the drawing into view', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 664 });
    await page.locator('#search').tap();
    await page.keyboard.type('cn-00');
    await page.locator('.sr-item', { hasText: 'cn-003' }).tap();
    await expect(device(page, 'cn-003')).toBeInViewport();
    await expect.poll(stageTop(page)).toBe(0);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('.view-toggle [data-view="map"]').tap();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('.fm-rack[data-rack="r3"]').tap();
    await expect(page.locator('.scene .rack-head[data-rack="r3"]')).toBeInViewport();
  });

  test('the racks start at 100%, and two fingers zoom the drawing, not the page', async ({ page }) => {
    await page.locator('#btn-keep-example').tap();
    await expect(page.locator('#btn-zoom-reset')).toHaveText('100%');
    await page.evaluate(() => document.querySelector('#stage').scrollIntoView({ block: 'start' }));
    const box = await page.locator('#canvas').boundingBox();
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    const cdp = await page.context().newCDPSession(page);
    const fingers = (d) => [{ x: x - d, y, id: 1 }, { x: x + d, y, id: 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(40) });
    for (let d = 44; d <= 80; d += 4) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(d) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('#btn-zoom-reset')).toHaveText('200%');
    expect(await page.evaluate(() => window.visualViewport.scale)).toBe(1);
    // The fingers lifted tap nothing.
    await expect(page.locator('#inspector .insp-where')).toHaveCount(0);
  });

  test('a tap on the selected device, then on a free slot, moves it', async ({ page }) => {
    await page.locator('#btn-keep-example').tap();
    await page.evaluate(() => document.querySelector('#stage').scrollIntoView({ block: 'start' }));
    await device(page, 'cn-001').tap();
    await expect(where(page)).toHaveText('Rack A01 · U4–5');
    await expect(page.locator('#inspector .hint-touch')).toHaveText('To move it in the drawing, tap it again, then tap a free slot.');
    await device(page, 'cn-001').tap();
    await expect(page.locator('#armed-hint')).toHaveText('Tap a free slot to move cn-001', { useInnerText: true });

    // A tap on another device selects that one instead.
    await device(page, 'cn-002').tap();
    await expect(where(page)).toHaveText('Rack A01 · U6–7');
    await expect(page.locator('#armed-hint')).toBeHidden();
    await device(page, 'cn-001').tap();
    await device(page, 'cn-001').tap();
    await expect(page.locator('#armed-hint')).toBeVisible();

    let target = await spot(page, 'compute-node', { rack: 'r1', kind: 'u', at: 30 });
    await page.evaluate((y) => (document.querySelector('#canvas').scrollTop += y - window.innerHeight / 2), target.y);
    target = await spot(page, 'compute-node', { rack: 'r1', kind: 'u', at: 30 });
    await page.touchscreen.tap(target.x, target.y);
    await expect(where(page)).toHaveText('Rack A01 · U30–31');
    await expect(page.locator('#armed-hint')).toBeHidden();
    await page.locator('#btn-nav-undo').tap();
    await expect(where(page)).toHaveText('Rack A01 · U4–5');
  });

  test('the example notice comes before the Devices panel, on the first screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 664 });
    const notice = page.locator('#example-notice');
    await expect(notice).toBeInViewport({ ratio: 1 });
    expect((await notice.boundingBox()).y).toBeLessThan((await page.locator('#bin').boundingBox()).y);
    // Beside the drawing, it is under the stage's nav bar again.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('#stage > .nav + #example-notice')).toBeVisible();
    await page.locator('#btn-keep-example').click();
    await expect(notice).toBeHidden();
  });

  test('adds a device type from a template in the catalog', async ({ page }) => {
    await page.locator('#btn-catalog').tap();
    const list = await page.locator('#cat-list').boundingBox();
    const form = await page.locator('#cat-form').boundingBox();
    expect(list.y + list.height).toBeLessThanOrEqual(form.y);
    await page.locator('#cat-new').tap();
    await page.locator('[data-template="1"]').tap();
    await expect(page.locator('#cat-label')).toHaveValue('GPU server 2');
  });
});

test('the eye of a cluster hides its devices in the racks and shows them again', async ({ page }) => {
  const eye = page.locator('#clusters [data-cl-eye="c-kestrel"]');
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  // Its name and its title agree, shown or hidden.
  await expect(eye).toHaveAccessibleName('Show Kestrel HPC in the racks');
  await expect(eye).toHaveAttribute('title', 'Show Kestrel HPC in the racks (Alt-click: only it)');
  await eye.click();
  await expect(eye).toHaveAttribute('aria-pressed', 'false');
  await expect(eye).toHaveAttribute('title', 'Show Kestrel HPC in the racks (Alt-click: only it)');
  await expect(device(page, 'cn-001')).toHaveAttribute('aria-label', /, cluster Kestrel HPC, hidden$/);
  await expect(device(page, 'gpu-001')).not.toHaveAttribute('aria-label', /hidden/);
  await expect(eye).toBeFocused();
  await expect(page.locator('#clusters .cl-row[data-cluster="c-kestrel"]')).toHaveClass(/is-hidden/);
  // Its devices keep their units, drawn as outlines; the others are as they were.
  await expect(page.locator('.scene .dev.is-hidden')).toHaveCount(12);
  await expect(devices(page)).toHaveCount(37);
  await expect(device(page, 'gpu-001')).not.toHaveClass(/is-hidden/);
  await eye.click();
  await expect(page.locator('.scene .dev.is-hidden')).toHaveCount(0);
});

test('a hidden device still reads as taken space; one placed into a hidden cluster says so', async ({ page }) => {
  await page.click('#clusters [data-cl-eye="c-kestrel"]');
  // Its name stays, in faint ink, over a hatch with a solid outline.
  const cn = device(page, 'cn-001');
  await expect(cn).toHaveClass(/is-hidden/);
  await expect(cn.locator('text')).toHaveText('cn-001');
  await expect(cn.locator('[stroke-dasharray]')).toHaveCount(0);

  await dragPart(page, 'compute-node', await spot(page, 'compute-node', { rack: 'r1', kind: 'u', at: 30 }));
  await page.mouse.up();
  await expect(page.locator('input[name="place-cluster"][value="c-kestrel"]')).toBeChecked();
  await page.click('#place-submit');
  const note = page.locator('#toasts .toast').filter({ hasText: 'Placed cn-013 in Kestrel HPC, which is hidden' });
  await expect(note).toBeVisible();
  await note.locator('button', { hasText: 'Show' }).click();
  await expect(page.locator('#clusters .cl-row[data-cluster="c-kestrel"]')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('.scene .dev.is-hidden')).toHaveCount(0);
});

test('a hidden cluster put in focus is shown; search matches and the selection are drawn; hovering it dims nothing', async ({ page }) => {
  await page.click('#clusters [data-cl-eye="c-kestrel"]');
  const row = page.locator('#clusters .cl-row[data-cluster="c-kestrel"]');
  const dimmed = page.locator('.scene .dev[opacity="0.2"]');
  await page.locator('#clusters .cl-row[data-cluster="c-osprey"] .cl-main').hover();
  await expect.poll(() => dimmed.count()).toBeGreaterThan(0);
  await row.locator('.cl-main').hover();
  await expect(dimmed).toHaveCount(0);

  // Search matches are drawn in full; so is a hidden device selected, and its inspector says it is hidden.
  await page.locator('#search').fill('cn-00');
  await expect(device(page, 'cn-001')).not.toHaveClass(/is-hidden/);
  await expect(device(page, 'cn-010')).toHaveClass(/is-hidden/);
  await page.locator('#search').press('Enter');
  await page.locator('#search').fill('');
  await page.locator('#scene').focus();
  await expect(device(page, 'cn-001')).toHaveClass(/is-selected/);
  await expect(device(page, 'cn-001')).not.toHaveClass(/is-hidden/);
  await expect(device(page, 'cn-002')).toHaveClass(/is-hidden/);
  await expect(page.locator('#inspector')).toContainText('Kestrel HPC is hidden in the racks. Show');
  await page.keyboard.press('Escape');
  await expect(device(page, 'cn-001')).toHaveClass(/is-hidden/);

  await row.locator('.cl-main').click();
  await expect(row).not.toHaveClass(/is-hidden/);
  await expect(page.locator('.scene .dev.is-hidden')).toHaveCount(0);
});

test('PNG, SVG and print draw hidden clusters as on screen, and the Export menu says so', async ({ page }) => {
  await page.click('#clusters [data-cl-eye="c-kestrel"]');
  await page.click('#btn-export');
  await expect(page.locator('#menu-export [data-export="svg"] small')).toHaveText('This row, opens in vector editors · 1 cluster hidden');
  await page.keyboard.press('Escape');
  const svg = await exportFile(page, 'svg');
  const text = fs.readFileSync(await svg.path(), 'utf8');
  expect(text.split('class="dev is-hidden"').length - 1).toBe(12);
});

test('the cluster list says how many are hidden, with Show all; Alt-click on an eye shows only that cluster', async ({ page }) => {
  const note = page.locator('#clusters-hidden');
  const hiddenRows = page.locator('#clusters .cl-row.is-hidden');
  const eye = page.locator('#clusters [data-cl-eye="c-kestrel"]');
  await expect(note).toBeHidden();
  const at = await eye.boundingBox();
  await eye.click();
  // The note takes the hint's place: the list does not move, so a second click in place shows the cluster again.
  await expect(note).toHaveText('1 cluster hidden · Show all');
  await expect(page.locator('#clusters-hint')).toBeHidden();
  expect((await eye.boundingBox()).y).toBe(at.y);
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await expect(hiddenRows).toHaveCount(0);
  await expect(page.locator('#clusters-hint')).toBeVisible();
  await eye.click();
  await page.click('#clusters [data-cl-eye="c-osprey"]');
  await expect(note).toHaveText('2 clusters hidden · Show all');
  // The floor map draws their devices as taken space, without color.
  await page.keyboard.press('m');
  await expect(page.locator('.fm-elev i.is-hidden')).toHaveCount(20);
  await page.keyboard.press('m');
  // The sheet's legend marks them too.
  await expect(page.locator('.scene')).toContainText('Kestrel HPC12 · hidden');
  await note.locator('[data-show-all]').click();
  await expect(note).toBeHidden();
  await expect(hiddenRows).toHaveCount(0);
  await expect(page.locator('.scene .dev.is-hidden')).toHaveCount(0);

  const rows = await page.locator('#clusters .cl-row').count();
  await page.click('#clusters [data-cl-eye="c-kestrel"]', { modifiers: ['Alt'] });
  await expect(hiddenRows).toHaveCount(rows - 1);
  await expect(page.locator('#clusters .cl-row[data-cluster="c-kestrel"]')).not.toHaveClass(/is-hidden/);
  await expect(page.locator('.scene .dev:not(.is-hidden)')).toHaveCount(12);
  // Again: all of them are shown.
  await page.click('#clusters [data-cl-eye="c-kestrel"]', { modifiers: ['Alt'] });
  await expect(hiddenRows).toHaveCount(0);
});

test('Ctrl+A and Shift-drag leave hidden devices out; a cluster\'s select button takes them', async ({ page }) => {
  await page.click('#clusters [data-cl-eye="c-kestrel"]');
  await page.locator('#scene').focus();
  await page.keyboard.press('Control+a');
  await expect(page.locator('.multi-title')).toHaveText('25 devices');
  await expect(device(page, 'cn-001')).not.toHaveClass(/is-selected/);
  // The selection is told to screen readers too.
  await expect(page.locator('.scene .dev[aria-pressed="true"]')).toHaveCount(25);
  await expect(device(page, 'cn-001')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');

  const a = await device(page, 'sw-mgmt-a01').boundingBox();
  const b = await device(page, 'cn-003').boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(a.x - 30, a.y + 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 10, b.y + b.height - 2, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(device(page, 'sw-mgmt-a01')).toHaveClass(/is-selected/);
  for (const name of ['cn-001', 'cn-002', 'cn-003']) await expect(device(page, name)).not.toHaveClass(/is-selected/);

  // The inspector says how many of the selection are hidden.
  const row = page.locator('#clusters .cl-row[data-cluster="c-kestrel"]');
  await row.hover();
  await row.locator('.cl-select').click();
  await expect(page.locator('.multi-title')).toHaveText('12 devices (12 hidden)');
});

test('a cluster row shows its full name: buttons over its end on hover, a long name cut in the middle', async ({ page }) => {
  const row = page.locator('#clusters .cl-row[data-cluster="c-ceph"]');
  await row.hover();
  await row.locator('.cl-edit').click();
  await page.fill('#cluster-name', 'Ceph object store backup site');
  await page.click('#cluster-submit');
  await expect(row.locator('.cl-name')).toHaveText('Ceph object store backup site');
  await expect(row.locator('.cl-main')).toHaveAttribute('title', 'Ceph object store backup site');
  // The end of the name stays in sight; the cut is in the middle.
  await expect(row.locator('.cl-tail')).toHaveText(' site');
  const cut = (loc) => loc.evaluate((e) => e.scrollWidth > e.clientWidth);
  expect(await cut(row.locator('.cl-head'))).toBe(true);
  // Select and edit take no width: the count ends where the row does, and they show over it on hover.
  await page.mouse.move(0, 0);
  const tools = row.locator('.cl-tools');
  await expect(tools).toHaveCSS('opacity', '0');
  const rowBox = await row.boundingBox();
  const count = await row.locator('.cl-count').boundingBox();
  expect(rowBox.x + rowBox.width - (count.x + count.width)).toBeLessThan(12);
  await row.hover();
  await expect(tools).toHaveCSS('opacity', '1');
  // Short names are not cut at all.
  const core = page.locator('#clusters .cl-row[data-cluster="c-net"] .cl-name');
  await expect(core).toHaveText('Core network');
  expect(await cut(core)).toBe(false);
});

test.describe('on a touch tablet', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

  test('the buttons of a cluster are in sight without hover, in the row of the cluster tapped', async ({ page }) => {
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    const row = page.locator('#clusters .cl-row[data-cluster="c-kestrel"]');
    // Beside the drawing the names keep the row: each shows its start and its whole end.
    await expect(row.locator('.cl-tools')).toBeHidden();
    const cuts = await page.locator('#clusters .cl-name.is-split').evaluateAll((names) =>
      names.map((n) => [n.querySelector('.cl-head').clientWidth > 0, n.querySelector('.cl-tail').scrollWidth <= n.querySelector('.cl-tail').clientWidth])
    );
    expect(cuts.length).toBeGreaterThan(0);
    for (const cut of cuts) expect(cut).toEqual([true, true]);
    await row.locator('.cl-main').tap();
    await expect(row.locator('.cl-tools')).toBeVisible();
    await expect(row.locator('.cl-tools')).toHaveCSS('opacity', '1');
    // They sit after the count, not over it.
    const count = await row.locator('.cl-count').boundingBox();
    const select = await row.locator('.cl-select').boundingBox();
    expect(select.x).toBeGreaterThanOrEqual(count.x + count.width);
    await row.locator('.cl-edit').tap();
    await expect(page.locator('#dlg-cluster')).toBeVisible();
    await expect(page.locator('#cluster-name')).toHaveValue('Kestrel HPC');
  });
});

test('the cluster dialog warns of a color near another cluster’s', async ({ page }) => {
  await page.click('#btn-add-cluster');
  const near = page.locator('#cluster-near');
  await expect(near).toBeHidden();
  // Violet and cobalt differ in hue only.
  await page.click('#cluster-colors .swatch[title="Violet"]');
  await expect(near).toHaveText('Close to the color of Kestrel HPC. Not everyone can tell the two apart.');
  await page.click('#cluster-colors .swatch[title="Cobalt"]');
  await expect(near).toHaveText('Kestrel HPC has this color too.');
  await page.click('#cluster-colors .swatch[title="Brown"]');
  await expect(near).toBeHidden();
  await page.click('#dlg-cluster [data-close]');
  // A cluster's own color is no warning.
  const row = page.locator('#clusters .cl-row[data-cluster="c-kestrel"]');
  await row.hover();
  await row.locator('.cl-edit').click();
  await expect(page.locator('#cluster-name')).toHaveValue('Kestrel HPC');
  await expect(near).toBeHidden();
});

test('a cluster’s number marks its swatch and its devices, besides its color', async ({ page }) => {
  await expect(page.locator('#clusters .cl-row .sw')).toHaveText(['1', '2', '3', '4', '5', '6', '7', '']);
  await expect(device(page, 'cn-001').locator('.dev-mark')).toHaveText('2');
  await expect(device(page, 'jbod-01').locator('.dev-mark')).toHaveText('5');
});
