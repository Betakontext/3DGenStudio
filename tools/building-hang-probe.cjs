// Finds which interaction freezes the plan editor.
//
//   node server.js &
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tools/building-hang-probe.cjs
//
// A frozen main thread cannot answer executeJavaScript, so responsiveness is the
// measurement: after each click, ask the page a trivial question with a timeout.
// The first click that stops answering is the one that hangs, and the log says
// which kind of click it was.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-hang');
const RESPOND_MS = Number(process.env.PROBE_TIMEOUT || 5000);

const logs = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(line) { logs.push(line); process.stdout.write(`${line}\n`); }

// Resolves false when the renderer does not answer in time.
async function responsive(win) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), RESPOND_MS); });
  const ask = win.webContents.executeJavaScript('1+1').then(v => v === 2).catch(() => false);
  const ok = await Promise.race([ask, timeout]);
  clearTimeout(timer);
  return ok;
}

async function click(win, x, y, { double = false } = {}) {
  const at = { x: Math.round(x), y: Math.round(y) };
  win.webContents.sendInputEvent({ type: 'mouseMove', ...at });
  await sleep(30);
  for (let i = 1; i <= (double ? 2 : 1); i++) {
    win.webContents.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: i });
    await sleep(20);
    win.webContents.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: i });
    await sleep(30);
  }
}

// A slow drag, the way a hand moves: many pointermove events with the button
// held. This is the interaction that commits to the document on every frame, so
// it is where per-move cost shows up - a click never exercises it.
async function drag(win, from, to, steps = 24) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x), y: Math.round(from.y) });
  await sleep(40);
  win.webContents.sendInputEvent({
    type: 'mouseDown', x: Math.round(from.x), y: Math.round(from.y), button: 'left', clickCount: 1,
  });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
      button: 'left', buttons: 1,
    });
    await sleep(16);
  }
  win.webContents.sendInputEvent({
    type: 'mouseUp', x: Math.round(to.x), y: Math.round(to.y), button: 'left', clickCount: 1,
  });
}

async function step(win, label, fn) {
  log(`\n>>> ${label}`);
  try { await fn(); } catch (err) { log(`    threw: ${err.message}`); }
  await sleep(400);
  const t0 = Date.now();
  const alive = await responsive(win);
  const latency = Date.now() - t0;
  log(`    responsive: ${alive ? `YES (${latency}ms)` : '*** NO - FROZEN HERE ***'}`);
  if (alive && latency > 250) log(`    *** SLUGGISH: ${latency}ms to answer 1+1`);
  if (!alive) {
    try {
      const image = await Promise.race([
        win.webContents.capturePage(),
        new Promise(r => setTimeout(() => r(null), 3000)),
      ]);
      if (image) {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'frozen.png'), image.toPNG());
        log('    captured frozen.png');
      }
    } catch { /* the GPU process may be fine even when the renderer is not */ }
  }
  return alive;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: true });

  win.webContents.on('render-process-gone', (_e, details) =>
    log(`RENDERER GONE: ${JSON.stringify(details)}`));
  win.webContents.on('unresponsive', () => log('EVENT: unresponsive'));
  win.webContents.on('responsive', () => log('EVENT: responsive again'));
  win.webContents.on('console-message', (_e, level, message) => {
    if (/Maximum update depth|Uncaught|RangeError|out of memory/i.test(message)) {
      log(`CONSOLE[${level}] ${message.slice(0, 300)}`);
    }
  });

  await win.loadURL(`${BASE}/buildings`);
  await sleep(2500);
  await win.webContents.executeJavaScript(
    `(() => { try { Object.keys(localStorage).filter(k => k.startsWith('building:draft:')).forEach(k => localStorage.removeItem(k)); } catch {} return true })()`,
  ).catch(() => {});
  await win.webContents.reload();
  await sleep(3000);

  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.buildinggen__tab')].find(b => /Plan/.test(b.textContent))?.click()`,
  );
  await sleep(900);

  const rect = JSON.parse(await win.webContents.executeJavaScript(
    `JSON.stringify((() => { const c = document.querySelector('.planedit__canvas'); const b = c.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })())`,
  ));
  log(`canvas ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.w)}x${Math.round(rect.h)}`);

  // Where the plan's corners are on screen, so a click can be aimed at one.
  const corners = JSON.parse(await win.webContents.executeJavaScript(
    `JSON.stringify((() => {
      const r = document.querySelector('.planedit__canvas').getBoundingClientRect();
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, r };
    })())`,
  ));
  const cx = corners.cx;
  const cy = corners.cy;

  // The default plan is fitted, so it spans most of the canvas. These aim at the
  // parts of it that take different code paths.
  const probes = [
    ['click empty background (deselect / maybe-pan)', () => click(win, rect.x + 30, rect.y + 30)],
    ['click the middle of the plan (inside, no hit)', () => click(win, cx, cy)],
    ['click a plan EDGE (inserts a corner)', () => click(win, cx, rect.y + rect.h * 0.12)],
    ['click a plan CORNER (selects)', () => click(win, rect.x + rect.w * 0.1, rect.y + rect.h * 0.12)],
    ['arm Outline', async () => {
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('.planedit__tool')].find(b => /Outline/.test(b.textContent))?.click()`,
      );
    }],
    ['place first corner while drawing', () => click(win, cx - 150, cy - 100)],
    ['place second corner', () => click(win, cx + 150, cy - 100)],
    ['place third corner', () => click(win, cx + 150, cy + 100)],
    ['finish with a double-click', () => click(win, cx - 150, cy + 100, { double: true })],
    ['click after finishing', () => click(win, cx, cy)],
    // The real test: dragging commits on every move.
    ['DRAG a corner across the canvas', async () => {
      const from = { x: rect.x + rect.w * 0.1, y: rect.y + rect.h * 0.12 };
      await drag(win, from, { x: cx, y: cy }, 30);
    }],
    ['DRAG a corner back', async () => {
      await drag(win, { x: cx, y: cy }, { x: rect.x + rect.w * 0.15, y: rect.y + rect.h * 0.2 }, 30);
    }],
    ['DRAG the background (pan)', async () => {
      await drag(win, { x: rect.x + 40, y: rect.y + rect.h - 40 },
        { x: rect.x + 240, y: rect.y + rect.h - 140 }, 30);
    }],
  ];

  for (const [label, fn] of probes) {
    const alive = await step(win, label, fn);
    if (!alive) { log('\nSTOPPING: the renderer is frozen.'); break; }
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'hang.log'), logs.join('\n'));
  log(`\nwrote ${OUT}`);
  app.quit();
}).catch(err => { console.error('probe failed:', err); app.quit(); });
