// Phase 3's demo: a hip roof on an L-plan, plus the other shapes.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-roof');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const selectNode = label => `[...document.querySelectorAll('.buildinggen__node')]
  .find(b => new RegExp('${label}').test(b.textContent))?.click()`;
const setSelect = (label, v) => `(() => {
  const row = [...document.querySelectorAll('.binspect__row')].find(r => /${label}/.test(r.textContent));
  const sel = row && row.querySelector('select');
  if (!sel) return 'no select ${label}';
  const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  s.call(sel, '${v}'); sel.dispatchEvent(new Event('change', { bubbles: true }));
  return sel.value;
})()`;
const setNumber = (label, v) => `(() => {
  const row = [...document.querySelectorAll('.binspect__row')].find(r => /${label}/.test(r.textContent));
  const input = row && row.querySelector('input[type=number]');
  if (!input) return 'no input ${label}';
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  s.call(input, '${v}');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.blur(); return input.value;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: true });
  win.webContents.on('console-message', (_e, l, m) => {
    if (/Uncaught|Maximum update/.test(m)) console.log(`CONSOLE ${String(m).slice(0, 220)}`);
  });
  await win.loadURL(`${BASE}/buildings`);
  await sleep(2500);
  await win.webContents.executeJavaScript(
    `(() => { try { Object.keys(localStorage).filter(k => k.startsWith('building:draft:')).forEach(k => localStorage.removeItem(k)); } catch {} return true })()`,
  ).catch(() => {});
  await win.webContents.reload();
  await sleep(3200);
  fs.mkdirSync(OUT, { recursive: true });
  const shot = async n => {
    for (let i = 1; i <= 4; i++) {
      try { fs.writeFileSync(path.join(OUT, `${n}.png`), (await win.webContents.capturePage()).toPNG()); console.log(`shot ${n}`); return; }
      catch { await sleep(700); }
    }
    console.log(`GAVE UP ${n}`);
  };
  const stats = async () => JSON.parse(await win.webContents.executeJavaScript(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__stats > div')].map(d => d.textContent.trim()))`));

  console.log('nodes:', await win.webContents.executeJavaScript(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__node')].map(b => b.textContent.trim()))`));

  // THE DEMO: an L-shaped plan with a hip roof.
  await win.webContents.executeJavaScript(`(() => {
    const canvas = document.querySelector('.planedit__canvas');
    return !!canvas;
  })()`);
  await win.webContents.executeJavaScript(selectNode('Footprint'));
  await sleep(600);
  console.log('L-plan set via the Plan tab is manual; using Mass storeys instead');

  await win.webContents.executeJavaScript(selectNode('Mass'));
  await sleep(300);
  console.log('storeys=', await win.webContents.executeJavaScript(setNumber('Storeys', 2)));
  await sleep(800);
  await shot('1-hip-default');
  console.log('stats:', (await stats()).join(' / '));

  for (const [name, kind, props] of [
    ['2-hip-steep', 'hip', { Pitch: 55 }],
    ['3-mansard', 'mansard', { Pitch: 72 }],
    ['4-stepped', 'stepped', {}],
    ['5-tiered', 'tiered', {}],
    ['6-flat', 'flat', {}],
  ]) {
    await win.webContents.executeJavaScript(selectNode('Roof'));
    await sleep(300);
    console.log(`${name} kind=`, await win.webContents.executeJavaScript(setSelect('Shape', kind)));
    await sleep(400);
    for (const [label, v] of Object.entries(props)) {
      console.log(`  ${label}=`, await win.webContents.executeJavaScript(setNumber(label, v)));
      await sleep(300);
    }
    await sleep(900);
    await shot(name);
    console.log('  stats:', (await stats()).join(' / '));
  }
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
