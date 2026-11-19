'use strict';

// Vertical PDUs in the Racks workspace and the catalog: PDU slots, placing,
// the PDU inspector, Fill PDU slots, and the PDU and cord types.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// The example as version 5 saved it: PDUs of a 1U type in the side slots of Row B, no power data.
const V5 = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'v5.json'));

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', { name: 'v5.json', mimeType: 'application/json', buffer: V5 });
  await expect(page.locator('.toast').last()).toContainText('Hall 2 expansion');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

const device = (page, name) => page.locator(`.scene .dev[aria-label^="${name},"]`);
const plan = (page, fn, arg) => page.evaluate(({ fn, arg }) => new Function('p', 'arg', `return (${fn})(p, arg)`)(window.RP.app.project(), arg), { fn: fn.toString(), arg });
const undoToast = (page) => page.locator('.toast button', { hasText: 'Undo' });
const pdus = (page) => plan(page, (p) => p.devices.filter((d) => d.loc.kind === 'pdu').map((d) => `${d.name} ${d.loc.rack} P${d.loc.at + 1} ${(p.powerGrids.find((g) => g.id === d.grid) || { name: '-' }).name}`).sort());

/** Adds the device type of template `k` of the catalog's “New type” menu and returns its id. */
async function addType(page, k) {
  await page.click('#btn-catalog');
  await page.click('#cat-new');
  await page.click(`[data-template="${k}"]`);
  const id = await page.locator('#cat-list .cat-item[aria-selected="true"]').getAttribute('data-id');
  return id;
}
const closeCatalog = (page) => page.keyboard.press('Escape');

/** Screen position of the middle of PDU slot `at` of rack `rackId`. */
function slotSpot(page, typeId, rackId, at) {
  return page.evaluate(
    ({ typeId, rackId, at }) => {
      const svg = document.querySelector('#scene');
      const box = svg.getBoundingClientRect();
      const zoom = box.width / svg.viewBox.baseVal.width;
      const r = window.RP.render.locRect(window.RP.app.project(), { rack: rackId, kind: 'pdu', at }, typeId);
      return { x: box.left + (r.x + r.w / 2) * zoom, y: box.top + (r.y + r.h / 2) * zoom };
    },
    { typeId, rackId, at }
  );
}

async function dragPart(page, typeId, point) {
  const card = page.locator(`.part[data-type="${typeId}"]`);
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + 40, { steps: 3 });
  await page.mouse.move(point.x, point.y, { steps: 10 });
}

