'use strict';

const { test, expect } = require('@playwright/test');

// Every test starts from a fresh browser profile, so the example plan (one view) loads.
test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('.scene .dev')).toHaveCount(37);
});

const device = (page, name) => page.locator(`.scene .dev[aria-label^="${name},"]`);
const viewItems = (page) => page.locator('#menu-views [data-cluster-view]');
/** Opens the view menu and picks view `name`. */
async function pickView(page, name) {
  await page.click('#btn-cluster-view');
  await viewItems(page).filter({ hasText: name }).click();
}
const shown = (page) => page.locator('#clusters-view');
const app = (page, fn, arg) => page.evaluate(fn, arg);

/** Adds a copy of the view shown, named `name`, with the views dialog. */
async function copyView(page, name) {
  await page.click('#btn-views');
  await page.click('#view-copy');
  const input = page.locator('#view-list input[data-view-name]').last();
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press('Tab');
  await page.click('#dlg-views [data-close]');
}

test('a copied view has its own clusters; the switch shows the views and V steps through them', async ({ page }) => {
  await expect(page.locator('#view-switch')).toBeHidden();
  await copyView(page, 'InfiniBand');
  await expect(page.locator('#view-switch')).toBeVisible();
  await expect(shown(page)).toHaveText('InfiniBand');
  await page.click('#btn-cluster-view');
  await expect(viewItems(page).locator('span')).toHaveText(['Default', 'InfiniBand']);
  await expect(viewItems(page).nth(1)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // A cluster change in the copy leaves the first view as it was.
  await device(page, 'cn-001').click();
  await expect(page.locator('input[name="insp-cluster"]:checked')).toHaveCount(1);
  await page.click('label.chip:has(input[name="insp-cluster"][value=""]) span');
  await expect(device(page, 'cn-001')).not.toHaveAttribute('aria-label', /cluster/);
  await expect(page.locator('.scene')).toContainText('CLUSTERS · INFINIBAND');
  await pickView(page, 'Default');
  await expect(shown(page)).toHaveText('Default');
  await expect(device(page, 'cn-001')).toHaveAttribute('aria-label', /cluster Kestrel HPC/);
  await expect(page.locator('#clusters .cl-row[data-cluster="c-kestrel"]')).toBeVisible();

  await page.locator('#scene').focus();
  await page.keyboard.press('v');
  await expect(shown(page)).toHaveText('InfiniBand');
  await expect(device(page, 'cn-001')).not.toHaveAttribute('aria-label', /cluster/);
  await page.keyboard.press('v');
  await expect(shown(page)).toHaveText('Default');

  // The view shown is remembered for the plan.
  await pickView(page, 'InfiniBand');
  await page.reload();
  await expect(shown(page)).toHaveText('InfiniBand');
});

test('a new device takes the clusters of the device it follows in the other views', async ({ page }) => {
  await copyView(page, 'Power');
  await page.click('#btn-add-cluster');
  await expect(page.locator('#cluster-title')).toHaveText('Create a cluster in Power');
  await page.fill('#cluster-name', 'Feed A');
  await page.click('#cluster-submit');
  await device(page, 'cn-012').click();
  await expect(page.locator('#insp-cluster-label')).toHaveText('Cluster in Power');
  await page.click('#insp-dup');
  const copy = await app(page, () => {
    const p = window.RP.app.project();
    const d = p.devices.find((x) => x.name === 'cn-013');
    return p.views.map((v) => (window.RP.model.clusterOf(p, d, v.id) || {}).name || null);
  });
  expect(copy, 'a duplicate keeps its clusters in every view').toEqual(['Kestrel HPC', 'Kestrel HPC']);

  /** Clicks unit `at` of Rack A03 with a 48-port switch armed. */
  const placeSwitch = async (at) => {
    await page.click('.part[data-type="switch-rj45"]');
    const slot = await app(page, (at) => {
      const svg = document.querySelector('#scene');
      const box = svg.getBoundingClientRect();
      const zoom = box.width / svg.viewBox.baseVal.width;
      const r = window.RP.render.locRect(window.RP.app.project(), { rack: 'r3', kind: 'u', at }, 'switch-rj45');
      return { x: box.left + (r.x + r.w / 2) * zoom, y: box.top + (r.y + r.h / 2) * zoom };
    }, at);
    await page.mouse.click(slot.x, slot.y);
    await expect(page.locator('#dlg-place')).toBeVisible();
  };
  const lastClusters = () =>
    app(page, () => {
      const p = window.RP.app.project();
      const d = p.devices[p.devices.length - 1];
      return p.views.map((v) => (window.RP.model.clusterOf(p, d, v.id) || {}).name || null);
    });
  await placeSwitch(40);
  await expect(page.locator('#place-cluster-label')).toHaveText('Cluster in Power');
  await expect(page.locator('#place-views')).toHaveText('Like sw-bmc-a03: Core network in Default');
  await page.click('label.chip:has(input[name="place-cluster"]) span:text("Feed A")');
  await page.click('#place-submit');
  expect(await lastClusters()).toEqual(['Core network', 'Feed A']);
  await expect(page.locator('.toast').last()).toHaveText('Placed sw-bmc-a03-2');

  // A view where the device it follows has no cluster: the toast says so and shows it.
  await page.click('#btn-views');
  await page.click('#view-add');
  await page.click('#dlg-views [data-close]');
  await pickView(page, 'Power');
  await placeSwitch(41);
  await expect(page.locator('#place-views')).toHaveText('Like sw-bmc-a03-2: Core network in Default and none in View 3');
  await page.click('#place-submit');
  expect(await lastClusters()).toEqual(['Core network', 'Feed A', null]);
  const note = page.locator('.toast').last();
  await expect(note).toContainText('Placed sw-bmc-a03-3 · no cluster in View 3');
  await note.locator('button', { hasText: 'Show' }).click();
  await expect(shown(page)).toHaveText('View 3');
});

test('views are renamed and deleted in the views dialog, and undo brings one back', async ({ page }) => {
  await copyView(page, 'Lustre');
  await page.click('#btn-views');
  const names = page.locator('#view-list input[data-view-name]');
  await names.first().fill('lustre');
  await names.first().press('Tab');
  await expect(page.locator('#views-error')).toHaveText('Another view is named lustre.');
  await expect(names.first()).toHaveValue('Default');
  await names.first().fill('InfiniBand');
  await names.first().press('Tab');
  await expect(names.nth(0)).toHaveValue('InfiniBand');
  await expect(names.nth(1)).toHaveValue('Lustre');

  await page.click('#view-list li:nth-child(2) [data-view-delete]');
  await page.click('#confirm-ok');
  await expect(page.locator('#view-list li')).toHaveCount(1);
  await expect(page.locator('#view-list [data-view-delete]')).toBeDisabled();
  await page.click('#dlg-views [data-close]');
  await expect(page.locator('#view-switch')).toBeHidden();
  await page.click('.toast button:text("Undo")');
  await page.click('#btn-cluster-view');
  await expect(viewItems(page).locator('span')).toHaveText(['InfiniBand', 'Lustre']);
  await page.click('#menu-views [data-edit-views]');
  await expect(page.locator('#dlg-views')).toBeVisible();
});

test('the plan name keeps its room next to the view switch on laptop screens', async ({ page }) => {
  await copyView(page, 'InfiniBand');
  await page.click('#btn-views');
  await page.click('#view-add');
  await page.click('#dlg-views [data-close]');
  await page.click('#btn-cluster-view');
  await expect(viewItems(page)).toHaveCount(3);
  await page.keyboard.press('Escape');
  for (const width of [1181, 1280, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const cut = await page.locator('#plan-name').evaluate((e) => e.scrollWidth > e.clientWidth);
    expect(cut, `at ${width} px`).toBe(false);
    await expect(page.locator('#btn-cluster-view')).toBeVisible();
  }
});

test('on laptop screens the toolbar names the workspaces and the view shown, and its icons keep their names', async ({ page }) => {
  await copyView(page, 'InfiniBand');
  await page.click('.ws-switch [data-workspace="cabling"]');
  for (const width of [1100, 1280, 1366]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.locator('.ws-switch .ws-label').first(), `at ${width} px`).toBeVisible();
    await expect(page.locator('#view-label'), `at ${width} px`).toBeVisible();
    await expect(page.locator('#view-label')).toHaveText('InfiniBand');
  }
  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const cut = await page.locator('#plan-name').evaluate((e) => e.scrollWidth > e.clientWidth);
    expect(cut, `at ${width} px`).toBe(false);
    // Icons alone, with a tooltip and a name.
    await expect(page.locator('#btn-export > span')).toHaveCSS('width', '1px');
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toHaveAttribute('title', /^Export: /);
    await expect(page.getByRole('button', { name: 'New plan', exact: true })).toHaveAttribute('title', 'New plan');
    await expect(page.getByRole('button', { name: 'Plans', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cabling', exact: true })).toBeVisible();
  }
});

test('a version 4 plan opens with one view, Default', async ({ page }) => {
  const v4 = {
    app: 'rackplanner',
    version: 4,
    name: 'Old plan',
    racks: [{ id: 'r1', name: 'Rack 1' }],
    clusters: [{ id: 'c1', name: 'HPC', color: '#2f6fdb' }],
    devices: [{ id: 'a', type: 'compute-node', name: 'cn-1', cluster: 'c1', loc: { rack: 'r1', kind: 'u', at: 1 } }],
  };
  await page.click('#btn-open');
  await page.fill('#open-text', JSON.stringify(v4));
  await page.click('#open-form [type="submit"]');
  await expect(device(page, 'cn-1')).toHaveAttribute('aria-label', /cluster HPC/);
  await expect(page.locator('#view-switch')).toBeHidden();
  const views = await app(page, () => window.RP.app.project().views.map((v) => v.name));
  expect(views).toEqual(['Default']);
});

test('undo goes back to the view of the change it reverts', async ({ page }) => {
  await copyView(page, 'InfiniBand');
  await device(page, 'cn-001').click();
  await page.click('label.chip:has(input[name="insp-cluster"][value=""]) span');
  await pickView(page, 'Default');
  await expect(shown(page)).toHaveText('Default');

  await page.keyboard.press('Control+z');
  await expect(shown(page)).toHaveText('InfiniBand');
  await expect(page.locator('.toast[data-kind="undo"]')).toHaveText('Undid: Set the cluster of cn-001 (InfiniBand)');

  // Undoing the delete of the view shown shows that view again.
  await page.click('#btn-views');
  await page.click('#view-list li:nth-child(2) [data-view-delete]');
  await page.click('#confirm-ok');
  await expect(shown(page)).toHaveText('Default');
  await page.click('#dlg-views [data-close]');
  await page.locator('.toast', { hasText: 'Deleted view InfiniBand' }).getByRole('button', { name: 'Undo' }).click();
  await expect(shown(page)).toHaveText('InfiniBand');
});

test('undo names the steps of the views dialog', async ({ page }) => {
  const said = page.locator('.toast[data-kind="undo"]');
  await page.click('#btn-views');
  await page.click('#view-add');
  await page.click('#dlg-views [data-close]');
  await page.keyboard.press('Control+z');
  await expect(said).toHaveText(/^Undid: Added view \S/);

  await copyView(page, 'Lustre');
  await page.keyboard.press('Control+z');
  await expect(said).toHaveText('Undid: Renamed view Default (copy) to Lustre');
  await page.keyboard.press('Control+z');
  await expect(said).toHaveText(/^Undid: Copied view Default as Default \(copy\)/);
});

test('copies of a view get names of their own', async ({ page }) => {
  await page.click('#btn-views');
  const names = page.locator('#view-list input[data-view-name]');
  await page.click('#view-copy');
  await expect(names.last()).toHaveValue('Default (copy)');
  // Show Default again and copy it once more.
  await page.click('#view-list li:nth-child(1) [data-view-show]');
  await page.click('#view-copy');
  await expect(names).toHaveCount(3);
  expect(await names.evaluateAll((list) => list.map((e) => e.value))).toEqual(['Default', 'Default (copy)', 'Default (copy 2)']);
});
