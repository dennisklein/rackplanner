'use strict';

// Fixes from the last review of the Cabling workspace: port names told
// apart in the inspector, the rack the port map opens on, the Connect
// series title and its first port, toasts whose Undo would undo another
// step, read-only titles on touch screens, and the network dialog's hint.
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

/** Runs `fn(project, arg, RP)` in the page, with the plan as it is. */
const plan = (page, fn, arg) =>
  page.evaluate(({ fn, arg }) => new Function('p', 'arg', 'RP', `return (${fn})(p, arg, RP)`)(window.RP.app.project(), arg, window.RP), { fn: fn.toString(), arg });
const idOf = (page, name) => plan(page, (p, name) => p.devices.find((d) => d.name === name).id, name);
const ui = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.RP.app.ui)));
const counts = (page) => plan(page, (p) => ({ devices: p.devices.length, cables: p.cables.length }));
const row = (page, label) => page.locator('#sc-body tr[data-cable]').filter({ has: page.locator('.sc-label', { hasText: new RegExp(`^${label}$`) }) });
/** Clicks a row of the schedule on its label, away from the device links. */
const pick = (page, label, modifiers) => row(page, label).first().locator('td').nth(1).click({ modifiers });

async function toCabling(page, view) {
  await page.click('.ws-switch [data-workspace="cabling"]');
  if (view) await page.click(`#cab-toggle [data-cab-view="${view}"]`);
}
/** Selects a device in Cabling through the search. */
async function selectDevice(page, name) {
  await page.click('#search');
  await page.keyboard.type(name);
  await page.locator('.sr-item', { hasText: name }).first().click();
  await expect(page.locator('#inspector .name-static')).toHaveText(name);
}
/** The example plan changed by `change(p, M)` in Node, opened as a plan file named `name`. */
async function openChanged(page, name, change) {
  const M = require('../js/model.js');
  const IO = require('../js/io.js');
  const p = M.createExampleProject();
  change(p, M);
  delete p.meta.example;
  p.name = name;
  const out = IO.normalizeProject(JSON.parse(JSON.stringify(p))).project;
  await page.click('#btn-open');
  await page.setInputFiles('#file-input', { name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(out)) });
  await expect(page.locator('#plan-name')).toHaveValue(name);
}
/** Deletes ib-leaf-a01 and its 16 cables in Racks: a step that a wrong Undo would bring back. */
async function deleteLeafInRacks(page) {
  await page.locator('.scene .dev[aria-label^="ib-leaf-a01,"]').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.toast').last()).toContainText('Deleted ib-leaf-a01');
  expect(await counts(page)).toEqual({ devices: 64, cables: 131 });
}

test('the inspector’s port list shows names like Ethernet1/1 to Ethernet1/32 whole, each told apart', async ({ page }) => {
  await openChanged(page, 'Ethernet plan', (p) => {
    const t = p.deviceTypes.find((x) => x.id === 'switch-qsfp');
    t.ports = [{ name: 'Ethernet1/', first: 1, count: 32, connector: 'qsfp56', speedGbps: 200, side: 'front' }];
    const ids = new Set(p.devices.filter((d) => d.type === 'switch-qsfp').map((d) => d.id));
    const fix = (e) => {
      if (e && ids.has(e.device)) e.port = e.port.replace(/^p(\d+)$/, 'Ethernet1/$1');
    };
    for (const c of p.cables) [c.a].concat(c.b).forEach(fix);
  });
  await toCabling(page);
  await selectDevice(page, 'ib-leaf-a01');
  const names = page.locator('#inspector .pl-port b');
  await expect(names).toHaveCount(32);
  const shown = await names.evaluateAll((bs) => bs.map((b) => ({ text: b.textContent, cut: b.scrollWidth > b.clientWidth, lines: b.getClientRects().length, height: b.getBoundingClientRect().height })));
  expect(shown.map((x) => x.text)).toEqual(Array.from({ length: 32 }, (_, i) => `Ethernet1/${i + 1}`));
  // Whole, on one line each: nothing cut, nothing broken.
  expect(shown.filter((x) => x.cut)).toEqual([]);
  expect(new Set(shown.map((x) => Math.round(x.height))).size).toBe(1);
  // The far end still has room beside it.
  const peer = await page.locator('#inspector .pl-row .pl-peer').first().boundingBox();
  expect(peer.width).toBeGreaterThan(90);
});

