// A slot holding SEVERAL assets, picked per opening from the seed - plus the
// modal actually listing a mesh's versions, which it did not before.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-variant');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: true });
  win.webContents.on('console-message', (_e, l, m) => {
    if (/Uncaught|Building slot mesh|Building texture/.test(m)) {
      console.log(`CONSOLE ${String(m).slice(0, 180)}`);
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
  const setNumber = (label, v) => `(() => {
    const row = [...document.querySelectorAll('.buildinggen__field, .binspect__row')].find(r => new RegExp('${label}','i').test(r.textContent));
    const input = row && row.querySelector('input');
    if (!input) return 'no input';
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(input, '${v}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur(); return input.value;
  })()`;

  await js(`[...document.querySelectorAll('.bstyle__item')].find(b => /Roman/.test(b.textContent))?.click()`);
  await sleep(1600);
  await js(`document.querySelector('.buildinggen__tab:nth-child(2)')?.click()`);
  await sleep(700);

  // Open the Window model picker.
  await js(`(() => {
    const blocks = [...document.querySelectorAll('.btex')];
    const openings = blocks.find(b => /Openings/.test(b.querySelector('.buildinggen__title')?.textContent || ''));
    openings?.querySelector('.btex__slot .btex__buttons button')?.click();
  })()`);
  await sleep(2800);

  console.log('modal:', await js(`document.querySelector('.asset-selector-title')?.textContent?.trim()`));
  console.log('cards:', await js(`document.querySelectorAll('.asset-selector-card').length`));
  // THE FIX: a mesh's versions must be listed, badged VERSION.
  console.log('VERSION badges visible:', await js(
    `[...document.querySelectorAll('.asset-selector-child-badge')].map(b => b.textContent.trim()).length`));
  console.log('badge text:', await js(
    `JSON.stringify([...new Set([...document.querySelectorAll('.asset-selector-child-badge')].map(b => b.textContent.trim()))])`));
  await shot('1-modal-with-versions');

  // Multi-select three models at once.
  console.log('picked:', await js(`(() => {
    const cards = [...document.querySelectorAll('.asset-selector-card')].filter(c => !/300K|100K/.test(c.textContent));
    const take = cards.slice(0, 3);
    take.forEach(c => c.click());
    return take.length + ': ' + take.map(c => c.textContent.trim().slice(0, 18)).join(' | ');
  })()`));
  await sleep(600);
  console.log('confirm label:', await js(
    `[...document.querySelectorAll('.asset-selector-footer button')].find(b => !/cancel/i.test(b.textContent))?.textContent?.trim()`));
  await js(`[...document.querySelectorAll('.asset-selector-footer button')].find(b => !/cancel/i.test(b.textContent))?.click()`);
  await sleep(6000);

  console.log('window slot now:', await js(`(() => {
    const blocks = [...document.querySelectorAll('.btex')];
    const openings = blocks.find(b => /Openings/.test(b.querySelector('.buildinggen__title')?.textContent || ''));
    const group = openings?.querySelector('.btex__group');
    return group?.textContent?.trim()?.replace(/\s+/g, ' ')?.slice(0, 120);
  })()`));
  await shot('2-three-models');

  // Re-roll: a different seed must give a different mix.
  console.log('seed:', await js(setNumber('SEED', 777)));
  await sleep(2500);
  await shot('3-reseeded');

  app.quit();
}).catch(e => { console.error(e); app.quit(); });
