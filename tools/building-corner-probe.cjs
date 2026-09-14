// Screenshots the 3D preview with Sharp vs Rounded corners, so the fix is looked
// at rather than assumed.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-corner');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const setSelect = (label, value) => `(() => {
  const row = [...document.querySelectorAll('.binspect__row')].find(r => /${label}/.test(r.textContent));
  const sel = row && row.querySelector('select');
  if (!sel) return 'no select for ${label}';
  const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  s.call(sel, '${value}'); sel.dispatchEvent(new Event('change', { bubbles: true }));
  return sel.value;
})()`;

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
  await win.loadURL(`${BASE}/buildings`);
  await sleep(2500);
  await win.webContents.executeJavaScript(
    `(() => { try { Object.keys(localStorage).filter(k => k.startsWith('building:draft:')).forEach(k => localStorage.removeItem(k)); } catch {} return true })()`,
  ).catch(() => {});
  await win.webContents.reload();
  await sleep(3000);
  fs.mkdirSync(OUT, { recursive: true });

  // capturePage intermittently rejects with UnknownVizError when the compositor
  // is mid-frame. Retrying is enough; it is a capture failure, not a page one.
  const shot = async name => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
        console.log(`shot ${name}`);
        return;
      } catch (err) {
        console.log(`  capture attempt ${attempt} failed: ${err.message}`);
        await sleep(700);
      }
    }
    console.log(`  GAVE UP on ${name}`);
  };

  for (const [name, profile, join, radius] of [
    ['4-curve-default', 'curve', 'miter', 0],
  ]) {
    console.log(`profile=${await win.webContents.executeJavaScript(setSelect('Profile', profile))}`);
    await sleep(300);
    console.log(`corners=${await win.webContents.executeJavaScript(setSelect('Corners', join))}`);
    await sleep(300);
    if (profile === 'batter') {
      console.log(`amount=${await win.webContents.executeJavaScript(setNumber('Profile amount', 2))}`);
      await sleep(300);
    }
    if (radius) {
      console.log(`radius=${await win.webContents.executeJavaScript(setNumber('Corner radius', radius))}`);
      await sleep(300);
    }
    await sleep(900);
    await shot(name);
    // Open the curve editor.
    const opened = await win.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.binspect__row')].find(r => /Profile curve/.test(r.textContent));
      const btn = row && row.querySelector('button');
      if (!btn) return 'no button';
      btn.click();
      return btn.textContent.trim();
    })()`);
    console.log(`curve button -> ${opened}`);
    await sleep(1200);
    await shot('5-curve-editor');
  }
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