test('the port map opens on the switch end of the cable selected, not on its server’s rack', async ({ page }) => {
  await page.click('.ws-switch [data-workspace="cabling"]');
  await page.click('#cab-toggle [data-cab-view="schedule"]');
  // MGT-0040 runs from arc-02 (Rack 2A02, no switch) to sw-arc-01 (Rack 2A01).
  const c = await plan(page, (p) => {
    const c = p.cables.find((x) => x.label === 'MGT-0040');
    return { a: p.devices.find((d) => d.id === c.a.device).name, b: p.devices.find((d) => d.id === c.b.device).name };
  });
  expect(c).toEqual({ a: 'arc-02', b: 'sw-arc-01' });
  // Chosen in the search: selected, and shown in the schedule of its row.
  await page.click('#search');
  await page.keyboard.type('MGT-0040');
  await page.locator('.sr-item', { hasText: 'MGT-0040' }).first().click();
  expect((await ui(page)).cabSel).toEqual({ kind: 'cables', ids: [await plan(page, (p) => p.cables.find((x) => x.label === 'MGT-0040').id)] });
  await page.click('#cab-toggle [data-cab-view="ports"]');
  await expect(page.locator('.pm-top h2')).toHaveText(/^Rack 2A01 · switches$/);
  await expect(page.locator(`.pm-card.is-current[data-pm-dev="${await idOf(page, 'sw-arc-01')}"]`)).toHaveCount(1);
  // With every device shown, its first end, as before.
  await page.click('[data-pm-filter="all"]');
  await page.click('#cab-toggle [data-cab-view="schedule"]');
  await page.click('#cab-toggle [data-cab-view="ports"]');
  await expect(page.locator('.pm-top h2')).toHaveText('Rack 2A02 · devices');
});

test('with nothing selected, the port map opens on the first rack of the row that has a switch', async ({ page }) => {
  // Row A's first rack without its switches.
  await openChanged(page, 'No switch in A01', (p, M) => {
    const a01 = p.floors[0].rows[0].racks[0].id;
    const gone = new Set(p.devices.filter((d) => d.loc.rack === a01 && /^(sw-|ib-leaf)/.test(d.name)).map((d) => d.id));
    p.devices = p.devices.filter((d) => !gone.has(d.id));
    p.cables = p.cables.filter((c) => !M.cableEnds(c).some((x) => gone.has(x.end.device)));
  });
  await toCabling(page, 'ports');
  await expect(page.locator('.pm-top h2')).toHaveText('Rack A02 · switches');
  await expect(page.locator('.pm-card')).not.toHaveCount(0);
});

test('the Connect series title names every rack its devices are in', async ({ page }) => {
  await toCabling(page);
  await selectDevice(page, 'ib-leaf-a01');
  await page.click('#cab-dev-series');
  await expect(page.locator('#connect-title')).toHaveText('12 devices from Rack A01');
  await page.selectOption('#cs-from-last', await idOf(page, 'gpu-004'));
  await expect(page.locator('#connect-title')).toHaveText('16 devices from Rack A01 to A02');
});

test('Connect prefills a first port of the To device that a cable joins to the From port', async ({ page }) => {
  // The leaves get an RJ45 port first, then QSFP-DD cages; cn-001's ib0 is free.
  await openChanged(page, 'QSFP-DD leaves', (p, M) => {
    const t = p.deviceTypes.find((x) => x.id === 'switch-qsfp');
    t.ports = [
      { name: 'mgmt', connector: 'rj45', speedGbps: 1, side: 'front' },
      { name: 'p', first: 1, count: 24, connector: 'qsfp-dd', speedGbps: 400, side: 'front' },
    ];
    const cn = p.devices.find((d) => d.name === 'cn-001');
    p.cables = p.cables.filter((c) => !M.cableEnds(c).some((x) => x.end.device === cn.id && x.end.port === 'ib0'));
  });
  await toCabling(page);
  await selectDevice(page, 'cn-001');
  await page.click('#inspector [data-cab-connect="ib0"]');
  await expect(page.locator('#dlg-connect')).toBeVisible();
  // No switch has a free QSFP port: the leaf of its rack, at the cage cn-001 was on, not at mgmt.
  await expect(page.locator('#cs-to')).toHaveValue(await idOf(page, 'ib-leaf-a01'));
  await expect(page.locator('#cs-to-port')).toHaveValue('p1');
  await expect(page.locator('#cs-rows')).not.toContainText('No cable type');
  await expect(page.locator('#cs-submit')).toHaveText('Connect 1 cable');
  // Another leaf picked: its first cage too.
  await page.selectOption('#cs-to', await idOf(page, 'ib-leaf-a02'));
  await expect(page.locator('#cs-to-port')).toHaveValue('p12');
  // A port picked by hand that joins stays when the From port changes back and forth.
  await page.selectOption('#cs-to-port', 'p20');
  await page.selectOption('#cs-from-port', 'ib0');
  await expect(page.locator('#cs-to-port')).toHaveValue('p20');
});

