// The reported bug: with Deform -> Lean the walls leaned and the windows stayed
// vertical. Drives the real controls and reads the picture back.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-lean');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    if (/Uncaught/.test(m)) console.log(`CONSOLE ${String(m).slice(0, 200)}`);
  });
  await win.loadURL(`${BASE}/buildings`);
  await sleep(2500);
  await win.webContents.executeJavaScript(
    `(() => { try { Object.keys(localStorage).filter(k => k.startsWith('building:draft:')).forEach(k => localStorage.removeItem(k)); } catch {} return true })()`,
  ).catch(() => {});
  await win.webContents.reload();
  await sleep(3500);
  fs.mkdirSync(OUT, { recursive: true });

  const js = src => win.webContents.executeJavaScript(src);
  const shot = async n => {
    for (let i = 0; i < 2; i++) {
      try { await win.webContents.capturePage(); } catch { /* retry below */ }
      await sleep(1100);
    }
    try {
      fs.writeFileSync(path.join(OUT, `${n}.png`), (await win.webContents.capturePage()).toPNG());
      console.log(`shot ${n}`);
    } catch { console.log(`GAVE UP ${n}`); }
  };

  await js(`[...document.querySelectorAll('.bstyle__item')].find(b => /Roman/.test(b.textContent))?.click()`);
  await sleep(1500);
  await js(`document.querySelector('.buildinggen__tab:nth-child(2)')?.click()`);
  await sleep(800);

  // Three storeys so the lean is obvious, then a Deform set to Lean.
  await js(`[...document.querySelectorAll('.buildinggen__node')].find(b => /Mass/.test(b.textContent))?.click()`);
  await sleep(700);
  console.log('storeys=', await js(setNumber('Storeys', 3)));
  await sleep(900);

  // Select the LAST node before the Output: a node is spliced in after the
  // selected one, and the Output has no output port to splice after.
  await js(`(() => {
    const rows = [...document.querySelectorAll('.buildinggen__node')];
    rows[rows.length - 2]?.click();
  })()`);
  await sleep(600);
  console.log('add buttons:', await js(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__add-btn')].map(b => b.textContent.trim()))`));
  await js(`[...document.querySelectorAll('.buildinggen__add-btn')].find(b => /Deform/.test(b.textContent))?.click()`);
  await sleep(1200);
  console.log('nodes:', await js(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__node')].map(b => b.textContent.trim()))`));

  await js(`[...document.querySelectorAll('.buildinggen__node')].find(b => /Deform/.test(b.textContent))?.click()`);
  await sleep(800);
  for (const [file, warp, amount] of [
    ['1-lean', 'lean', 6],
    ['2-sag-small', 'sag', 1],
    ['3-sag-large', 'sag', 6],
    ['4-twist', 'twist', 40],
    ['5-bend', 'bend', 5],
  ]) {
    console.log(`${file}: warp=`, await js(setSelect('Warp', warp)));
    await sleep(700);
    console.log('  amount=', await js(setNumber('Amount', amount)));
    await sleep(1500);
    await shot(file);
  }

  app.quit();
}).catch(e => { console.error(e); app.quit(); });
