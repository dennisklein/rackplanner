'use strict';

// The drawings of the Cabling workspace: the elevation (sides, connecting
// by clicks, drags and breakout legs, selecting and deleting, exits to
// other rows, Show in elevation, zoom), the port map and the fabric, and
// their PNG and SVG exports.
const { test, expect } = require('@playwright/test');
const fs = require('fs');

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
  await page.click('.ws-switch [data-workspace="cabling"]');
  await expect(page.locator('.scene .cable').first()).toBeAttached();
});

/** Runs `fn(project, arg, RP)` in the page, with the plan as it is. */
const plan = (page, fn, arg) =>
  page.evaluate(({ fn, arg }) => new Function('p', 'arg', 'RP', `return (${fn})(p, arg, RP)`)(window.RP.app.project(), arg, window.RP), { fn: fn.toString(), arg });
const idOf = (page, name) => plan(page, (p, name) => p.devices.find((d) => d.name === name).id, name);
const cableBy = (page, label) => plan(page, (p, label) => p.cables.find((c) => c.label === label) || null, label);
const ui = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.RP.app.ui)));
/** The port `name` of the device named `dev` in a drawing (`scope`: '.scene' or '.pm'). */
async function port(page, dev, name, scope) {
  return page.locator(`${scope || '.scene'} [data-port="${await idOf(page, dev)}|${name}"]`);
}
/** The cable at a port, with the type it gets: { id, label, type, network, typeName, b }. */
const cableAt = (page, dev, name) =>
  plan(
    page,
    (p, [dev, name], RP) => {
      const d = p.devices.find((x) => x.name === dev);
      const c = p.cables.find((x) => RP.model.cableEnds(x).some((e) => e.end.device === d.id && e.end.port === name));
      if (!c) return null;
      const t = RP.cabling.describe(p, c).type;
      return { id: c.id, label: c.label, type: c.type, network: c.network, typeName: t ? t.name : null, b: c.b };
    },
    [dev, name]
  );
const zoomText = (page) => page.locator('#btn-zoom-reset').textContent();
const undoToast = (page) => page.locator('.toast button', { hasText: 'Undo' }).last();

test('the elevation is the default view: Row A from the rear, and from the front', async ({ page }) => {
  await expect(page.locator('#cab-toggle [data-cab-view="elevation"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#scene')).toBeVisible();
  await expect(page.locator('#cab-host')).toBeHidden();
  await expect(page.locator('#zoom')).toBeVisible();
  await expect(page.locator('#cab-sides')).toBeVisible();
  await expect(page.locator('#cab-sides [data-cab-side="rear"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#scene')).toHaveAttribute('aria-label', /Row A, seen from the rear/);
  const racks = await plan(page, (p) => p.floors[0].rows[0].racks.map((r) => r.id));
  // From the rear the racks run right to left.
  expect(await page.locator('.scene .rack').evaluateAll((gs) => gs.map((g) => g.dataset.rack))).toEqual(racks.slice().reverse());
  await expect(page.locator('.scene .dev')).toHaveCount(37);
  expect(await page.locator('.scene .cable').count()).toBeGreaterThan(50);
  await expect(page.locator('.scene .exit[data-row="row2"]')).toHaveCount(1);
  // Fitted to the stage's width when it opens.
  const svg = await page.locator('#scene').boundingBox();
  const canvas = await page.locator('#canvas').boundingBox();
  expect(svg.width).toBeLessThanOrEqual(canvas.width);
  // The overview says how to work here.
  await expect(page.locator('#inspector .insp-note')).toContainText('Drag from a port to another port');

  await page.click('#cab-sides [data-cab-side="front"]');
  await expect(page.locator('#cab-sides [data-cab-side="front"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#scene')).toHaveAttribute('aria-label', /Row A, seen from the front/);
  expect(await page.locator('.scene .rack').evaluateAll((gs) => gs.map((g) => g.dataset.rack))).toEqual(racks);
  expect((await ui(page)).cabView).toBe('elevation');
  // The side is remembered.
  await page.reload();
  await expect(page.locator('#cab-sides [data-cab-side="front"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#scene')).toHaveAttribute('aria-label', /seen from the front/);
});

test('two free ports clicked one after the other are connected with Auto, labeled in the network in focus', async ({ page }) => {
  await page.click('#networks [data-net-focus="n-ib"]');
  await page.click('#btn-zoom-reset');
  const next = await plan(page, (p, a, RP) => RP.model.nextCableLabel(p, 'n-ib'));
  await (await port(page, 'ib-leaf-a01', 'p13')).click();
  await expect(page.locator('#armed-hint')).toBeVisible();
  await expect(page.locator('#armed-hint')).toContainText('Click a second port to connect ib-leaf-a01 p13 with Auto');
  await expect(page.locator('#armed-hint')).toContainText('Esc to cancel');
  expect((await ui(page)).pending).toMatchObject({ port: 'p13', legs: [] });
  // The port inspector follows.
  await expect(page.locator('#inspector .name-static')).toHaveText('ib-leaf-a01 · p13');

  await (await port(page, 'ib-leaf-a02', 'p12')).click();
  const c = await cableAt(page, 'ib-leaf-a01', 'p13');
  expect(c).toMatchObject({ label: next, network: 'n-ib', type: null, typeName: 'QSFP56 DAC', b: { port: 'p12' } });
  await expect(page.locator('#armed-hint')).toBeHidden();
  await expect(page.locator('.toast').last()).toContainText(`Connected ${next}`);
  // The new cable is selected, in the drawing and the inspector.
  await expect(page.locator(`.scene .cable.is-selected[data-cable="${c.id}"]`)).toHaveCount(1);
  await expect(page.locator('#cab-label')).toHaveValue(next);
  // Undo keeps the zoom.
  await undoToast(page).click();
  expect(await cableAt(page, 'ib-leaf-a01', 'p13')).toBeNull();
  expect(await zoomText(page)).toBe('100%');
});

test('dragging from a free port to another connects them, with a line to the pointer', async ({ page }) => {
  const from = await (await port(page, 'sw-mgmt-a01', 'swp13')).boundingBox();
  const to = await (await port(page, 'sw-bmc-a01', 'swp21')).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 60, { steps: 4 });
  await expect(page.locator('.cab-band')).toBeVisible();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.cab-band')).toBeHidden();
  const c = await cableAt(page, 'sw-mgmt-a01', 'swp13');
  expect(c).toMatchObject({ label: 'C-0001', network: null, type: null, typeName: 'Cat6a patch cord', b: { port: 'swp21' } });
  expect((await ui(page)).pending).toBeNull();
  // The drawing kept its place: no pan while dragging from a port.
  await expect(page.locator(`.scene .cable.is-selected[data-cable="${c.id}"]`)).toHaveCount(1);
});

