'use strict';

// What the Power workspace gives and takes as files: the four power CSVs
// of the Export menu and of the views, the power cord schedule read back
// with Open, and the rear elevation as SVG and on the printed sheets.
const fs = require('fs');
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

/** Runs `fn(project, arg, RP)` in the page, with the plan as it is. */
const plan = (page, fn, arg) =>
  page.evaluate(({ fn, arg }) => new Function('p', 'arg', 'RP', `return (${fn})(p, arg, RP)`)(window.RP.app.project(), arg, window.RP), { fn: fn.toString(), arg });
const cords = (page) => plan(page, (p) => p.powerCords.length);
const toast = (page) => page.locator('.toast').last();
const view = (page, id) => page.click(`#pow-toggle [data-pow-view="${id}"]`);

/** Opens the Power workspace on Row B, where the example has its PDUs. */
async function toPower(page) {
  await page.click('.ws-switch [data-workspace="power"]');
  await page.click('#btn-row-next');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await expect(page.locator('.scene .pw-pdu')).toHaveCount(6);
}

/** The file a click downloads: its name and its lines, without the byte order mark. */
async function read(page, click) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  return { name: dl.suggestedFilename(), bom: text.startsWith('﻿'), text, lines: text.replace(/^﻿/, '').trim().split('\r\n') };
}
const fromMenu = (page, kind) =>
  read(page, async () => {
    await page.click('#btn-export');
    await page.click(`#menu-export [data-export="${kind}"]`);
  });

test('the Export menu has the four power CSVs of the plan, after the cable CSVs', async ({ page }) => {
  await page.click('#btn-export');
  await expect(page.locator('#menu-export [data-export] > span:first-child')).toHaveText([
    'PNG image',
    'SVG drawing',
    'Print or PDF…',
    'CSV inventory',
    'Cable schedule (CSV)',
    'Cable order list (CSV)',
    'Power cord schedule (CSV)',
    'PDU outlet plan (CSV)',
    'Power load (CSV)',
    'Cord order list (CSV)',
    'Plan file (.json)',
    'Copy plan as JSON',
    'Share link…',
  ]);
  await page.keyboard.press('Escape');

  // From the Racks workspace too: they hold the whole plan.
  const schedule = await fromMenu(page, 'cords-csv');
  expect(schedule.name).toBe('hall-2-expansion-power-cords.csv');
  expect(schedule.bom).toBe(true);
  expect(schedule.lines[0]).toBe('Label,Grid,Cord type,Length (m),Estimated,Floor,Row,Rack,Device,Position,Inlet,PDU,PDU slot,Outlet,Fuse,Phase,Meter,Draw (W),Draw grid down (W),Color,Notes,Device ID,PDU ID');
  expect(schedule.lines.length - 1).toBe(await cords(page));
  expect(schedule.lines[1]).toMatch(/^P-0001,Grid A,C14–C13 cord \(auto\),1,yes,Ground floor,Row B,Rack B01,core-sw-01,U4,psu1,pdu-b01-a,P1,1,CB1,L1,M1,175,350,Grid A,,/);
  await expect(toast(page)).toHaveText('Exported hall-2-expansion-power-cords.csv');

  const outlets = await fromMenu(page, 'outlets-csv');
  expect(outlets.name).toBe('hall-2-expansion-pdu-outlets.csv');
  expect(outlets.lines[0]).toBe('Rack,PDU,PDU slot,Grid,Outlet,Connector,Fuse,Rating (A),Phase,Meter,Device,Inlet,Draw (W),Draw grid down (W),Cord label');
  expect(outlets.lines.length - 1).toBe(6 * 30);
  expect(outlets.lines).toContain('Rack B01,pdu-b01-a,P1,Grid A,3,C13,CB1,16,L1,M1,,,0,0,');

  const load = await fromMenu(page, 'load-csv');
  expect(load.name).toBe('hall-2-expansion-power-load.csv');
  expect(load.lines[0]).toBe('Level,Grid,Rack,PDU,Phase,Fuse,Rating,Unit,All up,Grid A down,Grid B down,Worst,Use at worst (%),Check');
  expect(load.lines[1]).toBe('Grid,Grid A,,,,,,W,10575,0,20650,20650,,');
  expect(load.lines).toContain('Fuse,Grid A,Rack B01,pdu-b01-a,L1,CB1,16,A,1.5,0,2.3,2.3,14,');

  const order = await fromMenu(page, 'cord-order-csv');
  expect(order.name).toBe('hall-2-expansion-cord-order.csv');
  expect(order.lines[0]).toBe('Cord type,Length (m),Color,Count,Total (m)');
  expect(order.lines[1]).toBe('C14–C13 cord,1,Grid A,5,5');
  expect(order.lines.slice(1).reduce((n, l) => n + Number(l.split(',')[3]), 0)).toBe(33);

  // The cable CSVs hold no power cords, as before.
  const cables = await fromMenu(page, 'cables-csv');
  expect(cables.lines[0]).toMatch(/^Label,Network,Cable type,/);
  expect(cables.text).not.toContain('P-0001');
});

