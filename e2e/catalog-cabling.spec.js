'use strict';

// The catalog's ports, cable types and transceivers, length settings in the
// inspectors, and cables following devices that are deleted or duplicated.
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

const device = (page, name) => page.locator(`.scene .dev[aria-label^="${name},"]`);
const plan = (page, fn, arg) => page.evaluate(({ fn, arg }) => new Function('p', 'arg', `return (${fn})(p, arg)`)(window.RP.app.project(), arg), { fn: fn.toString(), arg });
const cableCount = (page) => plan(page, (p) => p.cables.length);
const undoToast = (page) => page.locator('.toast button', { hasText: 'Undo' });
/** Cables with an end on device `id`. */
const cablesOf = (page, id) => plan(page, (p, id) => p.cables.filter((c) => [c.a].concat(c.b).some((e) => e && e.device === id)).length, id);
const idOf = (page, name) => plan(page, (p, name) => p.devices.find((d) => d.name === name).id, name);
const selected = (page) => page.locator('#cat-list .cat-item[aria-selected="true"]');

test('the ports of a device type are edited as patterns; unplugging cables asks first and can be undone', async ({ page }) => {
  await page.click('#btn-catalog');
  await page.click('.cat-item[data-id="switch-rj45"]');
  // General stays the first view, with the fields as before.
  await expect(page.locator('#cat-label')).toHaveValue('48-port switch');
  await expect(page.locator('#cat-sub-general')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#cat-tab-devices')).toHaveAttribute('aria-selected', 'true');
  await page.click('#cat-sub-ports');
  await expect(page.locator('#cat-sub-ports')).toHaveText('Ports · 52');
  await expect(page.locator('#cat-tab-devices')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#cat-pg-0-names')).toHaveValue('swp[1-48]');
  await expect(page.locator('.cat-side')).toHaveText(['Front', 'Rear']);

  // A new group is the next free single port, ready to be renamed; Enter moves on.
  await page.click('#cat-pg-add');
  await expect(page.locator('#cat-pg-2-names')).toHaveValue('eth0');
  await expect(page.locator('#cat-pg-2-names')).toBeFocused();
  await page.keyboard.type('mgmt[0-1]');
  await page.keyboard.press('Enter');
  await expect(page.locator('#cat-pg-2-connector')).toBeFocused();
  await expect(page.locator('#cat-sub-ports')).toHaveText('Ports · 54');
  await expect(page.locator('.pt-table tbody tr').nth(2).locator('.pt-count')).toHaveText('2');
  await page.selectOption('#cat-pg-2-connector', 'sfp28');
  await expect(page.locator('#cat-pg-2-speed')).toHaveValue('25');
  await expect(page.locator('#cat-pg-2-connector')).toBeFocused();
  expect(await plan(page, (p) => p.deviceTypes.find((t) => t.id === 'switch-rj45').ports[2])).toEqual({
    name: 'mgmt', first: 0, count: 2, connector: 'sfp28', speedGbps: 25, side: 'rear',
  });

  // Patterns that are no pattern, names used twice: refused with the reason, the text kept.
  await page.fill('#cat-pg-2-names', 'swp[1-');
  await page.press('#cat-pg-2-names', 'Tab');
  await expect(page.locator('#cat-error')).toContainText('isn’t a port name or a range');
  await expect(page.locator('#cat-pg-2-names')).toHaveValue('swp[1-');
  await expect(page.locator('#cat-pg-2-connector')).toBeFocused();
  await page.fill('#cat-pg-2-names', 'swp50');
  await page.press('#cat-pg-2-names', 'Tab');
  await expect(page.locator('#cat-error')).toHaveText('Port swp50 is named twice');
  await page.fill('#cat-pg-2-names', 'mgmt[0-1]');
  await page.press('#cat-pg-2-names', 'Tab');
  await expect(page.locator('#cat-error')).toBeHidden();

  // Fewer ports unplug cables: the change names them first.
  const before = await cableCount(page);
  await page.fill('#cat-pg-0-names', 'swp[1-24]');
  await page.press('#cat-pg-0-names', 'Tab');
  await expect(page.locator('#dlg-confirm')).toBeVisible();
  await expect(page.locator('#confirm-title')).toHaveText(/^Unplug \d+ cables\?$/);
  await expect(page.locator('#confirm-body')).toContainText(/plugged into: BMC-\d{4}, BMC-\d{4}\./);
  await page.click('#dlg-confirm button[value="cancel"]');
  await expect(page.locator('#cat-pg-0-names')).toHaveValue('swp[1-48]');
  expect(await cableCount(page)).toBe(before);

  await page.fill('#cat-pg-0-names', 'swp[1-24]');
  await page.press('#cat-pg-0-names', 'Tab');
  await page.click('#confirm-ok');
  await expect(page.locator('#dlg-catalog')).toBeVisible();
  await expect(page.locator('#cat-pg-0-names')).toHaveValue('swp[1-24]');
  await expect(page.locator('#cat-sub-ports')).toHaveText('Ports · 30');
  const after = await cableCount(page);
  expect(after).toBeLessThan(before);
  await undoToast(page).click();
  await expect(page.locator('#cat-pg-0-names')).toHaveValue('swp[1-48]');
  expect(await cableCount(page)).toBe(before);

  // A group without cables goes at once.
  await page.click('#cat-pg-2-del');
  await expect(page.locator('#dlg-confirm')).toBeHidden();
  await expect(page.locator('#cat-sub-ports')).toHaveText('Ports · 52');

  // Ports copied from another type, and the type's slack.
  await page.click('.cat-item[data-id="compute-node"]');
  await expect(page.locator('#cat-pg-0-names')).toHaveValue('bmc');
  await page.click('#cat-new');
  await page.click('[data-template="6"]');
  await expect(page.locator('#cat-label')).toHaveValue('Generic device');
  await page.click('#cat-sub-ports');
  await expect(page.locator('.pt-table')).toHaveCount(0);
  await page.click('#cat-pg-copy');
  await page.click('#cat-pg-menu [data-pg-copy="compute-node"]');
  await expect(page.locator('#cat-sub-ports')).toHaveText('Ports · 3');
  await page.fill('#cat-slack', '0.4');
  await page.press('#cat-slack', 'Tab');
  const made = await plan(page, (p) => p.deviceTypes[p.deviceTypes.length - 1]);
  expect(made.slackM).toBe(0.4);
  expect(made.ports.map((g) => g.name)).toEqual(['bmc', 'eth0', 'ib0']);
});

test('rack types and racks set their cable lengths, floors their row pitch', async ({ page }) => {
  await page.click('#btn-catalog');
  await page.click('#cat-tab-racks');
  await expect(selected(page)).toContainText('47U rack');
  await expect(page.locator('#cat-rtray')).toHaveValue('0.5');
  for (const [sel, v] of [['#cat-rwidth', '800'], ['#cat-rdepth', '1000'], ['#cat-rtray', '0.8'], ['#cat-rslack', '0.4']]) {
    await page.fill(sel, v);
    await page.press(sel, 'Tab');
  }
  expect(await plan(page, (p) => p.rackTypes[0])).toMatchObject({ id: 'rack-47', widthMm: 800, depthMm: 1000, trayM: 0.8, slackM: 0.4 });
  await page.click('#dlg-catalog [data-close]');

  // A rack takes its type's values until it gets its own; emptied, it takes them again.
  await page.locator('.rack-head[data-rack="r1"]').click();
  await expect(page.locator('#insp-rack-tray')).toHaveValue('');
  await expect(page.locator('#insp-rack-tray')).toHaveAttribute('placeholder', '0.8 (type)');
  await expect(page.locator('#insp-rack-slack')).toHaveAttribute('placeholder', '0.4 (type)');
  await page.fill('#insp-rack-tray', '1.2');
  await page.press('#insp-rack-tray', 'Tab');
  await page.fill('#insp-rack-slack', '0');
  await page.press('#insp-rack-slack', 'Tab');
  const rack = () => plan(page, (p) => p.floors[0].rows[0].racks.find((r) => r.id === 'r1'));
  expect(await rack()).toMatchObject({ trayM: 1.2, slackM: 0 });
  await page.fill('#insp-rack-tray', '');
  await page.press('#insp-rack-tray', 'Tab');
  expect(await rack()).toMatchObject({ trayM: null, slackM: 0 });

  await page.locator('.ftab[aria-pressed="true"]').click();
  await expect(page.locator('#floor-pitch')).toHaveValue('3');
  await page.fill('#floor-pitch', '2.4');
  await page.press('#floor-pitch', 'Tab');
  expect(await plan(page, (p) => p.floors[0].rowPitchM)).toBe(2.4);
  await page.fill('#floor-pitch', '');
  await page.press('#floor-pitch', 'Tab');
  expect(await plan(page, (p) => p.floors[0].rowPitchM)).toBe(3);
});

test('cable types are added from templates, sold in stock lengths or made to length, and kept while cables name them', async ({ page }) => {
  await page.click('#btn-catalog');
  await page.click('#cat-tab-cables');
  await expect(page.locator('#cat-tab-cables')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#cat-tab-devices')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('.cat-item[data-id="mpo-om4"] .cat-sub')).toHaveText('OM4 · MPO · made to length');
  await expect(page.locator('.cat-item[data-id="dac-osfp-2x"] .cat-sub')).toHaveText('DAC · OSFP → 2 × QSFP56');
  const n = await plan(page, (p) => p.cableTypes.length);

  await page.click('#cat-new');
  await page.click('[data-template="2"]');
  await expect(page.locator('#cat-c-name')).toHaveValue('QSFP56 DAC 2');
  await expect(selected(page).locator('.cat-sub')).toHaveText('DAC · QSFP56 · 0.5–\u20603 m');
  expect(await plan(page, (p) => p.cableTypes.length)).toBe(n + 1);

  await page.fill('#cat-c-lengths', '3, 1 m, 2');
  await page.press('#cat-c-lengths', 'Tab');
  await expect(page.locator('#cat-c-lengths')).toHaveValue('1, 2, 3');
  await expect(selected(page).locator('.cat-sub')).toHaveText('DAC · QSFP56 · 1–\u20603 m');
  await page.fill('#cat-c-lengths', '1, two');
  await page.press('#cat-c-lengths', 'Tab');
  await expect(page.locator('#cat-error')).toContainText('“two” isn’t a length');
  await expect(page.locator('#cat-c-lengths')).toHaveValue('1, two');

  // Made to length empties the stock lengths; unticked, they come back.
  await page.check('#cat-c-made');
  await expect(page.locator('#cat-c-lengths')).toBeDisabled();
  await expect(page.locator('#cat-c-lengths')).toHaveValue('');
  await expect(page.locator('#cat-error')).toBeHidden();
  await expect(selected(page).locator('.cat-sub')).toHaveText('DAC · QSFP56 · made to length');
  await page.uncheck('#cat-c-made');
  await expect(page.locator('#cat-c-lengths')).toHaveValue('1, 2, 3');

  // Fiber media take fiber plugs.
  await page.selectOption('#cat-c-media', 'om4');
  await expect(page.locator('#cat-c-conn option')).toHaveText(['LC duplex', 'MPO']);
  await page.selectOption('#cat-c-conn', 'mpo');
  expect(await plan(page, (p) => p.cableTypes[p.cableTypes.length - 1])).toMatchObject({ media: 'om4', connector: 'mpo', lengthsM: [1, 2, 3] });

  // Types that cables name stay; others go, with Undo.
  await page.click('.cat-item[data-id="dac-osfp-2x"]');
  await expect(page.locator('.cat-actions .sec-hint')).toHaveText(/^\d+ cables use this type; \d+ by name$/);
  await page.click('#cat-delete');
  await expect(page.locator('#cat-error')).toContainText('cables use this type');
  await expect(page.locator('.cat-item[data-id="dac-osfp-2x"]')).toHaveCount(1);
  // A type that Auto picks for cables, which no cable names, counts them as the Cables panel does; it can go.
  await page.click('.cat-item[data-id="cat6a"]');
  const cat6a = String(await plan(page, (p) => p.cables.filter((c) => (window.RP.cabling.describe(p, c).type || {}).id === 'cat6a').length));
  expect(Number(cat6a)).toBeGreaterThan(0);
  await expect(page.locator('.cat-item[data-id="cat6a"] .cat-count')).toHaveText(cat6a);
  await expect(page.locator('.cat-actions .sec-hint')).toHaveText(`${cat6a} cables use this type; Auto picked it for all of them`);
  await page.click('#cat-delete');
  await expect(page.locator('.cat-item[data-id="cat6a"]')).toHaveCount(0);
  await undoToast(page).click();
  await expect(page.locator('.cat-item[data-id="cat6a"]')).toHaveCount(1);
  expect(await plan(page, (p) => p.cableTypes.length)).toBe(n + 1);
});

test('transceivers are added from templates and edited', async ({ page }) => {
  await page.click('#btn-catalog');
  await page.click('#cat-tab-transceivers');
  await expect(page.locator('.cat-item[data-id="qsfp56-200g-sr4"] .cat-sub')).toHaveText('QSFP56 · MPO · MMF · 100 m');
  await page.click('#cat-new');
  await page.click('[data-template="3"]');
  await expect(page.locator('#cat-x-name')).toHaveValue('QSFP28 100G LR4 2');
  await page.selectOption('#cat-x-conn', 'osfp');
  await page.selectOption('#cat-x-mode', 'mmf');
  await page.selectOption('#cat-x-fiber', 'mpo');
  await page.fill('#cat-x-reach', '70');
  await page.press('#cat-x-reach', 'Tab');
  await expect(selected(page).locator('.cat-sub')).toHaveText('OSFP · MPO · MMF · 70 m');
  await page.click('[data-cat-move="-1"]');
  const ids = await plan(page, (p) => p.transceivers.map((t) => t.id));
  expect(ids[ids.length - 2]).toBe(await plan(page, (p) => p.transceivers.find((t) => t.name === 'QSFP28 100G LR4 2').id));
  await expect(page.locator('.cat-actions .sec-hint')).toHaveText('No cable end uses this transceiver');
  await page.click('#cat-delete');
  expect(await plan(page, (p) => p.transceivers.some((t) => t.name === 'QSFP28 100G LR4 2'))).toBe(false);
});

test('a device is mounted front to front or back to front, one or several at a time', async ({ page }) => {
  await device(page, 'cn-001').click();
  await expect(page.locator('#insp-mount-front')).toBeChecked();
  await page.click('label:has(#insp-mount-back)');
  const reversed = (name) => plan(page, (p, name) => p.devices.find((d) => d.name === name).reversed, name);
  expect(await reversed('cn-001')).toBe(true);
  await expect(page.locator('#insp-mount-back')).toBeChecked();

  // Mixed: neither is checked, and a pick sets all.
  await device(page, 'cn-002').click({ modifiers: ['Shift'] });
  await expect(page.locator('.multi-title')).toHaveText('2 devices');
  await expect(page.locator('#multi-mount-front')).not.toBeChecked();
  await expect(page.locator('#multi-mount-back')).not.toBeChecked();
  await page.click('label:has(#multi-mount-back)');
  expect(await reversed('cn-002')).toBe(true);
  await expect(page.locator('#multi-mount-back')).toBeChecked();
  await page.click('label:has(#multi-mount-front)');
  expect([await reversed('cn-001'), await reversed('cn-002')]).toEqual([false, false]);
});

test('deleting devices deletes their cables; confirmations count them', async ({ page }) => {
  const before = await cableCount(page);
  const id = await idOf(page, 'cn-001');
  expect(await cablesOf(page, id)).toBe(3);
  await device(page, 'cn-001').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.toast').last()).toContainText('Deleted cn-001 and 3 cables');
  expect(await cableCount(page)).toBe(before - 3);
  expect(await cablesOf(page, id)).toBe(0);
  await page.keyboard.press('Control+z');
  expect(await cableCount(page)).toBe(before);

  await page.locator('.rack-head[data-rack="r1"]').click();
  await page.click('#insp-del-rack');
  await expect(page.locator('#confirm-body')).toContainText(/It holds 15 devices and \d+ cables, which are deleted with it/);
  await page.click('#confirm-ok');
  expect(await plan(page, (p) => {
    const ids = new Set(p.devices.map((d) => d.id));
    return p.cables.every((c) => [c.a].concat(c.b).every((e) => !e || ids.has(e.device)));
  })).toBe(true);
  expect(await cableCount(page)).toBeLessThan(before);
});

test('duplicating cabled devices copies the cables between them', async ({ page }) => {
  const before = await cableCount(page);
  await device(page, 'cn-001').click();
  await device(page, 'sw-mgmt-a01').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+d');
  await expect(page.locator('.multi-title')).toHaveText('2 devices');
  await expect(page.locator('.toast').last()).toContainText('Duplicated 2 devices and 1 cable');
  expect(await cableCount(page)).toBe(before + 1);
  const copy = await plan(page, (p) => {
    const c = p.cables[p.cables.length - 1];
    const name = (id) => p.devices.find((d) => d.id === id).name;
    return { a: [name(c.a.device), c.a.port], b: [name(c.b.device), c.b.port], label: c.label };
  });
  expect(copy.a[1]).toBe('eth0');
  expect(copy.b[1]).toBe('swp1');
  expect(copy.a[0]).not.toBe('cn-001');
  expect(copy.b[0]).not.toBe('sw-mgmt-a01');
  expect(copy.label).toMatch(/^MGT-\d{4}$/);
  await page.keyboard.press('Control+z');
  expect(await cableCount(page)).toBe(before);
});

test('the catalog tabs fit a phone, scrolling sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#btn-catalog');
  const tabs = await page.locator('#dlg-catalog .tabs').boundingBox();
  const dlg = await page.locator('#dlg-catalog').boundingBox();
  expect(tabs.x + tabs.width).toBeLessThanOrEqual(dlg.x + dlg.width);
  await page.locator('#cat-tab-transceivers').scrollIntoViewIfNeeded();
  await page.click('#cat-tab-transceivers');
  await expect(page.locator('#cat-x-name')).toBeVisible();
});

test('arrow keys on the Mounted radios switch them and keep focus there', async ({ page }) => {
  await device(page, 'cn-001').click();
  const loc = () => plan(page, (p) => JSON.stringify(p.devices.find((d) => d.name === 'cn-001').loc));
  const reversed = () => plan(page, (p) => p.devices.find((d) => d.name === 'cn-001').reversed);
  const at = await loc();
  await page.focus('#insp-mount-front');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#insp-mount-back')).toBeChecked();
  await expect(page.locator('#insp-mount-back')).toBeFocused();
  expect(await reversed()).toBe(true);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#insp-mount-front')).toBeChecked();
  await expect(page.locator('#insp-mount-front')).toBeFocused();
  expect(await reversed()).toBe(false);
  expect(await loc()).toBe(at);

  // Reserved space faces no way: no Mounted radios, and a group sets only its devices.
  await page.fill('#search', 'Core expansion');
  await page.keyboard.press('Enter');
  await expect(page.locator('#insp-name')).toHaveValue('Core expansion');
  await expect(page.locator('#insp-mount-front')).toHaveCount(0);
});

test('dragging a device mounted back to front shows its rear as the ghost', async ({ page }) => {
  const sw = device(page, 'sw-mgmt-a01');
  const face = await sw.evaluate((e) => e.innerHTML);
  expect(face).toContain('r="1.3"'); // the LEDs of its power supplies: the rear is drawn
  const b = await sw.boundingBox();
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 40, b.y + b.height / 2 + 30, { steps: 4 });
  await page.mouse.move(b.x + 40, b.y + b.height / 2 + 45, { steps: 4 });
  await expect(page.locator('.drag-chip')).toBeVisible();
  const ghost = await page.locator('#ghost-layer').evaluate((e) => e.innerHTML);
  expect((ghost.match(/r="1\.3"/g) || []).length).toBe(2);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('length fields show the value kept when a typed one is out of range', async ({ page }) => {
  await page.locator('.rack-head[data-rack="r1"]').click();
  await page.fill('#insp-rack-tray', '25');
  await page.press('#insp-rack-tray', 'Tab');
  await expect(page.locator('#insp-rack-tray')).toHaveValue('10');
  await page.fill('#insp-rack-slack', '-3');
  await page.press('#insp-rack-slack', 'Tab');
  await expect(page.locator('#insp-rack-slack')).toHaveValue('0');
  expect(await plan(page, (p) => p.floors[0].rows[0].racks.find((r) => r.id === 'r1'))).toMatchObject({ trayM: 10, slackM: 0 });
  await page.locator('.ftab[aria-pressed="true"]').click();
  await page.fill('#floor-pitch', '100');
  await page.press('#floor-pitch', 'Tab');
  await expect(page.locator('#floor-pitch')).toHaveValue('50');
});

test('the ports editor draws the front ports, keeps focus on keyboard edits and shows errors in red', async ({ page }) => {
  await page.click('#btn-catalog');
  await page.click('.cat-item[data-id="switch-rj45"]');
  await page.click('#cat-sub-ports');
  const front = page.locator('.cat-preview svg').first();
  const ports = () => front.evaluate((e) => e.querySelectorAll('rect[rx="0.6"], rect[rx="0.8"]').length);
  expect(await ports()).toBe(52);

  // Enter after a change that unplugs cables, and Enter on its question: focus goes on along the row.
  await page.focus('#cat-pg-0-names');
  await page.fill('#cat-pg-0-names', 'swp[1-8]');
  await page.keyboard.press('Enter');
  await expect(page.locator('#dlg-confirm')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#cat-sub-ports')).toHaveText('Ports · 12');
  await expect(page.locator('#cat-pg-0-connector')).toBeFocused();
  expect(await ports()).toBe(12);

  // Removing the last row by keyboard leaves focus on the row above, then on Add ports.
  await page.focus('#cat-pg-1-del');
  await page.keyboard.press('Enter');
  await expect(page.locator('#dlg-confirm')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#cat-pg-1-names')).toHaveCount(0);
  await expect(page.locator('#cat-pg-0-del')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#dlg-confirm')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.pt-table')).toHaveCount(0);
  await expect(page.locator('#cat-pg-add')).toBeFocused();

  // A refused pattern is an error, in the danger color.
  await page.click('#cat-pg-add');
  await page.fill('#cat-pg-0-names', 'eth[');
  await page.press('#cat-pg-0-names', 'Tab');
  await expect(page.locator('#cat-error')).toBeVisible();
  const colors = await page.evaluate(() => [getComputedStyle(document.querySelector('#cat-error')).color, getComputedStyle(document.body).getPropertyValue('--danger').trim()]);
  const probe = await page.evaluate((c) => {
    const s = document.createElement('span');
    s.style.color = c;
    document.body.append(s);
    const v = getComputedStyle(s).color;
    s.remove();
    return v;
  }, colors[1]);
  expect(colors[0]).toBe(probe);
});

test('the copy-ports menu stays inside the dialog body', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.click('#btn-catalog');
    await page.click('.cat-item[data-id="switch-rj45"]');
    await page.click('#cat-sub-ports');
    await page.locator('#cat-pg-copy').scrollIntoViewIfNeeded();
    await page.click('#cat-pg-copy');
    await expect(page.locator('#cat-pg-menu')).toBeVisible();
    const [menu, body] = await page.evaluate(() => ['#cat-pg-menu', '#dlg-catalog .dlg-body'].map((s) => document.querySelector(s).getBoundingClientRect().toJSON()));
    expect(menu.top).toBeGreaterThanOrEqual(body.top - 1);
    expect(menu.bottom).toBeLessThanOrEqual(body.bottom + 1);
    expect(menu.right).toBeLessThanOrEqual(body.right + 1);
    // Every type is reachable in the menu itself.
    const last = page.locator('#cat-pg-menu button').last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await page.keyboard.press('Escape');
    await page.click('#dlg-catalog [data-close]');
  }
});

test('the catalog fits a phone: only the port table scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#btn-catalog');
  await page.click('.cat-item[data-id="switch-rj45"]');
  await page.click('#cat-sub-ports');
  await expect(page.locator('.pt-table')).toBeVisible();
  const [scroll, client] = await page.locator('#dlg-catalog').evaluate((e) => [e.scrollWidth, e.clientWidth]);
  expect(scroll).toBeLessThanOrEqual(client);
});

test('sub lines of cable types break only between their parts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('#btn-catalog');
  await page.click('#cat-tab-cables');
  // Where a sub line wraps, the line before ends with a dot separator.
  const bad = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('#cat-list .cat-sub')) {
      const node = el.firstChild;
      if (!node) continue;
      const r = document.createRange();
      let top = null;
      for (let i = 0; i < node.length; i++) {
        r.setStart(node, i);
        r.setEnd(node, i + 1);
        const rect = r.getClientRects()[0];
        if (!rect || !rect.width) continue;
        if (top !== null && rect.top > top + 2 && !/·\s*$/.test(node.data.slice(0, i).replace(/[ ⁠]/g, ' '))) out.push(node.data);
        top = rect.top;
      }
    }
    return out;
  });
  expect(bad).toEqual([]);
});

