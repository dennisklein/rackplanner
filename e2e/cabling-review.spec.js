'use strict';

// Fixes from the review of the Cabling workspace: legs of a breakout
// plugged in again, the schedule on laptop screens, the empty fabric, the
// fabric's header and note, touch wording, toasts in dialogs, the catalog's
// counts, focus and scroll, keyboard focus after dialogs and deletes, live
// regions, large plans (counts, search), device ids with "|", and the
// storage-full warning.
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
const row = (page, label) => page.locator('#sc-body tr[data-cable]').filter({ has: page.locator('.sc-label', { hasText: new RegExp(`^${label}$`) }) });
const undoToast = (page) => page.locator('.toast button', { hasText: 'Undo' }).last();
async function port(page, dev, name, scope) {
  return page.locator(`${scope || '.scene'} [data-port="${await idOf(page, dev)}|${name}"]`);
}
async function toCabling(page, view) {
  await page.click('.ws-switch [data-workspace="cabling"]');
  if (view) await page.click(`#cab-toggle [data-cab-view="${view}"]`);
}
/** Opens a plan file made in the test. */
async function openPlan(page, p, name) {
  await page.click('#btn-open');
  await page.setInputFiles('#file-input', { name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(p)) });
  await expect(page.locator('#plan-name')).toHaveValue(name);
}

