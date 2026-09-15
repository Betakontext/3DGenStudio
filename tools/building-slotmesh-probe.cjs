// Binding a real model into the window openings, instead of the placeholder box.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pickStyle } = require('./building-probe-style.cjs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-slotmesh');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: true });
  win.webContents.on('console-message', (_e, l, m) => {
    if (/Uncaught|Building slot mesh|Building texture/.test(m)) {
      console.log(`CONSOLE ${String(m).slice(0, 200)}`);
    }
  });
  await win.loadURL(`${BASE}/buildings`);
  await sleep(2500);
  await win.webContents.executeJavaScript(`(()=>{try{Object.keys(localStorage).filter(k=>k.startsWith('building:draft:')).forEach(k=>localStorage.removeItem(k))}catch{};return true})()`).catch(()=>{});
  await win.webContents.reload();
  await sleep(3500);
  fs.mkdirSync(OUT, { recursive: true });

  const js = src => win.webContents.executeJavaScript(src);
  const shot = async n => {
    for (let i = 0; i < 2; i++) {
      try { await win.webContents.capturePage(); } catch { /* retry below */ }
      await sleep(1200);
    }
    try {
      fs.writeFileSync(path.join(OUT, `${n}.png`), (await win.webContents.capturePage()).toPNG());
      console.log(`shot ${n}`);
    } catch { console.log(`GAVE UP ${n}`); }
  };

  await js(`${pickStyle('Roman')}`);
  await sleep(1600);
  await js(`document.querySelector('.buildinggen__tab:nth-child(2)')?.click()`);
  await sleep(800);

  // The Openings list is the SECOND BuildingTextures block in the sidebar.
  const sections = await js(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__title')].map(h => h.textContent.trim()))`);
  console.log('sidebar sections:', sections);
  console.log('opening rows:', await js(`(() => {
    const blocks = [...document.querySelectorAll('.btex')];
    const openings = blocks.find(b => /Openings/.test(b.querySelector('.buildinggen__title')?.textContent || ''));
    if (!openings) return 'no Openings block';
    return JSON.stringify([...openings.querySelectorAll('.btex__slot')].map(s => s.textContent.trim().slice(0, 30)));
  })()`));
  await shot('1-boxes');

  // Pick a library mesh for the Window row.
  console.log('picker:', await js(`(() => {
    const blocks = [...document.querySelectorAll('.btex')];
    const openings = blocks.find(b => /Openings/.test(b.querySelector('.buildinggen__title')?.textContent || ''));
    const row = openings?.querySelector('.btex__slot');
    const buttons = row?.querySelectorAll('.btex__buttons button');
    if (!buttons?.length) return 'no buttons';
    // A model row has no Generate button, so the picker is the first one.
    buttons[0].click();
    return 'opened (' + buttons.length + ' buttons)';
  })()`));
  await sleep(2600);
  console.log('modal title:', await js(
    `document.querySelector('.asset-selector-title')?.textContent?.trim()`));
  console.log('cards:', await js(`document.querySelectorAll('.asset-selector-card').length`));
  const picked = await js(`(() => {
    const cards = [...document.querySelectorAll('.asset-selector-card')];
    const small = cards.find(c => !/300K|100K/.test(c.textContent)) || cards[0];
    if (!small) return 'none';
    small.click();
    return small.textContent.trim().slice(0, 36);
  })()`);
  console.log('selected:', picked);
  await sleep(700);
  await js(`[...document.querySelectorAll('.asset-selector-footer button')].find(b => !/cancel|close/i.test(b.textContent))?.click()`);
  await sleep(6000);

  console.log('window row now:', await js(`(() => {
    const blocks = [...document.querySelectorAll('.btex')];
    const openings = blocks.find(b => /Openings/.test(b.querySelector('.buildinggen__title')?.textContent || ''));
    return openings?.querySelector('.btex__slot')?.textContent?.trim()?.slice(0, 60);
  })()`));
  await shot('2-model');

  app.quit();
}).catch(e => { console.error(e); app.quit(); });
