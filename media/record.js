// Records the intro video: draws every frame of media/intro.html in Chromium
// and encodes them with ffmpeg into media/rackplanner-intro.mp4, which is not
// kept in git. Run with `npm run video`; needs ffmpeg on the PATH.
// `npm run video -- --still 3,12.5` saves those moments as PNGs instead.
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('@playwright/test');

const PORT = 4181;
const FPS = 30;
const SIZE = { width: 1920, height: 1080 };
const OUT = path.join(__dirname, 'rackplanner-intro.mp4');

/** Writes to a stream, waiting while its buffer is full. */
function write(stream, data) {
  return new Promise((resolve, reject) => {
    if (stream.write(data)) return resolve();
    const done = (err) => {
      stream.off('drain', done);
      stream.off('error', done);
      if (err) reject(err);
      else resolve();
    };
    stream.on('drain', done);
    stream.on('error', done);
  });
}

async function record(page) {
  const duration = await page.evaluate(() => window.DURATION);
  const frames = Math.round(duration * FPS);
  const ffmpeg = spawn(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  );
  const done = new Promise((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.seek(t), i / FPS);
    await write(ffmpeg.stdin, await page.screenshot({ type: 'png' }));
    if (i % FPS === 0) process.stdout.write(`\r${i / FPS}/${duration} s`);
  }
  ffmpeg.stdin.end();
  await done;
  console.log(`\r${path.relative(process.cwd(), OUT)}`);
}

async function still(page, t) {
  const file = path.join(__dirname, `still-${t}.png`);
  await page.evaluate((s) => window.seek(s), t);
  await page.screenshot({ path: file });
  console.log(path.relative(process.cwd(), file));
}

(async () => {
  const at = process.argv.indexOf('--still');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'e2e', 'serve.js'), String(PORT)], { stdio: 'inherit' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: SIZE });
    await page.goto(`http://127.0.0.1:${PORT}/media/intro.html?render`);
    await page.waitForFunction(() => window.introReady === true);
    if (at > 0) for (const t of process.argv[at + 1].split(',')) await still(page, Number(t));
    else await record(page);
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
