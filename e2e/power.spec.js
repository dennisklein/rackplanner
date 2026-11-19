'use strict';

// The Power workspace: switching to it, the elevation and connecting, the
// left panel (cord types and power grids), the inspectors, the outlet map,
// the schedule, the Load view, search, what moving a device does to its
// cords, and the floor map's meter for power at worst. The example plan
// has PDUs on two grids and cords in Row B.
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

/** Runs `fn(project, arg, RP)` in the page, with the plan as it is. */
const plan = (page, fn, arg) =>
  page.evaluate(({ fn, arg }) => new Function('p', 'arg', 'RP', `return (${fn})(p, arg, RP)`)(window.RP.app.project(), arg, window.RP), { fn: fn.toString(), arg });
const idOf = (page, name) => plan(page, (p, name) => p.devices.find((d) => d.name === name).id, name);
const cords = (page) => plan(page, (p) => p.powerCords.length);
const cordBy = (page, label) => plan(page, (p, label) => p.powerCords.find((c) => c.label === label) || null, label);
const undoToast = (page) => page.locator('.toast button', { hasText: 'Undo' }).last();
const toast = (page) => page.locator('.toast').last();
const inlet = async (page, device, name) => page.locator(`.scene [data-inlet="${await idOf(page, device)}|${name}"]`);
const outlet = async (page, pdu, name) => page.locator(`.scene [data-outlet="${await idOf(page, pdu)}|${name}"]`);
const view = (page, id) => page.click(`#pow-toggle [data-pow-view="${id}"]`);

/** Opens the Power workspace on Row B, where the example has its PDUs. */
async function toPower(page) {
  await page.click('.ws-switch [data-workspace="power"]');
  await page.click('#btn-row-next');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await expect(page.locator('.scene .pw-pdu')).toHaveCount(6);
}

test('the switch has three workspaces: C steps through them and P goes to Power', async ({ page }) => {
  await expect(page.locator('.ws-switch [data-workspace]')).toHaveText(['Racks', 'Cabling', 'Power']);
  await page.keyboard.press('c');
  await expect(page.locator('#cab-toggle')).toBeVisible();
  await page.keyboard.press('c');
  await expect(page.locator('#app')).toHaveClass(/is-power/);
  await expect(page.locator('#pow-toggle')).toBeVisible();
  await expect(page.locator('#cab-toggle')).toBeHidden();
  await expect(page.locator('.view-toggle')).toBeHidden();
  await expect(page.locator('#pow-types-sec')).toBeVisible();
  await expect(page.locator('#pow-grids-sec')).toBeVisible();
  await expect(page.locator('#cab-types-sec')).toBeHidden();
  await expect(page.locator('#racks-parts-sec')).toBeHidden();
  await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Search devices, PDUs and cords');
  await expect(page.locator('.ws-switch [data-workspace="power"]')).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).hash).toContain('ws=power');

  // The elevation opens from the rear, where the cords run.
  await expect(page.locator('#pow-sides [data-pow-side="rear"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#scene')).toHaveAttribute('aria-label', /^Power cabling of Ground floor, Row A, seen from the rear$/);

  // C goes on to Racks, as it was; P comes straight back.
  await page.keyboard.press('c');
  await expect(page.locator('#app')).not.toHaveClass(/is-power/);
  await expect(page.locator('#racks-parts-sec')).toBeVisible();
  await expect(page.locator('#pow-types-sec')).toBeHidden();
  await expect(page.locator('.view-toggle')).toBeVisible();
  await expect(page.locator('.scene .dev')).toHaveCount(37);
  await page.keyboard.press('p');
  await expect(page.locator('#pow-toggle')).toBeVisible();
  await page.keyboard.press('p');
  await expect(page.locator('#pow-toggle')).toBeVisible();

  // A reload opens where the address says.
  await page.reload();
  await expect(page.locator('#app')).toHaveClass(/is-power/);
  await expect(page.locator('.scene .pw-dev').first()).toBeVisible();

  // Network cables are not drawn here, and power cords not in Cabling.
  await page.click('#btn-row-next');
  await expect(page.locator('.scene .pw-cord')).toHaveCount(33);
  await expect(page.locator('.scene .cable')).toHaveCount(0);
  await page.click('.ws-switch [data-workspace="cabling"]');
  await page.click('#cab-toggle [data-cab-view="elevation"]');
  await expect(page.locator('.scene .pw-cord')).toHaveCount(0);
});

test('the help lists the how-tos and shortcuts of Power; the status line names the workspace and what was connected', async ({ page }) => {
  await page.keyboard.press('p');
  await expect(page.locator('#status')).toHaveText('Power workspace');
  await page.keyboard.press('?');
  const help = page.locator('#dlg-help');
  await expect(page.locator('#help-title')).toHaveText('Power: how-tos and shortcuts');
  await expect(help.locator('.howto dt')).toHaveText(['Hang PDUs', 'Connect', 'Connect many at once', 'Check the load', 'Order']);
  await expect(help.locator('.keys')).toContainText('Next workspace: Racks, Cabling, Power');
  await expect(help.locator('.keys')).toContainText('The Power workspace');
  await expect(help.locator('.keys')).not.toContainText('Bare devices');
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
});

test('the bar above the drawing is as high in Power as in Cabling, and the plan name keeps its room', async ({ page }) => {
  const navHeight = () => page.locator('#stage .nav').evaluate((n) => Math.round(n.getBoundingClientRect().height));
  for (const width of [961, 1024, 1181, 1280, 1367, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.click('.ws-switch [data-workspace="cabling"]');
    const cabling = await navHeight();
    await page.click('.ws-switch [data-workspace="power"]');
    expect(await navHeight(), `at ${width} px`).toBe(cabling);
    expect(await page.locator('#plan-name').evaluate((e) => e.scrollWidth > e.clientWidth), `the plan name at ${width} px`).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `the page at ${width} px`).toBe(false);
  }
});