test('a CSV merge that adds nothing offers no Undo, and leaves the step before it and the Cabling state alone', async ({ page }) => {
  await deleteLeafInRacks(page);
  const csv = await page.evaluate(() => window.RP.io.toCSV(window.RP.app.project()));
  await toCabling(page, 'schedule');
  await page.fill('#sc-filter', 'IB');
  await pick(page, 'IB-0020');
  const before = (await ui(page)).cabSel;
  expect(before).toMatchObject({ kind: 'cables' });

  await page.click('#btn-open');
  await page.check('#open-merge');
  await page.fill('#open-text', csv);
  await page.click('#open-form button[type="submit"]');
  await expect(page.locator('.toast', { hasText: 'No devices added from the CSV' })).toBeVisible();
  if (await page.locator('#dlg-report').isVisible()) await page.click('#dlg-report button[value="ok"]');
  await expect(page.locator('.toast', { hasText: 'Added 0 devices' })).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'No devices added from the CSV' }).locator('button')).toHaveCount(0);
  expect(await counts(page)).toEqual({ devices: 64, cables: 131 });
  // The selection and the filter stay.
  expect((await ui(page)).cabSel).toEqual(before);
  await expect(page.locator('#sc-filter')).toHaveValue('IB');
  // Undo still undoes the delete.
  await page.click('#btn-undo');
  expect(await counts(page)).toEqual({ devices: 65, cables: 147 });
});

test('renumbering cables to the labels they have offers no Undo that would undo another step', async ({ page }) => {
  await deleteLeafInRacks(page);
  await toCabling(page, 'schedule');
  await pick(page, 'MGT-0001');
  await pick(page, 'MGT-0002', ['Control']);
  await expect(page.locator('#multi-label')).toHaveValue('MGT-0001');
  await page.click('#multi-renumber');
  const t = page.locator('.toast').last();
  await expect(t).toContainText('MGT-0001 … MGT-0002: the labels are in this sequence already');
  await expect(t.locator('button')).toHaveCount(0);
  expect(await counts(page)).toEqual({ devices: 64, cables: 131 });
  // A renumber that changes labels still offers Undo.
  await page.fill('#multi-label', 'R-001');
  await page.click('#multi-renumber');
  await expect(page.locator('.toast').last()).toContainText('Labeled R-001 … R-002');
  await page.locator('.toast button', { hasText: 'Undo' }).last().click();
  expect(await plan(page, (p) => p.cables.filter((c) => /^MGT-000[12]$/.test(c.label)).length)).toBe(2);
  expect(await counts(page)).toEqual({ devices: 64, cables: 131 });
});

test('unplugging a leg of a breakout cable without a label names the cable', async ({ page }) => {
  await openChanged(page, 'Unlabeled breakout', (p) => {
    p.cables.find((c) => c.type === 'dac-osfp-2x').label = '';
  });
  const id = await plan(page, (p) => p.cables.find((c) => c.type === 'dac-osfp-2x').id);
  await toCabling(page, 'schedule');
  await page.keyboard.press(']');
  await page.locator(`#sc-body tr[data-cable="${id}"] td`).nth(1).click();
  await page.click('[data-cab-unplug-leg="1"]');
  const after = await plan(page, (p, id) => p.cables.find((c) => c.id === id).label, id);
  await expect(page.locator('.toast').last()).toHaveText(new RegExp(`^Unplugged leg 2 of ${after || 'the cable'}`));
  // Its last leg: the cable goes, named.
  await page.click('[data-cab-unplug-leg="0"]');
  await expect(page.locator('.toast').last()).toHaveText(/^Deleted \S+, its last leg unplugged/);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a read-only device title has no input outline; the cable label that is editable has one', async ({ page }) => {
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    const border = (sel) => page.locator(sel).evaluate((e) => getComputedStyle(e).borderTopColor);
    await toCabling(page, 'schedule');
    await page.locator('#sc-body tr[data-cable]').first().locator('td').nth(1).click();
    await expect(page.locator('#cab-label')).toBeVisible();
    expect(await border('#cab-label')).not.toBe('rgba(0, 0, 0, 0)');
    await page.locator('#inspector .end-dev').first().click();
    await expect(page.locator('#inspector .name-static')).toBeVisible();
    expect(await border('#inspector .name-static')).toBe('rgba(0, 0, 0, 0)');
  });

  test('the network dialog’s hint keeps each label of its series on one line', async ({ page }) => {
    await toCabling(page, 'schedule');
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator('#networks [data-net-edit="n-ib"]').dispatchEvent('click');
      const labels = page.locator('#network-label-hint .label-eg');
      await expect(labels).toHaveText(['IB-0001', 'IB-0002']);
      expect(await labels.evaluateAll((ls) => ls.map((l) => l.getClientRects().length))).toEqual([1, 1]);
      await page.fill('#network-label', 'SAN-A-0001');
      await expect(labels).toHaveText(['SAN-A-0001', 'SAN-A-0002']);
      expect(await labels.evaluateAll((ls) => ls.map((l) => l.getClientRects().length))).toEqual([1, 1]);
      await page.keyboard.press('Escape');
      await expect(page.locator('#dlg-network')).toBeHidden();
    }
  });
});