/** The example plan copied to more rows and floors: over 2000 cables. */
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
      ...rows.map((r) => ({
        id: uid('row'),
        name: `${r.name}${suffix}`,
        racks: r.racks.map((k) => {
          racks.set(k.id, uid('rk'));
          return Object.assign({}, k, { id: racks.get(k.id), name: `${k.name}${suffix}` });
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

test('a leg of a breakout cable that is not plugged in is plugged in from the inspector', async ({ page }) => {
  await toCabling(page, 'elevation');
  await page.click('#btn-row-next');
  await expect(page.locator('#row-label')).toHaveText('Row B');
  await page.click('.cab-card[data-cab-type="dac-osfp-2x"]');
  await page.click('#btn-zoom-reset');
  // A breakout finished with one leg: the other is free.
  await (await port(page, 'ib-leaf-b02', 'p8')).click();
  await (await port(page, 'core-sw-02', 'p11')).click();
  await page.keyboard.press('Enter');
  const id = await plan(page, (p, a, RP) => {
    const d = p.devices.find((x) => x.name === 'ib-leaf-b02');
    return p.cables.find((c) => c.a.device === d.id && c.a.port === 'p8').id;
  });
  expect(await plan(page, (p, id) => p.cables.find((c) => c.id === id).b[1], id)).toBeNull();
  const free = page.locator('#inspector .end-item.is-free');
  await expect(free).toContainText('Leg 2');
  await expect(free).toContainText('Not plugged in');

  // Plug in… arms it: the next free port clicked takes the leg. Esc stops it.
  await free.locator('[data-cab-plug-leg="1"]').click();
  await expect(page.locator('#armed-hint')).toContainText('Click a free port for leg 2 of');
  await expect(page.locator('#inspector [data-cab-plug-leg="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#inspector [data-cab-plug-leg="1"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#armed-hint')).toBeHidden();
  expect((await ui(page)).pending).toBeNull();

  await page.locator('#inspector [data-cab-plug-leg="1"]').click();
  // A port in use refuses it and keeps the leg armed.
  await (await port(page, 'ib-leaf-b02', 'p1')).click();
  await expect(page.locator('.toast.warn').last()).toBeVisible();
  expect((await ui(page)).pending).toMatchObject({ fill: { cable: id, leg: 1 } });
  await (await port(page, 'core-sw-02', 'p12')).click();
  await expect(page.locator('.toast').last()).toContainText('Plugged leg 2 of');
  expect(await plan(page, (p, id) => p.cables.find((c) => c.id === id).b.map((e) => e && e.port), id)).toEqual(['p11', 'p12']);
  await expect(page.locator('#armed-hint')).toBeHidden();
  await expect(page.locator('#inspector .end-item.is-free')).toHaveCount(0);
  // The cable kept its label; Undo frees the leg again.
  await undoToast(page).click();
  expect(await plan(page, (p, id) => p.cables.find((c) => c.id === id).b[1], id)).toBeNull();

  // From the schedule, Plug in… opens the elevation, where ports are clicked.
  await page.click('#cab-toggle [data-cab-view="schedule"]');
  await page.locator('#sc-body tr[data-cable="' + id + '"] td').nth(1).click();
  await page.locator('#inspector [data-cab-plug-leg="1"]').click();
  await expect(page.locator('#cab-toggle [data-cab-view="elevation"]')).toHaveAttribute('aria-pressed', 'true');
  expect((await ui(page)).pending).toMatchObject({ fill: { cable: id, leg: 1 } });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a toast moved into a dialog keeps clear of its buttons', async ({ page }) => {
    await toCabling(page, 'schedule');
    await page.locator('#sc-body tr[data-cable] td.sc-check').first().click();
    await page.locator('#cab-del, #multi-del').first().click();
    await expect(undoToast(page)).toBeVisible();
    await page.click('#sc-series');
    await expect(page.locator('#dlg-connect #toasts .toast')).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll('#dlg-connect .dlg-foot button')].every((b) => {
            const r = b.getBoundingClientRect();
            return [0.1, 0.5, 0.9].every((f) => b.contains(document.elementFromPoint(r.left + r.width * f, r.top + r.height / 2)));
          })
        )
      )
      .toBe(true);
    const foot = await page.locator('#dlg-connect .dlg-foot').boundingBox();
    const toast = await page.locator('#dlg-connect #toasts').boundingBox();
    expect(toast.y + toast.height).toBeLessThanOrEqual(foot.y);
  });

  test('touch screens are told to tap ports, and get no keyboard shortcuts', async ({ page }) => {
    await toCabling(page, 'elevation');
    const panel = page.locator('#cab-types-sec .sec-hint');
    await expect(panel.locator('.hint-touch')).toBeVisible();
    await expect(panel.locator('.hint-pointer')).toBeHidden();
    await expect(panel).not.toContainText(/drag/i, { useInnerText: true });
    await expect(page.locator('#inspector .insp-note')).toHaveText(/^Tap a device or a port/, { useInnerText: true });
    await expect(page.locator('#inspector .keys-sec')).toBeHidden();
    await page.click('#cab-toggle [data-cab-view="ports"]');
    await expect(page.locator('.pm-hint')).toHaveText('Tap a free port, then another.', { useInnerText: true });
    await page.click('#cab-toggle [data-cab-view="schedule"]');
    await expect(page.locator('#inspector .keys-sec')).toBeHidden();
  });
});

test('on 1280 and 1366 px laptops the schedule keeps Length and Check in view, with positions under the ends', async ({ page }) => {
  for (const [width, height] of [
    [1280, 720],
    [1366, 768],
  ]) {
    await page.setViewportSize({ width, height });
    if (width === 1280) await toCabling(page, 'schedule');
    await expect(row(page, 'IB-0026')).toBeVisible();
    const scroller = await page.locator('#sc-scroll').boundingBox();
    const check = await row(page, 'IB-0026').locator('td.sc-issue').boundingBox();
    expect(check.x + check.width).toBeLessThanOrEqual(scroller.x + scroller.width + 0.5);
    expect(await page.locator('#sc-scroll').evaluate((s) => s.scrollWidth <= s.clientWidth + 1)).toBe(true);
    // The Position columns give way to the place under each end.
    await expect(page.locator('#sc-table th.sc-pos').first()).toBeHidden();
    const after = await row(page, 'IB-0001').locator('td.sc-end > div').first().evaluate((d) => getComputedStyle(d, '::after').content);
    expect(after).toBe('"A01 · U4–5"');
  }
  // Where there is room, they are columns of their own.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#sc-table th.sc-pos').first()).toBeVisible();
  await expect(row(page, 'IB-0001').locator('td.sc-pos').first()).toHaveText('A01 · U4–5');
});

