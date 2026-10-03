// Takes the README screenshots from the example plan, and the banner that
// links to the intro video. Run with `npm run screenshots`, or name some of
// them: `npm run screenshots -- intro-video`.
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

/** The banner at the top of the README that links to the intro video, in the app's colors and fonts. */
async function introVideo(browser) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 560 } });
  // Same origin as the server, so the bundled fonts load.
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
  await page.setContent(`<!doctype html>
    <base href="http://127.0.0.1:${PORT}/">
    <link rel="stylesheet" href="css/fonts.css">
    <style>
      body {
        margin: 0; height: 560px; display: flex; align-items: center; justify-content: center; gap: 72px;
        color: #e6ebf0; font-family: Barlow, sans-serif; -webkit-font-smoothing: antialiased;
        background:
          radial-gradient(ellipse 60% 90% at 50% 50%, transparent 30%, rgb(0 0 0 / 0.5) 100%),
          linear-gradient(rgb(255 255 255 / 0.045) 1px, transparent 1px) 0 0 / 200px 200px,
          linear-gradient(90deg, rgb(255 255 255 / 0.045) 1px, transparent 1px) 0 0 / 200px 200px,
          linear-gradient(rgb(255 255 255 / 0.022) 1px, transparent 1px) 0 0 / 40px 40px,
          linear-gradient(90deg, rgb(255 255 255 / 0.022) 1px, transparent 1px) 0 0 / 40px 40px,
          #0d1115;
      }
      .play { width: 230px; height: 230px; border-radius: 50%; background: #f2c230; box-shadow: 10px 10px 0 #a07a0c; display: grid; place-items: center; flex: none; }
      .play svg { width: 110px; height: 110px; margin-left: 18px; }
      .tag { display: inline-block; padding: 10px 16px 9px; border-radius: 4px; background: #f2c230; color: #1b1f24; font: 600 30px/1 "IBM Plex Mono", monospace; letter-spacing: 0.08em; box-shadow: 3px 3px 0 #a07a0c; }
      h1 { margin: 22px 0 0; font: 600 150px/0.95 "Barlow Condensed", sans-serif; letter-spacing: -0.005em; white-space: nowrap; }
      h1 em { font-style: normal; color: #f2c230; }
      p { margin: 18px 0 0; font-size: 40px; color: #a5b0bc; }
    </style>
    <div class="play"><svg viewBox="0 0 10 12"><path d="M0 0L10 6 0 12z" fill="#1b1f24"/></svg></div>
    <div>
      <span class="tag">INTRO VIDEO</span>
      <h1>Rackplanner in <em>27 seconds</em></h1>
      <p>Place, color-code, budget, search, export and share: a quick tour.</p>
    </div>`);
  await page.evaluate(() =>
    Promise.all(['600 150px "Barlow Condensed"', '400 40px Barlow', '600 30px "IBM Plex Mono"'].map((f) => document.fonts.load(f, 'Ra27')))
  );
  await page.screenshot({ path: path.join(OUT, 'intro-video.png') });
  console.log('docs/screenshots/intro-video.png');
  await page.close();
}

const SHOTS = {
  elevation: (browser) => elevation(browser, 'light', 'elevation'),
  'elevation-dark': (browser) => elevation(browser, 'dark', 'elevation-dark'),
  placing,
  'floor-map': floorMap,
  catalog,
  sheet,
  'intro-video': introVideo,
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
