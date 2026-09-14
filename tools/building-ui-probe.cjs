// Drives the Building Generator's plan editor with REAL input events, in the
// Chromium that Electron already ships.
//
//   node server.js &                              # serves dist/
//   npx electron tools/building-ui-probe.cjs      # writes probe-*.png + a log
//
// This exists because the plan editor is the one part of the generator that
// cannot be tested headlessly: every other layer is arithmetic over JSON, but
// "can the author actually draw a footprint" is a question about pointer
// capture, passive listeners and hit testing, and the only honest way to answer
// it is to click on the thing.
//
// sendInputEvent generates trusted mouse events, which Chromium promotes to
// pointer events - so the code under test takes exactly the path a person does.

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe');

const logs = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function shot(win, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
  log(`shot ${name}.png`);
}

function log(line) {
  logs.push(line);
  process.stdout.write(`${line}\n`);
}

async function click(win, x, y) {
  const at = { x: Math.round(x), y: Math.round(y) };
  win.webContents.sendInputEvent({ type: 'mouseMove', ...at });
  await sleep(25);
  win.webContents.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 });
  await sleep(25);
  win.webContents.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 });
  await sleep(60);
}

// Ask the page about itself. Everything here reads the DOM, so it needs no hook
// into React internals - which is the point: if the DOM does not show it, the
// author cannot see it either.
const PROBE = `(() => {
  const canvas = document.querySelector('.planedit__canvas');
  const rect = canvas ? canvas.getBoundingClientRect() : null;
  const tools = [...document.querySelectorAll('.planedit__tool')].map(b => ({
    text: b.textContent.trim().replace(/\\s+/g, ' '),
    on: b.classList.contains('planedit__tool--on'),
    disabled: b.disabled,
  }));
  const hint = document.querySelector('.planedit__hint');
  const readout = document.querySelector('.planedit__readout');
  const stats = [...document.querySelectorAll('.buildinggen__stats > div')]
    .map(d => d.textContent.trim().replace(/\\s+/g, ' '));
  return JSON.stringify({
    hasCanvas: !!canvas,
    rect: rect && { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    backing: canvas && { w: canvas.width, h: canvas.height },
    tools, stats,
    hint: hint ? hint.textContent.trim() : null,
    readout: readout ? readout.textContent.trim() : null,
  });
})()`;