test('the schedule, the Load view and the outlet map export what they show', async ({ page }) => {
  await toPower(page);
  // The schedule: its cords and their order list, of the row, the floor or the plan.
  await view(page, 'schedule');
  await page.fill('#ps-filter', 'gpu-srv-01');
  await expect(page.locator('#ps-body tr[data-cord]')).toHaveCount(4);
  const row = await read(page, () => page.click('#ps-csv'));
  expect(row.name).toBe('hall-2-expansion-ground-floor-row-b-power-cords.csv');
  expect(row.lines.length - 1).toBe(33);
  await expect(toast(page)).toHaveText(`Exported ${row.name}`);
  // The order list under the table counts the cords of the row, whatever the filter shows.
  await expect(page.locator('#ps-bom')).toContainText('33 cords of Row B');
  const order = await read(page, () => page.click('#ps-order'));
  expect(order.name).toBe('hall-2-expansion-ground-floor-row-b-cord-order.csv');
  expect(order.lines.slice(1).reduce((n, l) => n + Number(l.split(',')[3]), 0)).toBe(33);
  await page.click('#ps-scope [data-pow-scope="floor"]');
  expect((await read(page, () => page.click('#ps-csv'))).name).toBe('hall-2-expansion-ground-floor-power-cords.csv');
  await page.click('#ps-scope [data-pow-scope="plan"]');
  expect((await read(page, () => page.click('#ps-order'))).name).toBe('hall-2-expansion-cord-order.csv');
  await page.click('#ps-scope [data-pow-scope="row"]');

  // A row without cords: the files have their header line alone.
  await page.click('#btn-row-prev');
  await expect(page.locator('#ps-title')).toHaveText('Power cords of Row A');
  const none = await read(page, () => page.click('#ps-csv'));
  expect(none.name).toBe('hall-2-expansion-ground-floor-row-a-power-cords.csv');
  expect(none.lines).toHaveLength(1);
  await page.click('#btn-row-next');

  // The Load view: the grids, PDUs, phases and fuse groups of its scope.
  await view(page, 'load');
  const load = await read(page, () => page.click('#ld-csv'));
  expect(load.name).toBe('hall-2-expansion-ground-floor-row-b-power-load.csv');
  expect(load.lines.length - 1).toBe(2 + 6 + 18 + 36);
  expect(load.lines.map((l) => l.split(',')[0]).slice(1, 5)).toEqual(['Grid', 'PDU', 'Phase', 'Fuse']);

  // The outlet map: the PDUs of the rack shown.
  await view(page, 'outlets');
  await page.selectOption('#om-rack', { label: 'Rack B02' });
  const map = await read(page, () => page.click('#om-csv'));
  expect(map.name).toBe('hall-2-expansion-ground-floor-row-b-rack-b02-pdu-outlets.csv');
  expect(map.lines.length - 1).toBe(60);
  expect(map.lines.slice(1).every((l) => l.startsWith('Rack B02,pdu-b02-'))).toBe(true);
});

