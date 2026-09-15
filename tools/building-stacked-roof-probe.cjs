// Two chained Roof nodes: a stepped platform capped with a hip - a temple.
//
// Browser-only because the thing under test is what the SECOND Roof node does
// to the first, and that is a graph edit made through the UI. The headless
// tests cover stackRoofs; this covers the node actually being insertable, the
// row being distinguishable, and the result being one continuous roof.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-stacked');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const rows = `[...document.querySelectorAll('.buildinggen__node')]`;
const selectNth = (label, n) => `${rows}
  .filter(b => new RegExp('${label}').test(b.textContent))[${n}]?.click()`;
const addNode = label => `[...document.querySelectorAll('.buildinggen__add-btn')]
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
  await sleep(3500);
  fs.mkdirSync(OUT, { recursive: true });
  const shot = async n => {
    // Capture once and throw it away first: capturePage returns the last
    // composited frame, so a shot taken straight after a React commit shows the
    // PREVIOUS state - which made every screenshot in this run lag one step.
    try { await win.webContents.capturePage(); } catch { /* the retry below covers it */ }
    await sleep(900);
    for (let i = 1; i <= 4; i++) {
      try { fs.writeFileSync(path.join(OUT, `${n}.png`), (await win.webContents.capturePage()).toPNG()); console.log(`shot ${n}`); return; }
      catch { await sleep(700); }
    }
    console.log(`GAVE UP ${n}`);
  };
  const js = src => win.webContents.executeJavaScript(src);
  const stats = async () => JSON.parse(await js(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__stats > div')].map(d => d.textContent.trim())) `));
  const nodeList = async () => JSON.parse(await js(`JSON.stringify(${rows}.map(b => b.textContent.trim()))`));
  const diags = async () => JSON.parse(await js(
    `JSON.stringify([...document.querySelectorAll('.bdiag__item, .buildinggen__diag')].map(d => d.textContent.trim()).slice(0, 8))`));

  console.log('nodes:', (await nodeList()).join(' | '));

  await js(selectNth('Mass', 0));
  await sleep(300);
  console.log('storeys=', await js(setNumber('Storeys', 2)));
  await sleep(700);

  // Roof 1: a stepped platform, stopped by a height cap so it ends on a tread.
  await js(selectNth('Roof', 0));
  await sleep(300);
  console.log('roof1 shape=', await js(setSelect('Shape', 'stepped')));
  await sleep(400);
  console.log('  step depth=', await js(setNumber('Step depth', 1)));
  await sleep(250);
  console.log('  step rise=', await js(setNumber('Step rise', 0.8)));
  await sleep(250);
  console.log('  cap=', await js(setNumber('Height cap', 2)));
  await sleep(900);
  await shot('1-platform-only');
  console.log('  stats:', (await stats()).join(' / '));

  // Roof 2: the hip cap that makes it a temple.
  console.log('add roof:', await js(addNode('Roof')));
  await sleep(900);
  console.log('nodes:', (await nodeList()).join(' | '));

  await js(selectNth('Roof', 1));
  await sleep(300);
  console.log('roof2 shape=', await js(setSelect('Shape', 'hip')));
  await sleep(300);
  console.log('  pitch=', await js(setNumber('Pitch', 45)));
  await sleep(1100);
  await shot('2-temple');
  console.log('  stats:', (await stats()).join(' / '));
  console.log('  diags:', (await diags()).join(' // '));

  // And the refusal: put the cap under the ridge instead - roof 1 back to hip,
  // uncapped, so it closes and roof 2 has nothing to stand on.
  await js(selectNth('Roof', 0));
  await sleep(300);
  console.log('roof1 shape=', await js(setSelect('Shape', 'hip')));
  await sleep(400);
  console.log('  cap=', await js(setNumber('Height cap', 0)));
  await sleep(1100);
  await shot('3-refused-on-ridge');
  console.log('  stats:', (await stats()).join(' / '));
  console.log('  diags:', (await diags()).join(' // '));

  // A pagoda: tiered on tiered, which is the same-shape case.
  await js(setSelect('Shape', 'tiered'));
  await sleep(300);
  console.log('  cap=', await js(setNumber('Height cap', 3)));
  await sleep(400);
  await js(selectNth('Roof', 1));
  await sleep(300);
  console.log('roof2 shape=', await js(setSelect('Shape', 'tiered')));
  await sleep(1100);
  await shot('4-pagoda');
  console.log('  stats:', (await stats()).join(' / '));

  app.quit();
}).catch(e => { console.error(e); app.quit(); });