test('a breakout cable takes its head, then each leg; Enter finishes with fewer legs', async ({ page }) => {
  await page.click('#btn-row-next');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await page.click('.cab-card[data-cab-type="dac-osfp-2x"]');
  await page.click('#btn-zoom-reset');
  await (await port(page, 'ib-leaf-b02', 'p7')).click();
  await expect(page.locator('#armed-hint')).toContainText('Click the first of 2 legs to connect ib-leaf-b02 p7 with OSFP to 2 × QSFP56 DAC');
  await (await port(page, 'core-sw-01', 'p11')).click();
  await expect(page.locator('#armed-hint')).toContainText('Click leg 2 of 2');
  await expect(page.locator('.scene .leg-ring')).toHaveCount(1);
  expect(await cableAt(page, 'ib-leaf-b02', 'p7')).toBeNull();
  await (await port(page, 'core-sw-01', 'p12')).click();
  const c = await cableAt(page, 'ib-leaf-b02', 'p7');
  expect(c.type).toBe('dac-osfp-2x');
  expect(c.b.map((e) => e.port)).toEqual(['p11', 'p12']);
  await expect(page.locator('#armed-hint')).toBeHidden();

  // With one leg set, Enter connects the head and that leg.
  await (await port(page, 'ib-leaf-b02', 'p8')).click();
  await (await port(page, 'core-sw-02', 'p11')).click();
  await page.keyboard.press('Enter');
  const d = await cableAt(page, 'ib-leaf-b02', 'p8');
  expect(d.type).toBe('dac-osfp-2x');
  expect(d.b).toEqual([{ device: await idOf(page, 'core-sw-02'), port: 'p11' }, null]);
  // Without a leg, Esc only stops.
  await (await port(page, 'ib-leaf-b02', 'p9')).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#armed-hint')).toBeHidden();
  expect(await cableAt(page, 'ib-leaf-b02', 'p9')).toBeNull();
});

test('hovering a port shows it and what it connects to', async ({ page }) => {
  await page.click('#btn-zoom-reset');
  const cabled = await port(page, 'cn-004', 'ib0');
  await cabled.scrollIntoViewIfNeeded();
  await cabled.hover();
  await expect(page.locator('#drag-chip')).toBeVisible();
  await expect(page.locator('#drag-chip')).toHaveText('cn-004 ib0 · QSFP56 200G → ib-leaf-a01 p4');
  const free = await port(page, 'ib-leaf-a01', 'p13');
  await free.scrollIntoViewIfNeeded();
  await free.hover();
  await expect(page.locator('#drag-chip')).toHaveText('ib-leaf-a01 p13 · QSFP56 200G · free');
  await page.mouse.move(5, 5);
  await expect(page.locator('#drag-chip')).toBeHidden();
});

