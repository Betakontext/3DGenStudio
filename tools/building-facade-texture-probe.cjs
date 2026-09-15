// Per-facade and per-side textures, driven through the real UI.
//
// The headless tests prove the resolution chain. What they cannot show is
// whether the split actually reaches the GPU: walls are one geometry with draw
// groups now, and a mistake there paints the whole building in whichever
// material happened to be first - which looks like the override never applied.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pickStyle } = require('./building-probe-style.cjs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-facade-tex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: true });
  win.webContents.on('console-message', (_e, l, m) => {
    if (/Uncaught|Building texture|Maximum update/.test(m)) {
      console.log(`CONSOLE ${String(m).slice(0, 200)}`);
    }
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
      try { await win.webContents.capturePage(); } catch { /* the retry covers it */ }
      await sleep(1100);
    }
    try {
      fs.writeFileSync(path.join(OUT, `${n}.png`), (await win.webContents.capturePage()).toPNG());
      console.log(`shot ${n}`);
    } catch { console.log(`GAVE UP ${n}`); }
  };

  /** Bind the nth image in the library to whichever picker is open. */
  const pickNth = async n => {
    await sleep(2200);
    const picked = await js(`(() => {
      const cards = [...document.querySelectorAll('.asset-selector-card')];
      if (cards.length <= ${n}) return 'only ' + cards.length + ' cards';
      cards[${n}].click();
      return cards[${n}].textContent.trim().slice(0, 34);
    })()`);
    await sleep(700);
    await js(`[...document.querySelectorAll('.asset-selector-footer button')]
      .find(b => !/cancel|close/i.test(b.textContent))?.click()`);
    await sleep(2500);
    return picked;
  };

  await js(`${pickStyle('Roman')}`);
  await sleep(1500);
  await js(`document.querySelector('.buildinggen__tab:nth-child(2)')?.click()`);
  await sleep(800);

  // 1. A building-wide wall texture.
  await js(`[...document.querySelectorAll('.btex__slot')][0]
    ?.querySelectorAll('.btex__buttons button')[1]?.click()`);
  console.log('building-wide wall:', await pickNth(0));
  await shot('1-building-wide');

  // 2. Select the ground-floor Facade and give it its own wall texture.
  console.log('nodes:', await js(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__node')].map(b => b.textContent.trim()))`));
  await js(`[...document.querySelectorAll('.buildinggen__node')]
    .find(b => /Facade/.test(b.textContent) && /ground/.test(b.textContent))?.click()`);
  await sleep(1200);
  console.log('inspector texture rows:', await js(
    `JSON.stringify([...document.querySelectorAll('.binspect__section--textures .btex__slot')]
      .map(s => s.textContent.trim().slice(0, 40)))`));

  await js(`document.querySelector('.binspect__section--textures .btex__slot .btex__buttons button:nth-child(2)')?.click()`);
  console.log('ground-floor wall:', await pickNth(1));
  await shot('2-ground-override');

  // 3. Open the per-side rows and override one side of that facade.
  console.log('sides toggle:', await js(`(() => {
    const button = document.querySelector('.binspect__sides-toggle');
    if (!button) return 'missing';
    button.click();
    return button.textContent.trim();
  })()`));
  await sleep(900);
  const rows = await js(
    `JSON.stringify([...document.querySelectorAll('.binspect__section--textures .btex__slot')]
      .map(s => s.textContent.trim().slice(0, 34)))`);
  console.log('rows with sides:', rows);

  // The south row of the Wall group: rows are Wall, N, E, S, W, Windows, N...
  await js(`[...document.querySelectorAll('.binspect__section--textures .btex__slot')][3]
    ?.querySelectorAll('.btex__buttons button')[1]?.click()`);
  console.log('south side:', await pickNth(2));
  await shot('3-side-override');

  console.log('final rows:', await js(
    `JSON.stringify([...document.querySelectorAll('.binspect__section--textures .btex__slot')]
      .map(s => s.textContent.trim().slice(0, 46)))`));

  app.quit();
}).catch(e => { console.error(e); app.quit(); });
