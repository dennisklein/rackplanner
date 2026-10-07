'use strict';

// The Cabling workspace: switching to it, the schedule and its filters, the
// cable inspectors, Connect series and + Cable, the order list, CSVs in and
// out, search, and the network dialog.
const { test, expect } = require('@playwright/test');
const fs = require('fs');

test.beforeEach(async ({ page }) => {
  // These tests are about the schedule: the Cabling workspace opens on it, as it does once it was shown last.
  await page.addInitScript(() => {
    const key = 'rackplanner.prefs.v1';
    const prefs = JSON.parse(localStorage.getItem(key) || '{}');
    if (!prefs.cabView) localStorage.setItem(key, JSON.stringify(Object.assign(prefs, { cabView: 'schedule' })));
  });
  await page.goto('/index.html');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

/** Runs `fn(project, arg, RP)` in the page, with the plan as it is. */
const plan = (page, fn, arg) =>
  page.evaluate(({ fn, arg }) => new Function('p', 'arg', 'RP', `return (${fn})(p, arg, RP)`)(window.RP.app.project(), arg, window.RP), { fn: fn.toString(), arg });
const idOf = (page, name) => plan(page, (p, name) => p.devices.find((d) => d.name === name).id, name);
const cableBy = (page, label) => plan(page, (p, label) => p.cables.find((c) => c.label === label) || null, label);
const rows = (page) => page.locator('#sc-body tr[data-cable]');
/** The schedule's row of the cable labeled `label`. */
const row = (page, label) => page.locator('#sc-body tr[data-cable]').filter({ has: page.locator('.sc-label', { hasText: new RegExp(`^${label}$`) }) });
const undoToast = (page) => page.locator('.toast button', { hasText: 'Undo' }).last();

async function toCabling(page) {
  await page.click('.ws-switch [data-workspace="cabling"]');
  await expect(page.locator('#sc-body tr[data-cable]').first()).toBeVisible();
}
/** Clicks a row of the schedule on its label, away from the device links. */
const pick = (page, label, modifiers) => row(page, label).first().locator('td').nth(1).click({ modifiers });

test('the workspace switches with its button and with C; the Racks workspace stays as it was', async ({ page }) => {
  // Something to come back to: a selected device and a scrolled sheet.
  await page.locator('.scene .dev[aria-label^="cn-001,"]').click();
  await expect(page.locator('#insp-name')).toHaveValue('cn-001');
  await page.locator('#canvas').evaluate((c) => (c.scrollTop = 140));
  const scroll = await page.locator('#canvas').evaluate((c) => c.scrollTop);

  await toCabling(page);
  await expect(page.locator('.ws-switch [data-workspace="cabling"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#scene')).toBeHidden();
  await expect(page.locator('#cab-host')).toBeVisible();
  await expect(page.locator('#cab-types-sec')).toBeVisible();
  await expect(page.locator('#cab-nets-sec')).toBeVisible();
  await expect(page.locator('#racks-parts-sec')).toBeHidden();
  await expect(page.locator('#racks-clusters-sec')).toBeHidden();
  await expect(page.locator('.view-toggle')).toBeHidden();
  await expect(page.locator('#cab-toggle [data-cab-view="schedule"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#zoom')).toBeHidden();
  await expect(page.locator('.cab-card[data-cab-type="auto"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#networks .cl-name')).toHaveText(['Management', 'BMC', 'InfiniBand', 'Storage 25G', 'SAS']);
  // Nothing is selected in Cabling: the row's cabling.
  await expect(page.locator('#inspector .kicker')).toHaveText('Cabling · Row A');
  // Arrows and M do nothing here; the device selected in Racks is not moved.
  const loc = await plan(page, (p) => JSON.stringify(p.devices.find((d) => d.name === 'cn-001').loc));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('m');
  expect(await plan(page, (p) => JSON.stringify(p.devices.find((d) => d.name === 'cn-001').loc))).toBe(loc);
  await expect(page.locator('#cab-host')).toBeVisible();

  // A cable type is armed with a click.
  await page.click('.cab-card[data-cab-type="dac-qsfp56"]');
  await expect(page.locator('.cab-card[data-cab-type="dac-qsfp56"]')).toHaveClass(/is-armed/);
  expect(await page.evaluate(() => window.RP.app.ui.cabType)).toBe('dac-qsfp56');

  // C goes back to Racks, as it was: selection, scroll, panels.
  await page.keyboard.press('c');
  await expect(page.locator('#scene')).toBeVisible();
  await expect(page.locator('#cab-host')).toBeHidden();
  await expect(page.locator('.scene .dev')).toHaveCount(37);
  await expect(page.locator('#insp-name')).toHaveValue('cn-001');
  await expect(page.locator('#racks-parts-sec')).toBeVisible();
  await expect(page.locator('#cab-types-sec')).toBeHidden();
  await expect(page.locator('.view-toggle')).toBeVisible();
  await expect(page.locator('#cab-toggle')).toBeHidden();
  await expect(page.locator('#zoom')).toBeVisible();
  expect(await page.locator('#canvas').evaluate((c) => c.scrollTop)).toBe(scroll);
  await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Search devices, racks, rows, floors');

  // C typed into a field is just a letter.
  await page.click('#search');
  await page.keyboard.type('c');
  await expect(page.locator('#scene')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('.nav').click({ position: { x: 700, y: 20 } });
  await page.keyboard.press('c');
  await expect(page.locator('#cab-host')).toBeVisible();
  await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Search devices and cables');
});

test('the schedule lists the row’s cables in groups that fold, for the row, the floor or the plan', async ({ page }) => {
  await toCabling(page);
  const expected = await plan(page, (p, a, RP) => RP.cabling.groupCables(p, RP.cabling.cablesWithin(p, 'row1'), 'route').map((g) => [g.label, g.cables.length]));
  await expect(page.locator('#sc-title')).toHaveText('Row A · cable schedule');
  await expect(page.locator('#sc-sub')).toHaveText('112 cables with an end in this row · lengths in italics are estimates');
  await expect(rows(page)).toHaveCount(112);
  await expect(page.locator('.sc-fold b')).toHaveText(expected.map(([l]) => l));
  await expect(page.locator('.sc-group .sc-count').first()).toHaveText(`${expected[0][1]} cables`);

  // A row: label, both ends with their places, the cable, speed, length and check.
  const r = row(page, 'IB-0001');
  await expect(r.locator('td').nth(2)).toHaveText('cn-001 ib0');
  await expect(r.locator('td').nth(3)).toHaveText('A01 · U4–5');
  await expect(r.locator('td').nth(5)).toHaveText('ib-leaf-a01 p1');
  await expect(r.locator('td').nth(7)).toHaveText('DAC');
  await expect(r.locator('td').nth(8)).toHaveText('200G');
  const len = r.locator('td').nth(9);
  await expect(len).toHaveClass(/is-auto/);
  await expect(len).toHaveAttribute('title', /^needs \d+(\.\d)? m$/);
  // The DAC that was ordered too short is flagged.
  const late = await plan(page, (p) => p.cables.find((c) => c.type === 'dac-qsfp56').label);
  await expect(row(page, late).locator('.sc-flag.is-warn')).toHaveText('Too long');
  await expect(row(page, late).locator('.sc-flag')).toHaveAttribute('title', /reaches 3 m/);
  await expect(page.locator('.sc-group', { hasText: 'Rack A02 ⇄ A03' }).locator('.sc-flag')).toHaveText('1 to check');

  // Folding a group hides its cables, and is kept while the plan changes, and across the workspaces.
  const fold = page.locator('.sc-fold', { hasText: 'Within Rack A01' });
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(rows(page)).toHaveCount(112 - expected[0][1]);
  const other = await rows(page).first().locator('.sc-label').textContent();
  await pick(page, other);
  await page.locator('label.chip:has(input[name="cab-net"][value="n-sas"]) span').click();
  expect((await cableBy(page, other)).network).toBe('n-sas');
  await page.keyboard.press('Escape');
  await page.locator('#sc-title').click();
  await page.keyboard.press('c');
  await expect(page.locator('#scene')).toBeVisible();
  await page.keyboard.press('c');
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(rows(page)).toHaveCount(112 - expected[0][1]);
  await page.keyboard.press('Control+z');
  expect((await cableBy(page, other)).network).not.toBe('n-sas');
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#sc-body .sc-fold', { hasText: 'Within Rack A01' }).click();
  await expect(rows(page)).toHaveCount(112);

  // Floor and plan.
  await page.click('[data-sc-scope="floor"]');
  const floor = await plan(page, (p, a, RP) => RP.cabling.cablesWithin(p, 'f1').length);
  await expect(page.locator('#sc-title')).toHaveText('Ground floor · cable schedule');
  await expect(page.locator('#sc-sub')).toContainText(`${floor} cables with an end on this floor`);
  await page.click('[data-sc-scope="plan"]');
  await expect(page.locator('#sc-title')).toHaveText('Hall 2 expansion · cable schedule');
  await expect(rows(page)).toHaveCount(await plan(page, (p) => p.cables.length));
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rackplanner.prefs.v1')).cabScope)).toBe('plan');

  // Grouped by network, the groups follow the networks.
  await page.selectOption('#sc-group', 'network');
  await expect(page.locator('.sc-fold b')).toHaveText(['Management', 'BMC', 'InfiniBand', 'Storage 25G', 'SAS']);
  await page.selectOption('#sc-group', 'type');
  await expect(page.locator('.sc-fold b').first()).toHaveText('Cat6a patch cord');
});

test('network chips, the network in focus and the text filter narrow the schedule', async ({ page }) => {
  await toCabling(page);
  await expect(page.locator('#sc-nets .chip-net')).toHaveCount(5);
  // A network unticked leaves the table.
  await page.locator('#sc-nets label', { hasText: 'InfiniBand' }).click();
  const ib = await plan(page, (p, a, RP) => RP.cabling.cablesWithin(p, 'row1').filter((c) => c.network === 'n-ib').length);
  await expect(rows(page)).toHaveCount(112 - ib);
  await expect(page.locator('#sc-body .sc-label', { hasText: /^IB-/ })).toHaveCount(0);
  await expect(page.locator('#sc-sub')).toContainText(`${112 - ib} shown`);
  await page.locator('#sc-nets label', { hasText: 'InfiniBand' }).click();
  await expect(rows(page)).toHaveCount(112);

  // A network clicked in the panel is the only one shown; Esc shows all again.
  await page.locator('#networks .cl-main', { hasText: 'Management' }).click();
  await expect(page.locator('#networks .cl-main', { hasText: 'Management' })).toHaveAttribute('aria-pressed', 'true');
  const mgt = await plan(page, (p, a, RP) => RP.cabling.cablesWithin(p, 'row1').filter((c) => c.network === 'n-mgmt').length);
  await expect(rows(page)).toHaveCount(mgt);
  await expect(page.locator('#sc-body .sc-label').first()).toHaveText(/^MGT-/);
  await expect(page.locator('#networks-hint')).toHaveText('Click the highlighted network again to show all cables.');
  await page.keyboard.press('Escape');
  await expect(rows(page)).toHaveCount(112);
  await expect(page.locator('#networks .cl-main', { hasText: 'Management' })).toHaveAttribute('aria-pressed', 'false');

  // Words of the filter all match: a device, then a device and a port.
  await page.fill('#sc-filter', 'ceph-01');
  await expect(rows(page)).toHaveCount(5);
  await page.fill('#sc-filter', 'ceph-01 ib');
  await expect(rows(page)).toHaveCount(2);
  await page.fill('#sc-filter', 'nothing-like-this');
  await expect(page.locator('#sc-body .sc-none')).toHaveText('No cable matches the filters.');
  await page.fill('#sc-filter', '');
  await expect(rows(page)).toHaveCount(112);
});

test('a selected cable is edited in the inspector: label, network, type, length and notes, each undone', async ({ page }) => {
  await toCabling(page);
  const before = await cableBy(page, 'IB-0001');
  await pick(page, 'IB-0001');
  await expect(row(page, 'IB-0001')).toHaveClass(/is-selected/);
  await expect(row(page, 'IB-0001').locator('input')).toBeChecked();
  await expect(page.locator('#cab-label')).toHaveValue('IB-0001');
  await expect(page.locator('#inspector .kicker')).toHaveText('Cable · InfiniBand');
  await expect(page.locator('#inspector .insp-where')).toHaveText('cn-001 → ib-leaf-a01');
  await expect(page.locator('.end-item')).toHaveCount(2);
  await expect(page.locator('.end-item').first()).toContainText('cn-001 · ib0');
  await expect(page.locator('.end-item').first()).toContainText('rear of the rack');
  await expect(page.locator('#cab-type option').first()).toHaveText('Auto: QSFP56 DAC');
  await expect(page.locator('#cab-length')).toHaveAttribute('placeholder', /^\d+(\.\d+)? m \(needs \d+(\.\d)?\)$/);
  await expect(page.locator('#inspector .check-list')).toHaveText('No problems');

  // Typed key by key, the label is one step to undo (below).
  await page.locator('#cab-label').fill('');
  await page.locator('#cab-label').pressSequentially('IB-X1');
  await expect(row(page, 'IB-X1')).toHaveCount(1);
  await page.locator('label.chip:has(input[name="cab-net"][value="n-mgmt"]) span').click();
  await expect(page.locator('#inspector .kicker')).toHaveText('Cable · Management');
  await page.selectOption('#cab-type', 'aoc-qsfp56');
  await page.fill('#cab-length', '7');
  await page.press('#cab-length', 'Tab');
  await expect(row(page, 'IB-X1').locator('td').nth(9)).toHaveText('7 m');
  await expect(row(page, 'IB-X1').locator('td').nth(9)).not.toHaveClass(/is-auto/);
  await page.fill('#cab-notes', 'Through the tray');
  await page.locator('#cab-notes').blur();
  const after = await cableBy(page, 'IB-X1');
  expect(after).toMatchObject({ id: before.id, label: 'IB-X1', network: 'n-mgmt', type: 'aoc-qsfp56', lengthM: 7, notes: 'Through the tray' });
  await expect(row(page, 'IB-X1').locator('td').nth(7)).toHaveText('AOC');

  // Each edit is its own step.
  const steps = [
    (c) => c.notes === '',
    (c) => c.lengthM === null,
    (c) => c.type === null,
    (c) => c.network === 'n-ib',
    (c) => c.label === 'IB-0001',
  ];
  for (const check of steps) {
    await page.keyboard.press('Control+z');
    const c = await plan(page, (p, id) => p.cables.find((x) => x.id === id), before.id);
    expect(check(c)).toBe(true);
  }
  expect(await plan(page, (p, id) => p.cables.find((x) => x.id === id), before.id)).toEqual(before);
});

test('Delete removes the selected cables, with Undo; Shift and Ctrl clicks and the checkboxes select', async ({ page }) => {
  await toCabling(page);
  const count = await plan(page, (p) => p.cables.length);
  await pick(page, 'MGT-0001');
  await pick(page, 'IB-0001', ['Shift']);
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(3);
  await expect(page.locator('#inspector .multi-title')).toHaveText('3 cables');
  await pick(page, 'BMC-0001', ['Control']);
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(2);
  await row(page, 'MGT-0002').locator('input').click();
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(3);
  await expect(page.locator('#sc-all')).toHaveJSProperty('indeterminate', true);

  await page.keyboard.press('Delete');
  await expect(page.locator('.toast').last()).toContainText('Deleted 3 cables');
  expect(await plan(page, (p) => p.cables.length)).toBe(count - 3);
  await expect(row(page, 'MGT-0002')).toHaveCount(0);
  await expect(page.locator('#inspector .kicker')).toHaveText('Cabling · Row A');
  await undoToast(page).click();
  expect(await plan(page, (p) => p.cables.length)).toBe(count);
  await expect(row(page, 'MGT-0002')).toHaveCount(1);

  // Ctrl+D copies nothing here; Backspace deletes too.
  const devices = await plan(page, (p) => p.devices.length);
  await pick(page, 'MGT-0001');
  await page.locator('#sc-title').click();
  await page.keyboard.press('Control+d');
  expect(await plan(page, (p) => [p.devices.length, p.cables.length])).toEqual([devices, count]);
  await expect(row(page, 'MGT-0001')).toHaveClass(/is-selected/);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.toast').last()).toContainText('Deleted MGT-0001');
  expect(await plan(page, (p) => p.cables.length)).toBe(count - 1);
  await undoToast(page).click();
  expect(await plan(page, (p) => p.cables.length)).toBe(count);

  // The header checkbox takes every cable shown, and Ctrl+A too; Esc deselects.
  await page.fill('#sc-filter', 'cn-001');
  await expect(rows(page)).toHaveCount(3);
  await page.click('#sc-all');
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(3);
  await page.click('#sc-all');
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(0);
  await page.locator('#sc-title').click();
  await page.keyboard.press('Control+a');
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(0);
});

test('Connect series joins the compute nodes’ ib0 to a leaf, with labels in series and the lengths they need', async ({ page }) => {
  await toCabling(page);
  // The compute nodes' InfiniBand cables go first.
  const old = await plan(page, (p, a, RP) =>
    p.cables
      .filter((c) => c.a.port === 'ib0' && /^cn-/.test(p.devices.find((d) => d.id === c.a.device).name))
      .map((c) => ({ port: c.b.port, length: RP.cabling.describe(p, c).lengthM }))
  );
  expect(old).toHaveLength(12);
  await page.fill('#sc-filter', 'cn- ib0');
  await expect(rows(page)).toHaveCount(12);
  await page.click('#sc-all');
  await page.keyboard.press('Delete');
  await expect(page.locator('.toast').last()).toContainText('Deleted 12 cables');
  await page.fill('#sc-filter', '');

  await page.click('#sc-series');
  await expect(page.locator('#dlg-connect')).toBeVisible();
  await expect(page.locator('#connect-kicker')).toHaveText('Connect series');
  await page.selectOption('#cs-from', await idOf(page, 'cn-001'));
  await page.selectOption('#cs-from-last', await idOf(page, 'cn-012'));
  await page.check('#cs-only');
  await page.selectOption('#cs-from-port', 'ib0');
  await page.selectOption('#cs-to', await idOf(page, 'ib-leaf-a01'));
  await page.selectOption('#cs-to-port', 'p1');
  await page.locator('#cs-nets label', { hasText: 'InfiniBand' }).click();
  const first = await plan(page, (p, a, RP) => RP.model.nextCableLabel(p, 'n-ib'));
  await expect(page.locator('#cs-label')).toHaveValue(first);
  await expect(page.locator('#cs-rows tr')).toHaveCount(12);
  await expect(page.locator('#cs-summary')).toContainText(/^12 cables · QSFP56 DAC/);
  await expect(page.locator('#cs-submit')).toHaveText('Connect 12 cables');
  await expect(page.locator('#connect-title')).toHaveText('12 devices from Rack A01');
  await page.click('#cs-submit');
  await expect(page.locator('#dlg-connect')).toBeHidden();
  await expect(page.locator('.toast').last()).toContainText('Connected 12 cables');

  const made = await plan(page, (p, a, RP) =>
    p.cables
      .filter((c) => c.a.port === 'ib0' && /^cn-/.test(p.devices.find((d) => d.id === c.a.device).name))
      .map((c) => ({ from: p.devices.find((d) => d.id === c.a.device).name, to: p.devices.find((d) => d.id === c.b.device).name, port: c.b.port, label: c.label, network: c.network, length: RP.cabling.describe(p, c).lengthM }))
  );
  const series = await plan(page, (p, first, RP) => RP.model.nameSequence(first, 12), first);
  expect(made).toEqual(
    Array.from({ length: 12 }, (_, i) => ({ from: `cn-${String(i + 1).padStart(3, '0')}`, to: 'ib-leaf-a01', port: `p${i + 1}`, label: series[i], network: 'n-ib', length: old[i].length }))
  );
  // They are selected, and Undo takes them away again.
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(12);
  await undoToast(page).click();
  expect(await plan(page, (p) => p.cables.filter((c) => c.a.port === 'ib0' && c.b.device === 'ex-2').length)).toBe(0);
});

test('+ Cable connects two ports; the type and label follow from the ports and the network', async ({ page }) => {
  await toCabling(page);
  await page.click('#sc-add');
  await expect(page.locator('#connect-kicker')).toHaveText('New cable');
  await expect(page.locator('#cs-from-last')).toBeHidden();
  await expect(page.locator('#cs-step-field')).toBeHidden();
  await page.selectOption('#cs-from', await idOf(page, 'sw-mgmt-a01'));
  await page.selectOption('#cs-from-port', 'swp13');
  await page.selectOption('#cs-to', await idOf(page, 'sw-mgmt-a02'));
  await page.selectOption('#cs-to-port', 'swp12');
  await page.locator('#cs-nets label', { hasText: 'Management' }).click();
  const label = await plan(page, (p, a, RP) => RP.model.nextCableLabel(p, 'n-mgmt'));
  await expect(page.locator('#cs-submit')).toHaveText('Connect 1 cable');
  await expect(page.locator('#cs-rows td').nth(4)).toHaveText('Cat6a patch cord');
  await page.click('#cs-submit');
  await expect(page.locator('.toast').last()).toContainText(`Connected ${label}`);
  const c = await cableBy(page, label);
  expect(c).toMatchObject({ network: 'n-mgmt', type: null, a: { device: await idOf(page, 'sw-mgmt-a01'), port: 'swp13' }, b: { device: await idOf(page, 'sw-mgmt-a02'), port: 'swp12' } });
  await expect(page.locator('#cab-label')).toHaveValue(label);
  await expect(row(page, label)).toHaveClass(/is-selected/);
  // The network used last is the next one's.
  await page.click('#sc-add');
  await expect(page.locator('#cs-nets input[value="n-mgmt"]')).toBeChecked();
  // Ports in use can't be picked; they name their cable.
  await page.selectOption('#cs-to', await idOf(page, 'sw-mgmt-a02'));
  await expect(page.locator('#cs-to-port option[value="swp1"]')).toBeDisabled();
  await expect(page.locator('#cs-to-port option[value="swp1"]')).toHaveText(/^swp1 · RJ45 1G · MGT-\d{4}$/);
  await expect(page.locator('#cs-to-port option[value="swp12"]')).toBeDisabled();
});

test('a breakout cable shows its legs; a leg is unplugged from the inspector', async ({ page }) => {
  await toCabling(page);
  await page.keyboard.press(']');
  await expect(page.locator('#sc-title')).toHaveText('Row B · cable schedule');
  const label = await plan(page, (p) => p.cables.find((c) => c.type === 'dac-osfp-2x').label);
  const r = row(page, label);
  await expect(r.locator('td').nth(2)).toHaveText('ib-leaf-b02 p1');
  await expect(r.locator('td').nth(5).locator('div')).toHaveText(['gpu-srv-01 ib0', 'gpu-srv-01 ib1']);
  await expect(r.locator('td').nth(6).locator('div')).toHaveCount(2);
  await expect(r.locator('td').nth(7)).toHaveText('DAC 1→2');

  await pick(page, label);
  await expect(page.locator('.end-tag')).toHaveText(['Head', 'Leg 1', 'Leg 2']);
  // A breakout names its type: no Auto.
  await expect(page.locator('#cab-type option').first()).toHaveText('OSFP to 2 × QSFP56 DAC');
  await page.click('[data-cab-unplug-leg="1"]');
  await expect(page.locator('.toast').last()).toContainText(`Unplugged leg 2 of ${label}`);
  expect((await cableBy(page, label)).b[1]).toBeNull();
  await expect(page.locator('.end-item.is-free')).toHaveText(/Leg 2\s*Not plugged in/);
  await undoToast(page).click();
  expect((await cableBy(page, label)).b[1]).toMatchObject({ port: 'ib1' });
});

test('the order list shows stock lengths, cables made to length with their total, and transceivers', async ({ page }) => {
  await toCabling(page);
  const bom = await plan(page, (p, a, RP) => {
    const b = RP.cabling.billOfMaterials(p, RP.cabling.cablesWithin(p, 'row1'));
    return {
      stock: b.cables.map((x) => [x.type.name, RP.cabling.fmtM(x.lengthM), x.count]),
      made: b.madeToLength.map((x) => [x.type.name, x.lengths.map((l) => `${RP.cabling.fmtM(l.lengthM)} × ${l.count}`), RP.cabling.fmtM(x.totalM)]),
      optics: b.transceivers.map((x) => [x.transceiver.name, x.count]),
    };
  });
  expect(bom.made.length).toBeGreaterThan(0);
  expect(bom.optics.length).toBeGreaterThan(0);
  const strip = page.locator('#sc-bom');
  const [type, len, n] = bom.stock[0];
  await expect(strip.locator('.bom-type', { hasText: type }).first()).toContainText(`${len} × ${n}`);
  for (const [name, lengths, total] of bom.made) {
    const t = strip.locator('.bom-type.is-made', { hasText: name });
    for (const l of lengths) await expect(t).toContainText(l);
    await expect(t.locator('.bom-total')).toHaveText(`total ${total}`);
  }
  for (const [name, count] of bom.optics) await expect(strip.locator('.bom-type.is-optic', { hasText: name })).toContainText(`× ${count}`);
  await expect(strip.locator('.bom-head')).toContainText('To order');
});

test('the cable schedule and the order list download as CSV, for the plan and for the scope', async ({ page }) => {
  await toCabling(page);
  const read = async (click) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
    return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
  };
  const total = await plan(page, (p) => p.cables.reduce((a, c) => a + (Array.isArray(c.b) ? c.b.length : 1), 0));
  const all = await read(async () => {
    await page.click('#btn-export');
    await page.click('[data-export="cables-csv"]');
  });
  expect(all.name).toBe('hall-2-expansion-cables.csv');
  const lines = all.text.replace(/^﻿/, '').trim().split('\r\n');
  expect(lines[0]).toMatch(/^Label,Network,Cable type,Length \(m\),Length,Leg,A floor/);
  expect(lines.length - 1).toBe(total);
  const order = await read(async () => {
    await page.click('#btn-export');
    await page.click('[data-export="order-csv"]');
  });
  expect(order.name).toBe('hall-2-expansion-cable-order.csv');
  expect(order.text).toContain('Item,Kind,Length (m),Count,Total (m)');
  expect(order.text).toContain('Cable, made to length');
  expect(order.text).toContain('Transceiver');

  // The strip's buttons export the schedule's scope.
  const rowCsv = await read(() => page.click('#sc-cables-csv'));
  expect(rowCsv.name).toBe('hall-2-expansion-ground-floor-row-a-cables.csv');
  const rowLegs = await plan(page, (p, a, RP) => RP.cabling.cablesWithin(p, 'row1').reduce((n, c) => n + (Array.isArray(c.b) ? c.b.length : 1), 0));
  expect(rowCsv.text.trim().split('\r\n').length - 1).toBe(rowLegs);
  const rowOrder = await read(() => page.click('#sc-order-csv'));
  expect(rowOrder.name).toBe('hall-2-expansion-ground-floor-row-a-cable-order.csv');
  // The Racks workspace keeps its exports.
  await page.keyboard.press('c');
  const inv = await read(async () => {
    await page.click('#btn-export');
    await page.click('[data-export="csv"]');
  });
  expect(inv.name).toBe('hall-2-expansion.csv');
});

test('opening a cable schedule CSV adds its cables to the plan, with Undo', async ({ page }) => {
  await toCabling(page);
  const csv = await plan(page, (p, a, RP) => RP.io.exportCablesCSV(p, p.cables.filter((c) => /^cn-0(0[1-9]|1[0-2])$/.test(p.devices.find((d) => d.id === c.a.device).name) && c.a.port === 'ib0')));
  await page.fill('#sc-filter', 'cn- ib0');
  await page.click('#sc-all');
  await page.keyboard.press('Delete');
  await page.fill('#sc-filter', '');
  const count = await plan(page, (p) => p.cables.length);
  // From the Racks workspace: the cables come in, and Cabling shows them.
  await page.keyboard.press('c');
  await page.click('#btn-open');
  await expect(page.locator('#dlg-open .dlg-sub')).toContainText('A cable schedule CSV');
  await page.fill('#open-text', csv);
  await page.click('#open-form button[type="submit"]');
  await expect(page.locator('.toast').last()).toContainText('Added 12 cables from the CSV');
  expect(await plan(page, (p) => p.cables.length)).toBe(count + 12);
  await expect(page.locator('#cab-host')).toBeVisible();
  await expect(row(page, 'IB-0001')).toHaveCount(1);
  expect(await cableBy(page, 'IB-0001')).toMatchObject({ network: 'n-ib', type: null, lengthM: null, a: { port: 'ib0' }, b: { port: 'p1' } });
  await undoToast(page).click();
  expect(await plan(page, (p) => p.cables.length)).toBe(count);

  // A file that is no cable schedule nor inventory says why.
  await page.click('#btn-open');
  await page.fill('#open-text', 'Label,A device,A port,B device,B port\nX-1,nobody,p1,cn-001,ib0');
  await page.click('#open-form button[type="submit"]');
  await expect(page.locator('.toast').last()).toContainText('The CSV added no cables');
  await expect(page.locator('#report-list')).toContainText('there is no device nobody');
});

test('search finds cables by label and ends and selects them in Cabling; devices too', async ({ page }) => {
  await toCabling(page);
  const label = await plan(page, (p) => p.cables.find((c) => c.type === 'dac-osfp-2x').label);
  await page.click('#search');
  await page.keyboard.type(label);
  const item = page.locator('.sr-item', { hasText: label });
  await expect(item).toBeVisible();
  await expect(page.locator('.sr-group').last()).toContainText('Cables');
  await expect(item.locator('.sr-detail')).toHaveText('ib-leaf-b02 p1 → gpu-srv-01 ib0, gpu-srv-01 ib1');
  await item.click();
  // The cable is on Row B: the schedule follows, and the workspace stays.
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await expect(page.locator('#cab-host')).toBeVisible();
  await expect(page.locator('#cab-label')).toHaveValue(label);
  await expect(row(page, label)).toHaveClass(/is-selected/);
  await expect(row(page, label)).toBeInViewport();

  // Ends are found too.
  await page.fill('#search', 'ceph-03 ib1');
  await expect(page.locator('.sr-item', { hasText: 'IB-' })).toHaveCount(1);
  await page.keyboard.press('Escape');

  // A device is selected in Cabling, with its ports.
  await page.fill('#search', 'oss-01');
  await page.locator('.sr-item', { hasText: 'oss-01' }).first().click();
  await expect(page.locator('#cab-host')).toBeVisible();
  await expect(page.locator('#inspector .name-static')).toHaveText('oss-01');
  await expect(page.locator('#inspector .port-list .pl-row').first()).toBeVisible();
  // A cabled port selects its cable; the port name shows the port.
  await page.locator('#inspector .pl-row').filter({ hasText: 'ib0' }).locator('.pl-peer').click();
  await expect(page.locator('#inspector .kicker')).toHaveText('Cable · InfiniBand');
});

test('cabling and the workspace survive a reload', async ({ page }) => {
  await toCabling(page);
  await pick(page, 'IB-0002');
  await page.fill('#cab-label', 'KEEP-ME');
  await page.locator('#cab-label').blur();
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.locator('#cab-host')).toBeVisible();
  await expect(page.locator('#scene')).toBeHidden();
  await expect(row(page, 'KEEP-ME')).toHaveCount(1);
  expect(await page.evaluate(() => window.RP.app.ui.workspace)).toBe('cabling');
  await page.keyboard.press('c');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

test('the network dialog adds, renames and deletes a network; its cables keep their place', async ({ page }) => {
  await toCabling(page);
  await page.click('#btn-add-network');
  await expect(page.locator('#dlg-network')).toBeVisible();
  await expect(page.locator('#network-kicker')).toHaveText('New network');
  await page.fill('#network-name', 'Uplinks');
  await expect(page.locator('#network-label')).toHaveValue('UPL-0001');
  await page.click('#network-submit');
  await expect(page.locator('#networks .cl-name')).toHaveText(['Management', 'BMC', 'InfiniBand', 'Storage 25G', 'SAS', 'Uplinks']);
  const id = await plan(page, (p) => p.networks.find((n) => n.name === 'Uplinks').id);

  // A cable takes it, and a new network straight from the inspector works too.
  await pick(page, 'IB-0003');
  await page.locator(`label.chip:has(input[name="cab-net"][value="${id}"]) span`).click();
  await expect(page.locator('#inspector .kicker')).toHaveText('Cable · Uplinks');

  await page.locator('#networks .cl-row', { hasText: 'Uplinks' }).hover();
  await page.locator('#networks .cl-row', { hasText: 'Uplinks' }).locator('.cl-edit').click();
  await expect(page.locator('#network-kicker')).toHaveText('Edit network');
  await page.fill('#network-name', 'Spine uplinks');
  // The first label is the network's own once set.
  await expect(page.locator('#network-label')).toHaveValue('UPL-0001');
  await page.fill('#network-label', 'SPN-0001');
  await page.click('#network-submit');
  await expect(page.locator('#networks .cl-name').last()).toHaveText('Spine uplinks');
  expect(await plan(page, (p, id) => p.networks.find((n) => n.id === id), id)).toMatchObject({ name: 'Spine uplinks', firstLabel: 'SPN-0001' });

  await page.locator('#networks .cl-row', { hasText: 'Spine uplinks' }).locator('.cl-edit').click();
  await page.click('#network-delete');
  await expect(page.locator('#confirm-title')).toHaveText('Delete Spine uplinks?');
  await expect(page.locator('#confirm-body')).toContainText('Its 1 cable stay');
  await page.click('#confirm-ok');
  await expect(page.locator('.toast').last()).toContainText('Deleted network Spine uplinks');
  expect(await plan(page, (p) => p.networks.length)).toBe(5);
  expect((await cableBy(page, 'IB-0003')).network).toBeNull();
  await expect(page.locator('#networks .cl-name').last()).toHaveText('No network');
  await undoToast(page).click();
  expect((await cableBy(page, 'IB-0003')).network).toBe(id);

  // + New network from the inspector gives the cable the network it creates.
  await pick(page, 'IB-0004');
  await page.locator('label.chip:has(input[name="cab-net"][value="__new"]) span').click();
  await page.fill('#network-name', 'Storage 100G');
  await page.click('#network-submit');
  await expect(page.locator('#inspector .kicker')).toHaveText('Cable · Storage 100G');
  await page.keyboard.press('Control+z');
  expect((await cableBy(page, 'IB-0004')).network).toBe('n-ib');
  expect(await plan(page, (p) => p.networks.some((n) => n.name === 'Storage 100G'))).toBe(false);
});

// ------------------------------------------------------------ revealing, keys and focus

test('a cable chosen in search, To check or a port list shows in the schedule, whatever hid it', async ({ page }) => {
  await toCabling(page);
  const fold = (name) => page.locator('#sc-body .sc-fold', { hasText: name });
  // Its group folded: search unfolds it.
  await fold('Within Rack A01').click();
  await expect(fold('Within Rack A01')).toHaveAttribute('aria-expanded', 'false');
  await page.click('#search');
  await page.keyboard.type('IB-0003');
  await expect(page.locator('.sr-item', { hasText: 'IB-0003' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#cab-label')).toHaveValue('IB-0003');
  await expect(fold('Within Rack A01')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'IB-0003')).toHaveClass(/is-selected/);
  await expect(row(page, 'IB-0003')).toBeInViewport();

  // A To check link: every group folded, a text filter and another network in focus hide its cable; they give way.
  await page.keyboard.press('Escape');
  await expect(page.locator('#inspector .kicker')).toHaveText('Cabling · Row A');
  const link = page.locator('#inspector .check-link').first();
  const label = await link.locator('b').textContent();
  const net = (await cableBy(page, label)).network;
  for (const f of await page.locator('#sc-body .sc-fold').all()) await f.click();
  await expect(rows(page)).toHaveCount(0);
  await page.locator('#networks .cl-main', { hasText: 'BMC' }).click();
  await page.fill('#sc-filter', 'cn-001');
  await link.click();
  await expect(page.locator('#cab-label')).toHaveValue(label);
  await expect(row(page, label)).toHaveClass(/is-selected/);
  await expect(row(page, label)).toBeInViewport();
  await expect(page.locator('#sc-filter')).toHaveValue('');
  expect(await page.evaluate(() => window.RP.app.ui.focusNetwork)).toBeNull();
  await expect(page.locator('#sc-body .sc-fold[aria-expanded="false"]')).not.toHaveCount(0);
  expect(net).not.toBe('n-bmc');

  // A cable of a port list, with its network's chip off: the chip comes back on.
  await page.locator('#sc-nets label', { hasText: 'InfiniBand' }).click();
  await page.fill('#search', 'cn-001');
  await page.locator('.sr-item', { hasText: 'cn-001' }).first().click();
  await expect(page.locator('#inspector .name-static')).toHaveText('cn-001');
  await page.locator('#inspector .pl-row').filter({ hasText: 'ib0' }).locator('.pl-peer').click();
  await expect(page.locator('#cab-label')).toHaveValue('IB-0001');
  await expect(page.locator('#sc-nets input[data-sc-net="n-ib"]')).toBeChecked();
  await expect(row(page, 'IB-0001')).toHaveClass(/is-selected/);
  await expect(row(page, 'IB-0001')).toBeInViewport();
});

test('+ Cable starts from a device of the row shown', async ({ page }) => {
  await toCabling(page);
  await page.keyboard.press(']');
  await expect(page.locator('#sc-title')).toHaveText('Row B · cable schedule');
  await page.click('#sc-add');
  const rowOf = (id) => plan(page, (p, id, RP) => RP.model.locateRack(p, p.devices.find((d) => d.id === id).loc.rack).row.name, id);
  expect(await rowOf(await page.locator('#cs-from').inputValue())).toBe('Row B');
  expect(await rowOf(await page.locator('#cs-to').inputValue())).toBe('Row B');
  // Any device of the plan can still be picked.
  await expect(page.locator('#cs-from option')).toHaveCount(await plan(page, (p, a, RP) => RP.model.sortedDevices(p).filter((d) => d.type !== RP.model.RESERVED.id && RP.model.expandPorts(RP.model.typeOf(p, d.type)).length).length));
});

test('Renumber follows the schedule’s order as it is when clicked', async ({ page }) => {
  await toCabling(page);
  await pick(page, 'IB-0001');
  await pick(page, 'MGT-0002', ['Control']);
  await expect(page.locator('#multi-label')).toHaveValue('IB-0001');
  // By cable type the Cat6a cables come first: the inspector follows.
  await page.selectOption('#sc-group', 'type');
  await expect(page.locator('#sc-body tr.is-selected .sc-label')).toHaveText(['MGT-0002', 'IB-0001']);
  await expect(page.locator('#inspector .contents .nm')).toHaveText(['MGT-0002', 'IB-0001']);
  await expect(page.locator('#multi-label')).toHaveValue('MGT-0002');
  await page.fill('#multi-label', 'R-001');
  await page.click('#multi-renumber');
  await expect(page.locator('#sc-body tr.is-selected .sc-label')).toHaveText(['R-001', 'R-002']);
  await expect(page.locator('.toast').last()).toContainText('Labeled R-001 … R-002');
});

test('Esc clears the selection from the schedule’s checkboxes too', async ({ page }) => {
  await toCabling(page);
  await page.click('#sc-all');
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(112);
  await expect(page.locator('#sc-all')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(0);
  await expect(page.locator('#inspector .kicker')).toHaveText('Cabling · Row A');
  // A row's checkbox reached with Tab.
  await row(page, 'MGT-0001').locator('input').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(0);
});

test('picking a row from the row menu in Cabling keeps the Racks view as it was', async ({ page }) => {
  await page.click('.view-toggle [data-view="map"]');
  await expect(page.locator('#floormap')).toBeVisible();
  await toCabling(page);
  await page.click('#btn-row');
  await page.locator('#menu-row [data-row="row2"]').click();
  await expect(page.locator('#sc-title')).toHaveText('Row B · cable schedule');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rackplanner.prefs.v1')).view)).toBe('map');
  await page.keyboard.press('c');
  await expect(page.locator('#floormap')).toBeVisible();
  await expect(page.locator('.view-toggle [data-view="map"]')).toHaveAttribute('aria-pressed', 'true');
});

test('Unplug and Del on a port unplug its cable; a breakout loses only that leg', async ({ page }) => {
  await toCabling(page);
  const count = await plan(page, (p) => p.cables.length);
  await page.click('#search');
  await page.keyboard.type('gpu-srv-01');
  await page.locator('.sr-item', { hasText: 'gpu-srv-01' }).first().click();
  await page.locator('#inspector .pl-row').filter({ hasText: 'ib1' }).locator('.pl-port').click();
  await expect(page.locator('#inspector .name-static')).toHaveText('gpu-srv-01 · ib1');
  await expect(page.locator('#cab-del')).toHaveAttribute('title', /leg/);
  await page.click('#cab-del');
  await expect(page.locator('.toast').last()).toContainText('Unplugged leg 2 of IB-0043');
  let bo = await cableBy(page, 'IB-0043');
  expect(bo.b[0]).toMatchObject({ port: 'ib0' });
  expect(bo.b[1]).toBeNull();
  // The port stays selected, free now.
  await expect(page.locator('#inspector .name-static')).toHaveText('gpu-srv-01 · ib1');
  await expect(page.locator('#cab-pc-go')).toBeVisible();
  await undoToast(page).click();
  expect((await cableBy(page, 'IB-0043')).b[1]).toMatchObject({ port: 'ib1' });

  // Del does the same, with focus away from the fields.
  await expect(page.locator('#cab-del')).toBeVisible();
  await page.locator('#inspector .name-static').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.toast').last()).toContainText('Unplugged leg 2 of IB-0043');
  bo = await cableBy(page, 'IB-0043');
  expect(bo.b[1]).toBeNull();
  expect(await plan(page, (p) => p.cables.length)).toBe(count);

  // A cable that is no breakout goes.
  await page.locator('#inspector [data-cab-select-device]').first().click();
  await page.locator('#inspector .pl-row').filter({ hasText: 'eth0' }).locator('.pl-port').click();
  const label = await page.locator('#cab-label').inputValue();
  await page.locator('#inspector .name-static').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.toast').last()).toContainText(`Unplugged ${label}`);
  expect(await cableBy(page, label)).toBeNull();
  await expect(page.locator('#cab-pc-go')).toBeVisible();
});

test('arrow keys go on through the network chips of the cable inspector', async ({ page }) => {
  await toCabling(page);
  const id = (await cableBy(page, 'IB-0001')).id;
  await pick(page, 'IB-0001');
  await page.locator('input[name="cab-net"]:checked').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#inspector .kicker')).toHaveText('Cable · Storage 25G');
  await expect(page.locator('input[name="cab-net"][value="n-stor"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#inspector .kicker')).toHaveText('Cable · SAS');
  expect((await plan(page, (p, id) => p.cables.find((c) => c.id === id), id)).network).toBe('n-sas');
  await expect(page.locator('input[name="cab-net"][value="n-sas"]')).toBeFocused();
});

test('while a network is in focus the chips show it alone, and Show all brings the others back', async ({ page }) => {
  await toCabling(page);
  await page.locator('#networks .cl-main', { hasText: 'InfiniBand' }).click();
  const ib = await plan(page, (p, a, RP) => RP.cabling.cablesWithin(p, 'row1').filter((c) => c.network === 'n-ib').length);
  await expect(rows(page)).toHaveCount(ib);
  await expect(page.locator('#sc-nets .chip-net')).toHaveCount(1);
  await expect(page.locator('#sc-nets input[data-sc-net="n-ib"]')).toBeChecked();
  await expect(page.locator('#sc-nets input[data-sc-net="n-ib"]')).toBeDisabled();
  // A network unticked before the focus does not hide the network in focus.
  await page.click('#sc-nets [data-sc-unfocus]');
  await expect(page.locator('#sc-nets .chip-net')).toHaveCount(5);
  await expect(rows(page)).toHaveCount(112);
  await page.locator('#sc-nets label', { hasText: 'InfiniBand' }).click();
  await page.locator('#networks .cl-main', { hasText: 'InfiniBand' }).click();
  await expect(rows(page)).toHaveCount(ib);
  await page.keyboard.press('Escape');
  await expect(rows(page)).toHaveCount(112 - ib);
  await expect(page.locator('#sc-nets input[data-sc-net="n-ib"]')).not.toBeChecked();
});

test('the schedule’s header keeps its place while the filters change', async ({ page }) => {
  await toCabling(page);
  const top = () => page.locator('#sc-scroll').evaluate((e) => Math.round(e.getBoundingClientRect().top));
  const before = await top();
  await page.fill('#sc-filter', 'ib');
  await expect(page.locator('#sc-sub')).toContainText('shown');
  expect(await top()).toBe(before);
  await page.locator('#sc-nets label', { hasText: 'BMC' }).click();
  expect(await top()).toBe(before);
  await page.fill('#sc-filter', '');
  await page.locator('#networks .cl-main', { hasText: 'Management' }).click();
  await expect(page.locator('#sc-sub')).toContainText('shown');
  expect(await top()).toBe(before);
  await expect(page.locator('#sc-sub')).toHaveAttribute('title', /shown/);
});

test('the schedule’s sub line, which says what italic lengths are, stays whole on laptop screens', async ({ page }) => {
  await toCabling(page);
  const whole = () => page.locator('#sc-sub').evaluate((e) => e.scrollWidth <= e.clientWidth + 0.5 && e.scrollHeight <= e.clientHeight + 0.5);
  const top = () => page.locator('#sc-scroll').evaluate((e) => Math.round(e.getBoundingClientRect().top));
  for (const width of [1024, 1280, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const scope of ['row', 'floor']) {
      await page.click(`[data-sc-scope="${scope}"]`);
      await page.fill('#sc-filter', '');
      await expect(page.locator('#sc-sub')).toContainText('lengths in italics are estimates');
      expect(await whole(), `at ${width} px, ${scope}`).toBe(true);
      const before = await top();
      await page.fill('#sc-filter', 'ib');
      await expect(page.locator('#sc-sub')).toContainText('shown · lengths in italics are estimates');
      expect(await whole(), `at ${width} px, ${scope}, filtered`).toBe(true);
      expect(await top(), `at ${width} px, ${scope}`).toBe(before);
    }
  }
});

test('the port list shows each port’s spec and each cable’s length in full', async ({ page }) => {
  await toCabling(page);
  await row(page, 'IB-0001').locator('.sc-dev', { hasText: 'ib-leaf-a01' }).click();
  await expect(page.locator('#inspector .name-static')).toHaveText('ib-leaf-a01');
  const cut = (sel) => page.locator(sel).evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent));
  expect(await cut('#inspector .pl-port small')).toEqual([]);
  expect(await cut('#inspector .pl-peer small')).toEqual([]);
  // Within the rack the place is the units; the length follows the cable.
  await expect(page.locator('#inspector .pl-row').filter({ hasText: 'p1' }).first().locator('.pl-peer small')).toHaveText(/^U4–5 · DAC\u00a0\d+(\.\d+)?\u00a0m$/);
  // Ends in another rack name it; a long line breaks between the place and the cable.
  await expect(page.locator('#inspector .pl-peer small', { hasText: 'B01' }).first()).toHaveText(/^B01\u00a0·\u00a0U\d+ · OM4\u00a0/);
  await expect(page.locator('#inspector .pl-port small').first()).toHaveText('QSFP56 200G');

  // Nor the far device and its port, nor a long spec, on the devices with the longest of them, on a laptop and a small screen.
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    for (const name of ['ceph-01', 'cn-001', 'sw-mgmt-a01', 'sw-mgmt-a02']) {
      await page.fill('#search', name);
      await page.locator('.sr-item', { hasText: name }).first().click();
      await expect(page.locator('#inspector .name-static')).toHaveText(name);
      for (const sel of ['.pl-port small', '.pl-peer b', '.pl-peer small']) expect(await cut(`#inspector ${sel}`), `${sel} of ${name} at ${width} px`).toEqual([]);
    }
  }
  // A far device and its port break between the two.
  await expect(page.locator('#inspector .pl-peer b').first()).toHaveText(/^\S+ · \S+$/);
});

test('Connect series names its device types in the plural, and says why two ends of one device give no cable', async ({ page }) => {
  await toCabling(page);
  await page.click('#sc-series');
  await expect(page.locator('label[for="cs-label"]')).toHaveText('First label');
  await expect(page.locator('#connect-sub')).toContainText('the next free port of the To device');
  await page.selectOption('#cs-from', await idOf(page, 'sw-mgmt-a01'));
  await expect(page.locator('#cs-only-text')).toHaveText('only 48-port switches');
  await page.selectOption('#cs-from', await idOf(page, 'cn-001'));
  await expect(page.locator('#cs-only-text')).toHaveText('only compute nodes');
  await page.selectOption('#cs-from-last', await idOf(page, 'cn-001'));
  await page.selectOption('#cs-to', await idOf(page, 'cn-001'));
  await expect(page.locator('#cs-rows')).toHaveText('cn-001 is the device to connect to: pick other devices to connect from.');
  await page.keyboard.press('Escape');

  // One cable: a label, not a first one; the same device at both ends says so.
  await page.click('#sc-add');
  await expect(page.locator('label[for="cs-label"]')).toHaveText('Label');
  await page.selectOption('#cs-from', await idOf(page, 'ceph-01'));
  await page.selectOption('#cs-to', await idOf(page, 'ceph-01'));
  await expect(page.locator('#cs-rows')).toHaveText('A cable cannot join ceph-01 to itself: pick another device.');
  await expect(page.locator('#cs-submit')).toBeDisabled();
});

test('the network dialog shows the series its first label starts', async ({ page }) => {
  await toCabling(page);
  await page.locator('#networks .cl-row', { hasText: 'Management' }).locator('.cl-edit').click();
  await expect(page.locator('#network-label-hint')).toHaveText('New cables of this network continue this series: MGT-0001, MGT-0002, …');
  await page.fill('#network-label', 'OOB-07');
  await expect(page.locator('#network-label-hint')).toHaveText('New cables of this network continue this series: OOB-07, OOB-08, …');
  await page.keyboard.press('Escape');
  await page.click('#btn-add-network');
  await page.fill('#network-name', 'Uplinks');
  await expect(page.locator('#network-label-hint')).toContainText('UPL-0001, UPL-0002, …');
});

test('the transceiver picked by hand leaves Auto naming the one it would pick', async ({ page }) => {
  await toCabling(page);
  await pick(page, 'IB-0031');
  const first = page.locator('#cab-tr-a option').first();
  await expect(first).toHaveText('Auto: QSFP56 200G SR4');
  await page.selectOption('#cab-tr-a', 'qsfp56-200g-sr4');
  expect((await cableBy(page, 'IB-0031')).a.transceiver).toBe('qsfp56-200g-sr4');
  await expect(first).toHaveText('Auto: QSFP56 200G SR4');
});

/** Opens a plan made here: the example as changed by `change(p, M)`. */
async function openPlan(page, change) {
  const M = require('../js/model.js');
  const p = M.createExampleProject();
  change(p, M);
  await page.click('#btn-open');
  await page.setInputFiles('#file-input', { name: 'changed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(p)) });
  await expect(page.locator('#plan-name')).toHaveValue(p.name);
}

test('Shift-click grouped by device selects the rows between the two clicked', async ({ page }) => {
  await toCabling(page);
  await page.selectOption('#sc-group', 'device');
  // A cable is listed under each of its devices: here, the rows under cn-002 and cn-003.
  const under = (group, label) =>
    page.locator(`xpath=//tr[contains(@class,"sc-group")][.//b[normalize-space()="${group}"]]/following-sibling::tr[@data-cable][.//span[contains(@class,"sc-label")][normalize-space()="${label}"]][1]/td[2]`);
  await under('cn-002', 'MGT-0002').click();
  await under('cn-003', 'IB-0003').click({ modifiers: ['Shift'] });
  const selected = () => plan(page, (p, a, RP) => RP.app.ui.cabSel.ids.map((id) => p.cables.find((c) => c.id === id).label).sort());
  expect(await selected()).toEqual(['BMC-0002', 'BMC-0003', 'IB-0002', 'IB-0003', 'MGT-0002', 'MGT-0003']);
  await expect(page.locator('#inspector .multi-title')).toHaveText('6 cables');
  // Up from the row clicked: the rows of cn-001 and that row.
  await under('cn-002', 'MGT-0002').click();
  await under('cn-001', 'MGT-0001').click({ modifiers: ['Shift'] });
  await expect(page.locator('#inspector .multi-title')).toHaveText('4 cables');
  expect(await selected()).toEqual(['BMC-0001', 'IB-0001', 'MGT-0001', 'MGT-0002']);
});

test('the inspector follows a label, a length, a slack and a row pitch as they change; Tab goes on to the next field', async ({ page }) => {
  await toCabling(page);
  await pick(page, 'MGT-0001');
  await expect(page.locator('#inspector .check-list')).toHaveText('No problems');
  // A label used twice is flagged as it is typed, and the field keeps focus.
  await page.locator('#cab-label').fill('MGT-0002');
  await expect(page.locator('#inspector .check-list')).toContainText('The label MGT-0002 is used twice');
  await expect(page.locator('#cab-label')).toBeFocused();
  await page.locator('#cab-label').fill('MGT-0001');
  await expect(page.locator('#inspector .check-list')).toHaveText('No problems');

  // Tab out of a changed length goes on to the notes; the inspector shows the length.
  await page.locator('#cab-length').fill('6');
  await page.keyboard.press('Tab');
  await expect(page.locator('#cab-notes')).toBeFocused();
  await expect(page.locator('#inspector .insp-sub')).toContainText('6 m');
  await page.keyboard.type('patch via tray');
  await expect(page.locator('#cab-host')).toBeVisible();
  expect((await cableBy(page, 'MGT-0001')).notes).toBe('patch via tray');
  // Shift+Tab back from the notes after a change too.
  await page.locator('#cab-length').fill('7');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#cab-type')).toBeFocused();

  // A port's line names its cable by the label typed; a label used twice is flagged there too.
  await row(page, 'IB-0002').locator('.sc-dev', { hasText: 'cn-002' }).click();
  await page.locator('#inspector .pl-row').filter({ hasText: 'ib0' }).locator('.pl-port').click();
  await expect(page.locator('#inspector .insp-sub')).toHaveText(/ · cable IB-0002$/);
  await page.locator('#cab-label').fill('IB-0003');
  await expect(page.locator('#inspector .insp-sub')).toHaveText(/ · cable IB-0003$/);
  await expect(page.locator('#inspector .check-list')).toContainText('The label IB-0003 is used twice');
  await page.locator('#cab-label').fill('IB-0002');
  await expect(page.locator('#inspector .check-list')).toHaveText('No problems');

  // A device's slack: its port list shows the lengths that follow, and Tab goes on.
  await row(page, 'IB-0001').locator('.sc-dev', { hasText: 'cn-001' }).click();
  await page.locator('#cab-dev-slack').fill('6');
  await page.keyboard.press('Tab');
  const length = (label) => plan(page, (p, label, RP) => RP.cabling.fmtM(RP.cabling.describe(p, p.cables.find((c) => c.label === label)).lengthM), label);
  await expect(page.locator('#inspector .pl-row').filter({ hasText: 'ib0' }).locator('.pl-peer small')).toContainText((await length('IB-0001')).replace(/ /g, ' '));
  expect(await page.evaluate(() => document.activeElement.closest('#inspector') !== null)).toBe(true);

  // The row's pitch: To check follows.
  await page.keyboard.press('Escape');
  await expect(page.locator('#inspector .kicker')).toHaveText('Cabling · Row A');
  const toCheck = () => plan(page, (p, a, RP) => RP.cabling.cablesWithin(p, 'row1').filter((c) => RP.cabling.describe(p, c).issues.length).length);
  const was = await toCheck();
  await page.locator('#cab-pitch').fill('50');
  await page.keyboard.press('Tab');
  const now = await toCheck();
  expect(now).not.toBe(was);
  await expect(page.locator('#inspector .stats div', { hasText: 'To check' }).locator('dd')).toHaveText(String(now));
  await expect(page.locator('#cab-pitch')).toHaveValue('50');
});

test('another row’s schedule opens at its top', async ({ page }) => {
  await toCabling(page);
  await page.locator('#sc-scroll').evaluate((e) => (e.scrollTop = 1500));
  await page.locator('#sc-title').click();
  await page.keyboard.press(']');
  await expect(page.locator('#sc-title')).toHaveText('Row B · cable schedule');
  expect(await page.locator('#sc-scroll').evaluate((e) => e.scrollTop)).toBe(0);
  await expect(page.locator('#sc-body .sc-group').first()).toBeInViewport();
  await page.locator('#sc-scroll').evaluate((e) => (e.scrollTop = 600));
  await page.click('[data-sc-scope="floor"]');
  await expect(page.locator('#sc-title')).toHaveText('Ground floor · cable schedule');
  expect(await page.locator('#sc-scroll').evaluate((e) => e.scrollTop)).toBe(0);
  // The same scope keeps its place while the plan changes.
  await page.locator('#sc-scroll').evaluate((e) => (e.scrollTop = 600));
  await page.locator('#sc-body tr[data-cable]').filter({ visible: true }).nth(12).locator('td').nth(1).click();
  const at = await page.locator('#sc-scroll').evaluate((e) => e.scrollTop);
  await page.locator('label.chip:has(input[name="cab-net"][value="n-sas"]) span').click();
  expect(await page.locator('#sc-scroll').evaluate((e) => e.scrollTop)).toBe(at);
});

test('a free port with no other device to connect to says so', async ({ page }) => {
  await openPlan(page, (p, M) => {
    const ex = M.createEmptyProject(3);
    Object.assign(p, ex, { name: 'One switch' });
    p.devices = [M.newDevice({ id: 'd1', type: 'switch-rj45', name: 'only-sw', loc: { rack: M.allRacks(p)[0].rack.id, kind: 'u', at: 10 } })];
  });
  await page.click('.ws-switch [data-workspace="cabling"]');
  await page.click('#search');
  await page.keyboard.type('only-sw');
  await page.locator('.sr-item', { hasText: 'only-sw' }).first().click();
  await page.locator('#inspector .pl-port').first().click();
  await expect(page.locator('#inspector .empty-note')).toHaveText('No other device has ports to connect to. Give a device type ports in the catalog.');
  await expect(page.locator('#cab-pc-go')).toHaveCount(0);
});

test('keyboard focus stays on a network’s button as it is put in focus and out', async ({ page }) => {
  await toCabling(page);
  const mgmt = page.locator('#networks .cl-main', { hasText: 'Management' });
  await mgmt.focus();
  await page.keyboard.press('Enter');
  await expect(mgmt).toHaveAttribute('aria-pressed', 'true');
  await expect(mgmt).toBeFocused();
  await page.keyboard.press('Space');
  await expect(mgmt).toHaveAttribute('aria-pressed', 'false');
  await expect(mgmt).toBeFocused();
});

test('beside a row’s checkbox, in its cell, still adds the row to the selection', async ({ page }) => {
  await toCabling(page);
  await row(page, 'MGT-0001').locator('input').click();
  await row(page, 'MGT-0002').locator('input').click();
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(2);
  await row(page, 'MGT-0003').locator('td.sc-check').click({ position: { x: 3, y: 3 } });
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(3);
  await row(page, 'MGT-0003').locator('td.sc-check').click({ position: { x: 3, y: 3 } });
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(2);
  // The header's cell takes every cable shown.
  await page.locator('#sc-table th.sc-check').click({ position: { x: 3, y: 3 } });
  await expect(page.locator('#sc-body tr.is-selected')).toHaveCount(112);
});

test('long names: a device’s is cut short before its port, a row’s in its scope button', async ({ page }) => {
  const long = 'compute-node-very-long-hostname-001.example.internal';
  const rowName = 'Row A (cold aisle containment, north)';
  await openPlan(page, (p) => {
    p.name = 'Long names';
    p.devices.find((d) => d.name === 'cn-001').name = long;
    p.floors[0].rows[0].name = rowName;
  });
  await toCabling(page);
  // The schedule cuts the name, with the whole of it as the title; its port and the other columns keep their place.
  const dev = row(page, 'IB-0001').locator('.sc-dev').first();
  await expect(dev).toHaveAttribute('title', long);
  expect(await dev.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  expect(await page.locator('#sc-table th').nth(2).evaluate((e) => e.getBoundingClientRect().width)).toBeLessThan(260);
  // The inspector's end cuts the name and keeps the port.
  await pick(page, 'IB-0001');
  const end = page.locator('.end-item').first().locator('.end-dev');
  await expect(end).toContainText(' · ib0');
  expect(await end.locator('b').evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  expect(await end.locator('span').evaluate((s) => s.getBoundingClientRect().right <= s.parentElement.getBoundingClientRect().right + 0.5)).toBe(true);
  await expect(end).toHaveAttribute('title', `${long} · ib0: select the device`);
  // The scope button ends its row's name in an ellipsis, and names it whole in its title.
  const scope = page.locator('#sc-scope-row');
  await expect(scope).toHaveAttribute('title', `The cables of ${rowName}`);
  expect(await scope.locator('.sc-scope-name').evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow === 'ellipsis' && getComputedStyle(e).display === 'block')).toBe(true);
  // In the colors of its button, pressed or not.
  expect(await scope.locator('.sc-scope-name').evaluate((e) => getComputedStyle(e).color === getComputedStyle(e.parentElement).color)).toBe(true);
});

test('the cable inspector breaks its lines between parts, not between a number and its unit', async ({ page }) => {
  await toCabling(page);
  await pick(page, 'IB-0031');
  const text = (sel) => page.locator(sel).first().evaluate((e) => e.textContent);
  expect(await text('#inspector .insp-sub')).toMatch(/\d m \(est\.\)$/);
  expect(await text('#inspector .end-main small')).toMatch(/^Rack A\d\d · U\d+(–\d+)? · rear of the rack · QSFP56 200G$/);
});

test('Connect series from a switch starts on the port of each device that reaches it', async ({ page }) => {
  await toCabling(page);
  // The compute nodes unplugged: each has every port free.
  await page.fill('#sc-filter', 'cn-0');
  await page.click('#sc-all');
  await page.keyboard.press('Delete');
  await page.fill('#sc-filter', '');
  await page.click('#search');
  await page.keyboard.type('ib-leaf-a01');
  await page.locator('.sr-item', { hasText: 'ib-leaf-a01' }).first().click();
  await page.click('#cab-dev-series');
  await expect(page.locator('#cs-to')).toHaveValue(await idOf(page, 'ib-leaf-a01'));
  await expect(page.locator('#cs-from-port')).toHaveValue('ib0');
  await expect(page.locator('#cs-rows')).not.toContainText('No cable type');
  await expect(page.locator('#cs-submit')).toBeEnabled();
});

// ------------------------------------------------------------ narrow and wide screens

test('the plan name keeps its room next to the workspace switch on laptop screens', async ({ page }) => {
  for (const width of [1181, 1280, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const cut = await page.locator('#plan-name').evaluate((e) => e.scrollWidth > e.clientWidth);
    expect(cut, `at ${width} px`).toBe(false);
    await expect(page.locator('.ws-switch [data-workspace="cabling"]')).toBeVisible();
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('the whole schedule and its order list scroll into view', async ({ page }) => {
    await page.click('.ws-switch [data-workspace="cabling"]');
    await expect(rows(page).first()).toBeAttached();
    // Nothing of the schedule is cut off by the stage: the page scrolls to the order list.
    const box = (sel) => page.locator(sel).evaluate((e) => { const r = e.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY }; });
    const canvas = await box('#canvas');
    const bom = await box('#sc-bom');
    expect(bom.bottom).toBeLessThanOrEqual(canvas.bottom + 1);
    const btn = await box('#sc-order-csv');
    await page.evaluate((y) => window.scrollTo(0, y - 200), btn.top);
    const hit = await page.locator('#sc-order-csv').evaluate((b) => { const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + 4, r.top + 4); return !!e && !!e.closest('#sc-order-csv'); });
    expect(hit).toBe(true);
    // The table scrolls to its last row inside its own box.
    await page.locator('#sc-scroll').evaluate((e) => (e.scrollTop = e.scrollHeight));
    const last = rows(page).last();
    const inBox = await last.evaluate((tr) => tr.getBoundingClientRect().bottom <= document.querySelector('#sc-scroll').getBoundingClientRect().bottom + 1);
    expect(inBox).toBe(true);
  });
});

// ------------------------------------------------------------ a large plan

/** The example with its ground floor's rows copied three times, then that floor copied three times: about 2250 cables. */
function largePlan() {
  const M = require('../js/model.js');
  const IO = require('../js/io.js');
  const p = M.createExampleProject();
  let n = 0;
  const uid = (pre) => `${pre}-x${++n}`;
  const copyRows = (rows, floor, suffix) => {
    const racks = new Map();
    const devices = new Map();
    floor.rows.push(
      ...rows.map((row) => ({
        id: uid('row'),
        name: `${row.name}${suffix}`,
        racks: row.racks.map((r) => {
          racks.set(r.id, uid('rk'));
          return Object.assign({}, r, { id: racks.get(r.id), name: `${r.name}${suffix}` });
        }),
      }))
    );
    for (const d of p.devices.slice()) {
      if (!racks.has(d.loc.rack)) continue;
      devices.set(d.id, uid('dv'));
      p.devices.push(Object.assign({}, d, { id: devices.get(d.id), name: `${d.name}${suffix}`, loc: Object.assign({}, d.loc, { rack: racks.get(d.loc.rack) }) }));
    }
    const move = (e) => (e ? Object.assign({}, e, { device: devices.get(e.device) }) : e);
    for (const c of p.cables.slice()) {
      if (!M.cableEnds(c).every((x) => devices.has(x.end.device))) continue;
      p.cables.push(Object.assign({}, c, { id: uid('cb'), label: `${c.label}${suffix}`, a: move(c.a), b: Array.isArray(c.b) ? c.b.map(move) : move(c.b) }));
    }
  };
  const ground = p.floors[0];
  const base = ground.rows.slice();
  for (let i = 1; i <= 3; i++) copyRows(base, ground, `-${i}`);
  for (let k = 1; k <= 3; k++) {
    const floor = { id: uid('fl'), name: `${ground.name} copy ${k}`, rows: [] };
    p.floors.push(floor);
    copyRows(ground.rows.slice(), floor, `-f${k}`);
  }
  delete p.meta.example;
  p.name = 'Large plan';
  return IO.normalizeProject(JSON.parse(JSON.stringify(p))).project;
}

test('a schedule of 2000 cables draws the rows in view, and stays quick to filter, select and change', async ({ page }) => {
  test.setTimeout(90000);
  const big = largePlan();
  expect(big.cables.length).toBeGreaterThan(2000);
  await page.click('#btn-open');
  await page.setInputFiles('#file-input', { name: 'large.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(big)) });
  await expect(page.locator('#plan-name')).toHaveValue('Large plan');
  await toCabling(page);
  await page.click('[data-sc-scope="plan"]');
  await expect(page.locator('#sc-sub')).toContainText(`${big.cables.length} cables in the plan`);
  // Only the rows near the view are drawn; the table knows how many there are.
  const count = Number(await page.locator('#sc-table').getAttribute('aria-rowcount')) - 1;
  expect(count).toBeGreaterThan(big.cables.length);
  expect(await rows(page).count()).toBeLessThan(150);
  // Scrolling draws the rows that come into view, with their place in the table.
  await page.locator('#sc-scroll').evaluate((e) => (e.scrollTop = e.scrollHeight));
  await expect(page.locator(`#sc-body tr[aria-rowindex="${count + 1}"]`)).toBeInViewport();

  // Long tasks while the schedule is grouped again, a group folded, a network hidden: none near a second any more.
  await page.evaluate(() => {
    window.longTasks = [];
    new PerformanceObserver((l) => window.longTasks.push(...l.getEntries().map((e) => e.duration))).observe({ type: 'longtask' });
  });
  await page.selectOption('#sc-group', 'device');
  await expect(page.locator('#sc-body .sc-fold').first()).toBeVisible();
  await page.selectOption('#sc-group', 'route');
  await page.locator('#sc-body .sc-fold').first().click();
  await page.locator('#sc-nets label').first().click();
  await page.locator('#sc-nets label').first().click();
  await page.locator('#sc-body .sc-fold').first().click();
  await page.waitForTimeout(300);
  expect(Math.max(0, ...(await page.evaluate(() => window.longTasks)))).toBeLessThan(600);

  // A click right after typing in the filter (which waits for typing to pause here) keeps what was typed, and applies it.
  await page.locator('#sc-filter').pressSequentially('swp4');
  await rows(page).first().locator('td').nth(1).click();
  await expect(page.locator('#sc-filter')).toHaveValue('swp4');
  await expect(page.locator('#sc-sub')).toContainText('shown');
  await page.waitForTimeout(300);
  await expect(page.locator('#sc-filter')).toHaveValue('swp4');
  await page.locator('#sc-filter').fill('');
  await expect(page.locator('#sc-sub')).not.toContainText('shown');

  // Search reveals a cable far down.
  const last = big.cables[big.cables.length - 1].label;
  await page.click('#search');
  await page.keyboard.type(last);
  await expect(page.locator('.sr-item', { hasText: last }).first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(row(page, last)).toHaveClass(/is-selected/);
  await expect(row(page, last)).toBeInViewport();

  // Typing a label: the schedule follows once typing pauses.
  await page.locator('#cab-label').fill('');
  await page.locator('#cab-label').pressSequentially('BIG-1');
  await expect(row(page, 'BIG-1')).toHaveClass(/is-selected/);

  // Every cable selected, then given a network at once.
  await page.locator('#sc-title').click();
  await page.keyboard.press('Control+a');
  await expect(page.locator('#inspector .multi-title')).toHaveText(`${big.cables.length} cables`);
  await page.evaluate(() => (window.longTasks = []));
  await page.locator('label.chip:has(input[name="multi-net"][value="n-bmc"]) span').click();
  await expect(page.locator('#inspector .contents .sw').first()).toBeVisible();
  expect(await plan(page, (p) => p.cables.every((c) => c.network === 'n-bmc'))).toBe(true);
  await page.waitForTimeout(300);
  expect(Math.max(0, ...(await page.evaluate(() => window.longTasks)))).toBeLessThan(1000);
});