test('a port in use refuses the connection with a toast; Esc stops connecting', async ({ page }) => {
  await page.click('#btn-zoom-reset');
  const n = await plan(page, (p) => p.cables.length);
  await (await port(page, 'ib-leaf-a01', 'p13')).click();
  const used = await cableAt(page, 'ib-leaf-a02', 'p1');
  await (await port(page, 'ib-leaf-a02', 'p1')).click();
  await expect(page.locator('.toast.warn').last()).toContainText(`ib-leaf-a02 p1 already has cable ${used.label}`);
  // Still connecting from the first port.
  await expect(page.locator('#armed-hint')).toBeVisible();
  expect((await ui(page)).pending).toMatchObject({ port: 'p13' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#armed-hint')).toBeHidden();
  expect((await ui(page)).pending).toBeNull();
  expect(await plan(page, (p) => p.cables.length)).toBe(n);
  // The pending port again stops too.
  await (await port(page, 'ib-leaf-a01', 'p13')).click();
  await (await port(page, 'ib-leaf-a01', 'p13')).click();
  await expect(page.locator('#armed-hint')).toBeHidden();
});

test('a cable, a cabled port and a device are selected by a click; Shift adds; Delete removes the cables', async ({ page }) => {
  const a = await cableAt(page, 'cn-004', 'ib0');
  const b = await cableAt(page, 'cn-005', 'ib0');
  // A click on the cable's run, where it leaves its port for the cable manager.
  const at = await page.evaluate((id) => {
    const path = document.querySelector(`.scene .cable[data-cable="${id}"] path:last-of-type`);
    const pt = path.getPointAtLength(14);
    const m = path.getScreenCTM();
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  }, a.id);
  await page.mouse.click(at.x, at.y);
  expect((await ui(page)).cabSel).toEqual({ kind: 'cables', ids: [a.id] });
  await expect(page.locator('#cab-label')).toHaveValue(a.label);
  await expect(page.locator(`.scene .cable.is-selected[data-cable="${a.id}"]`)).toHaveCount(1);
  // Shift-click on a cabled port adds its cable.
  await (await port(page, 'cn-005', 'ib0')).click({ modifiers: ['Shift'] });
  expect((await ui(page)).cabSel).toEqual({ kind: 'cables', ids: [a.id, b.id] });
  await expect(page.locator('#inspector .multi-title')).toHaveText('2 cables');
  await page.keyboard.press('Delete');
  expect(await cableBy(page, a.label)).toBeNull();
  expect(await cableBy(page, b.label)).toBeNull();
  await undoToast(page).click();
  expect(await cableBy(page, a.label)).not.toBeNull();

  // A device, by its face; the empty sheet clears.
  const dev = await idOf(page, 'gpu-003');
  const box = await page.locator(`.scene .dev[data-dev="${dev}"]`).boundingBox();
  await page.mouse.click(box.x + box.width * 0.45, box.y + 4);
  expect((await ui(page)).cabSel).toEqual({ kind: 'devices', ids: [dev] });
  await expect(page.locator('#inspector .name-static')).toHaveText('gpu-003');
  const svg = await page.locator('#scene').boundingBox();
  await page.mouse.click(svg.x + 4, svg.y + 4);
  expect((await ui(page)).cabSel).toBeNull();
  await expect(page.locator('#inspector .kicker')).toHaveText('Cabling · Row A');
  // A drag on the sheet pans it and selects nothing.
  await page.click('#btn-zoom-reset');
  await page.locator('#canvas').evaluate((c) => (c.scrollTop = c.scrollLeft = 0));
  const s2 = await page.locator('#scene').boundingBox();
  const c2 = await page.locator('#canvas').boundingBox();
  await page.mouse.move(s2.x + 8, c2.y + c2.height / 2);
  await page.mouse.down();
  await page.mouse.move(s2.x + 8, c2.y + c2.height / 2 - 200, { steps: 5 });
  await page.mouse.up();
  expect(await page.locator('#canvas').evaluate((c) => c.scrollTop)).toBeGreaterThan(150);
  expect((await ui(page)).cabSel).toBeNull();
});

test('an exit at the end of the tray goes to its row', async ({ page }) => {
  await page.click('.scene .exit[data-row="row2"]');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await expect(page.locator('#scene')).toHaveAttribute('aria-label', /Row B/);
  expect((await ui(page)).cabView).toBe('elevation');
  // And back with the keyboard.
  await page.locator('.scene .exit[data-row="row1"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#row-label')).toHaveText('Row A');
});

test('Show in elevation goes from the schedule to the row and side of the cable, scrolled to it', async ({ page }) => {
  await page.click('#cab-toggle [data-cab-view="schedule"]');
  const c = await cableBy(page, 'IB-0012');
  await page.locator('#sc-body tr[data-cable]', { has: page.locator('.sc-label', { hasText: /^IB-0012$/ }) }).locator('td').nth(1).click();
  await expect(page.locator('#cab-label')).toHaveValue('IB-0012');
  // Another row shown meanwhile: the elevation goes back to the cable's.
  await page.keyboard.press(']');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await page.click('#inspector [data-cab-show-cable]');
  await expect(page.locator('#cab-toggle [data-cab-view="elevation"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#row-label')).toHaveText('Row A');
  await expect(page.locator('#cab-sides [data-cab-side="rear"]')).toHaveAttribute('aria-pressed', 'true');
  const drawn = page.locator(`.scene .cable.is-selected[data-cable="${c.id}"]`);
  await expect(drawn).toHaveCount(1);
  const box = await drawn.boundingBox();
  const canvas = await page.locator('#canvas').boundingBox();
  expect(box.y + box.height).toBeGreaterThan(canvas.y);
  expect(box.y).toBeLessThan(canvas.y + canvas.height);
  // The elevation's inspector has no such button.
  await expect(page.locator('#inspector [data-cab-show-cable]')).toHaveCount(0);

  // A device's: the side where its ports are.
  await page.click('#cab-sides [data-cab-side="front"]');
  await page.click('#cab-toggle [data-cab-view="ports"]');
  await page.click('.pm-name >> text=sw-mgmt-a01');
  await page.click('#inspector [data-cab-show-device]');
  await expect(page.locator('#cab-sides [data-cab-side="rear"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`.scene .dev[data-dev="${await idOf(page, 'sw-mgmt-a01')}"]`)).toBeInViewport();
});

test('search in the elevation shows the cable chosen where it is seen, and highlights the matches', async ({ page }) => {
  // While typing, the matching cables are drawn stronger: the others fade.
  const own = await cableAt(page, 'cn-004', 'ib0');
  await page.fill('#search', 'cn-004');
  await expect(page.locator('.scene .cable[opacity]').first()).toBeAttached();
  await expect(page.locator(`.scene .cable[data-cable="${own.id}"]`)).not.toHaveAttribute('opacity');
  await page.fill('#search', 'ib-leaf-b02 p1');
  const item = page.locator('.sr-item', { hasText: 'IB-' }).first();
  await expect(item).toBeVisible();
  const label = (await item.locator('.sr-name').textContent()).trim();
  const c = await cableBy(page, label);
  await item.click();
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await expect(page.locator('#cab-toggle [data-cab-view="elevation"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`.scene .cable.is-selected[data-cable="${c.id}"]`)).toBeInViewport();
  await expect(page.locator('#cab-label')).toHaveValue(label);
});

test('the zoom buttons, keys and Ctrl+wheel zoom the elevation; a change keeps zoom and scroll', async ({ page }) => {
  await page.click('#btn-zoom-reset');
  expect(await zoomText(page)).toBe('100%');
  const w = (await page.locator('#scene').boundingBox()).width;
  await page.click('#btn-zoom-in');
  expect(await zoomText(page)).toBe('120%');
  expect((await page.locator('#scene').boundingBox()).width).toBeGreaterThan(w * 1.15);
  await page.click('#btn-zoom-out');
  await page.click('#btn-zoom-out');
  expect(await zoomText(page)).toBe('83%');
  await page.keyboard.press('1');
  expect(await zoomText(page)).toBe('100%');
  await page.keyboard.press('+');
  expect(await zoomText(page)).toBe('120%');
  await page.keyboard.press('0');
  const fit = parseInt(await zoomText(page), 10);
  expect(fit).toBeLessThan(100);
  await page.click('#btn-zoom-fit');
  expect(parseInt(await zoomText(page), 10)).toBe(fit);
  const c = await page.locator('#canvas').boundingBox();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  expect(parseInt(await zoomText(page), 10)).toBeGreaterThan(fit);

  // A cable connected, undone and redone leaves zoom and scroll as they were.
  await page.keyboard.press('1');
  await (await port(page, 'ib-leaf-a01', 'p14')).click();
  await (await port(page, 'sw-mgmt-a01', 'swp49')).click();
  expect(await cableAt(page, 'ib-leaf-a01', 'p14')).not.toBeNull();
  const where = () => page.locator('#canvas').evaluate((c) => ({ left: c.scrollLeft, top: c.scrollTop }));
  const scroll = await where();
  await page.keyboard.press('Control+z');
  expect(await cableAt(page, 'ib-leaf-a01', 'p14')).toBeNull();
  expect(await zoomText(page)).toBe('100%');
  expect(await where()).toEqual(scroll);
  await page.keyboard.press('Control+Shift+z');
  expect(await cableAt(page, 'ib-leaf-a01', 'p14')).not.toBeNull();
  expect(await where()).toEqual(scroll);

  // The Racks sheet keeps its own zoom.
  await page.keyboard.press('c');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rackplanner.prefs.v1')).zoom)).toBeNull();
});

test('the port map shows a rack’s switches with their cabled ports, and steps from rack to rack', async ({ page }) => {
  await page.click('#cab-toggle [data-cab-view="ports"]');
  await expect(page.locator('#cab-host')).toBeVisible();
  await expect(page.locator('#zoom')).toBeHidden();
  await expect(page.locator('#cab-sides')).toBeHidden();
  await expect(page.locator('.pm-top h2')).toHaveText('Rack A01 · switches');
  const leaf = await idOf(page, 'ib-leaf-a01');
  const card = page.locator(`.pm-card[data-pm-dev="${leaf}"]`);
  await expect(card.locator('.pm-use')).toHaveText('16 of 24');
  await expect(card.locator('[data-port]')).toHaveCount(24);
  // The far ends written beside the cabled ports.
  await expect(card.locator('.pm-plate text[transform]')).toHaveCount(16);
  await expect(page.locator('.pm-card')).toHaveCount(3);

  // A cabled port selects its cable, whose card is marked.
  await card.locator(`[data-port="${leaf}|p4"]`).click();
  await expect(page.locator('#cab-label')).toHaveValue((await cableAt(page, 'ib-leaf-a01', 'p4')).label);
  await expect(card).toHaveClass(/is-current/);

  // The stepper: A01 is the plan's first rack.
  await expect(page.locator('[data-pm-step="-1"]')).toBeDisabled();
  await page.click('[data-pm-step="1"]');
  await expect(page.locator('.pm-top h2')).toHaveText('Rack A02 · switches');
  await expect(page.locator('#pm-rack')).toHaveValue(await plan(page, (p) => p.floors[0].rows[0].racks[1].id));
  await page.click('[data-pm-step="1"]');
  await page.click('[data-pm-step="1"]');
  await expect(page.locator('.pm-top h2')).toHaveText('Rack B01 · switches');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await page.selectOption('#pm-rack', { label: 'Rack A03' });
  await expect(page.locator('.pm-top h2')).toHaveText('Rack A03 · switches');
  await expect(page.locator('#row-label')).toHaveText('Row A');
  // All devices.
  await page.click('[data-pm-filter="all"]');
  await expect(page.locator('.pm-top h2')).toHaveText('Rack A03 · devices');
  expect(await page.locator('.pm-card').count()).toBe(await plan(page, (p, a, RP) => RP.model.devicesWithin(p, p.floors[0].rows[0].racks[2].id).length));

  // Connect series… from a card goes to that device.
  await page.click('[data-pm-filter="switches"]');
  const a03 = await idOf(page, 'ib-leaf-a03');
  await page.click(`[data-pm-series="${a03}"]`);
  await expect(page.locator('#dlg-connect')).toBeVisible();
  await expect(page.locator('#cs-to')).toHaveValue(a03);
  await page.keyboard.press('Escape');

  // Two free ports clicked in the port map connect them.
  const p5 = page.locator(`.pm [data-port="${a03}|p5"]`);
  await p5.click();
  await expect(page.locator('#armed-hint')).toContainText('ib-leaf-a03 p5');
  const mgmt = await idOf(page, 'sw-mgmt-a03');
  await page.locator(`.pm [data-port="${mgmt}|swp7"]`).click();
  expect(await cableAt(page, 'ib-leaf-a03', 'p5')).toMatchObject({ b: { device: mgmt, port: 'swp7' } });
});

test('the port map starts at the rack of the device selected', async ({ page }) => {
  const dev = await idOf(page, 'gpu-003');
  const box = await page.locator(`.scene .dev[data-dev="${dev}"]`).boundingBox();
  await page.mouse.click(box.x + box.width * 0.45, box.y + 4);
  await page.click('#cab-toggle [data-cab-view="ports"]');
  await expect(page.locator('.pm-top h2')).toHaveText('Rack A02 · switches');
});

test('the fabric shows InfiniBand’s cores and leaves; a leaf shows its oversubscription, a box its nodes', async ({ page }) => {
  await page.click('#cab-toggle [data-cab-view="fabric"]');
  await expect(page.locator('#cab-head')).toBeVisible();
  await expect(page.locator('#zoom')).toBeVisible();
  await expect(page.locator('#fb-net')).toHaveValue('n-ib');
  await expect(page.locator('#cab-head h2')).toHaveText('InfiniBand fabric · whole plan');
  await expect(page.locator('.scene [data-leaf]')).toHaveCount(5);
  await expect(page.locator('.scene [data-core]')).toHaveCount(2);

  await page.click(`.scene [data-leaf="${await idOf(page, 'ib-leaf-a02')}"]`);
  await expect(page.locator('#inspector .kicker')).toHaveText('Leaf switch · InfiniBand');
  const stat = (dt) => page.locator('#inspector .stats div', { has: page.locator('dt', { hasText: new RegExp(`^${dt}$`) }) }).locator('dd');
  await expect(stat('Oversubscription')).toHaveText('2.75 : 1');
  await expect(stat('Down')).toHaveText('11 × 200G');
  await expect(stat('Up')).toHaveText('4 × 200G');
  await expect(page.locator('#inspector .fb-links tbody tr')).toHaveCount(4);
  await expect(page.locator('#inspector .check-list')).toContainText('Every leaf reaches both core switches');
  // A core switch.
  await page.click(`.scene [data-core="${await idOf(page, 'core-sw-01')}"]`);
  await expect(page.locator('#inspector .kicker')).toHaveText('Core switch · InfiniBand');
  // A box of nodes selects them.
  await page.click('.scene [data-group="0"]');
  await expect(page.locator('#inspector .multi-title')).toHaveText('12 devices');

  // Every device: a box each.
  const nodes = await plan(page, (p, a, RP) => RP.cabling.fabric(p, 'n-ib').nodes.length);
  await page.click('[data-fb-grouped="0"]');
  await expect(page.locator('.scene [data-group]')).toHaveCount(nodes);
  await page.click('[data-fb-grouped="1"]');
  // Another network, and the network in focus.
  await page.selectOption('#fb-net', 'n-mgmt');
  await expect(page.locator('#cab-head h2')).toHaveText('Management fabric · whole plan');
  await page.click('#networks [data-net-focus="n-sas"]');
  await expect(page.locator('#fb-net')).toHaveValue('n-sas');
});

test('every box of the fabric is a button for the keyboard: Tab reaches it, Enter and Space select it', async ({ page }) => {
  await page.click('#cab-toggle [data-cab-view="fabric"]');
  await expect(page.locator('.scene .fb-box')).not.toHaveCount(0);
  const boxes = page.locator('.scene .fb-box');
  expect(await boxes.evaluateAll((gs) => gs.every((g) => g.getAttribute('tabindex') === '0' && g.getAttribute('role') === 'button' && g.getAttribute('aria-label')))).toBe(true);
  // Tab from the bar above: the drawing, then its first box.
  await page.focus('[data-fb-grouped="0"]');
  const focused = () => page.evaluate(() => {
    const a = document.activeElement;
    return a.id === 'scene' ? 'scene' : a.classList.contains('fb-box') ? a.getAttribute('aria-label') : a.tagName;
  });
  let label = null;
  for (let i = 0; i < 4 && !label; i++) {
    await page.keyboard.press('Tab');
    const f = await focused();
    if (f !== 'scene' && f !== 'BUTTON') label = f;
  }
  expect(label).toMatch(/core-sw-01/);
  await expect(page.locator('.scene .fb-box:focus')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('#inspector .kicker')).toHaveText('Core switch · InfiniBand');
  // Drawn again with the core selected, focus stays on its box, and Tab goes on to the next.
  expect(await focused()).toBe(label);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const leaf = await focused();
  expect(leaf).toMatch(/^ib-leaf-/);
  await page.keyboard.press(' ');
  await expect(page.locator('#inspector .kicker')).toHaveText('Leaf switch · InfiniBand');
  expect((await ui(page)).cabSel).toEqual({ kind: 'devices', ids: [await idOf(page, leaf.split(',')[0])] });
  // A box of nodes selects them.
  await page.focus('.scene [data-group="0"]');
  await page.keyboard.press('Enter');
  await expect(page.locator('#inspector .multi-title')).toHaveText('12 devices');
  await expect(page.locator('.scene [data-group="0"]')).toBeFocused();
});

test('PNG and SVG export the elevation and the fabric in Cabling', async ({ page }) => {
  const read = async (kind) => {
    await page.click('#btn-export');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`[data-export="${kind}"]`)]);
    return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
  };
  const svg = await read('svg');
  expect(svg.name).toMatch(/-cabling-rear\.svg$/);
  const text = svg.data.toString('utf8');
  expect(text).toContain('<title>Hall 2 expansion · Ground floor · Row A · rear</title>');
  expect(text).toContain('data-cable=');
  const png = await read('png');
  expect(png.name).toMatch(/-cabling-rear\.png$/);
  expect(png.data.subarray(1, 4).toString()).toBe('PNG');

  await page.click('#cab-toggle [data-cab-view="fabric"]');
  const fsvg = await read('svg');
  expect(fsvg.name).toMatch(/-infiniband-fabric\.svg$/);
  expect(fsvg.data.toString('utf8')).toContain('InfiniBand fabric');
  const fpng = await read('png');
  expect(fpng.name).toMatch(/-infiniband-fabric\.png$/);

  // The schedule has no drawing: the Racks sheet is exported.
  await page.click('#cab-toggle [data-cab-view="schedule"]');
  const rsvg = await read('svg');
  expect(rsvg.name).not.toMatch(/cabling|fabric/);
});

test('the print dialog prints the cabling of the rows from the side asked', async ({ page }) => {
  await page.evaluate(() => (window.print = () => (window.__printed = document.getElementById('print-root').innerHTML)));
  await page.click('#btn-export');
  await page.click('[data-export="print"]');
  await expect(page.locator('input[name="print-drawing"][value="rear"]')).toBeChecked();
  await page.click('#dlg-print button[type="submit"]');
  const html = await page.evaluate(() => window.__printed);
  expect(html).toContain('CABLE TRAY');
  expect(html).toContain('Row A · rear');
});

/** A point on the run of a cable drawn in the elevation, in page coordinates. */
const cablePoint = (page, id) =>
  page.evaluate((id) => {
    const path = document.querySelector(`.scene .cable[data-cable="${id}"] path:last-of-type`);
    const pt = path.getPointAtLength(14);
    const m = path.getScreenCTM();
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  }, id);
const focused = (page) => page.evaluate(() => (document.activeElement === document.body ? 'body' : document.activeElement.id || document.activeElement.className));

test('a click on a drawing takes keyboard focus off the control it was on', async ({ page }) => {
  // The search closes its results, and Delete deletes the cable clicked instead of editing the query.
  const a = await cableAt(page, 'cn-004', 'ib0');
  await page.fill('#search', 'cn-001');
  await expect(page.locator('#search-results')).toBeVisible();
  const at = await cablePoint(page, a.id);
  await page.mouse.click(at.x, at.y);
  expect((await ui(page)).cabSel).toEqual({ kind: 'cables', ids: [a.id] });
  await expect(page.locator('#search-results')).toBeHidden();
  expect(await focused(page)).toBe('body');
  await page.keyboard.press('Delete');
  expect(await cableBy(page, a.label)).toBeNull();
  await expect(page.locator('#search')).toHaveValue('cn-001');
  await undoToast(page).click();

  // Enter after a zoom button and a click on a cable edits its label, and leaves the zoom alone.
  await page.fill('#search', '');
  await page.click('#btn-zoom-in');
  const zoom = await zoomText(page);
  const at2 = await cablePoint(page, a.id);
  await page.mouse.click(at2.x, at2.y);
  await page.keyboard.press('Enter');
  await expect(page.locator('#cab-label')).toBeFocused();
  expect(await zoomText(page)).toBe(zoom);

  // In the port map: after the rack stepper, Enter on a cabled port's cable edits its label instead of stepping again.
  await page.click('#cab-toggle [data-cab-view="ports"]');
  await page.click('[data-pm-step="1"]');
  await expect(page.locator('.pm-top h2')).toHaveText('Rack A02 · switches');
  await (await port(page, 'ib-leaf-a02', 'p1', '.pm')).click();
  await expect(page.locator('#cab-label')).toHaveValue((await cableAt(page, 'ib-leaf-a02', 'p1')).label);
  await page.keyboard.press('Enter');
  await expect(page.locator('#cab-label')).toBeFocused();
  await expect(page.locator('.pm-top h2')).toHaveText('Rack A02 · switches');

  // In the fabric: arrow keys after a click on a leaf leave the network select alone.
  await page.click('#cab-toggle [data-cab-view="fabric"]');
  await page.locator('#fb-net').focus();
  await page.click(`.scene [data-leaf="${await idOf(page, 'ib-leaf-a01')}"]`);
  expect(await focused(page)).toBe('body');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#fb-net')).toHaveValue('n-ib');
});

test('a search result chosen while connecting keeps the first port, across rows', async ({ page }) => {
  await (await port(page, 'ib-leaf-a01', 'p13')).click();
  expect((await ui(page)).pending).toMatchObject({ port: 'p13' });
  await page.fill('#search', 'core-sw-01');
  await page.locator('.sr-item', { hasText: 'core-sw-01' }).first().click();
  await expect(page.locator('#row-label')).toHaveText('Row B');
  expect((await ui(page)).pending).toMatchObject({ port: 'p13' });
  await expect(page.locator('#armed-hint')).toContainText('ib-leaf-a01 p13');
  const core = await idOf(page, 'core-sw-01');
  const free = await plan(page, (p, id, RP) => {
    const d = p.devices.find((x) => x.id === id);
    const idx = RP.cabling.cableIndex(p);
    return RP.model.expandPorts(RP.model.typeOf(p, d.type)).find((pt) => !idx.has(`${id}|${pt.name}`)).name;
  }, core);
  await page.locator(`.scene [data-port="${core}|${free}"]`).click();
  expect(await cableAt(page, 'ib-leaf-a01', 'p13')).toMatchObject({ b: { device: core, port: free } });
  // Opening the elevation from another view still stops a connection.
  await page.click('#cab-toggle [data-cab-view="schedule"]');
  await page.click('#cab-toggle [data-cab-view="ports"]');
  await expect(page.locator('.pm [data-port]').first()).toBeAttached();
  expect((await ui(page)).pending).toBeNull();
});

test('a double click on Show in elevation does not delete the cable', async ({ page }) => {
  await page.click('#cab-toggle [data-cab-view="schedule"]');
  const c = await cableBy(page, 'IB-0026');
  await page.locator('#sc-body tr[data-cable]', { has: page.locator('.sc-label', { hasText: /^IB-0026$/ }) }).locator('td').nth(1).click();
  const show = await page.locator('#inspector [data-cab-show-cable]').boundingBox();
  const n = await plan(page, (p) => p.cables.length);
  await page.mouse.dblclick(show.x + 20, show.y + show.height / 2);
  await expect(page.locator('#cab-toggle [data-cab-view="elevation"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await plan(page, (p) => p.cables.length)).toBe(n);
  expect(await cableBy(page, 'IB-0026')).not.toBeNull();
  // Delete keeps to the right of the bar, away from where the button was.
  const del = await page.locator('#cab-del').boundingBox();
  expect(del.x).toBeGreaterThan(show.x + 40);
  expect((await ui(page)).cabSel).toEqual({ kind: 'cables', ids: [c.id] });
});

test('in the elevation, Show in elevation is offered for what the row shown does not draw', async ({ page }) => {
  await (await port(page, 'ib-leaf-a01', 'p21')).click();
  await expect(page.locator('#inspector [data-cab-show-cable]')).toHaveCount(0);
  // The far end, in Row B: not drawn here.
  await page.click('#inspector .end-dev >> text=core-sw-01');
  await expect(page.locator('#inspector .name-static')).toHaveText('core-sw-01');
  await page.click('#inspector [data-cab-show-device]');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await expect(page.locator(`.scene .dev[data-dev="${await idOf(page, 'core-sw-01')}"]`)).toBeInViewport();
  await expect(page.locator('#inspector [data-cab-show-device]')).toHaveCount(0);
  // A cable on the other side of the row is not drawn on this one.
  const c = await cableAt(page, 'cn-004', 'ib0');
  await page.click('[data-cab-side="front"]');
  await page.keyboard.press('[');
  await page.fill('#search', c.label);
  await page.locator('.sr-item', { hasText: c.label }).first().click();
  await expect(page.locator('#cab-sides [data-cab-side="rear"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#inspector [data-cab-show-cable]')).toHaveCount(0);
  await page.click('[data-cab-side="front"]');
  await expect(page.locator('#inspector [data-cab-show-cable]')).toHaveCount(1);
});

test('the fabric of every device opens on its switches, and another network opens fitted', async ({ page }) => {
  await page.click('#cab-toggle [data-cab-view="fabric"]');
  // The badge and the inspector give a leaf's oversubscription alike.
  const a02 = await idOf(page, 'ib-leaf-a02');
  await expect(page.locator(`.scene [data-leaf="${a02}"] text`, { hasText: '2.75:1' })).toHaveCount(1);
  await page.click('[data-fb-grouped="0"]');
  const canvas = await page.locator('#canvas').boundingBox();
  const inView = (b) => b && b.x >= canvas.x - 1 && b.x + b.width <= canvas.x + canvas.width + 1;
  let shown = 0;
  for (const g of await page.locator('.scene [data-leaf], .scene [data-core]').all()) if (inView(await g.boundingBox())) shown++;
  expect(shown).toBeGreaterThanOrEqual(4);
  // On coming back too.
  await page.click('#cab-toggle [data-cab-view="schedule"]');
  await page.click('#cab-toggle [data-cab-view="fabric"]');
  expect(inView(await page.locator(`.scene [data-leaf="${a02}"]`).boundingBox())).toBe(true);
  await page.click('[data-fb-grouped="1"]');
  // Management is wider than InfiniBand: it is fitted again, not cut off.
  await page.selectOption('#fb-net', 'n-mgmt');
  await expect(page.locator('#cab-head h2')).toHaveText('Management fabric · whole plan');
  const svg = await page.locator('#scene').boundingBox();
  const c2 = await page.locator('#canvas').boundingBox();
  expect(svg.x + svg.width).toBeLessThanOrEqual(c2.x + c2.width + 1);
  // The badge reads as the inspector does.
  const mgmt = await idOf(page, 'sw-mgmt-b01');
  const badge = (await page.locator(`.scene [data-leaf="${mgmt}"] text`).allTextContents()).find((t) => /:1$/.test(t));
  await page.click(`.scene [data-leaf="${mgmt}"]`);
  const stat = page.locator('#inspector .stats div', { has: page.locator('dt', { hasText: /^Oversubscription$/ }) }).locator('dd');
  expect((await stat.textContent()).replace(/\s/g, '')).toBe(badge);
});

test('hovering a network redraws the elevation and the port map, not the fabric', async ({ page }) => {
  await page.click('#cab-toggle [data-cab-view="fabric"]');
  const watch = () =>
    page.evaluate(() => {
      window.__redraws = 0;
      new MutationObserver(() => window.__redraws++).observe(document.getElementById('scene'), { childList: true });
    });
  await watch();
  for (const row of await page.locator('#networks .cl-row').all()) await row.hover();
  await page.mouse.move(700, 5);
  expect(await page.evaluate(() => window.__redraws)).toBe(0);
  await page.click('#cab-toggle [data-cab-view="elevation"]');
  await watch();
  await page.locator('#networks .cl-row').first().hover();
  await expect.poll(() => page.evaluate(() => window.__redraws)).toBeGreaterThan(0);
});

test('the port map brings the network in focus and the search matches forward, and lists port groups', async ({ page }) => {
  await page.click('#cab-toggle [data-cab-view="ports"]');
  const mgmt = await idOf(page, 'sw-mgmt-a01');
  const leaf = await idOf(page, 'ib-leaf-a01');
  await expect(page.locator(`.pm-card[data-pm-dev="${mgmt}"] .pm-meta`)).toHaveText('48-port switch · U1 · swp1–48 · 48 × RJ45 1G, swp49–52 · 4 × SFP+ 10G');
  await expect(page.locator(`.pm-card[data-pm-dev="${leaf}"] .pm-meta`)).toContainText('p1–24 · 24 × QSFP56 200G');
  await expect(page.locator('.pm [data-port][opacity]')).toHaveCount(0);
  await page.click('#networks [data-net-focus="n-mgmt"]');
  // The leaf's InfiniBand ports fade, and so does its card's head.
  await expect(page.locator(`.pm-card[data-pm-dev="${leaf}"] [data-port][opacity]`)).toHaveCount(16);
  await expect(page.locator(`.pm-card[data-pm-dev="${leaf}"]`)).toHaveClass(/is-faded/);
  await expect(page.locator(`.pm-card[data-pm-dev="${mgmt}"]`)).not.toHaveClass(/is-faded/);
  await page.click('#networks [data-net-focus="n-mgmt"]');
  // Still hovered, it stays forward till the pointer leaves.
  await expect(page.locator(`.pm-card[data-pm-dev="${leaf}"]`)).toHaveClass(/is-faded/);
  await page.mouse.move(700, 5);
  await expect(page.locator('.pm [data-port][opacity]')).toHaveCount(0);
  // A search rings its match.
  await page.fill('#search', 'cn-004');
  await expect(page.locator(`.pm-card[data-pm-dev="${leaf}"] .lit-ring`)).toHaveCount(1);
  await page.fill('#search', '');
  await page.locator('#search').blur();
  // Ctrl+A selects the cables of the ports shown.
  await page.locator('.pm-top h2').click();
  await page.keyboard.press('Control+a');
  const n = await plan(page, (p, ids, RP) => p.cables.filter((c) => RP.model.cableEnds(c).some((e) => ids.includes(e.end.device))).length, await page.locator('.pm-card[data-pm-dev]').evaluateAll((cs) => cs.map((c) => c.dataset.pmDev)));
  expect((await ui(page)).cabSel.ids.length).toBe(n);
});

test('the shortcuts listed fit the view', async ({ page }) => {
  const keys = page.locator('#inspector .keys');
  await expect(keys).toContainText('Shift or Ctrl + clickAdd or remove a cable');
  await expect(keys).toContainText('Select the cables shown');
  await page.click('#cab-toggle [data-cab-view="fabric"]');
  await page.click('.scene', { position: { x: 4, y: 4 } });
  await expect(keys).not.toContainText('Select the cables shown');
  await page.click('#cab-toggle [data-cab-view="schedule"]');
  await expect(keys).toContainText('Select a range of cables');
});

test('the Export menu says what PNG, SVG and Print give in Cabling', async ({ page }) => {
  const hint = (kind) => page.locator(`#menu-export [data-export="${kind}"] small`);
  await page.click('#btn-export');
  await expect(hint('png')).toHaveText('This row’s cabling from the rear, for docs, tickets and chat');
  await expect(hint('print')).toHaveText('One sheet per row, its cabling from the rear');
  await page.keyboard.press('Escape');
  await page.click('#cab-toggle [data-cab-view="fabric"]');
  await page.click('#btn-export');
  await expect(hint('svg')).toHaveText('The InfiniBand fabric of the whole plan, opens in vector editors');
  await expect(hint('print')).toHaveText('One sheet per row, with title blocks');
  await page.keyboard.press('Escape');
  await page.click('#cab-toggle [data-cab-view="schedule"]');
  await page.click('#btn-export');
  await expect(hint('png')).toHaveText('This row’s Racks sheet, for docs, tickets and chat');
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await page.click('#btn-export');
  await expect(hint('png')).toHaveText('This row, for docs, tickets and chat');
});

for (const size of [{ width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`at ${size.width} px the connecting hint clears Front | Rear and the port map keeps its numbers`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.click('#cab-toggle [data-cab-view="ports"]');
    await page.click('#cab-toggle [data-cab-view="elevation"]');
    await page.keyboard.press('1');
    // A breakout armed: the longest hint.
    await page.evaluate(() => {
      const p = window.RP.app.project();
      const t = p.cableTypes.find((x) => x.legs > 1);
      document.querySelector(`[data-cab-type="${t.id}"]`).click();
    });
    const p13 = await port(page, 'ib-leaf-a01', 'p13');
    await p13.scrollIntoViewIfNeeded();
    await p13.click();
    const hint = await page.locator('#armed-hint').boundingBox();
    const sides = await page.locator('#cab-sides').boundingBox();
    const overlap = hint.x < sides.x + sides.width && sides.x < hint.x + hint.width && hint.y < sides.y + sides.height && sides.y < hint.y + hint.height;
    expect(overlap).toBe(false);
    await page.keyboard.press('Escape');

    await page.click('#cab-toggle [data-cab-view="ports"]');
    const mgmt = await idOf(page, 'sw-mgmt-a01');
    const labels = await page.locator(`.pm-card[data-pm-dev="${mgmt}"] [data-port] text`).allTextContents();
    expect(labels).toHaveLength(52);
    expect(labels.filter((x) => x.includes('…'))).toEqual([]);
    // The card's type, position and port groups are not squeezed out.
    const meta = await page.locator(`.pm-card[data-pm-dev="${mgmt}"] .pm-meta`).boundingBox();
    expect(meta.width).toBeGreaterThan(200);
  });
}

test('a drag refused leaves the connection as it was before it, with a breakout cable armed too', async ({ page }) => {
  await page.click('#btn-row-next');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await page.click('.cab-card[data-cab-type="dac-osfp-2x"]');
  await page.click('#btn-zoom-reset');
  const n = await plan(page, (p) => p.cables.length);
  const drag = async (fromPort, toPort) => {
    await (await port(page, 'ib-leaf-b02', fromPort)).scrollIntoViewIfNeeded();
    const from = await (await port(page, 'ib-leaf-b02', fromPort)).boundingBox();
    const to = await (await port(page, 'ib-leaf-b02', toPort)).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  // Nothing pending: nothing pending after, and no hidden head waiting for the next click.
  await drag('p7', 'p1');
  await expect(page.locator('.toast.warn').last()).toContainText('ib-leaf-b02, its head');
  expect((await ui(page)).pending).toBeNull();
  await expect(page.locator('#armed-hint')).toBeHidden();
  await (await port(page, 'core-sw-01', 'p11')).click();
  expect((await ui(page)).pending).toMatchObject({ port: 'p11', legs: [] });
  await expect(page.locator('#armed-hint')).toContainText('core-sw-01 p11');
  await page.keyboard.press('Escape');
  // Another port pending: it still is, and shown.
  await (await port(page, 'ib-leaf-b02', 'p8')).click();
  await drag('p7', 'p1');
  expect((await ui(page)).pending).toMatchObject({ port: 'p8', legs: [] });
  await expect(page.locator('#armed-hint')).toContainText('ib-leaf-b02 p8');
  await page.keyboard.press('Escape');
  expect(await plan(page, (p) => p.cables.length)).toBe(n);
});

test('Enter on a focused button presses it while legs of a breakout cable are set', async ({ page }) => {
  await page.click('#btn-row-next');
  await page.click('.cab-card[data-cab-type="dac-osfp-2x"]');
  await page.click('#btn-zoom-reset');
  const n = await plan(page, (p) => p.cables.length);
  const headAndLeg = async () => {
    await (await port(page, 'ib-leaf-b02', 'p7')).click();
    await (await port(page, 'core-sw-01', 'p11')).click();
    await expect(page.locator('#armed-hint')).toContainText('Click leg 2 of 2');
  };
  // Stop connecting stops, with nothing connected.
  await headAndLeg();
  await page.locator('#armed-hint [data-cab-cancel]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#armed-hint')).toBeHidden();
  expect((await ui(page)).pending).toBeNull();
  expect(await plan(page, (p) => p.cables.length)).toBe(n);
  // Front turns the drawing round.
  await headAndLeg();
  await page.locator('#cab-sides [data-cab-side="front"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#cab-sides [data-cab-side="front"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await plan(page, (p) => p.cables.length)).toBe(n);
  // Enter on the drawing still connects the head and the leg set.
  await page.locator('#scene').focus();
  await page.keyboard.press('Enter');
  const c = await cableAt(page, 'ib-leaf-b02', 'p7');
  expect(c.b).toEqual([{ device: await idOf(page, 'core-sw-01'), port: 'p11' }, null]);
});

test('Esc stops a drag from a port: the line goes and the release connects nothing', async ({ page }) => {
  const n = await plan(page, (p) => p.cables.length);
  const from = await (await port(page, 'sw-mgmt-a01', 'swp13')).boundingBox();
  const to = await (await port(page, 'sw-bmc-a01', 'swp21')).boundingBox();
  const dragAndEsc = async () => {
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 60, { steps: 4 });
    await expect(page.locator('.cab-band')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.cab-band')).toBeHidden();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await expect(page.locator('.cab-band')).toBeHidden();
    await page.mouse.up();
  };
  await dragAndEsc();
  expect(await cableAt(page, 'sw-mgmt-a01', 'swp13')).toBeNull();
  expect(await plan(page, (p) => p.cables.length)).toBe(n);
  // From the port pending: the drag stops, the connection stays until the next Esc.
  await (await port(page, 'sw-mgmt-a01', 'swp13')).click();
  await dragAndEsc();
  expect((await ui(page)).pending).toMatchObject({ port: 'swp13' });
  await expect(page.locator('#armed-hint')).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await ui(page)).pending).toBeNull();
  expect(await plan(page, (p) => p.cables.length)).toBe(n);
});

test('the line of a drag starts at its port when the press commits an edit and draws the elevation again', async ({ page }) => {
  await page.click('#btn-zoom-reset');
  const p4 = await port(page, 'ib-leaf-a01', 'p4');
  await p4.scrollIntoViewIfNeeded();
  await p4.click();
  const c = await cableAt(page, 'ib-leaf-a01', 'p4');
  await expect(page.locator('#cab-label')).toHaveValue(c.label);
  await page.fill('#cab-length', '2.5');
  await expect(page.locator('#cab-length')).toBeFocused();
  const p13 = await port(page, 'ib-leaf-a01', 'p13');
  await p13.scrollIntoViewIfNeeded();
  await expect(page.locator('#cab-length')).toBeFocused();
  const b = await p13.boundingBox();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 80, { steps: 5 });
  const line = await page.locator('.cab-band line').evaluate((l) => ({ x: Number(l.getAttribute('x1')), y: Number(l.getAttribute('y1')) }));
  expect(Math.abs(line.x - cx)).toBeLessThan(6);
  expect(Math.abs(line.y - cy)).toBeLessThan(6);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await cableBy(page, c.label)).lengthM).toBe(2.5);
});

