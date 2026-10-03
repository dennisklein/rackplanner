// Records the intro video: draws every frame of media/intro.html in Chromium,
// renders its soundtrack (media/soundtrack.js) there too, and encodes both
// with ffmpeg into media/rackplanner-intro.mp4 (H.264, AAC) and .webm (VP9,
// Opus, for browsers without H.264), plus a poster frame,
// media/rackplanner-intro.jpg. None of them is kept in git; the Pages
// workflow records and publishes them. Run with `npm run video`; needs ffmpeg
// on the PATH. `npm run video -- --still 3,12.5` saves those moments as PNGs.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('@playwright/test');

const PORT = 4181;
const FPS = 30;
const SIZE = { width: 1920, height: 1080 };
const OUT = path.join(__dirname, 'rackplanner-intro.mp4');
const WEBM = path.join(__dirname, 'rackplanner-intro.webm');
const POSTER = path.join(__dirname, 'rackplanner-intro.jpg');

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
  const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rackplanner-')), 'soundtrack.wav');
  fs.writeFileSync(wav, Buffer.from(await page.evaluate(() => window.soundtrack()), 'base64'));
  const ffmpeg = spawn(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-i', wav,
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', OUT,
      '-map', '0:v', '-map', '1:a', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus', '-b:a', '128k', WEBM],
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
  fs.rmSync(path.dirname(wav), { recursive: true, force: true });
  console.log(`\r${path.relative(process.cwd(), OUT)}`);
  console.log(path.relative(process.cwd(), WEBM));
  await page.evaluate(() => window.seek(window.POSTER));
  await page.screenshot({ path: POSTER, type: 'jpeg', quality: 85 });
  console.log(path.relative(process.cwd(), POSTER));
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