test('the fabric of a plan without cables says so, with no empty drawing, network or legend', async ({ page }) => {
  await page.click('#btn-new');
  await page.click('#menu-new [data-new="empty"]');
  await toCabling(page, 'fabric');
  await expect(page.locator('#cab-host .cab-empty h2')).toHaveText('No cables yet');
  await expect(page.locator('#scene')).toBeHidden();
  await expect(page.locator('#zoom')).toBeHidden();
  await expect(page.locator('#cab-note')).toBeHidden();
  await expect(page.locator('#fb-tools')).toBeHidden();
  await expect(page.locator('#fb-title')).toHaveText('Fabric · whole plan');
  await page.click('#cab-host .cab-empty [data-cab-view="elevation"]');
  await expect(page.locator('#cab-toggle [data-cab-view="elevation"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#scene')).toBeVisible();
  await expect(page.locator('#zoom')).toBeVisible();
});

test('the fabric names only the tiers it has, and explains leaf badges only where there are leaves', async ({ page }) => {
  await toCabling(page, 'fabric');
  await expect(page.locator('#fb-sub')).toContainText('74 links between 2 core switches, 5 leaves and 31 nodes.');
  await expect(page.locator('#cab-note-leaf')).toBeVisible();
  await page.selectOption('#fb-net', 'n-sas');
  await expect(page.locator('#fb-title')).toHaveText('SAS fabric · whole plan');
  await expect(page.locator('#fb-sub')).toContainText('12 links between 12 nodes.');
  await expect(page.locator('#fb-sub')).not.toContainText('0 ');
  await expect(page.locator('#cab-note')).toBeVisible();
  await expect(page.locator('#cab-note-leaf')).toBeHidden();
  await page.selectOption('#fb-net', 'n-mgmt');
  await expect(page.locator('#fb-sub')).toContainText(/links between 5 leaves and \d+ nodes\./);
});

test('the fabric header is changed in place, and the drawing is drawn again only when what it shows changes', async ({ page }) => {
  await toCabling(page, 'fabric');
  const select = await page.locator('#fb-net').elementHandle();
  await page.click('[data-fb-grouped="0"]');
  await expect(page.locator('[data-fb-grouped="0"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-fb-grouped="0"]')).toBeFocused();
  expect(await select.evaluate((s) => s.isConnected)).toBe(true);
  await page.click('[data-fb-grouped="1"]');
  // Arming a cable type renders the app, not the fabric.
  await page.locator('#scene .fb-box').first().evaluate((g) => g.setAttribute('data-mark', '1'));
  await page.click('.cab-card[data-cab-type="cat6a"]');
  await expect(page.locator('.cab-card[data-cab-type="cat6a"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#scene .fb-box[data-mark]')).toHaveCount(1);
  // Selecting a box draws it again, outlined.
  await page.locator('#scene [data-group="0"]').click();
  await expect(page.locator('#scene .fb-box[data-mark]')).toHaveCount(0);
});

test('the devices listed in a selection line up whatever the length of their place', async ({ page }) => {
  await toCabling(page, 'fabric');
  await page.locator('#scene [data-group="0"]').click();
  await expect(page.locator('#inspector .multi-title')).toHaveText('12 devices');
  const xs = await page.locator('#inspector .contents .nm').evaluateAll((ns) => ns.map((n) => Math.round(n.getBoundingClientRect().left)));
  expect(new Set(xs).size).toBe(1);
});