test('the port map rings every end of the cable selected that it draws', async ({ page }) => {
  await page.click('#cab-toggle [data-cab-view="ports"]');
  const leaf = await idOf(page, 'ib-leaf-a01');
  const card = page.locator(`.pm-card[data-pm-dev="${leaf}"]`);
  await card.locator(`[data-port="${leaf}|p4"]`).click();
  await expect(card).toHaveClass(/is-current/);
  // The leaf's port is ringed and its far end (cn-004, not drawn under Switches) bold.
  await expect(card.locator('rect[stroke-width="2.5"]')).toHaveCount(1);
  await expect(card.locator('text[font-weight="700"]')).toHaveText('cn-004');
  // With every device drawn, both ends.
  await page.click('[data-pm-filter="all"]');
  await expect(page.locator('.pm rect[stroke-width="2.5"]')).toHaveCount(2);
  await expect(card.locator('rect[stroke-width="2.5"]')).toHaveCount(1);
});

test('at 1024 px a faceplate scrolled sideways stays where it is when the port map draws again', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.click('#cab-toggle [data-cab-view="ports"]');
  const mgmt = await idOf(page, 'sw-mgmt-a01');
  const wrap = page.locator(`.pm-card[data-pm-dev="${mgmt}"] .pm-plate-wrap`);
  const room = await wrap.evaluate((w) => w.scrollWidth - w.clientWidth);
  expect(room).toBeGreaterThan(40);
  await wrap.evaluate((w) => (w.scrollLeft = w.scrollWidth));
  const left = await wrap.evaluate((w) => w.scrollLeft);
  await page.locator(`.pm [data-port="${mgmt}|swp45"]`).click();
  expect((await ui(page)).pending).toMatchObject({ port: 'swp45' });
  expect(await wrap.evaluate((w) => w.scrollLeft)).toBe(left);
  // Hovering a network draws it again too.
  await page.hover('#networks [data-net-focus="n-mgmt"]');
  await page.mouse.move(5, 5);
  expect(await wrap.evaluate((w) => w.scrollLeft)).toBe(left);
  // Another rack opens at the left.
  await page.keyboard.press('Escape');
  await page.click('[data-pm-step="1"]');
  await page.click('[data-pm-step="-1"]');
  expect(await wrap.evaluate((w) => w.scrollLeft)).toBe(0);
});