test('a vertical PDU drops onto a PDU slot; its inspector sets the grid and the slot', async ({ page }) => {
  const typeId = await addType(page, 8);
  await expect(page.locator('#cat-label')).toHaveValue('0U PDU 3P 30');
  await expect(page.locator('#cat-kind')).toHaveValue('pdu');
  await expect(page.locator('#cat-sub-outlets')).toHaveText('Outlets · 30');
  await closeCatalog(page);

  // The racks draw their two PDU slots, free; the type drops onto the one under the pointer.
  await expect(page.locator('.scene .pdu-slot')).toHaveCount(6);
  await dragPart(page, typeId, await slotSpot(page, typeId, 'r1', 1));
  await expect(page.locator('#drag-chip')).toContainText('PDU slot P2');
  await page.mouse.up();
  await expect(page.locator('#place-pos-label')).toHaveText('Slot');
  await expect(page.locator('#place-pos')).toHaveValue('pdu:1');
  await expect(page.locator('#place-pos option')).toHaveText(['P1 · left', 'P2 · right']);
  await expect(page.locator('#place-name')).toHaveValue('pdu-a01-b');
  await expect(page.locator('#place-grid-field')).toBeVisible();
  await expect(page.locator('#place-grid option')).toHaveText(['No grid']);
  await expect(page.locator('#place-mount')).toBeEmpty();
  // Two at once take both slots, named by rack and slot.
  await page.selectOption('#place-pos', 'pdu:0');
  await expect(page.locator('#place-name')).toHaveValue('pdu-a01-a');
  await page.fill('#place-qty', '2');
  await expect(page.locator('#place-preview')).toHaveText('pdu-a01-a … pdu-a01-b · PDU slots P1, P2');
  await page.click('#place-submit');
  await expect(page.locator('.scene .dev.is-pdu')).toHaveCount(2);
  expect(await pdus(page)).toEqual(['pdu-a01-a r1 P1 -', 'pdu-a01-b r1 P2 -']);
  await expect(page.locator('.scene .rack-head').first()).toContainText('PDU 2/2');
  // A third finds no slot.
  await dragPart(page, typeId, await slotSpot(page, typeId, 'r1', 0));
  await expect(page.locator('#drag-chip')).toContainText('PDU slot P1 holds pdu-a01-a');
  await page.mouse.up();

  // The inspector: a new grid from the chips, then the other chips; the slot from its select.
  await device(page, 'pdu-a01-a').click();
  await expect(page.locator('#inspector .kicker')).toContainText('0U PDU 3P 30 · vertical PDU');
  await expect(page.locator('#inspector .insp-where')).toHaveText('Rack A01 · PDU slot P1');
  await expect(page.locator('#insp-grid-none')).toBeChecked();
  await page.locator('label.chip-new', { hasText: 'New grid' }).click();
  await expect(page.locator('.toast').last()).toContainText('Added Grid A for pdu-a01-a');
  expect(await pdus(page)).toEqual(['pdu-a01-a r1 P1 Grid A', 'pdu-a01-b r1 P2 -']);
  await expect(page.locator('#insp-pdu-load .meter')).toHaveCount(3);
  await expect(page.locator('#insp-slot option')).toHaveText(['P1 · left']);
  await page.selectOption('#insp-rack', 'r2');
  await expect(page.locator('#inspector .insp-where')).toHaveText('Rack A02 · PDU slot P1');
  await page.selectOption('#insp-slot', 'pdu:1');
  expect(await pdus(page)).toEqual(['pdu-a01-a r2 P2 Grid A', 'pdu-a01-b r1 P2 -']);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect(await pdus(page)).toEqual(['pdu-a01-a r1 P1 Grid A', 'pdu-a01-b r1 P2 -']);

  // The next PDU placed takes the first grid no PDU of its rack is on.
  await device(page, 'pdu-a01-b').click();
  await page.locator('label.chip-new', { hasText: 'New grid' }).click();
  expect(await plan(page, (p) => p.powerGrids.map((g) => g.name))).toEqual(['Grid A', 'Grid B']);
  await dragPart(page, typeId, await slotSpot(page, typeId, 'r2', 0));
  await page.mouse.up();
  await expect(page.locator('#place-grid option')).toHaveText(['Grid A', 'Grid B', 'No grid']);
  await expect(page.locator('#place-grid')).toHaveValue(await plan(page, (p) => p.powerGrids[0].id));
  await page.fill('#place-qty', '2');
  await page.click('#place-submit');
  expect(await pdus(page)).toEqual(['pdu-a01-a r1 P1 Grid A', 'pdu-a01-b r1 P2 Grid B', 'pdu-a02-a r2 P1 Grid A', 'pdu-a02-b r2 P2 Grid B']);
});