test('a field of the inspector gives up focus when another thing is selected, and keeps an edit made before', async ({ page }) => {
  const focused = () => page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
  // Typing a rack's name, then picking the next rack: keys belong to the plan again.
  await page.locator('.rack-head[data-rack="r1"]').click();
  await page.fill('#insp-rack-name', 'Spine A');
  await page.locator('.rack-head[data-rack="r2"]').click();
  await expect(page.locator('#insp-rack-name')).toHaveValue('Rack A02');
  expect(await focused()).not.toBe('insp-rack-name');
  const row = () => page.evaluate(() => window.RP.app.ui.rowId);
  const rowA = await row();
  await page.keyboard.press(']');
  expect(await row()).not.toBe(rowA);
  expect(await plan(page, (p) => p.floors[0].rows[0].racks.map((r) => r.name))).toEqual(['Spine A', 'Rack A02', 'Rack A03']);
  await page.keyboard.press('[');
  expect(await row()).toBe(rowA);

  // A multi-selection's owner field, then one more device: Delete deletes them.
  const devs = page.locator('.scene .dev');
  await devs.nth(3).click();
  await devs.nth(4).click({ modifiers: ['Shift'] });
  await page.click('#multi-owner');
  await devs.nth(5).click({ modifiers: ['Shift'] });
  expect(await focused()).not.toBe('multi-owner');
  const before = await plan(page, (p) => p.devices.length);
  await page.keyboard.press('Delete');
  await expect.poll(() => plan(page, (p) => p.devices.length)).toBe(before - 3);

  // A length typed and not yet left, then a click on the same rack: kept and shown.
  await page.locator('.rack-head[data-rack="r1"]').click();
  await page.click('#insp-rack-tray');
  await page.keyboard.type('3');
  await page.locator('.rack-head[data-rack="r1"]').click();
  await expect(page.locator('#insp-rack-tray')).toHaveValue('3');
  await expect(page.locator('#insp-rack-tray')).toBeFocused();
  expect(await plan(page, (p) => p.floors[0].rows[0].racks[0].trayM)).toBe(3);
});