test('a click on an inlet and then on an outlet connects them; Delete unplugs; undo and redo follow', async ({ page }) => {
  await toPower(page);
  expect(await cords(page)).toBe(33);
  // psu2 of sw-mgmt-b01 has no cord in the example.
  const free = await inlet(page, 'sw-mgmt-b01', 'psu2');
  await free.click();
  await expect(page.locator('#armed-hint')).toContainText('a free outlet of a PDU to connect sw-mgmt-b01 psu2 with Auto');
  await expect(page.locator('#inspector .name-static')).toHaveText('sw-mgmt-b01');
  await (await outlet(page, 'pdu-b01-b', '11')).click();
  await expect(toast(page)).toContainText('Connected sw-mgmt-b01 psu2 to pdu-b01-b outlet 11 as P-0034');
  expect(await cords(page)).toBe(34);
  const made = await cordBy(page, 'P-0034');
  expect(made).toMatchObject({ type: null, lengthM: null, color: null, inlet: { inlet: 'psu2' }, outlet: { outlet: '11' } });
  await expect(page.locator('#armed-hint')).toBeHidden();
  // The new cord is selected: its inspector, and its line in the drawing.
  await expect(page.locator('#pow-label')).toHaveValue('P-0034');
  await expect(page.locator('#inspector .kicker')).toContainText('Power cord · Grid B');
  await expect(page.locator('#inspector .insp-where')).toHaveText('sw-mgmt-b01 psu2 → pdu-b01-b · 11');
  await expect(page.locator(`.scene [data-cord="${made.id}"]`)).toHaveCount(1);
  await expect(page.locator('.scene .pw-cord.is-selected')).toHaveCount(1);

  // Its fields: a type, a length and a color of its own.
  await page.selectOption('#pow-type', 'c14-c13');
  await page.fill('#pow-length', '2,5');
  await page.locator('#pow-length').blur();
  await page.selectOption('#pow-color', 'own');
  expect(await cordBy(page, 'P-0034')).toMatchObject({ type: 'c14-c13', lengthM: 2.5 });
  expect((await cordBy(page, 'P-0034')).color).toMatch(/^#[0-9a-f]{6}$/);
  await page.fill('#pow-label', 'P-MGMT-2');
  await expect.poll(() => cordBy(page, 'P-MGMT-2')).not.toBeNull();
  // A cord that is too short says so.
  await page.fill('#pow-length', '0.2');
  await page.locator('#pow-length').blur();
  await expect(page.locator('#pow-cord-checks')).toContainText('Cord too short');

  // Delete unplugs the cord selected; the toast's Undo plugs it back in.
  await page.locator('#scene').focus();
  await page.keyboard.press('Delete');
  await expect(toast(page)).toContainText('Unplugged P-MGMT-2');
  expect(await cords(page)).toBe(33);
  await undoToast(page).click();
  expect(await cords(page)).toBe(34);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect((await cordBy(page, 'P-0034')).lengthM).toBe(2.5);
  await page.keyboard.press('Control+Shift+z');
  expect(await cordBy(page, 'P-MGMT-2')).not.toBeNull();

  // Esc stops a connection that was started.
  await page.locator('.scene [data-cord]').first().click({ force: true });
  await page.keyboard.press('Escape');
  await (await outlet(page, 'pdu-b01-b', '12')).click();
  await expect(page.locator('#armed-hint')).toContainText('a free inlet of a device to connect pdu-b01-b outlet 12');
  await page.keyboard.press('Escape');
  await expect(page.locator('#armed-hint')).toBeHidden();
  expect(await page.evaluate(() => window.RP.app.ui.powPending)).toBeNull();
});

test('a drag from an inlet to an outlet connects them; a cord to another rack or a taken outlet is refused', async ({ page }) => {
  await toPower(page);
  await page.keyboard.press('1');
  const from = await inlet(page, 'sw-mgmt-b01', 'psu2');
  const to = await outlet(page, 'pdu-b01-b', '12');
  await from.scrollIntoViewIfNeeded();
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + 10, { steps: 3 });
  await expect(page.locator('.pow-band')).toBeVisible();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(toast(page)).toContainText('Connected sw-mgmt-b01 psu2 to pdu-b01-b outlet 12');
  expect(await cords(page)).toBe(34);
  await undoToast(page).click();
  expect(await cords(page)).toBe(33);

  // The outlet of a PDU in another rack: a cord stays in its rack.
  await page.keyboard.press('0');
  await (await inlet(page, 'sw-mgmt-b01', 'psu2')).click();
  await (await outlet(page, 'pdu-b02-b', '2')).click();
  await expect(page.locator('.toast.warn').last()).toContainText(/rack/i);
  expect(await cords(page)).toBe(33);
  // The connection is still being made; an outlet with a cord says so.
  await expect(page.locator('#armed-hint')).toBeVisible();
  await (await outlet(page, 'pdu-b01-b', '1')).click();
  await expect(page.locator('.toast.warn').last()).toContainText('pdu-b01-b outlet 1 already has P-0002');
  expect(await cords(page)).toBe(33);
});

test('the cord type armed in the left panel is the type of new cords; one that does not fit gets a check', async ({ page }) => {
  await toPower(page);
  await expect(page.locator('#pow-types .cab-card')).toHaveText([/Auto/, /C14–C13 cord.*outlet C13 · inlet C14.*9/s, /C20–C19 cord.*outlet C19 · inlet C20.*24/s]);
  await expect(page.locator('#pow-types .cab-card[data-pow-type="auto"]')).toHaveClass(/is-armed/);
  await page.click('#pow-types .cab-card[data-pow-type="c20-c19"]');
  await expect(page.locator('#pow-types .cab-card[data-pow-type="c20-c19"]')).toHaveAttribute('aria-checked', 'true');
  await (await inlet(page, 'sw-mgmt-b01', 'psu2')).click();
  await expect(page.locator('#armed-hint')).toContainText('with C20–C19 cord');
  await (await outlet(page, 'pdu-b01-b', '11')).click();
  // The cord is made as asked for; that its plugs do not fit is a check, which the toast and the inspector tell.
  await expect(page.locator('.toast.warn').last()).toContainText('as P-0034: plug does not fit');
  expect((await cordBy(page, 'P-0034')).type).toBe('c20-c19');
  await expect(page.locator('#pow-cord-checks')).toContainText('C20–C19 cord on a C14 inlet on a C13 outlet');
  await undoToast(page).click();
  expect(await cords(page)).toBe(33);
  // With the type that fits, the cord names it.
  await page.click('#pow-types .cab-card[data-pow-type="c14-c13"]');
  await (await inlet(page, 'sw-mgmt-b01', 'psu2')).click();
  await (await outlet(page, 'pdu-b01-b', '11')).click();
  expect(await cords(page)).toBe(34);
  expect((await cordBy(page, 'P-0034')).type).toBe('c14-c13');
  await expect(page.locator('#pow-cord-checks')).toContainText('No problems');
  await expect(page.locator('#pow-types .cab-card[data-pow-type="c14-c13"] .part-count')).toHaveText('10');
  // The Catalog button opens the cord types.
  await page.click('#btn-pow-catalog');
  await expect(page.locator('#cat-tab-cords')).toHaveAttribute('aria-selected', 'true');
});