test('Fill PDU slots puts a PDU into each free slot of a rack, a row or a floor, with the grids in turn', async ({ page }) => {
  // Without a vertical PDU type the action is off and says why.
  await page.locator('.scene .rack-head').first().click();
  await expect(page.locator('#insp-fill-pdu')).toBeDisabled();
  await expect(page.locator('#insp-fill-pdu')).toHaveAttribute('title', 'The catalog has no vertical PDU type');
  const typeId = await addType(page, 8);
  await closeCatalog(page);
  await page.locator('.scene .rack-head').first().click();
  await page.click('#insp-fill-pdu');
  await expect(page.locator('.toast').last()).toContainText('Added 2 PDUs to Rack A01: pdu-a01-a, pdu-a01-b');
  await expect(page.locator('#insp-fill-pdu')).toBeDisabled();
  await expect(page.locator('#insp-fill-pdu')).toHaveAttribute('title', 'No PDU slot is free');
  await undoToast(page).click();
  expect(await pdus(page)).toEqual([]);

  // With grids, P1 is on the first and P2 on the second. The row's action fills the racks that have free slots.
  await page.locator('.scene .rack-head').first().click();
  await page.click('#insp-fill-pdu');
  await device(page, 'pdu-a01-a').click();
  await page.locator('label.chip-new', { hasText: 'New grid' }).click();
  await device(page, 'pdu-a01-b').click();
  await page.locator('label.chip-new', { hasText: 'New grid' }).click();
  await page.keyboard.press('Escape');
  await page.click('#btn-row');
  await page.click('[data-row-action="settings"]');
  await expect(page.locator('#insp-fill-pdu')).toBeEnabled();
  await page.click('#insp-fill-pdu');
  await expect(page.locator('.toast').last()).toContainText('Added 4 PDUs to Row A: pdu-a02-a … pdu-a03-b');
  expect(await pdus(page)).toEqual([
    'pdu-a01-a r1 P1 Grid A', 'pdu-a01-b r1 P2 Grid B',
    'pdu-a02-a r2 P1 Grid A', 'pdu-a02-b r2 P2 Grid B',
    'pdu-a03-a r3 P1 Grid A', 'pdu-a03-b r3 P2 Grid B',
  ]);
  await expect(page.locator('.scene .dev.is-pdu')).toHaveCount(6);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.scene .dev.is-pdu')).toHaveCount(2);

  // A rack type's default PDU type goes into new racks of the type, and wins over the catalog's first when filling.
  const other = await addType(page, 7);
  await page.click('#cat-tab-racks');
  await page.click('.cat-item[data-id="rack-47"]');
  await expect(page.locator('#cat-rpdu option')).toHaveText(['None', '0U PDU 3P 30', '0U PDU 1P 20 × C13']);
  await page.selectOption('#cat-rpdu', other);
  await closeCatalog(page);
  await page.click('#btn-row');
  await page.click('[data-row-action="settings"]');
  await page.click('#row-more');
  expect((await pdus(page)).filter((x) => x.includes(' r') && !/ r[123] /.test(x)).map((x) => x.replace(/ \S+ P/, ' P'))).toEqual(['pdu-a04-a P1 Grid A', 'pdu-a04-b P2 Grid B']);
  expect(await plan(page, (p, other) => p.devices.filter((d) => d.type === other).length, other)).toBe(2);
  expect(typeId).not.toBe(other);
});