test('port group actions clicked straight from an edited field do what they say', async ({ page }) => {
  await page.click('#btn-catalog');
  await page.click('.cat-item[data-id="switch-rj45"]');
  await page.click('#cat-sub-ports');
  // Add ports: the new group is ready to be renamed.
  await page.fill('#cat-pg-1-names', 'swp[49-54]');
  await page.click('#cat-pg-add');
  await expect(page.locator('#cat-pg-2-names')).toBeFocused();
  await page.keyboard.type('mgmt0');
  await page.keyboard.press('Tab');
  expect(await plan(page, (p) => p.deviceTypes.find((t) => t.id === 'switch-rj45').ports.map((g) => g.name))).toEqual(['swp', 'swp', 'mgmt0']);
  // Copy ports from…: the menu opens at the first click.
  await page.fill('#cat-pg-1-names', 'swp[49-53]');
  await page.click('#cat-pg-copy');
  await expect(page.locator('#cat-pg-menu')).toBeVisible();
  await expect(page.locator('#cat-pg-copy')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
});

test('the port table keeps focus and its text in place through questions, copies and undo', async ({ page }) => {
  await page.click('#btn-catalog');
  await page.click('.cat-item[data-id="switch-rj45"]');
  await page.click('#cat-sub-ports');
  // No to unplugging: focus goes back to the remove button pressed.
  await page.focus('#cat-pg-1-del');
  await page.keyboard.press('Enter');
  await expect(page.locator('#dlg-confirm')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pt-table tbody tr')).toHaveCount(2);
  await expect(page.locator('#cat-pg-1-del')).toBeFocused();

  // A range over the limit says so.
  await page.fill('#cat-pg-1-names', 'swp[49-2000]');
  await page.press('#cat-pg-1-names', 'Tab');
  await expect(page.locator('#cat-error')).toHaveText('A device type has at most 1024 ports');

  // Text refused before an undo stays with no group of the plan undone to.
  await page.click('#cat-pg-0-del');
  await page.click('#confirm-ok');
  await expect(page.locator('.pt-table tbody tr')).toHaveCount(1);
  await page.fill('#cat-pg-0-names', 'swp[49-');
  await page.press('#cat-pg-0-names', 'Tab');
  await expect(page.locator('#cat-error')).toBeVisible();
  await undoToast(page).click();
  await expect(page.locator('#cat-pg-0-names')).toHaveValue('swp[1-48]');
  await expect(page.locator('#cat-pg-1-names')).toHaveValue('swp[49-52]');
  await expect(page.locator('#cat-error')).toBeHidden();

  // Copying ports by keyboard leaves focus on the menu's button.
  await page.click('.cat-item[data-id="patch-panel"]');
  await page.click('#cat-sub-ports');
  await page.focus('#cat-pg-copy');
  await page.keyboard.press('Enter');
  await page.locator('#cat-pg-menu [data-pg-copy="switch-rj45"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#cat-pg-0-names')).toHaveValue('swp[1-48]');
  await expect(page.locator('#cat-pg-copy')).toBeFocused();
});

test('Tab after an edit in the catalog moves on to the next field', async ({ page }) => {
  await page.click('#btn-catalog');
  await page.click('.cat-item[data-id="switch-rj45"]');
  await page.fill('#cat-label', 'Edge switch');
  await page.keyboard.press('Tab');
  const next = await page.evaluate(() => document.activeElement.id);
  expect(next).not.toBe('');
  expect(next).not.toBe('cat-label');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#cat-label')).toBeFocused();
  await page.click('#cat-tab-cables');
  await page.fill('#cat-c-name', 'Patch lead');
  await page.keyboard.press('Tab');
  await expect(page.locator('#cat-c-media')).toBeFocused();
  expect(await plan(page, (p) => p.deviceTypes.find((t) => t.id === 'switch-rj45').label)).toBe('Edge switch');
});

test('a toast shown before a dialog opens moves into it and stays in reach', async ({ page }) => {
  await page.click('#btn-new');
  await page.click('#menu-new [data-new="empty"]');
  await expect(page.locator('#toasts button')).toHaveText('Back');
  await page.click('#btn-catalog');
  await expect(page.locator('#dlg-catalog #toasts')).toHaveCount(1);
  await page.locator('#toasts button').click({ timeout: 2000 });
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

test('on a phone the selected catalog tab scrolls into view', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#btn-catalog');
  // A tap does not scroll like Playwright's clicks do.
  await page.locator('#cat-tab-transceivers').dispatchEvent('click');
  await expect(page.locator('#cat-tab-transceivers')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => {
    const strip = await page.locator('#dlg-catalog .tabs').boundingBox();
    const tab = await page.locator('#cat-tab-transceivers').boundingBox();
    return tab.x + tab.width <= strip.x + strip.width + 0.5 && tab.x >= strip.x - 0.5;
  }).toBe(true);
});

test('keyboard focus on the Mounted radios shows', async ({ page }) => {
  await device(page, 'sw-mgmt-a01').click();
  await page.focus('#insp-slot');
  await page.keyboard.press('Tab');
  await expect(page.locator('#insp-mount-back')).toBeFocused();
  const look = await page.locator('#insp-mount-back + span').evaluate((e) => {
    const s = getComputedStyle(e);
    return { outline: s.outlineColor, style: s.outlineStyle, fill: s.backgroundColor };
  });
  expect(look.style).toBe('solid');
  expect(look.outline).not.toBe(look.fill);
});