test('the length hint says what an empty length gives for the cable’s type', async ({ page }) => {
  await toCabling(page, 'schedule');
  await row(page, 'IB-0031').locator('td').nth(1).click();
  await expect(page.locator('#cab-length + .field-hint')).toHaveText(/rounded up to 0\.1 m \(.+ is made to length\)/);
  await row(page, 'IB-0026').locator('td').nth(1).click();
  await expect(page.locator('#cab-length + .field-hint')).toHaveText(/^Empty: no length, as no stock length of .+ reaches 4 m\.$/);
  await row(page, 'IB-0001').locator('td').nth(1).click();
  await expect(page.locator('#cab-length + .field-hint')).toHaveText('Empty: the length it needs, rounded up to a stock length.');
});

test('the catalog opened from the Cables panel counts as the panel does, focuses its tab and opens each list at its top', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await toCabling(page, 'schedule');
  const panel = await page.locator('.cab-card[data-cab-type="cat6a"] .part-count').textContent();
  await page.focus('#btn-cab-catalog');
  await page.keyboard.press('Enter');
  await expect(page.locator('#cat-tab-cables')).toBeFocused();
  await expect(page.locator('#cat-tab-cables')).toHaveAttribute('tabindex', '0');
  await expect(page.locator('#cat-tab-devices')).toHaveAttribute('tabindex', '-1');
  await expect(page.locator('.cat-item[data-id="cat6a"] .cat-count')).toHaveText(panel);
  // Transceivers count the ends the order list counts.
  const optics = await plan(page, (p, a, RP) => RP.cabling.billOfMaterials(p, p.cables).transceivers.map((x) => [x.transceiver.id, x.count]));
  expect(optics.length).toBeGreaterThan(0);

  // The last item picked, far down the list; then Transceivers opens at its top, its first item in view.
  await page.locator('#cat-list').evaluate((l) => (l.scrollTop = l.scrollHeight));
  await page.locator('#cat-list .cat-item').last().click();
  await page.focus('#cat-tab-cables');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#cat-tab-transceivers')).toBeFocused();
  await expect(page.locator('#cat-tab-transceivers')).toHaveAttribute('aria-selected', 'true');
  expect(await page.locator('#cat-list').evaluate((l) => l.scrollTop)).toBe(0);
  await expect(page.locator('#cat-list .cat-item[aria-selected="true"]')).toBeInViewport({ ratio: 1 });
  for (const [id, count] of optics) await expect(page.locator(`.cat-item[data-id="${id}"] .cat-count`)).toHaveText(String(count));
});

test('keyboard focus comes back after the network dialog and Connect redraw what opened them', async ({ page }) => {
  await toCabling(page, 'schedule');
  // (a) A network renamed from its pencil.
  await page.focus('#networks [data-net-edit="n-ib"]');
  await page.keyboard.press('Enter');
  await expect(page.locator('#network-name')).toBeFocused();
  await page.keyboard.type(' fabric');
  await page.keyboard.press('Enter');
  await expect(page.locator('#networks [data-net-edit="n-ib"]')).toBeFocused();

  // (c) A new network from a cable's “+ New network”: focus on its chip.
  await row(page, 'IB-0004').locator('td').nth(1).click();
  await page.focus('#cab-net-__new');
  await page.keyboard.press('Space');
  await expect(page.locator('#network-name')).toBeFocused();
  await page.keyboard.press('Enter');
  const nid = await plan(page, (p) => p.networks[p.networks.length - 1].id);
  expect(await plan(page, (p) => p.cables.find((c) => c.label === 'IB-0004').network)).toBe(nid);
  await expect(page.locator(`#cab-net-${nid}`)).toBeFocused();

  // (b) Connect… from a device's free port: the new cable's label.
  await page.click('#cab-toggle [data-cab-view="ports"]');
  await page.click(`.pm-name[data-cab-select-device="${await idOf(page, 'ib-leaf-a01')}"]`);
  await expect(page.locator('#inspector .name-static')).toHaveText('ib-leaf-a01');
  await page.focus('#inspector [data-cab-connect="p13"]');
  await page.keyboard.press('Enter');
  await expect(page.locator('#dlg-connect')).toBeVisible();
  await page.click('#cs-submit');
  await expect(page.locator('#dlg-connect')).toBeHidden();
  await expect(page.locator('#cab-label')).toBeFocused();
});