test('the fabric of the network put in focus opens fitted', async ({ page }) => {
  await page.click('#cab-toggle [data-cab-view="fabric"]');
  await expect(page.locator('#fb-net')).toHaveValue('n-ib');
  const ib = await zoomText(page);
  const fitted = async () => {
    const svg = await page.locator('#scene').boundingBox();
    const canvas = await page.locator('#canvas').boundingBox();
    return svg.x + svg.width <= canvas.x + canvas.width + 1;
  };
  await page.click('#networks [data-net-focus="n-mgmt"]');
  await expect(page.locator('#fb-net')).toHaveValue('n-mgmt');
  expect(await fitted()).toBe(true);
  expect(await zoomText(page)).not.toBe(ib);
  // Out of focus: back to InfiniBand, fitted again.
  await page.click('#networks [data-net-focus="n-mgmt"]');
  await expect(page.locator('#fb-net')).toHaveValue('n-ib');
  expect(await zoomText(page)).toBe(ib);
  // A zoom of one's own stays while the same network is drawn.
  await page.click('#btn-zoom-reset');
  const own = await zoomText(page);
  await page.click(`.scene [data-leaf="${await idOf(page, 'ib-leaf-a02')}"]`);
  expect(await zoomText(page)).toBe(own);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });
  test('a tap on a port, a device or a fabric box draws no focus ring around the drawing', async ({ page }) => {
    const outline = () => page.locator('#scene').evaluate((s) => getComputedStyle(s).outlineStyle);
    await page.click('#btn-zoom-reset');
    const p13 = await port(page, 'ib-leaf-a03', 'p13');
    await p13.scrollIntoViewIfNeeded();
    await p13.tap();
    expect((await ui(page)).pending).toMatchObject({ port: 'p13' });
    expect(await outline()).toBe('none');
    await page.locator('#armed-hint [data-cab-cancel]').click();
    await page.click('#cab-toggle [data-cab-view="fabric"]');
    await page.locator(`.scene [data-leaf="${await idOf(page, 'ib-leaf-a02')}"]`).tap();
    await expect(page.locator('#inspector .kicker')).toHaveText('Leaf switch · InfiniBand');
    expect(await outline()).toBe('none');
  });
});