test('opening a power cord schedule CSV adds its cords to the plan, with Undo', async ({ page }) => {
  const csv = await plan(page, (p, a, RP) => RP.io.exportCordsCSV(p, p.powerCords.filter((c) => p.devices.find((d) => d.id === c.inlet.device).name === 'gpu-srv-01')));
  expect(csv.trim().split('\r\n')).toHaveLength(5);
  // The cords of gpu-srv-01 go: unplugged in the schedule.
  await toPower(page);
  await view(page, 'schedule');
  await page.fill('#ps-filter', 'gpu-srv-01');
  await expect(page.locator('#ps-body tr[data-cord]')).toHaveCount(4);
  await page.click('#ps-all');
  await page.keyboard.press('Delete');
  await expect(toast(page)).toContainText('Unplugged 4 cords');
  await page.fill('#ps-filter', '');
  expect(await cords(page)).toBe(29);

  // From the Racks workspace: the cords come in, and Power shows them.
  await page.click('.ws-switch [data-workspace="racks"]');
  await page.click('#btn-open');
  await expect(page.locator('#dlg-open .dlg-sub')).toContainText('a power cord schedule CSV (Device, Inlet, PDU and Outlet columns)');
  await page.fill('#open-text', csv);
  await page.click('#open-form button[type="submit"]');
  await expect(toast(page)).toContainText('Added 4 power cords from the CSV');
  expect(await cords(page)).toBe(33);
  await expect(page.locator('.ws-switch [data-workspace="power"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#ps-body tr[data-cord]')).toHaveCount(33);
  const back = () =>
    plan(page, (p) => {
      const d = p.devices.find((x) => x.name === 'gpu-srv-01');
      return p.powerCords.filter((c) => c.inlet.device === d.id).map((c) => `${c.label} ${c.inlet.inlet} ${c.type} ${c.lengthM}`).sort();
    });
  // Types that were picked and lengths that were estimated stay so.
  expect(await back()).toEqual(['P-0008 psu1 null null', 'P-0009 psu2 null null', 'P-0010 psu3 null null', 'P-0011 psu4 null null']);
  await page.locator('.toast button', { hasText: 'Undo' }).last().click();
  expect(await cords(page)).toBe(29);

  // The same lines with one more that names no device of the plan: the others come in, and the report says why not that one.
  await page.click('#btn-open');
  await page.fill('#open-text', `${csv}P-9999,,,,,,,,nope,,psu1,pdu-b02-a,P1,30,,,,,,,,,\r\n`);
  await page.click('#open-form button[type="submit"]');
  await expect(toast(page)).toContainText('Added 4 power cords from the CSV');
  await expect(page.locator('#dlg-report')).toContainText('Skipped cord P-9999: there is no device nope.');
  await page.click('#dlg-report button[value="ok"]');
  expect(await cords(page)).toBe(33);
  // A second time every inlet is taken: nothing is added, and there is no step to undo.
  await page.click('#btn-open');
  await page.fill('#open-text', csv);
  await page.click('#open-form button[type="submit"]');
  await expect(toast(page)).toContainText('The CSV added no power cords');
  await expect(page.locator('#dlg-report')).toContainText('Skipped cord P-0008: gpu-srv-01 psu1 already has cord P-0008.');
  await page.click('#dlg-report button[value="ok"]');
  expect(await cords(page)).toBe(33);
  await page.keyboard.press('Control+z');
  expect(await cords(page)).toBe(29);

  // A CSV that is no schedule of cords or cables is read as an inventory, as before.
  await page.click('#btn-open');
  await page.fill('#open-text', 'Device,Inlet\ncn-001,psu1');
  await page.click('#open-form button[type="submit"]');
  await expect(page.locator('#open-error')).toBeVisible();
});

