// Takes the README screenshots from the example plan. Run with `npm run screenshots`.
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('@playwright/test');

const PORT = 4180;
const OUT = path.join(__dirname, 'screenshots');
const VIEWPORT = { width: 1440, height: 900 };

/** A fresh browser profile on the example plan, fonts loaded and the example notice dismissed. */
async function openApp(browser, colorScheme) {
  const page = await browser.newPage({ viewport: VIEWPORT, colorScheme });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.waitForSelector('.scene .dev');
  await page.evaluate(() => document.fonts.ready);
  await page.click('#btn-keep-example');
  return page;
}

/** Waits for transitions to finish and saves the page, with the pointer out of the way. */
async function shot(page, name) {
  await page.mouse.move(VIEWPORT.width - 5, VIEWPORT.height - 5);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`docs/screenshots/${name}.png`);
}

/** Screen position of the middle of unit `at` of a rack on the shown row. */
function unitSpot(page, rack, at) {
  return page.evaluate(
    ({ rack, at }) => {
      const svg = document.querySelector('#scene');
      const box = svg.getBoundingClientRect();
      const zoom = box.width / svg.viewBox.baseVal.width;
      const r = window.RP.render.locRect(window.RP.app.project(), { rack, kind: 'u', at }, 'compute-node');
      return { x: box.left + (r.x + r.w / 2) * zoom, y: box.top + (r.y + r.h / 2) * zoom };
    },
    { rack, at }
  );
}

async function elevation(browser, colorScheme, name) {
  const page = await openApp(browser, colorScheme);
  await page.click('.scene .dev[aria-label^="cn-004,"]');
  await shot(page, name);
  await page.close();
}

async function placing(browser) {
  const page = await openApp(browser);
  await page.click('.part[data-type="compute-node"]');
  const at = await unitSpot(page, 'r1', 30);
  await page.mouse.click(at.x, at.y);
  await page.fill('#place-qty', '6');
  await page.check('#place-spread');
  await shot(page, 'placing');
  await page.close();
}

async function floorMap(browser) {
  const page = await openApp(browser);
  await page.keyboard.press('m');
  await page.click('.fm-metric [data-metric="power"]');
  await shot(page, 'floor-map');
  await page.close();
}

async function catalog(browser) {
  const page = await openApp(browser);
  await page.click('#btn-catalog');
  await page.click('.cat-item[data-id="gpu-server"]');
  await shot(page, 'catalog');
  await page.close();
}

/** The PNG export of Row B, as the app downloads it. */
async function sheet(browser) {
  const page = await openApp(browser);
  await page.click('#btn-row-next');
  const download = page.waitForEvent('download');
  await page.click('#btn-export');
  await page.click('[data-export="png"]');
  await (await download).saveAs(path.join(OUT, 'sheet.png'));
  console.log('docs/screenshots/sheet.png');
  await page.close();
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'e2e', 'serve.js'), String(PORT)], { stdio: 'inherit' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const browser = await chromium.launch();
  try {
    await elevation(browser, 'light', 'elevation');
    await elevation(browser, 'dark', 'elevation-dark');
    await placing(browser);
    await floorMap(browser);
    await catalog(browser);
    await sheet(browser);
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