test('the left panel lists the power grids: add, rename, recolor, note, hide and delete', async ({ page }) => {
  await toPower(page);
  const rows = page.locator('#pow-grids .cl-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Grid A');
  await expect(rows.nth(0).locator('.cl-note')).toHaveText('UPS 1, room 0.12');
  await expect(rows.nth(0).locator('.cl-count')).toHaveText('18');
  await expect(rows.nth(1).locator('.cl-count')).toHaveText('15');

  // The eye of a grid hides its cords in the elevation.
  await rows.nth(1).locator('.cl-eye').click();
  await expect(page.locator('.scene .pw-cord')).toHaveCount(18);
  await expect(page.locator('#pow-grids-hidden')).toContainText('1 grid hidden');
  await page.click('#pow-grids-hidden [data-show-all]');
  await expect(page.locator('.scene .pw-cord')).toHaveCount(33);

  // A new grid takes the next name and color.
  await page.click('#btn-add-grid');
  await expect(page.locator('#grid-name')).toHaveValue('Grid C');
  await page.fill('#grid-note', 'Utility, no UPS');
  await page.click('#grid-submit');
  await expect(rows).toHaveCount(3);
  expect(await plan(page, (p) => p.powerGrids.map((g) => `${g.name}|${g.note}`))).toEqual(['Grid A|UPS 1, room 0.12', 'Grid B|UPS 2, room 0.14', 'Grid C|Utility, no UPS']);
  await undoToast(page).click();
  await expect(rows).toHaveCount(2);

  // Rename and recolor; a name another grid has is refused.
  await rows.nth(0).locator('.cl-edit').click({ force: true });
  await expect(page.locator('#grid-title')).toHaveText('Grid A');
  await page.fill('#grid-name', 'grid b');
  await page.click('#grid-submit');
  await expect(page.locator('#grid-error')).toBeVisible();
  await page.fill('#grid-name', 'Feed A');
  await page.locator('#grid-colors input[type="radio"]').nth(3).check({ force: true });
  await page.click('#grid-submit');
  await expect(page.locator('#dlg-grid')).toBeHidden();
  const g = await plan(page, (p) => p.powerGrids[0]);
  expect(g.name).toBe('Feed A');
  expect(g.color).not.toBe('#d1453b');
  await expect(rows.nth(0)).toContainText('Feed A');
  // The cords of its PDUs take the new color.
  const stroke = await page.locator('.scene .pw-cord').first().getAttribute('stroke');
  expect([g.color, '#2b6cd4']).toContain(stroke);

  // Deleting a grid leaves its PDUs without one.
  await rows.nth(1).locator('.cl-main').click();
  await page.click('#grid-delete');
  await expect(page.locator('#confirm-body')).toContainText('3 PDUs stay, without a grid');
  await page.click('#confirm-ok');
  await expect(rows).toHaveText([/Feed A/, /No grid/]);
  expect(await plan(page, (p) => p.devices.filter((d) => d.loc.kind === 'pdu' && !d.grid).length)).toBe(3);
  await expect(page.locator('#pow-checks')).toContainText('PDU without a grid');
});

