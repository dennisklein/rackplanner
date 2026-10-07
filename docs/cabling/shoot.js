// Takes the screenshots of the cabling mockups: the real app on the example
// plan, with prototype.js and mockups.js drawing the proposed views into it.
// Run with `node docs/cabling/shoot.js`, or name some of them.
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('@playwright/test');

const PORT = 4181;
const OUT = path.join(__dirname, 'screenshots');
const VIEWPORT = { width: 1440, height: 900 };

async function openApp(browser, colorScheme) {
  const page = await browser.newPage({ viewport: VIEWPORT, colorScheme });
  page.on('pageerror', (err) => console.error('page error:', err.message));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.waitForSelector('.scene .dev');
  await page.evaluate(() => document.fonts.ready);
  await page.click('#btn-keep-example');
  await page.addStyleTag({ url: '/docs/cabling/mockups.css' });
  await page.addScriptTag({ url: '/docs/cabling/prototype.js' });
  await page.addScriptTag({ url: '/docs/cabling/mockups.js' });
  return page;
}

async function shot(page, name) {
  await page.mouse.move(VIEWPORT.width - 5, 5);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`docs/cabling/screenshots/${name}.png`);
}

const SHOTS = {
  async 'catalog-ports'(browser) {
    const page = await openApp(browser);
    await page.click('#btn-catalog');
    await page.click('.cat-item[data-id="switch-rj45"]');
    await page.evaluate(() => window.cablingMockups.showCatalogPorts());
    await shot(page, 'catalog-ports');
    await page.close();
  },
  async 'a-elevation'(browser) {
    const page = await openApp(browser);
    await page.evaluate(() => window.cablingMockups.showElevation({ selected: null }));
    await shot(page, 'a-elevation');
    await page.close();
  },
  async 'a-elevation-zoom'(browser) {
    const page = await openApp(browser);
    await page.evaluate(() => window.cablingMockups.showElevation({ selected: 'cn-004', zoom: 1, scrollX: 740, scrollY: 0 }));
    await shot(page, 'a-elevation-zoom');
    await page.close();
  },
  async 'a-elevation-dark'(browser) {
    const page = await openApp(browser, 'dark');
    await page.evaluate(() => window.cablingMockups.showElevation({ selected: 'cn-004', zoom: 1, scrollX: 740, scrollY: 0 }));
    await shot(page, 'a-elevation-dark');
    await page.close();
  },
  async 'b-port-map'(browser) {
    const page = await openApp(browser);
    await page.evaluate(() => window.cablingMockups.showPortMap());
    await shot(page, 'b-port-map');
    await page.close();
  },
  async 'c-schedule'(browser) {
    const page = await openApp(browser);
    await page.evaluate(() => window.cablingMockups.showSchedule());
    await shot(page, 'c-schedule');
    await page.close();
  },
  async 'c-connect-series'(browser) {
    const page = await openApp(browser);
    await page.evaluate(() => window.cablingMockups.showSchedule({ dialog: true }));
    await shot(page, 'c-connect-series');
    await page.close();
  },
  async 'd-fabric'(browser) {
    const page = await openApp(browser);
    await page.evaluate(() => window.cablingMockups.showFabric());
    await shot(page, 'd-fabric');
    await page.close();
  },
};

(async () => {
  const only = process.argv.slice(2);
  for (const name of only) if (!SHOTS[name]) throw new Error(`No screenshot named ${name}; there are ${Object.keys(SHOTS).join(', ')}`);
  const server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'e2e', 'serve.js'), String(PORT)], { stdio: 'inherit' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const browser = await chromium.launch();
  try {
    for (const [name, take] of Object.entries(SHOTS)) if (!only.length || only.includes(name)) await take(browser);
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
