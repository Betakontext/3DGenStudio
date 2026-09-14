// Proves per-floor customisation: add a second Facade, set it to the ground
// floor, and check the upper storeys are untouched.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-floors');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const clickNode = i => `[...document.querySelectorAll('.buildinggen__node')][${i}]?.click()`;
const clickNthFacade = n => `(() => {
  const rows = [...document.querySelectorAll('.buildinggen__node')].filter(b => /Facade/.test(b.textContent));
  rows[${n}]?.click();
  return rows.length;
})()`;
const clickAdd = label => `[...document.querySelectorAll('.buildinggen__add-btn')]
  .find(b => /${label}/.test(b.textContent))?.click()`;
const setSelect = (label, value) => `(() => {
  const row = [...document.querySelectorAll('.binspect__row')].find(r => /${label}/.test(r.textContent));
  const sel = row && row.querySelector('select');
  if (!sel) return 'no select ${label}';
  const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  s.call(sel, '${value}'); sel.dispatchEvent(new Event('change', { bubbles: true }));
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
const nodeList = `JSON.stringify([...document.querySelectorAll('.buildinggen__node')].map(b => b.textContent.trim()))`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: true });
  win.webContents.on('console-message', (_e, l, m) => {
    if (/Uncaught|Maximum update/.test(m)) console.log(`CONSOLE ${m.slice(0, 200)}`);
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
  };

  // A 5-storey building so the override is obvious.
  await win.webContents.executeJavaScript(clickNode(1));
  await sleep(300);
  console.log('storeys=', await win.webContents.executeJavaScript(setNumber('Storeys', 5)));
  await sleep(900);

  // Select the Facade, then add a second one after it.
  await win.webContents.executeJavaScript(clickNode(2));
  await sleep(300);
  console.log('palette=', await win.webContents.executeJavaScript(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__add-btn')].map(b => b.textContent.trim()))`));
  await win.webContents.executeJavaScript(clickAdd('Facade'));
  await sleep(700);
  console.log('nodes=', await win.webContents.executeJavaScript(nodeList));

  // The SECOND facade, by label - the list is in pipeline order now, but keying
  // on a fixed index would still silently select the wrong row if it changed.
  console.log('facades=', await win.webContents.executeJavaScript(clickNthFacade(1)));
  await sleep(400);
  console.log('storeysMode=', await win.webContents.executeJavaScript(setSelect('Storeys', 'ground')));
  await sleep(400);
  console.log('opening=', await win.webContents.executeJavaScript(setSelect('Opening', 'shopfront')));
  await sleep(400);
  console.log('bay=', await win.webContents.executeJavaScript(setNumber('Bay width', 6)));
  await sleep(400);
  console.log('winW=', await win.webContents.executeJavaScript(setNumber('Window width', 4.4)));
  await sleep(1400);
  console.log('nodes=', await win.webContents.executeJavaScript(nodeList));
  await shot('1-shopfront');
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
