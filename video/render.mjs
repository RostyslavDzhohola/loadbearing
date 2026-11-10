// Capture video/video.html frame by frame and mux it with the synthesized soundtrack.
//   node render.mjs [out.mp4] [--stats "1.2M tokens · $4.10"] [--stills 5,14,26]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { serve, CHROME } from './serve.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const stats = flag('--stats'), stills = flag('--stills');
const out = resolve(args[0] || 'out/loadbearing.mp4');
const FPS = 60, TAIL = 2.6;
await mkdir(dirname(out), { recursive: true });

const { server, url } = await serve(new URL('..', import.meta.url).pathname);
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));
await page.goto(`${url}/video/video.html${stats ? '?stats=' + encodeURIComponent(stats) : ''}`);
await page.waitForFunction('window.ready');

if (stills) { // quick look: a few frames as PNGs, no video
  for (const sec of stills.split(',').map(Number)) {
    const n = Math.round(sec * FPS);
    await page.evaluate((n) => { for (let i = window.__n || 0; i <= n; i += 1) window.renderFrame(i); window.__n = n; }, n);
    await page.screenshot({ path: `${dirname(out)}/still-${sec}.png` });
  }
} else {
  const silent = out.replace(/\.mp4$/, '.silent.mp4'), wav = out.replace(/\.mp4$/, '.wav');
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart', silent], { stdio: ['pipe', 'inherit', 'inherit'] });
  let end = Infinity, n = 0;
  for (; n < end; n++) {
    const info = await page.evaluate((n) => window.renderFrame(n), n);
    if (end === Infinity && info.arrivedAt !== null) end = n + Math.round(TAIL * FPS);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 97 });
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r));
    if (n % 300 === 0) console.log(`frame ${n} · sim ${info.t.toFixed(1)}s · ${info.percent}%`);
    if (n > 60 * 60) throw new Error('never arrived');
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  const seconds = n / FPS;
  await writeFile(wav, Buffer.from(await page.evaluate((s) => window.renderAudio(s), seconds), 'base64'));
  await new Promise((r) => spawn('ffmpeg', ['-v', 'error', '-y', '-i', silent, '-i', wav, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out], { stdio: 'inherit' }).on('close', r));
  console.log(`done: ${out} · ${n} frames · ${seconds.toFixed(1)}s`);
}
await browser.close();
server.close();