test('the inspector of a device lists its inlets and where they go; Unplug all and Connect series', async ({ page }) => {
  await toPower(page);
  await page.locator('.scene .pw-dev[aria-label^="gpu-srv-01,"]').click();
  await expect(page.locator('#inspector .name-static')).toHaveText('gpu-srv-01');
  await expect(page.locator('#inspector .insp-sub')).toContainText('3 kW · 4 of 4 inlets have a cord');
  await expect(page.locator('#pow-dev-note')).toHaveText('Redundant: Grid A and Grid B');
  const rows = page.locator('#pow-inlets .pl-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('psu1');
  await expect(rows.nth(0)).toContainText('C20 · 750 W');
  await expect(rows.nth(0)).toContainText('pdu-b02-a · 5');
  await expect(rows.nth(0)).toContainText('CB1 · L1 · M1');
  await expect(rows.nth(0)).toContainText('1.5 kW with one grid down');
  // Its cords are bold in the drawing, with the far ends named.
  await expect(page.locator('.scene .pw-cord.is-selected')).toHaveCount(4);
  await expect(page.locator('#scene')).toContainText('pdu-b02-a · 5');
  await expect(page.locator('#pow-dev-series')).toBeDisabled();

  // A click on a far end selects the cord.
  await rows.nth(1).locator('.pl-peer').click();
  await expect(page.locator('#pow-label')).toHaveValue(/^P-\d{4}$/);
  // A label emptied continues the series.
  await page.fill('#pow-label', '');
  await page.locator('#pow-label').blur();
  await expect(page.locator('#pow-label')).toHaveValue('P-0034');
  expect(await cordBy(page, 'P-0034')).not.toBeNull();
  await page.keyboard.press('Control+z');
  expect(await cordBy(page, 'P-0034')).toBeNull();
  await page.locator('#inspector [data-pow-device]').first().click();
  await expect(page.locator('#inspector .name-static')).toHaveText('gpu-srv-01');

  // Unplug all asks, and takes every cord of the device.
  await page.click('#pow-dev-unplug');
  await expect(page.locator('#confirm-title')).toHaveText('Unplug 4 cords?');
  await page.click('#confirm-ok');
  await expect.poll(() => cords(page)).toBe(29);
  await expect(page.locator('#pow-dev-note')).toHaveText('No inlet has a cord yet.');
  await expect(rows.nth(0)).toContainText('no cord');

  // Connect series plans a cord for each free inlet, spread over the PDUs and their fuse groups.
  await page.click('#pow-dev-series');
  await expect(page.locator('#pow-series-preview tbody tr')).toHaveCount(4);
  await expect(page.locator('#pow-series-submit')).toHaveText('Connect 4 cords');
  await page.click('#pow-series-submit');
  await expect(toast(page)).toContainText('Connected 4 cords');
  expect(await cords(page)).toBe(33);
  const ends = await plan(page, (p) => {
    const d = p.devices.find((x) => x.name === 'gpu-srv-01');
    const name = (id) => p.devices.find((x) => x.id === id).name;
    return p.powerCords.filter((c) => c.inlet.device === d.id).map((c) => `${c.inlet.inlet} ${name(c.outlet.device)}`).sort();
  });
  expect(ends).toEqual(['psu1 pdu-b02-a', 'psu2 pdu-b02-b', 'psu3 pdu-b02-a', 'psu4 pdu-b02-b']);
  await expect(page.locator('#inspector .multi-title')).toHaveText('4 power cords');
  await undoToast(page).click();
  expect(await cords(page)).toBe(29);

  // The inspector's Connect starts a connection from a free inlet.
  await page.locator('.scene .pw-dev[aria-label^="gpu-srv-01,"]').click();
  await page.locator('#pow-inlets [data-pow-plug="psu1"]').click();
  await expect(page.locator('#armed-hint')).toContainText('gpu-srv-01 psu1');
});

test('the front shows the devices with their inlets, but no cords', async ({ page }) => {
  await toPower(page);
  await page.click('#pow-sides [data-pow-side="front"]');
  await expect(page.locator('#scene')).toHaveAttribute('aria-label', /seen from the front$/);
  await expect(page.locator('.scene .pw-cord')).toHaveCount(0);
  await expect(page.locator('.scene [data-inlet]').first()).toBeVisible();
  await expect(page.locator('.scene .pw-pdu')).toHaveCount(6);
  // The first rack is on the left from the front, on the right from the rear.
  const x = (name) => page.locator(`.scene .pw-rack[data-rack]`).evaluateAll((list, name) => list.map((g) => g.getBoundingClientRect().left), name);
  const front = await x();
  await page.click('#pow-sides [data-pow-side="rear"]');
  await expect(page.locator('.scene .pw-cord')).toHaveCount(33);
  const racks = await plan(page, (p) => p.floors[0].rows[1].racks.map((r) => r.id));
  const order = await page.locator('.scene .pw-rack[data-rack]').evaluateAll((list) => list.map((g) => g.dataset.rack));
  expect(order).toEqual(racks.slice().reverse());
  expect(front.length).toBe(3);
});

test('the outlet map draws the PDUs of a rack with outlets, fuse groups and a scenario switch', async ({ page }) => {
  await toPower(page);
  await view(page, 'outlets');
  await expect(page.locator('#pow-host h2')).toHaveText('Outlets of Rack B01');
  await expect(page.locator('#zoom')).toBeHidden();
  const pdus = page.locator('#pow-host .om-pdu');
  await expect(pdus).toHaveCount(2);
  await expect(pdus.nth(0).locator('.om-head')).toContainText('pdu-b01-a');
  await expect(pdus.nth(0).locator('.om-head')).toContainText('P1 · left');
  await expect(pdus.nth(0).locator('.om-head')).toContainText('Grid A');
  await expect(pdus.nth(0).locator('.om-out')).toHaveCount(30);
  await expect(pdus.nth(0).locator('.om-out.is-used')).toHaveCount(4);
  await expect(pdus.nth(0).locator('.om-fuse-head')).toHaveCount(6);
  await expect(pdus.nth(0).locator('.om-out').first()).toContainText('core-sw-01 · psu1');
  await expect(pdus.nth(0).locator('.om-out').first()).toContainText('175 W');
  await expect(pdus.nth(0).locator('.om-out').first()).toContainText('M1');
  await expect(pdus.nth(0).locator('.om-meters')).toContainText('M1 525 W');

  // With Grid B down, the PDU on Grid A carries the whole load and the other has no power.
  await page.click('#pow-host [data-pow-scen="pg-b"]');
  await expect(pdus.nth(0).locator('.om-out').first()).toContainText('350 W');
  await expect(pdus.nth(1)).toHaveClass(/is-down/);
  await expect(pdus.nth(1).locator('.om-down')).toHaveText('Grid B down: no power');
  await page.click('#pow-host [data-pow-scen="__up"]');
  await expect(pdus.nth(1)).not.toHaveClass(/is-down/);

  // A fuse group has an inspector: its load in each scenario, its outlets and its meter group.
  await pdus.nth(0).locator('.om-fuse-head').first().click();
  await expect(page.locator('#inspector .kicker')).toContainText('Fuse group · Grid A');
  await expect(page.locator('#inspector .name-static')).toHaveText('CB1');
  await expect(page.locator('#inspector .insp-where')).toHaveText('pdu-b01-a · 16 A · L1 · outlets 1–5');
  await expect(page.locator('#pow-fuse-load tbody tr')).toHaveText([/All grids up\s*350 W\s*1.5 A/, /Grid A down\s*0 W\s*0 A/, /Grid B down\s*525 W\s*2.3 A/]);
  await expect(page.locator('#inspector')).toContainText('M1 · outlets 1–10');

  // An outlet with a cord selects it; a free one starts a connection, which an inlet in the elevation ends.
  await pdus.nth(0).locator('.om-out').first().click();
  await expect(page.locator('#pow-label')).toHaveValue('P-0001');
  await pdus.nth(1).locator('.om-out').nth(10).click();
  await expect(page.locator('#armed-hint')).toContainText('pdu-b01-b outlet 11');
  await view(page, 'elevation');
  await expect(page.locator('#armed-hint')).toBeVisible();
  await (await inlet(page, 'sw-mgmt-b01', 'psu2')).click();
  expect(await cords(page)).toBe(34);

  // The next rack, and a rack without PDUs.
  await view(page, 'outlets');
  await page.click('#pow-host [data-om-step="1"]');
  await expect(page.locator('#pow-host h2')).toHaveText('Outlets of Rack B02');
  await page.selectOption('#om-rack', { label: 'Rack B03' });
  await expect(page.locator('#pow-host h2')).toHaveText('Outlets of Rack B03');
  await page.click('#btn-row-prev');
  await expect(page.locator('#pow-host .pm-none')).toContainText('has no PDU');
});

test('the schedule lists the cords in groups, filters them and shows what to order', async ({ page }) => {
  await toPower(page);
  await view(page, 'schedule');
  const rows = page.locator('#ps-body tr[data-cord]');
  await expect(page.locator('#ps-title')).toHaveText('Power cords of Row B');
  await expect(rows).toHaveCount(33);
  await expect(page.locator('#ps-body .sc-group')).toHaveCount(6);
  await expect(page.locator('#ps-body .sc-group').first()).toContainText('pdu-b01-a · Rack B01 · P1');
  await expect(rows.first()).toContainText('P-0001');
  await expect(rows.first()).toContainText('core-sw-01 · psu1');
  await expect(rows.first().locator('td')).toHaveText([/^$/, 'P-0001', 'core-sw-01 · psu1', 'pdu-b01-a', '1', 'CB1', 'L1', 'M1', /C14–C13 cord\s*auto/, '1 m', '175 W', '350 W', '']);
  await expect(rows.first().locator('td.is-auto')).toHaveCount(1);

  // The order list: by cord type, length and color.
  await expect(page.locator('#ps-bom')).toContainText('33 cords of Row B');
  await expect(page.locator('#ps-bom .bom-type')).toHaveCount(2);
  await expect(page.locator('#ps-bom .bom-type').first()).toContainText('C14–C13 cord');
  await expect(page.locator('#ps-bom .bom-type').first()).toContainText('= 9');
  await expect(page.locator('#ps-bom .bom-type').nth(1)).toContainText('= 24');

  // Groups fold; another grouping; the filter.
  await page.locator('#ps-body .sc-fold').first().click();
  await expect(rows).toHaveCount(29);
  await page.selectOption('#ps-group', 'grid');
  await expect(page.locator('#ps-body .sc-group')).toHaveText([/Grid A\s*18 cords/, /Grid B\s*15 cords/]);
  await expect(rows).toHaveCount(33);
  await page.fill('#ps-filter', 'gpu-srv-01');
  await expect(rows).toHaveCount(4);
  await expect(page.locator('#ps-sub')).toContainText('33 cords · 4 shown');
  await expect(page.locator('#ps-filter')).toBeFocused();

  // A click selects a cord, Ctrl adds one, Shift a range, Ctrl+A all those shown.
  await rows.nth(0).locator('td').nth(1).click();
  await expect(page.locator('#pow-label')).toBeVisible();
  await rows.nth(2).locator('td').nth(1).click({ modifiers: ['Shift'] });
  await expect(page.locator('#inspector .multi-title')).toHaveText('3 power cords');
  await rows.nth(3).locator('.sc-check input').click();
  await expect(page.locator('#inspector .multi-title')).toHaveText('4 power cords');
  await expect(page.locator('#ps-all')).toBeChecked();
  await page.fill('#ps-filter', '');
  await page.locator('#ps-table').click({ position: { x: 300, y: 8 } });
  await page.keyboard.press('Control+a');
  await expect(page.locator('#inspector .multi-title')).toHaveText('33 power cords');
  await page.click('#pow-cords-unplug');
  expect(await cords(page)).toBe(0);
  await expect(page.locator('#ps-body .sc-none')).toContainText('No power cords in Row B yet');
  await undoToast(page).click();
  await expect(rows).toHaveCount(33);

  // Floor and plan: the same cords here, as only Row B has PDUs.
  await page.click('#pow-host [data-pow-scope="plan"]');
  await expect(page.locator('#ps-title')).toHaveText('Power cords of the plan');
  await expect(rows).toHaveCount(33);

  // Connect series from the schedule: every free inlet of the scope.
  await page.click('#ps-series');
  await expect(page.locator('#pow-series-preview tbody tr')).toHaveCount(1);
  await expect(page.locator('#pow-series-preview tbody tr')).toContainText('sw-mgmt-b01 · psu2');
  await expect(page.locator('#pow-series-skipped')).toBeVisible();
  await page.click('#pow-series-submit');
  expect(await cords(page)).toBe(34);
  expect((await cordBy(page, 'P-0034')).inlet.inlet).toBe('psu2');
});

test('the Load view lists grid, PDU, phase and fuse group; the plan sets the limit and the power factor', async ({ page }) => {
  await toPower(page);
  await view(page, 'load');
  await expect(page.locator('#pow-host h2')).toHaveText('Load of Row B');
  await expect(page.locator('#pow-host .ld-grid')).toHaveText([/Grid A\s*3 PDUs in Row B\s*10.6 kW\s*20.7 kW/, /Grid B\s*3 PDUs in Row B\s*10.1 kW\s*20.2 kW/]);
  await expect(page.locator('#pow-host .ld-pdu')).toHaveCount(6);
  await expect(page.locator('#pow-host .ld-phase')).toHaveCount(18);
  await expect(page.locator('#pow-host .ld-fuse')).toHaveCount(36);
  const b02 = page.locator('#pow-host .ld-pdu', { hasText: 'pdu-b02-a' });
  await expect(b02.locator('td')).toHaveText([/pdu-b02-a\s*P1 · Rack B02/, '22.1 kW', '5 kW', '9.9 kW', /45 %/, '']);
  // The fuse groups of a PDU fold away.
  await b02.locator('.sc-fold').click();
  await expect(page.locator('#pow-host .ld-fuse')).toHaveCount(30);
  await b02.locator('.sc-fold').click();

  // Nothing selected: the checks of the row and the settings of the plan.
  await expect(page.locator('#inspector .kicker')).toContainText('Row B · power');
  await expect(page.locator('#pow-checks')).toContainText('No redundancy');
  await expect(page.locator('#pow-checks')).toContainText('All live inlets of core-sw-02 are on Grid A');
  await expect(page.locator('#pow-limit')).toHaveValue('80');
  await expect(page.locator('#pow-pf')).toHaveValue('1');
  await page.fill('#pow-limit', '60');
  await page.locator('#pow-limit').blur();
  expect(await plan(page, (p) => p.powerSettings)).toEqual({ powerFactor: 1, limitPct: 60 });
  await expect(page.locator('#pow-checks')).toContainText('Fuse over 60 %');
  await expect(page.locator('#pow-host .ld-fuse .sc-flag', { hasText: 'Over 60 %' }).first()).toBeVisible();
  await page.fill('#pow-pf', '0.9');
  await page.locator('#pow-pf').blur();
  expect(await plan(page, (p) => p.powerSettings.powerFactor)).toBe(0.9);
  await expect(page.locator('#pow-host .fm-title p')).toContainText('power factor 0.9');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(page.locator('#pow-limit')).toHaveValue('80');

  // A check leads to what it is about; a line of the table to its PDU or fuse group.
  await page.locator('#pow-checks .check-link', { hasText: 'No redundancy' }).click();
  await expect(page.locator('#inspector .name-static')).toHaveText('core-sw-02');
  await expect(page.locator('#pow-dev-note')).toHaveText('No redundancy: every cord is on Grid A');
  await page.locator('#pow-host .ld-fuse .sc-dev').first().click();
  await expect(page.locator('#inspector .kicker')).toContainText('Fuse group');
  await page.locator('#pow-host .ld-pdu .sc-dev').first().click();
  await expect(page.locator('#inspector .kicker')).toContainText('Grid A · vertical PDU');
  await expect(page.locator('#pow-pdu-load .meter')).toHaveCount(4);
  // The PDU's grid is set here too.
  await page.selectOption('#pow-pdu-grid', 'pg-b');
  expect(await plan(page, (p) => p.devices.find((d) => d.name === 'pdu-b01-a').grid)).toBe('pg-b');
  await expect(page.locator('#inspector .kicker')).toContainText('Grid B · vertical PDU');

  // A row without PDUs says so, with the way to the Racks workspace.
  await page.click('#btn-row-prev');
  await expect(page.locator('#pow-host .cab-empty h2')).toHaveText('No PDUs in Row A');
  await page.click('#pow-host [data-pow-go-racks]');
  await expect(page.locator('#racks-parts-sec')).toBeVisible();
});

test('the search finds PDUs and cords in Power, and selects them there', async ({ page }) => {
  await toPower(page);
  await page.click('#search');
  await page.keyboard.type('P-0007');
  await expect(page.locator('#search-results .sr-group', { hasText: 'Power cords' })).toBeVisible();
  await expect(page.locator('#search-results .sr-item')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('#pow-label')).toHaveValue('P-0007');
  await expect(page.locator('.scene .pw-cord.is-selected')).toHaveCount(1);

  await page.click('#search');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('pdu-b03-b');
  await expect(page.locator('#search-results .sr-item')).toContainText(['pdu-b03-b']);
  await page.keyboard.press('Enter');
  await expect(page.locator('#inspector .name-static')).toHaveText('pdu-b03-b');
  await expect(page.locator('#inspector .kicker')).toContainText('Grid B · vertical PDU');
  await expect(page.locator('.scene .pw-pdu.is-selected')).toHaveCount(1);

  // From another row, the result's row is shown; in the schedule the cord's line.
  await view(page, 'schedule');
  await page.click('#btn-row-prev');
  await page.click('#search');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('gpu-srv-06 psu4');
  await page.keyboard.press('Enter');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await expect(page.locator('#ps-body tr.is-selected')).toHaveCount(1);
  await expect(page.locator('#ps-body tr.is-selected')).toContainText('gpu-srv-06 · psu4');

  // In Racks the search finds a PDU as a device; its inspector opens it in Power.
  await page.click('.ws-switch [data-workspace="racks"]');
  await page.click('#search');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('pdu-b02-a');
  await page.keyboard.press('Enter');
  await expect(page.locator('#insp-name')).toHaveValue('pdu-b02-a');
  await page.click('#insp-open-power');
  await expect(page.locator('#app')).toHaveClass(/is-power/);
  await expect(page.locator('#inspector .name-static')).toHaveText('pdu-b02-a');
});

test('moving a device or a PDU to another rack unplugs its cords after asking, and names them', async ({ page }) => {
  await page.click('#btn-row-next');
  await page.locator('.scene .dev[aria-label^="core-sw-01,"]').click();
  const b02 = await plan(page, (p) => p.floors[0].rows[1].racks[1].id);
  await page.selectOption('#insp-rack', b02);
  await expect(page.locator('#confirm-title')).toHaveText('Unplug 2 power cords?');
  await expect(page.locator('#confirm-body')).toContainText('P-0001');
  await expect(page.locator('#confirm-body')).toContainText('P-0002');
  // Cancel leaves the device and its cords.
  await page.click('#dlg-confirm button[value="cancel"]');
  expect(await cords(page)).toBe(33);
  expect(await plan(page, (p) => p.devices.find((d) => d.name === 'core-sw-01').loc.rack)).not.toBe(b02);
  await page.selectOption('#insp-rack', b02);
  await page.click('#confirm-ok');
  await expect.poll(() => cords(page)).toBe(31);
  expect(await plan(page, (p) => p.devices.find((d) => d.name === 'core-sw-01').loc.rack)).toBe(b02);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  expect(await cords(page)).toBe(33);

  // Within its rack a device keeps its cords; deleting it deletes them.
  await page.locator('.scene .dev[aria-label^="core-sw-01,"]').click();
  await page.keyboard.press('ArrowDown');
  expect(await cords(page)).toBe(33);
  await page.keyboard.press('Delete');
  expect(await cords(page)).toBe(31);
  await undoToast(page).click();
  expect(await cords(page)).toBe(33);

  // A PDU moved to another slot of its rack keeps its cords; deleted, it takes them along.
  await page.locator('.scene .dev[aria-label^="pdu-b03-a,"]').click({ force: true });
  await expect(page.locator('#insp-name')).toHaveValue('pdu-b03-a');
  await page.keyboard.press('Delete');
  expect(await cords(page)).toBe(26);
  await undoToast(page).click();
  expect(await cords(page)).toBe(33);
});

test('a change of a device’s type names the power cords it unplugs and asks first; Cancel leaves them as they are', async ({ page }) => {
  await page.click('#btn-row-next');
  const gpu = page.locator('.scene .dev[aria-label^="gpu-srv-01,"]');
  await gpu.click();
  // A patch panel has neither ports nor inlets.
  await page.selectOption('#insp-type', 'patch-panel');
  await expect(page.locator('#confirm-title')).toHaveText('Unplug 4 cables and 4 power cords?');
  await expect(page.locator('#confirm-body')).toContainText('It has no inlet in the place of the inlets of gpu-srv-01 that these power cords are plugged into: P-0008 (gpu-srv-01 psu1 to pdu-b02-a outlet');
  for (const label of ['P-0009', 'P-0010', 'P-0011']) await expect(page.locator('#confirm-body')).toContainText(label);
  await expect(page.locator('#confirm-ok')).toHaveText('Unplug them');
  await page.click('#dlg-confirm button[value="cancel"]');
  // Asking changed nothing: every cord has both its ends, in the plan and in its file.
  await expect(page.locator('#insp-type')).toHaveValue('gpu-server');
  expect(await plan(page, (p, arg, RP) => [p.powerCords.length, p.powerCords.filter((c) => !c.inlet.inlet || !c.outlet.outlet).length, JSON.parse(RP.io.serialize(p)).powerCords.length])).toEqual([33, 0, 33]);

  // A compute node has two inlets: the cords on psu3 and psu4 go, with the cables that find no port.
  await page.selectOption('#insp-type', 'compute-node');
  await expect(page.locator('#confirm-title')).toHaveText('Unplug 2 cables and 2 power cords?');
  await expect(page.locator('#confirm-body')).toContainText('P-0010 (gpu-srv-01 psu3 to pdu-b02-a outlet');
  await expect(page.locator('#confirm-body')).toContainText('P-0011 (gpu-srv-01 psu4 to pdu-b02-b outlet');
  await expect(page.locator('#confirm-body')).not.toContainText('P-0008');
  await page.click('#confirm-ok');
  await expect(toast(page)).toContainText('Changed gpu-srv-01 to Compute node; unplugged 2 cables and 2 power cords');
  expect(await cords(page)).toBe(31);
  await undoToast(page).click();
  expect(await cords(page)).toBe(33);

  // A device without cables: the question is about its cords alone.
  await page.click('.ws-switch [data-workspace="cabling"]');
  const gpuId = await idOf(page, 'gpu-srv-01');
  const inCabling = page.locator(`.scene .dev[data-dev="${gpuId}"]`);
  await inCabling.scrollIntoViewIfNeeded();
  const box = await inCabling.boundingBox();
  await page.mouse.click(box.x + box.width * 0.45, box.y + 4);
  await page.click('#cab-dev-unplug');
  await page.click('#confirm-ok');
  await expect.poll(() => plan(page, (p, id, RP) => RP.cabling.cablesOfDevice(p, id).length, gpuId)).toBe(0);
  await page.click('.ws-switch [data-workspace="racks"]');
  await gpu.click();
  await page.selectOption('#insp-type', 'patch-panel');
  await expect(page.locator('#confirm-title')).toHaveText('Unplug 4 power cords?');
  await expect(page.locator('#confirm-body')).toContainText('Patch panel has no inlet in the place of the inlets of gpu-srv-01 that these power cords are plugged into: P-0008');
  await expect(page.locator('#confirm-ok')).toHaveText('Unplug 4 cords');
  await page.click('#confirm-ok');
  await expect(toast(page)).toContainText('Changed gpu-srv-01 to Patch panel; unplugged 4 power cords');
  expect(await cords(page)).toBe(29);
});

test('a copy of devices with their PDUs copies the power cords between them', async ({ page }) => {
  await page.click('#btn-row-next');
  // A fourth rack with free PDU slots, for the copy of everything in Rack B03.
  await page.locator('.scene .add-rack').click();
  const [b03, b04] = await plan(page, (p) => ['Rack B03', 'Rack B04'].map((name) => p.floors[0].rows[1].racks.find((r) => r.name === name).id));
  await page.locator(`.rack-head[data-rack="${b03}"]`).click();
  await page.click('#insp-rack-select');
  await page.keyboard.press('Control+d');
  await expect(toast(page)).toContainText(/Duplicated 7 devices, \d+ cables and 14 power cords, from /);
  expect(await cords(page)).toBe(47);
  // The copies are plugged into the copies of the PDUs, in their rack, with the labels going on.
  expect(
    await plan(
      page,
      (p, rack) => {
        const there = new Set(p.devices.filter((d) => d.loc.rack === rack).map((d) => d.id));
        return p.powerCords.filter((c) => there.has(c.inlet.device) && there.has(c.outlet.device)).map((c) => c.label);
      },
      b04
    )
  ).toEqual(Array.from({ length: 14 }, (_, i) => `P-00${34 + i}`));
  await undoToast(page).click();
  expect(await cords(page)).toBe(33);
});

test('deleting devices or a rack asks about the power cords that go with them, and counts them', async ({ page }) => {
  await page.click('#btn-row-next');
  // The two PDUs of Rack B03 have no cables, but fourteen cords.
  await page.locator('.scene .dev[aria-label^="pdu-b03-a,"]').click({ force: true });
  await page.locator('.scene .dev[aria-label^="pdu-b03-b,"]').click({ force: true, modifiers: ['Shift'] });
  await page.keyboard.press('Delete');
  await expect(page.locator('#confirm-title')).toHaveText('Delete 2 devices?');
  await expect(page.locator('#confirm-body')).toHaveText('This deletes 2 devices and 14 power cords. Undo brings them back.');
  await page.click('#confirm-ok');
  await expect(toast(page)).toContainText('Deleted 2 devices and 14 power cords');
  expect(await cords(page)).toBe(19);
  await undoToast(page).click();
  expect(await cords(page)).toBe(33);

  // One device goes without a question; what went with it is counted.
  await page.locator('.scene .dev[aria-label^="core-sw-01,"]').click();
  await page.keyboard.press('Delete');
  await expect(toast(page)).toContainText('Deleted core-sw-01, 6 cables and 2 power cords');
  await undoToast(page).click();

  // A rack names its cords with its devices and cables.
  const b03 = await plan(page, (p) => p.floors[0].rows[1].racks[2].id);
  await page.locator(`.rack-head[data-rack="${b03}"]`).click();
  await page.click('#insp-del-rack');
  await expect(page.locator('#confirm-body')).toContainText(/It holds 7 devices, \d+ cables and 14 power cords, which are deleted with it/);
  await page.click('#confirm-ok');
  await expect.poll(() => cords(page)).toBe(19);
});

test('Tab reaches the checkbox of a row of the schedule; Space switches it and the focus stays, as on the fold of a group', async ({ page }) => {
  await toPower(page);
  await view(page, 'schedule');
  const rows = page.locator('#ps-body tr[data-cord]');
  await expect(rows).toHaveCount(33);
  const box = (i) => rows.nth(i).locator('.sc-check input');
  const fold = page.locator('#ps-body .sc-fold').first();

  // From the checkbox of the header: the fold of the first group, then its rows.
  await page.locator('#ps-all').focus();
  await page.keyboard.press('Tab');
  await expect(fold).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(box(0)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('#pow-label')).toHaveValue('P-0001');
  await expect(box(0)).toBeChecked();
  await expect(box(0)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(box(1)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('#inspector .multi-title')).toHaveText('2 power cords');
  await expect(box(1)).toBeFocused();
  // Space again takes the cord out of the selection.
  await page.keyboard.press('Space');
  await expect(page.locator('#pow-label')).toHaveValue('P-0001');
  await expect(box(1)).not.toBeChecked();
  await expect(box(1)).toBeFocused();
  // Delete, with the focus on a row, unplugs what is selected.
  await page.keyboard.press('Delete');
  await expect(rows).toHaveCount(32);
  await undoToast(page).click();
  await expect(rows).toHaveCount(33);

  // A click with the mouse leaves the focus where it was.
  await page.locator('#ps-filter').focus();
  await box(2).click();
  await expect(box(2)).toBeChecked();
  await expect(page.locator('#ps-filter')).toBeFocused();

  // The fold of a group keeps the focus when its rows go and come back.
  await fold.focus();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(29);
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(fold).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(33);
  await expect(fold).toBeFocused();
});

test('the inspector’s Connect keeps the focus while it starts and stops a connection', async ({ page }) => {
  await toPower(page);
  await page.locator('.scene .pw-dev[aria-label^="sw-mgmt-b01,"]').click();
  await expect(page.locator('#inspector .name-static')).toHaveText('sw-mgmt-b01');
  const plug = page.locator('#pow-inlets [data-pow-plug="psu2"]');
  await expect(plug).toHaveText('Connect');
  await plug.focus();
  await page.keyboard.press('Enter');
  await expect(plug).toHaveText('Connecting…');
  await expect(plug).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#armed-hint')).toContainText('sw-mgmt-b01 psu2');
  await expect(plug).toBeFocused();
  // The same key stops it again.
  await page.keyboard.press('Enter');
  await expect(plug).toHaveText('Connect');
  await expect(plug).toHaveAttribute('aria-pressed', 'false');
  await expect(plug).toBeFocused();

  // From a view without inlets and outlets it goes to the elevation, with the focus still on the button.
  await view(page, 'schedule');
  await expect(page.locator('#ps-table')).toBeVisible();
  await expect(page.locator('#inspector .name-static')).toHaveText('sw-mgmt-b01');
  await plug.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#pow-toggle [data-pow-view="elevation"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#ps-table')).toBeHidden();
  await expect(plug).toHaveAttribute('aria-pressed', 'true');
  await expect(plug).toBeFocused();
});

test('the title of a “One down” figure in the Load view names the grid that is down for it', async ({ page }) => {
  await toPower(page);
  await view(page, 'load');
  const pdu = (name) => page.locator('#pow-host .ld-pdu', { hasText: name });
  const down = (name) => pdu(name).locator('td').nth(3);
  // Two grids: a PDU carries the most when the other grid is down.
  await expect(down('pdu-b02-a')).toHaveText('9.9 kW');
  await expect(down('pdu-b02-a')).toHaveAttribute('title', 'Highest when Grid B is down');
  await expect(down('pdu-b02-b')).toHaveAttribute('title', 'Highest when Grid A is down');

  // One grid: its PDUs carry nothing when it is down, which is less than with all grids up.
  const grids = page.locator('#pow-grids .cl-row');
  await grids.nth(1).locator('.cl-main').click();
  await page.click('#grid-delete');
  await page.click('#confirm-ok');
  await expect(grids).toHaveText([/Grid A/, /No grid/]);
  await expect(pdu('pdu-b02-a').locator('td')).toHaveText([/pdu-b02-a/, '22.1 kW', '5 kW', '0 kW', /22 %/, '']);
  await expect(down('pdu-b02-a')).toHaveAttribute('title', 'Highest when Grid A is down');
  await expect(down('pdu-b02-b')).toHaveAttribute('title', 'Highest when Grid A is down');
  await expect(page.locator('#pow-host .ld-phase td[title]').first()).toHaveAttribute('title', 'Highest when Grid A is down');
  await expect(page.locator('#pow-host .ld-fuse td[title]').first()).toHaveAttribute('title', 'Highest when Grid A is down');

  // No grid: nothing to take down, so it is the load with all grids up.
  await grids.nth(0).locator('.cl-main').click();
  await page.click('#grid-delete');
  await page.click('#confirm-ok');
  await expect(grids).toHaveText([/No grid/]);
  await expect(down('pdu-b02-a')).toHaveAttribute('title', 'The plan has no power grid: the load with all grids up');
  await expect(down('pdu-b02-a')).toHaveText('5 kW');
});

test('a device type without inlets is told in the panel, with a button that adds them', async ({ page }) => {
  await plan(page, (p) => p.deviceTypes.filter((t) => p.devices.some((d) => d.type === t.id)).map((t) => `${t.label}:${(t.inlets || []).length}`));
  // Take the inlets of a type away through the catalog's data: a plan of version 5 has such types.
  await page.click('.ws-switch [data-workspace="power"]');
  await expect(page.locator('#pow-noinlets')).toBeHidden();
  await page.click('.ws-switch [data-workspace="racks"]');
  await page.click('#btn-catalog');
  await page.locator('#cat-list .cat-item', { hasText: 'Compute node' }).click();
  await page.click('#cat-sub-ports');
  await page.locator('[data-pw-del^="inlets:"]').first().click();
  await page.keyboard.press('Escape');
  await page.click('.ws-switch [data-workspace="power"]');
  await expect(page.locator('#pow-noinlets')).toContainText('devices have no inlets');
  await expect(page.locator('#pow-checks')).toContainText('No inlets');
  await page.click('#pow-noinlets [data-pow-add-inlets]');
  await expect(toast(page)).toContainText('the inlets psu1 and psu2');
  await expect(page.locator('#pow-noinlets')).toBeHidden();
  expect(await plan(page, (p) => p.deviceTypes.find((t) => t.label === 'Compute node').inlets.length)).toBeGreaterThan(0);
});

test('the floor map has a meter for power at worst: the highest use of a rating in each rack', async ({ page }) => {
  await page.keyboard.press('m');
  await expect(page.locator('#floormap')).toBeVisible();
  await page.click('.fm-metric [data-metric="worst"]');
  await expect(page.locator('.fm-metric [data-metric="worst"]')).toHaveAttribute('aria-pressed', 'true');
  // Row A has no PDUs; in Row B the fuse groups of the GPU racks carry the most when a grid is down.
  await expect(page.locator('.fm-rack .fm-val')).toHaveText(['no PDU', 'no PDU', 'no PDU', '14%', '65%', '65%']);
  const b02 = page.locator('.fm-rack', { hasText: 'B02' });
  await expect(b02).toHaveAttribute('aria-label', /65% of a rating at worst$/);
  await expect(b02.locator('.fm-meter > i')).toHaveAttribute('style', 'left:80%');
  await expect(page.locator('.fm-rack.is-over')).toHaveCount(0);
  // A lower limit: the racks over it are marked, and the tick moves.
  await page.click('.ws-switch [data-workspace="power"]');
  await page.fill('#pow-limit', '50');
  await page.locator('#pow-limit').blur();
  await page.click('.ws-switch [data-workspace="racks"]');
  await expect(page.locator('#floormap')).toBeVisible();
  await expect(page.locator('.fm-rack.is-over')).toHaveCount(2);
  await expect(b02).toHaveAttribute('aria-label', /65% of a rating at worst, over the limit$/);
  await expect(b02.locator('.fm-meter > i')).toHaveAttribute('style', 'left:50%');
  // The meter stays picked over a reload.
  await page.reload();
  await expect(page.locator('.fm-metric [data-metric="worst"]')).toHaveAttribute('aria-pressed', 'true');
});