async function probe(win, label) {
  const raw = await win.webContents.executeJavaScript(PROBE);
  const state = JSON.parse(raw);
  log(`\n--- ${label} ---`);
  log(`canvas ${state.hasCanvas ? 'present' : 'MISSING'} css=${state.rect && `${Math.round(state.rect.w)}x${Math.round(state.rect.h)}`} backing=${state.backing && `${state.backing.w}x${state.backing.h}`}`);
  log(`tools: ${state.tools.map(t => `${t.text}${t.on ? '[ON]' : ''}${t.disabled ? '[disabled]' : ''}`).join(' | ')}`);
  log(`hint: ${state.hint}`);
  log(`stats: ${state.stats.join(' / ')}`);
  return state;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600, height: 1000, show: true,
    webPreferences: { offscreen: false },
  });

  win.webContents.on('console-message', (_event, level, message, line, source) => {
    // Only what matters: the noise from a dev build would drown the signal.
    if (/preventDefault|Context Lost|Uncaught|Error|Warning/i.test(message)) {
      log(`CONSOLE[${level}] ${message} (${String(source).split('/').pop()}:${line})`);
    }
  });

  // Load FIRST. localStorage belongs to the page's origin, so touching it before
  // loadURL runs against about:blank - which throws a SecurityError and leaves
  // the renderer blank for the rest of the run.
  await win.loadURL(`${BASE}/buildings`);
  await sleep(2500);

  // A draft left by an earlier run pops a banner that shifts the whole layout
  // mid-probe, which moves the canvas out from under the precomputed clicks.
  const cleared = await win.webContents.executeJavaScript(
    `(() => { try { const k = Object.keys(localStorage).filter(x => x.startsWith('building:draft:')); k.forEach(x => localStorage.removeItem(x)); return k.length; } catch (e) { return 'ERR ' + e.message; } })()`,
  );
  log(`cleared ${cleared} stale draft(s)`);
  await win.webContents.reload();
  await sleep(3000);

  const ready = await win.webContents.executeJavaScript(
    `!!document.querySelector('.buildinggen') && document.querySelectorAll('.buildinggen__tab').length`,
  );
  log(`page ready: ${ready}`);
  await shot(win, '1-loaded');

  // The plan editor is behind the Plan tab.
  const tabs = await win.webContents.executeJavaScript(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__tab')].map(b => b.textContent.trim()))`,
  );
  log(`tabs: ${tabs}`);
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.buildinggen__tab')].find(b => /Plan/.test(b.textContent))?.click()`,
  );
  await sleep(900);
  const before = await probe(win, 'plan tab open');
  await shot(win, '2-plan');
  if (!before.hasCanvas) { log('NO CANVAS - stopping'); app.quit(); return; }

  const rectNow = async () => JSON.parse(await win.webContents.executeJavaScript(
    `JSON.stringify((() => { const c = document.querySelector('.planedit__canvas'); const b = c.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })())`,
  ));
  let r = before.rect;
  let cx = r.x + r.w / 2;
  let cy = r.y + r.h / 2;

  // 1. Does the Outline button actually enter drawing mode?
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.planedit__tool')].find(b => /Outline/.test(b.textContent))?.click()`,
  );
  await sleep(400);
  const drawingState = await probe(win, 'after clicking Outline');
  await shot(win, '3-outline-armed');

  // 2. Place four corners well inside the canvas.
  r = await rectNow();
  cx = r.x + r.w / 2;
  cy = r.y + r.h / 2;
  log(`canvas at click time: ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`);
  const pts = [
    [cx - 220, cy - 160],
    [cx + 220, cy - 160],
    [cx + 220, cy + 160],
    [cx - 220, cy + 160],
  ];
  for (let i = 0; i < pts.length; i++) {
    await click(win, pts[i][0], pts[i][1]);
    log(`placed corner ${i + 1} at ${Math.round(pts[i][0])},${Math.round(pts[i][1])}`);
  }
  await sleep(300);
  await probe(win, 'after four clicks');
  await shot(win, '4-four-corners');

  // 3. Finish with a double-click.
  //
  // NOT by clicking the first corner: grid snapping moves a placed corner up to
  // half a grid cell from the pixel that was clicked - about 20px at this zoom -
  // which is outside the 9px close radius. A person clicks the dot they can see;
  // a probe replaying stored pixels cannot, so it uses the other documented way
  // to finish.
  const dbl = { x: Math.round(pts[3][0]), y: Math.round(pts[3][1]) };
  win.webContents.sendInputEvent({ type: 'mouseMove', ...dbl });
  await sleep(40);
  for (const clickCount of [1, 2]) {
    win.webContents.sendInputEvent({ type: 'mouseDown', ...dbl, button: 'left', clickCount });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...dbl, button: 'left', clickCount });
    await sleep(40);
  }
  await sleep(600);
  const after = await probe(win, 'after closing the loop');
  await shot(win, '5-closed');

  // 4. Did the document actually change? The stats panel is the observable.
  log(`\nfootprint before: ${before.stats.find(s => /Footprint/.test(s))}`);
  log(`footprint after:  ${after.stats.find(s => /Footprint/.test(s))}`);

  // 5. Zoom. The readout is in plan metres, so if the view really changed the
  //    same screen point now names a different plan coordinate.
  const sampleX = Math.round(cx + 240);
  const sampleY = Math.round(cy);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: sampleX, y: sampleY });
  await sleep(150);
  const beforeZoom = (await probe(win, 'before wheel')).readout;
  for (let i = 0; i < 4; i++) {
    win.webContents.sendInputEvent({
      type: 'mouseWheel', x: Math.round(cx), y: Math.round(cy),
      deltaX: 0, deltaY: -120, canScroll: true,
    });
    await sleep(120);
  }
  win.webContents.sendInputEvent({ type: 'mouseMove', x: sampleX, y: sampleY });
  await sleep(300);
  const afterZoom = (await probe(win, 'after wheel zoom')).readout;
  await shot(win, '6-after-wheel');
  log(`ZOOM  readout at the same pixel: ${beforeZoom} -> ${afterZoom}  ${beforeZoom === afterZoom ? 'UNCHANGED (zoom broken)' : 'CHANGED (zoom works)'}`);

  // 6. Pan by left-dragging empty background.
  const panFrom = { x: Math.round(r.x + 80), y: Math.round(r.y + 80) };
  win.webContents.sendInputEvent({ type: 'mouseMove', ...panFrom });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...panFrom, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    win.webContents.sendInputEvent({
      type: 'mouseMove', x: panFrom.x + i * 20, y: panFrom.y + i * 12, button: 'left', buttons: 1,
    });
    await sleep(40);
  }
  win.webContents.sendInputEvent({
    type: 'mouseUp', x: panFrom.x + 120, y: panFrom.y + 72, button: 'left', clickCount: 1,
  });
  await sleep(300);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: sampleX, y: sampleY });
  await sleep(300);
  const afterPan = (await probe(win, 'after left-drag pan')).readout;
  await shot(win, '7-after-pan');
  log(`PAN   readout at the same pixel: ${afterZoom} -> ${afterPan}  ${afterZoom === afterPan ? 'UNCHANGED (pan broken)' : 'CHANGED (pan works)'}`);

  // 7. Tab-switch churn: does the WebGL context survive?
  for (let i = 0; i < 6; i++) {
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.buildinggen__tab')].find(b => /Preview/.test(b.textContent))?.click()`,
    );
    await sleep(250);
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.buildinggen__tab')].find(b => /Plan/.test(b.textContent))?.click()`,
    );
    await sleep(250);
  }
  log('completed 6 tab round-trips (watch for Context Lost above)');
  await shot(win, '8-after-tab-churn');

  // 8. The 3D preview, which is what the framing fix is about.
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.buildinggen__tab')].find(b => /Preview/.test(b.textContent))?.click()`,
  );
  await sleep(1200);
  await shot(win, '9-preview');

  // And with a batter profile, so a non-trivial mass is on screen too.
  const modeSet = await win.webContents.executeJavaScript(`(() => {
    const sel = [...document.querySelectorAll('.binspect__select')][0];
    if (!sel) return 'no select';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'batter');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
  })()`);
  log(`profile mode -> ${modeSet}`);
  await sleep(500);
  const amountSet = await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.binspect__row')].find(r => /Profile amount/.test(r.textContent));
    const input = row && row.querySelector('input[type=number]');
    if (!input) return 'no input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '2.5');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    return input.value;
  })()`);
  log(`profile amount -> ${amountSet}`);
  await sleep(1500);
  await shot(win, '10-preview-batter');
  await probe(win, 'batter applied');

  fs.writeFileSync(path.join(OUT, 'probe.log'), logs.join('\n'));
  log(`\nwrote ${OUT}`);
  app.quit();
}).catch(err => {
  console.error('probe failed:', err);
  app.quit();
});
