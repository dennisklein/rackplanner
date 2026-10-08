// Takes the README screenshots from the example plan, in the Racks and the
// Cabling workspace, and the banner that links to the intro video. Run with
// `npm run screenshots`, or name some of them:
// `npm run screenshots -- intro-video intro-video-dark`. PORT=… serves the
// app on another port than 4180.
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('@playwright/test');

const PORT = Number(process.env.PORT) || 4180;
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

/** The example plan in the Cabling workspace, on one of its views. */
async function openCabling(browser, colorScheme, view) {
  const page = await openApp(browser, colorScheme);
  await page.click('.ws-switch [data-workspace="cabling"]');
  if (view) await page.click(`#cab-toggle [data-cab-view="${view}"]`);
  return page;
}

/** The cabling elevation of Row A from the rear at 100%, with a compute node selected and its cables drawn bold. */
async function cablingElevation(browser, colorScheme, name) {
  const page = await openCabling(browser, colorScheme);
  const id = await page.evaluate(() => window.RP.app.project().devices.find((d) => d.name === 'cn-004').id);
  const dev = page.locator(`.scene .dev[data-dev="${id}"]`);
  await page.click('#btn-zoom-reset');
  // Rack A01 is on the right from the rear: scroll to it, with the tray above it in view.
  await dev.evaluate((g) => {
    const canvas = document.querySelector('#canvas');
    const r = g.getBoundingClientRect();
    const box = canvas.getBoundingClientRect();
    canvas.scrollLeft += r.left + r.width / 2 - (box.left + box.width / 2);
    canvas.scrollTop = 0;
  });
  // On its name, clear of the ports.
  await dev.click({ position: { x: 40, y: 8 } });
  await shot(page, name);
  await page.close();
}

async function portMap(browser) {
  const page = await openCabling(browser, 'light', 'ports');
  await shot(page, 'port-map');
  await page.close();
}

/** The cable schedule of Row A with a cable selected. */
async function schedule(browser) {
  const page = await openCabling(browser, 'light', 'schedule');
  // On its label cell, clear of the checkbox.
  await page.locator('#sc-body tr', { hasText: 'IB-0001' }).first().locator('td').nth(1).click();
  await shot(page, 'schedule');
  await page.close();
}

/** Connect series about to join the management ports of Row B's six PDUs to its management switch. */
async function connectSeries(browser) {
  const page = await openCabling(browser, 'light', 'schedule');
  await page.click('#btn-row-next');
  await page.click('#sc-series');
  const id = (name) => page.evaluate((name) => window.RP.app.project().devices.find((d) => d.name === name).id, name);
  await page.selectOption('#cs-from', await id('pdu-b01-a'));
  await page.selectOption('#cs-from-last', await id('pdu-b03-b'));
  await page.check('#cs-only');
  await page.selectOption('#cs-from-port', 'mgmt');
  await page.selectOption('#cs-to', await id('sw-mgmt-b01'));
  await page.locator('#cs-nets label', { hasText: 'Management' }).click();
  // Without the toast that named the row.
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await shot(page, 'connect-series');
  await page.close();
}

async function fabric(browser) {
  const page = await openCabling(browser, 'light', 'fabric');
  await shot(page, 'fabric');
  await page.close();
}

