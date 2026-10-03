// Records the intro video: draws every frame of media/intro.html in Chromium
// and encodes them with ffmpeg into media/rackplanner-intro.mp4 (H.264, AAC)
// and .webm (VP9, Opus, for browsers without H.264), plus a poster frame,
// media/rackplanner-intro.jpg. None of them is kept in git; the Pages
// workflow records and publishes them. Run with `npm run video`; needs ffmpeg
// on the PATH. `npm run video -- --still 3,12.5` saves those moments as PNGs.
//
// The sound is the music track given with `--music track.mp3`, cut to the
// picture (see EDIT), or else the soundtrack synthesized in the page by
// media/soundtrack.js.
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

/**
 * How a --music track is cut to the picture, in seconds. Its opening plays
 * from the start, `lead` late, so its first full downbeat lands as the app
 * window settles. At `jump.at` it skips ahead to `jump.from` in the track, a
 * whole number of beats, so the beat runs on: its break then falls on the
 * stripes and its biggest hit on the closing page. It fades out with the
 * video. These points fit "Industrial" by audioknap (Pixabay, 100 BPM);
 * another track needs its own.
 */
const EDIT = { lead: 0.04, jump: { at: 22.05, from: 26.21 }, crossfade: 0.06, fadeOut: 1.7 };

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

/** Runs ffmpeg with `args`, resolving when it exits cleanly. */
function ffmpeg(args, stdin) {
  const proc = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: [stdin ? 'pipe' : 'ignore', 'inherit', 'inherit'] });
  proc.done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  return proc;
}

/** Cuts the music track to the picture (see EDIT) into a WAV file, limited to peaks of -2 dBFS. */
function cutMusic(track, wav, duration) {
  const { lead, jump, crossfade: x, fadeOut } = EDIT;
  const ms = (s) => Math.round(s * 1000);
  const first = jump.at - lead; // where the opening leaves the track
  const graph =
    `[0:a]aresample=48000,asplit=2[a][b];` +
    `[a]atrim=end=${first + x / 2},asetpts=PTS-STARTPTS,afade=t=out:st=${first - x / 2}:d=${x},adelay=${ms(lead)}:all=1[s1];` +
    `[b]atrim=start=${jump.from - x / 2}:end=${jump.from + duration - jump.at + 0.1},asetpts=PTS-STARTPTS,afade=t=in:d=${x},adelay=${ms(jump.at - x / 2)}:all=1[s2];` +
    `[s1][s2]amix=inputs=2:normalize=0,afade=t=out:st=${duration - fadeOut}:d=${fadeOut},` +
    `volume=-1dB,alimiter=limit=0.79:attack=5:release=50:level=0,apad,atrim=end=${duration}`;
  return ffmpeg(['-i', track, '-filter_complex', graph, '-c:a', 'pcm_s16le', wav]).done;
}

async function record(page, music) {
  const duration = await page.evaluate(() => window.DURATION);
  const frames = Math.round(duration * FPS);
  const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rackplanner-')), 'soundtrack.wav');
  if (music) await cutMusic(music, wav, duration);
  else fs.writeFileSync(wav, Buffer.from(await page.evaluate(() => window.soundtrack()), 'base64'));
  const encoder = ffmpeg(
    ['-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-i', wav,
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', OUT,
      '-map', '0:v', '-map', '1:a', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus', '-b:a', '128k', WEBM],
    true
  );
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.seek(t), i / FPS);
    await write(encoder.stdin, await page.screenshot({ type: 'png' }));
    if (i % FPS === 0) process.stdout.write(`\r${i / FPS}/${duration} s`);
  }
  encoder.stdin.end();
  await encoder.done;
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
  const m = process.argv.indexOf('--music');
  const music = m > 0 ? path.resolve(process.argv[m + 1]) : null;
  if (music && !fs.existsSync(music)) throw new Error(`No music track at ${music}`);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'e2e', 'serve.js'), String(PORT)], { stdio: 'inherit' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: SIZE });
    await page.goto(`http://127.0.0.1:${PORT}/media/intro.html?render`);
    await page.waitForFunction(() => window.introReady === true);
    if (at > 0) for (const t of process.argv[at + 1].split(',')) await still(page, Number(t));
    else await record(page, music);
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