test('Open refuses a PDU outlet plan, which is written only, and says what to open for cords', async ({ page }) => {
  const csv = await plan(page, (p, a, RP) => RP.io.exportOutletsCSV(p));
  expect(csv.trim().split('\r\n')).toHaveLength(181);
  const note = 'This is a PDU outlet plan, which is written only. To add power cords, open a power cord schedule CSV (Export, Power cord schedule).';
  await page.click('#btn-open');
  await page.fill('#open-text', csv);
  await page.click('#open-form button[type="submit"]');
  await expect(page.locator('#open-error')).toHaveText(note);
  // The dialog stays, nothing is reported line by line, and the plan is as it was.
  await expect(page.locator('#dlg-open')).toBeVisible();
  await expect(page.locator('#dlg-report')).toBeHidden();
  expect(await plan(page, (p) => [p.devices.length, p.powerCords.length])).toEqual([65, 33]);
  // The file the outlet map gives is refused the same way.
  await page.fill('#open-text', '');
  await page.setInputFiles('#file-input', { name: 'hall-2-expansion-rack-b02-pdu-outlets.csv', mimeType: 'text/csv', buffer: Buffer.from(`\ufeff${csv}`) });
  await expect(page.locator('#open-error')).toHaveText(note);
  await expect(page.locator('#dlg-open')).toBeVisible();
  expect(await plan(page, (p) => [p.devices.length, p.powerCords.length])).toEqual([65, 33]);
  await expect(page.locator('#btn-undo')).toBeDisabled();
});

test('PNG, SVG and Print give the row’s power cabling from the rear, without the grids hidden', async ({ page }) => {
  await toPower(page);
  const hint = (kind) => page.locator(`#menu-export [data-export="${kind}"] small`);
  await page.click('#btn-export');
  await expect(hint('png')).toHaveText('This row’s power cabling from the rear, for docs, tickets and chat');
  await expect(hint('svg')).toHaveText('This row’s power cabling from the rear, opens in vector editors');
  await expect(hint('print')).toHaveText('One sheet per row, its power cabling from the rear');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="svg"]')]);
  expect(dl.suggestedFilename()).toBe('hall-2-expansion-ground-floor-row-b-power-rear.svg');
  const svg = fs.readFileSync(await dl.path(), 'utf8');
  expect(svg).toContain('<title>Hall 2 expansion · Ground floor · Row B · power rear</title>');
  expect(svg.match(/class="pw-cord"/g)).toHaveLength(33);

  // The front on the screen, or another view: the files are still the rear. A hidden grid stays out of them.
  await page.click('#pow-sides [data-pow-side="front"]');
  await page.click('#pow-grids [data-grid-eye="pg-b"]');
  await view(page, 'schedule');
  await page.click('#btn-export');
  await expect(hint('svg')).toHaveText('This row’s power cabling from the rear, opens in vector editors · 1 grid hidden');
  await expect(hint('print')).toHaveText('One sheet per row, its power cabling from the rear · 1 grid hidden');
  const [part] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="svg"]')]);
  expect(fs.readFileSync(await part.path(), 'utf8').match(/class="pw-cord"/g)).toHaveLength(18);
  const [png] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.click('#btn-export');
      await page.click('[data-export="png"]');
    })(),
  ]);
  expect(png.suggestedFilename()).toBe('hall-2-expansion-ground-floor-row-b-power-rear.png');
  expect(fs.readFileSync(await png.path()).subarray(1, 4).toString()).toBe('PNG');

  // Print: the sheet "Power rear" is picked in Power, one page per row.
  await page.evaluate(() => (window.print = () => (window.__printed = document.getElementById('print-root').innerHTML)));
  await page.click('#btn-export');
  await page.click('[data-export="print"]');
  await expect(page.locator('input[name="print-drawing"][value="power"]')).toBeChecked();
  await page.click('#dlg-print button[type="submit"]');
  const html = await page.evaluate(() => window.__printed);
  expect(html).toContain('pw-pdu');
  expect(html).toContain('power, from the rear');
  expect(html.match(/class="pw-cord"/g)).toHaveLength(18);
});
