// node recorder.mjs <outdir> — screenshot the CDP page as fast as it will go (~10–13 fps)
// until <outdir>/STOP exists. Writes <outdir>/times.txt: `<frame path> <epoch ms>` per frame,
// which make_video.py turns into a real-time, constant-frame-rate clip.
//
// Screenshots, not screen capture: it films only the page (no desktop, no notifications,
// no other windows), needs no Screen Recording permission, and works headless.
//
//   (node recorder.mjs rec/before > rec/before.log 2>&1 &); sleep 1.5
//   node before.mjs            # your scripted scenario (uses act.mjs, logs marks)
//   touch rec/before/STOP; sleep 2
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';

const out = path.resolve(process.argv[2] || 'frames');
fs.mkdirSync(out, { recursive: true });
fs.rmSync(`${out}/STOP`, { force: true });
const times = fs.createWriteStream(`${out}/times.txt`);
let n = 0; let c = null; const t0 = Date.now();
while (!fs.existsSync(`${out}/STOP`)) {
  try {
    c ??= await connect();
    const r = await Promise.race([
      c.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    const f = `${out}/f${String(n).padStart(5, '0')}.jpg`;
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    times.write(`${f} ${Date.now()}\n`); n++;
    await new Promise(r => setTimeout(r, 40));
  } catch {
    // the page reloads (e.g. a VS Code window reload) — reconnect and keep going
    try { c?.close(); } catch {}
    c = null; await new Promise(r => setTimeout(r, 300));
  }
}
times.end();
console.log(`frames ${n} in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
process.exit(0);