async function catalogPorts(browser) {
  const page = await openApp(browser);
  await page.click('#btn-catalog');
  await page.click('.cat-item[data-id="switch-rj45"]');
  await page.click('#cat-sub-ports');
  await shot(page, 'catalog-ports');
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

/**
 * The banner at the top of the README that links to the intro video, in the
 * app's colors and fonts, light or dark like the screenshot below it. It is
 * framed like that screenshot too: as wide, with the app's 16 px margin
 * around a panel with the same corners, so the edges of the two line up.
 * Laid out at 1920 px wide and scaled down.
 */
async function introVideo(browser, colorScheme, name) {
  const width = VIEWPORT.width;
  const zoom = width / 1920;
  const dark = colorScheme === 'dark';
  const page = await browser.newPage({ viewport: { width, height: Math.round(560 * zoom) } });
  // Same origin as the server, so the bundled fonts load.
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.setContent(`<!doctype html>
    <base href="http://127.0.0.1:${PORT}/">
    <link rel="stylesheet" href="css/fonts.css">
    <style>
      html { zoom: ${zoom}; }
      body { margin: 0; height: 560px; padding: ${16 / zoom}px; box-sizing: border-box; background: ${dark ? '#0d1115' : '#e6eaee'}; }
      .panel {
        height: 100%; box-sizing: border-box; border-radius: ${6 / zoom}px; border: ${dark ? `${1 / zoom}px solid #29313a` : '0'};
        display: flex; align-items: center; justify-content: center; gap: 72px;
        color: #e6ebf0; font-family: Barlow, sans-serif; -webkit-font-smoothing: antialiased;
        background:
          radial-gradient(ellipse 60% 90% at 50% 50%, transparent 30%, rgb(0 0 0 / 0.45) 100%),
          linear-gradient(rgb(255 255 255 / 0.045) 1px, transparent 1px) 0 0 / 200px 200px,
          linear-gradient(90deg, rgb(255 255 255 / 0.045) 1px, transparent 1px) 0 0 / 200px 200px,
          linear-gradient(rgb(255 255 255 / 0.022) 1px, transparent 1px) 0 0 / 40px 40px,
          linear-gradient(90deg, rgb(255 255 255 / 0.022) 1px, transparent 1px) 0 0 / 40px 40px,
          ${dark ? '#151a20' : '#0d1115'};
      }
      .play { width: 220px; height: 220px; border-radius: 50%; background: #f2c230; box-shadow: 10px 10px 0 #a07a0c; display: grid; place-items: center; flex: none; }
      .play svg { width: 104px; height: 104px; margin-left: 18px; }
      .tag { display: inline-block; padding: 10px 16px 9px; border-radius: 4px; background: #f2c230; color: #1b1f24; font: 600 30px/1 "IBM Plex Mono", monospace; letter-spacing: 0.08em; box-shadow: 3px 3px 0 #a07a0c; }
      h1 { margin: 22px 0 0; font: 600 144px/0.95 "Barlow Condensed", sans-serif; letter-spacing: -0.005em; white-space: nowrap; }
      h1 em { font-style: normal; color: #f2c230; }
      p { margin: 18px 0 0; font-size: 38px; color: #a5b0bc; }
    </style>
    <div class="panel">
      <div class="play"><svg viewBox="0 0 10 12"><path d="M0 0L10 6 0 12z" fill="#1b1f24"/></svg></div>
      <div>
        <span class="tag">INTRO VIDEO</span>
        <h1>Rackplanner in <em>50 seconds</em></h1>
        <p>Place, color-code, budget, search, cable, export and share: a quick tour.</p>
      </div>
    </div>`);
  await page.evaluate(() =>
    Promise.all(['600 144px "Barlow Condensed"', '400 38px Barlow', '600 30px "IBM Plex Mono"'].map((f) => document.fonts.load(f, 'Ra27')))
  );
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`docs/screenshots/${name}.png`);
  await page.close();
}

const SHOTS = {
  elevation: (browser) => elevation(browser, 'light', 'elevation'),
  'elevation-dark': (browser) => elevation(browser, 'dark', 'elevation-dark'),
  placing,
  'floor-map': floorMap,
  catalog,
  sheet,
  'cabling-elevation': (browser) => cablingElevation(browser, 'light', 'cabling-elevation'),
  'cabling-elevation-dark': (browser) => cablingElevation(browser, 'dark', 'cabling-elevation-dark'),
  'port-map': portMap,
  schedule,
  'connect-series': connectSeries,
  fabric,
  'catalog-ports': catalogPorts,
  'intro-video': (browser) => introVideo(browser, 'light', 'intro-video'),
  'intro-video-dark': (browser) => introVideo(browser, 'dark', 'intro-video-dark'),
};

(async () => {
  const only = process.argv.slice(2);
  for (const name of only) if (!SHOTS[name]) throw new Error(`No screenshot named ${name}; there are ${Object.keys(SHOTS).join(', ')}`);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'e2e', 'serve.js'), String(PORT)], { stdio: 'inherit' });
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