test('deleting cables from a row’s checkbox keeps keyboard focus in the table', async ({ page }) => {
  await toCabling(page, 'schedule');
  const box = (label) => row(page, label).locator('input[type="checkbox"]');
  await box('BMC-0001').focus();
  await page.keyboard.press('Space');
  await box('MGT-0002').focus();
  await page.keyboard.press('Shift+Space');
  await page.keyboard.press('Delete');
  await expect(page.locator('.toast').last()).toContainText('Deleted 3 cables');
  // The row that took their place (after them) has focus.
  await expect(box('BMC-0002')).toBeFocused();
  // A row that stays keeps it.
  await box('MGT-0003').focus();
  await page.keyboard.press('Space');
  await box('IB-0003').focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('.toast').last()).toContainText('Deleted MGT-0003');
  await expect(box('IB-0003')).toBeFocused();
});

test('only the armed cable type is a stop for Tab; arrows move through the others', async ({ page }) => {
  await toCabling(page, 'schedule');
  await expect(page.locator('#cab-types [data-cab-type][tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('#cab-types [data-cab-type="auto"]')).toHaveAttribute('tabindex', '0');
  await page.focus('#btn-cab-catalog');
  await page.keyboard.press('Tab');
  await expect(page.locator('#cab-types [data-cab-type="auto"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#cab-types [data-cab-type="cat6a"]')).toBeFocused();
  await expect(page.locator('#cab-types [data-cab-type="cat6a"]')).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('Tab');
  await expect(page.locator('#btn-add-network')).toBeFocused();
});

test('the Connect preview and the schedule’s filter count are read out', async ({ page }) => {
  await toCabling(page, 'schedule');
  await expect(page.locator('#cs-summary')).toHaveAttribute('aria-live', 'polite');
  await page.locator('#sc-filter').fill('ceph-01');
  await expect(page.locator('#sc-status')).toHaveText(/^\d+ of 112 cables shown$/);
  await expect(page.locator('#sc-status')).toHaveAttribute('role', 'status');
  await page.locator('#sc-filter').fill('');
  // Every pair refused: the summary says why.
  await page.click('#sc-series');
  await page.selectOption('#cs-from', await idOf(page, 'cn-001'));
  await page.selectOption('#cs-from-last', await idOf(page, 'cn-003'));
  await page.selectOption('#cs-from-port', 'ib0');
  await page.selectOption('#cs-to', await idOf(page, 'ib-leaf-a01'));
  await page.locator('#cs-skip').uncheck();
  await expect(page.locator('#cs-summary')).toContainText('3 left out: ');
  await expect(page.locator('#cs-summary')).toContainText('already has cable');
  await expect(page.locator('#cs-submit')).toBeDisabled();
});

test('warnings in the schedule are dark enough to read in the light theme', async ({ page }) => {
  await toCabling(page, 'schedule');
  await expect(row(page, 'IB-0026').locator('.sc-flag.is-warn')).toHaveCSS('color', 'rgb(138, 87, 0)');
});

test('the search lists the cables it highlights: by network, type and notes too', async ({ page }) => {
  await toCabling(page, 'elevation');
  await page.click('#search');
  await page.keyboard.type('InfiniBand');
  await expect(page.locator('.sr-empty')).toHaveCount(0);
  const hits = await page.locator('.sr-group', { hasText: 'Cables' }).locator('.mono').textContent();
  expect(Number(hits)).toBe(await plan(page, (p) => p.cables.filter((c) => c.network === 'n-ib').length));
});

test('ports of devices whose ids hold "|" are clicked, hovered and connected', async ({ page }) => {
  const p = await plan(page, (p) => {
    const q = JSON.parse(JSON.stringify(p));
    const map = (id) => `dev|${id}`;
    for (const d of q.devices) d.id = map(d.id);
    for (const c of q.cables) {
      c.a.device = map(c.a.device);
      if (Array.isArray(c.b)) c.b = c.b.map((e) => (e ? Object.assign(e, { device: map(e.device) }) : e));
      else c.b.device = map(c.b.device);
    }
    q.name = 'Pipes';
    delete q.meta.example;
    return q;
  });
  await openPlan(page, p, 'Pipes');
  await toCabling(page, 'elevation');
  await page.click('#btn-zoom-reset');
  const free = await port(page, 'sw-mgmt-a01', 'swp13');
  await free.click();
  expect((await ui(page)).pending).toMatchObject({ device: await idOf(page, 'sw-mgmt-a01'), port: 'swp13' });
  await (await port(page, 'sw-bmc-a01', 'swp21')).click();
  expect(await plan(page, (p) => p.cables.some((c) => c.a.port === 'swp13' && c.b.port === 'swp21'))).toBe(true);
  // A cabled port selects its cable.
  await (await port(page, 'sw-mgmt-a01', 'swp1')).click();
  expect((await ui(page)).cabSel).toMatchObject({ kind: 'cables' });
});

test('a large plan counts cable types after an edit without holding it up, and its search waits for typing to pause', async ({ page }) => {
  test.setTimeout(90000);
  const big = largePlan();
  expect(big.cables.length).toBeGreaterThan(2000);
  await openPlan(page, big, 'Large plan');
  await toCabling(page, 'elevation');
  const count = () => page.locator('.cab-card[data-cab-type="cat6a"] .part-count');
  const cat6a = await plan(page, (p, a, RP) => p.cables.filter((c) => (RP.cabling.describe(p, c).type || {}).id === 'cat6a').length);
  await expect(count()).toHaveText(String(cat6a));
  // An edit: the panel shows the counts it had, and the new ones once counted.
  const id = await plan(page, (p, a, RP) => p.cables.find((c) => (RP.cabling.describe(p, c).type || {}).id === 'cat6a').id);
  const before = await page.evaluate((id) => {
    // Delete it as the Delete key does, and read the panel right after.
    window.RP.app.ui.cabSel = { kind: 'cables', ids: [id] };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    return { cables: window.RP.app.project().cables.length, count: document.querySelector('.cab-card[data-cab-type="cat6a"] .part-count').textContent };
  }, id);
  expect(before).toEqual({ cables: big.cables.length - 1, count: String(cat6a) });
  await expect(count()).toHaveText(String(cat6a - 1));

  // Typing in the search: the results follow each key, the drawing once typing pauses.
  await page.locator('#scene .dev').first().evaluate((g) => g.setAttribute('data-mark', '1'));
  await page.click('#search');
  const now = await page.evaluate(() => {
    const s = document.querySelector('#search');
    s.value = 'gpu';
    s.dispatchEvent(new Event('input'));
    return { drawn: document.querySelectorAll('#scene .dev[data-mark]').length, results: !document.querySelector('#search-results').hidden };
  });
  expect(now).toEqual({ drawn: 1, results: true });
  await expect(page.locator('#scene .dev[data-mark]')).toHaveCount(0);
});

test('a plan opened when the browser storage is full says it is not saved', async ({ page }) => {
  await page.evaluate(() => {
    // Fill the storage to its quota.
    const chunk = 'x'.repeat(1 << 20);
    let i = 0;
    try {
      for (; i < 64; i++) localStorage.setItem(`fill-${i}`, chunk);
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
  await page.click('#btn-new');
  await page.click('#menu-new [data-new="example"]');
  await expect(page.locator('.toast.warn')).toContainText('The browser storage is full, so this plan is not saved');
});
