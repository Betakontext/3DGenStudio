// Per-Trim textures: a plinth and a cornice that no longer have to match.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-trim-tex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: true });
  win.webContents.on('console-message', (_e, l, m) => {
    if (/Uncaught|Building texture/.test(m)) console.log(`CONSOLE ${String(m).slice(0, 200)}`);
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
  const pickNth = async n => {
    await sleep(2200);
    const picked = await js(`(() => {
      const cards = [...document.querySelectorAll('.asset-selector-card')];
      if (cards.length <= ${n}) return 'only ' + cards.length + ' cards';
      cards[${n}].click();
      return cards[${n}].textContent.trim().slice(0, 30);
    })()`);
    await sleep(700);
    await js(`[...document.querySelectorAll('.asset-selector-footer button')]
      .find(b => !/cancel|close/i.test(b.textContent))?.click()`);
    await sleep(2500);
    return picked;
  };

  // Roman Villa ships a plinth AND a cornice, which is exactly the case.
  await js(`[...document.querySelectorAll('.bstyle__item')].find(b => /Roman/.test(b.textContent))?.click()`);
  await sleep(1500);
  await js(`document.querySelector('.buildinggen__tab:nth-child(2)')?.click()`);
  await sleep(800);

  const trims = await js(`JSON.stringify([...document.querySelectorAll('.buildinggen__node')]
    .map((b, i) => ({ i, text: b.textContent.trim() })).filter(n => /Trim/.test(n.text)))`);
  console.log('trim nodes:', trims);

  for (const [file, which, card] of [['1-first-trim', 0, 1], ['2-second-trim', 1, 2]]) {
    await js(`[...document.querySelectorAll('.buildinggen__node')]
      .filter(b => /Trim/.test(b.textContent))[${which}]?.click()`);
    await sleep(1200);
    console.log(`trim ${which} rows:`, await js(
      `JSON.stringify([...document.querySelectorAll('.binspect__section--textures .btex__slot')]
        .map(s => s.textContent.trim().slice(0, 40)))`));
    await js(`document.querySelector('.binspect__section--textures .btex__buttons button:nth-child(2)')?.click()`);
    console.log(`  bound:`, await pickNth(card));
    await shot(file);
  }

  console.log('final:', await js(
    `JSON.stringify([...document.querySelectorAll('.binspect__section--textures .btex__slot')]
      .map(s => s.textContent.trim().slice(0, 48)))`));

  app.quit();
}).catch(e => { console.error(e); app.quit(); });
