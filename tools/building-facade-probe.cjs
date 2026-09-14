// Screenshots the facade: the Phase 2 deliverable.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-facade');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const selectNode = label => `[...document.querySelectorAll('.buildinggen__node')]
  .find(b => /${label}/.test(b.textContent))?.click()`;
const setNumber = (label, value) => `(() => {
  const row = [...document.querySelectorAll('.binspect__row')].find(r => /${label}/.test(r.textContent));
  const input = row && row.querySelector('input[type=number]');
  if (!input) return 'no input for ${label}';
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  s.call(input, '${value}');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.blur();
  return input.value;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: true });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 || /Error|error|Cannot|undefined|THREE/.test(message)) {
      console.log(`CONSOLE[${level}] ${String(message).slice(0, 400)}`);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('GONE', JSON.stringify(d)));
  await win.loadURL(`${BASE}/buildings`);
  await sleep(2500);
  await win.webContents.executeJavaScript(
    `(() => { try { Object.keys(localStorage).filter(k => k.startsWith('building:draft:')).forEach(k => localStorage.removeItem(k)); } catch {} return true })()`,
  ).catch(() => {});
  await win.webContents.reload();
  await sleep(3200);
  fs.mkdirSync(OUT, { recursive: true });

  const shot = async name => {
    for (let i = 1; i <= 4; i++) {
      try {
        fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
        console.log(`shot ${name}`); return;
      } catch { await sleep(700); }
    }
    console.log(`GAVE UP on ${name}`);
  };

  const stats = async () => JSON.parse(await win.webContents.executeJavaScript(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__stats > div')].map(d => d.textContent.trim()))`,
  ));

  console.log('nodes:', await win.webContents.executeJavaScript(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__node')].map(b => b.textContent.trim()))`,
  ));
  await shot('1-default-facade');
  console.log('stats:', (await stats()).join(' / '));

  // A taller, wider building so the bay snapping is visible.
  await win.webContents.executeJavaScript(selectNode('Mass'));
  await sleep(400);
  console.log('storeys=', await win.webContents.executeJavaScript(setNumber('Storeys', 6)));
  await sleep(1200);
  await shot('2-six-storeys');
  console.log('stats:', (await stats()).join(' / '));

  // Change the bay width: the count should snap, not leave a stub.
  await win.webContents.executeJavaScript(selectNode('Facade'));
  await sleep(400);
  console.log('bay=', await win.webContents.executeJavaScript(setNumber('Bay width', 2)));
  await sleep(1200);
  await shot('3-narrow-bays');
  console.log('stats:', (await stats()).join(' / '));
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