test('Make vertical PDU turns the 1U PDU type of an older plan and moves its devices into PDU slots', async ({ page }) => {
  const before = await plan(page, (p) => ({ cables: p.cables.length, side: p.devices.filter((d) => d.type === 'pdu').map((d) => `${d.name} ${d.loc.kind}${d.loc.at}`) }));
  expect(before.side).toEqual(['pdu-b01-a side0', 'pdu-b01-b side1', 'pdu-b02-a side0', 'pdu-b02-b side1', 'pdu-b03-a side0', 'pdu-b03-b side1']);
  await page.click('#btn-catalog');
  await page.click('.cat-item[data-id="pdu"]');
  await expect(page.locator('#cat-kind')).toHaveValue('device');
  // While devices of the type exist its kind does not change by the Kind field: the action moves them along.
  await page.selectOption('#cat-kind', 'pdu');
  await expect(page.locator('#cat-error')).toContainText('6 devices');
  await expect(page.locator('#cat-kind')).toHaveValue('device');
  await expect(page.locator('#cat-make-pdu-tpl option')).toHaveText(['0U PDU 1P 20 × C13', '0U PDU 3P 30', '0U PDU 3P 24 × C13 metered']);
  await page.selectOption('#cat-make-pdu-tpl', '1');
  await page.click('#cat-make-pdu');
  await expect(page.locator('.toast').last()).toContainText('PDU is a vertical PDU: 6 devices moved into PDU slots');
  await expect(page.locator('#cat-sub-outlets')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#cat-sub-outlets')).toHaveText('Outlets · 30');
  const after = await plan(page, (p) => ({ cables: p.cables.length, slots: p.devices.filter((d) => d.type === 'pdu').map((d) => `${d.name} ${d.loc.kind}${d.loc.at}`) }));
  expect(after.slots).toEqual(['pdu-b01-a pdu0', 'pdu-b01-b pdu1', 'pdu-b02-a pdu0', 'pdu-b02-b pdu1', 'pdu-b03-a pdu0', 'pdu-b03-b pdu1']);
  expect(after.cables).toBe(before.cables);
  await page.click('#cat-sub-general');
  await expect(page.locator('#cat-kind')).toHaveValue('pdu');
  await expect(page.locator('#cat-make-pdu')).toHaveCount(0);
  await expect(page.locator('#cat-height')).toHaveCount(0);
  // One undo step takes the type and the devices back.
  await undoToast(page).click();
  expect(await plan(page, (p) => p.devices.filter((d) => d.type === 'pdu').every((d) => d.loc.kind === 'side'))).toBe(true);
  await expect(page.locator('#cat-kind')).toHaveValue('device');
});

test('the Outlets tab of a PDU type edits outlets, fuse groups and meter groups', async ({ page }) => {
  const typeId = await addType(page, 8);
  const pdu = () => plan(page, (p, id) => p.deviceTypes.find((t) => t.id === id).pdu, typeId);
  const groups = async (key) => (await pdu())[key].map((g) => `${g.name}:${g.outlets.join(' ')}`);
  await page.click('#cat-sub-outlets');
  await expect(page.locator('#cat-pdu-cap')).toHaveText('Capacity: 3 × 230 V × 32 A = 22.1 kW');
  await expect(page.locator('.pdu-strip .pdu-fg')).toHaveCount(6);
  await expect(page.locator('.pdu-strip .po')).toHaveCount(30);
  await expect(page.locator('#cat-fuses tbody tr')).toHaveCount(6);
  await expect(page.locator('#cat-fg-0-outlets')).toHaveValue('1-5');
  await expect(page.locator('#cat-fg-5-outlets')).toHaveValue('26-30');
  await expect(page.locator('#cat-fg-2-phase')).toHaveValue('L2');
  await expect(page.locator('#cat-meters tbody tr')).toHaveCount(3);
  await expect(page.locator('#cat-mg-0-outlets')).toHaveValue('1-10');

  // Outlets typed into a group leave the group they were in.
  await page.fill('#cat-fg-0-outlets', '1-6, 30');
  await page.press('#cat-fg-0-outlets', 'Tab');
  await expect(page.locator('#cat-fg-0-outlets')).toHaveValue('1-6, 30');
  await expect(page.locator('#cat-fg-1-outlets')).toHaveValue('7-10');
  await expect(page.locator('#cat-fg-5-outlets')).toHaveValue('26-29');
  // Outlets taken out of a group get a group of their own.
  await page.fill('#cat-fg-0-outlets', '1-5');
  await page.press('#cat-fg-0-outlets', 'Tab');
  expect((await groups('fuses')).slice(-1)).toEqual(['CB7:6 30']);
  await expect(page.locator('#cat-fuses tbody tr')).toHaveCount(7);
  // What is no list of outlets is refused with the reason, and the text stays.
  await page.fill('#cat-fg-1-outlets', '7-99');
  await page.press('#cat-fg-1-outlets', 'Tab');
  await expect(page.locator('#cat-error')).toBeVisible();
  await expect(page.locator('#cat-fg-1-outlets')).toHaveValue('7-99');
  await page.fill('#cat-fg-1-outlets', '7-10');
  await page.press('#cat-fg-1-outlets', 'Tab');
  await expect(page.locator('#cat-error')).toBeHidden();
  // Removing a group gives its outlets to the one before it; a name is taken once.
  await page.click('#cat-fg-6-del');
  await expect(page.locator('#cat-fg-5-outlets')).toHaveValue('6, 26-30');
  await page.fill('#cat-fg-1-name', 'cb1');
  await page.press('#cat-fg-1-name', 'Tab');
  await expect(page.locator('#cat-error')).toHaveText('Two fuse groups are named cb1');
  await page.fill('#cat-fg-1-name', 'F2');
  await page.press('#cat-fg-1-name', 'Tab');
  await page.fill('#cat-fg-1-ratingA', '20');
  await page.press('#cat-fg-1-ratingA', 'Tab');
  await page.selectOption('#cat-fg-1-phase', 'L3');
  expect((await pdu()).fuses[1]).toEqual({ name: 'F2', outlets: ['7', '8', '9', '10'], ratingA: 20, phase: 'L3' });
  // A new group takes half of the largest.
  await page.click('#cat-fg-add');
  await expect(page.locator('#cat-fg-6-outlets')).toBeFocused();
  await expect(page.locator('#cat-fg-6-outlets')).toHaveValue('28-30');
  await expect(page.locator('#cat-fg-5-outlets')).toHaveValue('6, 26-27');

  // Meter groups: as the fuse groups, or none with metering per outlet or at the inlet.
  await page.click('#cat-mg-same');
  await expect(page.locator('#cat-meters tbody tr')).toHaveCount(7);
  expect((await groups('meters'))[1]).toBe('M2:7 8 9 10');
  await page.selectOption('#cat-pdu-metering', 'outlet');
  await expect(page.locator('#cat-meters')).toHaveCount(0);
  expect((await pdu()).meters).toEqual([]);

  // Outlets are patterns with a connector; a single phase puts every group on L1.
  await expect(page.locator('#cat-outlets tbody tr')).toHaveCount(12);
  await page.fill('#cat-outlet-0-names', 'A[1-4]');
  await page.press('#cat-outlet-0-names', 'Tab');
  expect((await pdu()).fuses[0].outlets).toEqual(['A1', 'A2', 'A3', 'A4', '5']);
  await page.click('#cat-outlet-add');
  await expect(page.locator('#cat-sub-outlets')).toHaveText('Outlets · 31');
  await page.selectOption('#cat-pdu-phases', '1');
  await expect(page.locator('#cat-pdu-cap')).toHaveText('Capacity: 1 × 230 V × 32 A = 7.4 kW');
  expect([...new Set((await pdu()).fuses.map((f) => f.phase))]).toEqual(['L1']);
  await expect(page.locator('#cat-fg-0-phase')).toBeDisabled();
});

test('a drag across outlets in the strip of a PDU type picks them for a new group, or for one there is; the keyboard picks too', async ({ page }) => {
  const typeId = await addType(page, 8);
  await page.click('#cat-sub-outlets');
  const groups = (key) => plan(page, (p, { id, key }) => p.deviceTypes.find((t) => t.id === id).pdu[key].map((g) => `${g.name}: ${g.outlets.join(' ')}`), { id: typeId, key });
  const out = (n) => page.locator(`#cat-strip .po[data-out="${n}"]`);
  const picked = page.locator('#cat-strip .po.is-picked');
  const middle = async (n) => {
    const box = await out(n).boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  const drag = async (from, to) => {
    await page.locator('#cat-strip').scrollIntoViewIfNeeded();
    await page.mouse.move(...(await middle(from)));
    await page.mouse.down();
    await page.mouse.move(...(await middle(to)), { steps: 6 });
    await page.mouse.up();
  };
  expect(await groups('fuses')).toEqual(['CB1: 1 2 3 4 5', 'CB2: 6 7 8 9 10', 'CB3: 11 12 13 14 15', 'CB4: 16 17 18 19 20', 'CB5: 21 22 23 24 25', 'CB6: 26 27 28 29 30']);
  await expect(page.locator('#cat-pick')).toContainText('Drag across outlets in the strip to pick them for a group');

  // A drag from outlet 3 to outlet 7 picks all between, across two fuse groups.
  await drag('3', '7');
  await expect(picked).toHaveText(['3', '4', '5', '6', '7']);
  await expect(out('4')).toHaveAttribute('aria-pressed', 'true');
  await expect(out('8')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#cat-pick-text')).toHaveText('5 outlets picked: 3-7');
  await expect(page.locator('#cat-pick-to option')).toHaveText(['New fuse group', 'CB1', 'CB2', 'CB3', 'CB4', 'CB5', 'CB6', 'New meter group', 'M1', 'M2', 'M3']);
  // They become a new fuse group, with the rating and phase of the group outlet 3 was in.
  await page.click('#cat-pick-apply');
  expect(await groups('fuses')).toEqual(['CB1: 1 2', 'CB2: 8 9 10', 'CB3: 11 12 13 14 15', 'CB4: 16 17 18 19 20', 'CB5: 21 22 23 24 25', 'CB6: 26 27 28 29 30', 'CB7: 3 4 5 6 7']);
  await expect(page.locator('#cat-fg-6-outlets')).toHaveValue('3-7');
  await expect(page.locator('#cat-fg-6-outlets')).toBeFocused();
  await expect(page.locator('#cat-fg-6-phase')).toHaveValue('L1');
  await expect(picked).toHaveCount(0);
  await expect(page.locator('.pdu-fg').last()).toContainText('CB7 · 16 A · L1');

  // A click picks one outlet, Ctrl-click one more, Shift-click all up to it; a click on the only one picked lets go of it.
  await out('1').click();
  await out('9').click({ modifiers: ['Control'] });
  await expect(page.locator('#cat-pick-text')).toHaveText('2 outlets picked: 1, 9');
  await out('9').click({ modifiers: ['Control'] });
  await expect(picked).toHaveText(['1']);
  await out('1').click();
  await expect(picked).toHaveCount(0);
  await out('1').click();
  await out('2').click({ modifiers: ['Shift'] });
  await out('8').click({ modifiers: ['Control'] });
  await expect(page.locator('#cat-pick-text')).toHaveText('3 outlets picked: 1-2, 8');
  // Into a group there is: CB1 is left without outlets and is gone.
  await page.selectOption('#cat-pick-to', { label: 'CB7' });
  await page.click('#cat-pick-apply');
  expect(await groups('fuses')).toEqual(['CB2: 9 10', 'CB3: 11 12 13 14 15', 'CB4: 16 17 18 19 20', 'CB5: 21 22 23 24 25', 'CB6: 26 27 28 29 30', 'CB7: 1 2 3 4 5 6 7 8']);
  await expect(page.locator('#cat-fuses tbody tr')).toHaveCount(6);

  // A meter group from a drag; the fuse groups stay.
  expect(await groups('meters')).toEqual(['M1: 1 2 3 4 5 6 7 8 9 10', 'M2: 11 12 13 14 15 16 17 18 19 20', 'M3: 21 22 23 24 25 26 27 28 29 30']);
  await drag('13', '11');
  await expect(page.locator('#cat-pick-text')).toHaveText('3 outlets picked: 11-13');
  await page.selectOption('#cat-pick-to', 'meters:new');
  await page.click('#cat-pick-apply');
  expect(await groups('meters')).toEqual(['M1: 1 2 3 4 5 6 7 8 9 10', 'M2: 14 15 16 17 18 19 20', 'M3: 21 22 23 24 25 26 27 28 29 30', 'M4: 11 12 13']);
  expect((await groups('fuses')).length).toBe(6);

  // With the keyboard: the arrows go from outlet to outlet, Space picks, Shift+Space picks up to it.
  await out('21').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(out('23')).toBeFocused();
  await page.keyboard.press('Shift+Space');
  await expect(page.locator('#cat-pick-text')).toHaveText('3 outlets picked: 21-23');
  // A group that is these outlets already is said, and nothing changes.
  await drag('21', '25');
  await page.click('#cat-pick-apply');
  await expect(page.locator('#cat-error')).toHaveText('CB5 is these outlets already');
  await expect(picked).toHaveCount(5);
  await page.click('#cat-pick-clear');
  await expect(picked).toHaveCount(0);
  await expect(page.locator('#cat-pick')).toContainText('Drag across outlets');
  // The typed list still moves outlets.
  await page.fill('#cat-fg-0-outlets', '9-11');
  await page.keyboard.press('Tab');
  expect((await groups('fuses')).slice(0, 2)).toEqual(['CB2: 9 10 11', 'CB3: 12 13 14 15']);
});

test('cord types have a tab of their own; a rack type lists its PDU slots; a device type its inlets', async ({ page }) => {
  await page.click('#btn-catalog');
  await page.click('#cat-tab-cords');
  await expect(page.locator('#cat-list .cat-name')).toHaveText(['C14–C13 cord', 'C20–C19 cord']);
  await expect(page.locator('#cat-list .cat-sub').first()).toHaveText('C14 to C13 · 10 A · 0.6–3 m');
  await page.fill('#cat-p-lengths', '0.5, 1, 2');
  await page.press('#cat-p-lengths', 'Tab');
  await page.selectOption('#cat-p-inlet', 'c20');
  expect(await plan(page, (p) => p.cordTypes[0])).toMatchObject({ outlet: 'c13', inlet: 'c20', lengthsM: [0.5, 1, 2] });
  await page.click('#cat-new');
  await page.click('[data-template="1"]');
  await expect(page.locator('#cat-list .cat-item')).toHaveCount(3);
  await page.click('#cat-delete');
  await expect(page.locator('#cat-list .cat-item')).toHaveCount(2);

  // Rack types: up to four PDU slots, each on a side; a slot a PDU hangs in stays.
  await page.click('#cat-tab-racks');
  await page.click('.cat-item[data-id="rack-47"]');
  await expect(page.locator('.pdu-slot-pick')).toHaveCount(3);
  await expect(page.locator('#cat-pslot-0')).toHaveValue('left');
  await expect(page.locator('#cat-pslot-1')).toHaveValue('right');
  await expect(page.locator('#cat-rpdu')).toBeDisabled();
  await page.selectOption('#cat-pslot-2', 'left');
  await page.selectOption('#cat-pslot-3', 'right');
  await expect(page.locator('.pdu-slot-pick')).toHaveCount(4);
  expect(await plan(page, (p) => p.rackTypes.find((t) => t.id === 'rack-47').pduSlots)).toEqual(['left', 'right', 'left', 'right']);
  await page.keyboard.press('Escape');
  await expect(page.locator('.scene .pdu-slot')).toHaveCount(12);
  await page.locator('.scene .rack-head').first().click();
  await expect(page.locator('#inspector .insp-where')).toContainText('4 PDU slots');
  const typeId = await addType(page, 7);
  await page.keyboard.press('Escape');
  await page.locator('.scene .rack-head').first().click();
  await page.click('#insp-fill-pdu');
  await page.click('#btn-catalog');
  await page.click('#cat-tab-racks');
  await page.click('.cat-item[data-id="rack-47"]');
  await page.selectOption('#cat-pslot-3', '');
  await expect(page.locator('#cat-error')).toContainText('would lose its PDU slot');
  expect(await plan(page, (p) => p.rackTypes.find((t) => t.id === 'rack-47').pduSlots.length)).toBe(4);

  // Device types: inlets as patterns on the Ports tab; a PDU type has none.
  await page.click('#cat-tab-devices');
  await page.click('.cat-item[data-id="compute-node"]');
  await page.click('#cat-sub-ports');
  await expect(page.locator('#cat-inlets-h')).toHaveText('Inlets · 2');
  await expect(page.locator('#cat-inlet-0-names')).toHaveValue('psu[1-2]');
  await expect(page.locator('#cat-inlet-0-connector')).toHaveValue('c14');
  await page.fill('#cat-inlet-0-names', 'psu[1-4]');
  await page.press('#cat-inlet-0-names', 'Tab');
  await page.selectOption('#cat-inlet-0-connector', 'c20');
  await expect(page.locator('#cat-inlets-h')).toHaveText('Inlets · 4');
  await page.click('#cat-inlet-add');
  await expect(page.locator('#cat-inlet-1-names')).toHaveValue('psu5');
  await page.fill('#cat-inlet-1-names', 'psu4');
  await page.press('#cat-inlet-1-names', 'Tab');
  await expect(page.locator('#cat-error')).toBeVisible();
  await page.click('#cat-inlet-1-del');
  expect(await plan(page, (p) => p.deviceTypes.find((t) => t.id === 'compute-node').inlets)).toEqual([{ name: 'psu', first: 1, count: 4, connector: 'c20' }]);
  await page.click(`.cat-item[data-id="${typeId}"]`);
  await page.click('#cat-sub-ports');
  await expect(page.locator('#cat-inlets-h')).toHaveCount(0);
});

test('a vertical PDU is not turned: a selection with PDUs turns the other devices only, and Cabling offers it for none', async ({ page }) => {
  await addType(page, 8);
  await closeCatalog(page);
  await page.locator('.scene .rack-head').first().click();
  await page.click('#insp-fill-pdu');
  await expect(page.locator('.scene .dev.is-pdu')).toHaveCount(2);
  const turned = () => plan(page, (p) => ['pdu-a01-a', 'pdu-a01-b', 'cn-001'].map((n) => !!p.devices.find((d) => d.name === n).reversed));
  expect(await turned()).toEqual([false, false, false]);

  // PDUs alone: nothing to turn.
  await device(page, 'pdu-a01-a').click();
  await expect(page.locator('#insp-mount-label')).toHaveCount(0);
  await device(page, 'pdu-a01-b').click({ modifiers: ['Shift'] });
  await expect(page.locator('#inspector .multi-title')).toHaveText('2 devices');
  await expect(page.locator('input[name="multi-mount"]')).toHaveCount(0);
  // With a server: it turns, the PDUs stay as they hang.
  await device(page, 'cn-001').click({ modifiers: ['Shift'] });
  await expect(page.locator('#inspector .multi-title')).toHaveText('3 devices');
  await page.click('label:has(#multi-mount-back)');
  await expect(page.locator('#multi-mount-back')).toBeChecked();
  expect(await turned()).toEqual([false, false, true]);
  await page.keyboard.press('Control+z');
  expect(await turned()).toEqual([false, false, false]);

  // The Cabling inspector of a PDU keeps its slack per cable, without the way it is mounted.
  await page.click('.ws-switch [data-workspace="cabling"]');
  await page.locator('.scene .dev.is-pdu').first().click();
  await expect(page.locator('#inspector .name-static')).toHaveText('pdu-a01-a');
  await expect(page.locator('#cab-dev-slack')).toBeVisible();
  await expect(page.locator('input[name="cab-mount"]')).toHaveCount(0);
  await page.locator(`.scene .dev[data-dev="${await plan(page, (p) => p.devices.find((d) => d.name === 'cn-001').id)}"]`).click();
  await expect(page.locator('#inspector .name-static')).toHaveText('cn-001');
  await expect(page.locator('input[name="cab-mount"]')).toHaveCount(2);
});

test('a number of a PDU type or a cord type that is emptied keeps its value', async ({ page }) => {
  const typeId = await addType(page, 8);
  const pdu = () => plan(page, (p, id) => p.deviceTypes.find((t) => t.id === id).pdu, typeId);
  await page.click('#cat-sub-outlets');
  const before = await pdu();
  expect([before.voltageV, before.maxA, before.spanU]).toEqual([230, 32, 42]);
  for (const [id, value] of [['#cat-pdu-volts', '230'], ['#cat-pdu-max', '32'], ['#cat-pdu-span', '42']]) {
    await page.fill(id, '');
    await page.press(id, 'Tab');
    await expect(page.locator(id)).toHaveValue(value);
  }
  expect(await pdu()).toEqual(before);
  await expect(page.locator('#cat-pdu-cap')).toHaveText('Capacity: 3 × 230 V × 32 A = 22.1 kW');
  await expect(page.locator('#cat-error')).toBeHidden();
  // A number typed still counts.
  await page.fill('#cat-pdu-volts', '400');
  await page.press('#cat-pdu-volts', 'Tab');
  expect((await pdu()).voltageV).toBe(400);

  await page.click('#cat-tab-cords');
  await expect(page.locator('#cat-p-max')).toHaveValue('10');
  await page.fill('#cat-p-max', '');
  await page.press('#cat-p-max', 'Tab');
  await expect(page.locator('#cat-p-max')).toHaveValue('10');
  expect(await plan(page, (p) => p.cordTypes[0].maxA)).toBe(10);
  await page.fill('#cat-p-max', '16');
  await page.press('#cat-p-max', 'Tab');
  expect(await plan(page, (p) => p.cordTypes[0].maxA)).toBe(16);
});
