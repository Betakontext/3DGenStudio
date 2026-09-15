// Phase 5's demo: a Medieval pack with jettied, sagging upper floors.
//
// The headless tests prove the mitre arithmetic and that the warp turns an
// instance with its wall. What they cannot show is whether a cornice reads as a
// cornice and whether a sagging building looks settled rather than broken, so
// this drives the real style panel and reads the pictures back.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-trim');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const clickStyle = name => `[...document.querySelectorAll('.bstyle__item')]
  .find(b => new RegExp(${JSON.stringify(name)}).test(b.textContent))?.click()`;

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

  const js = src => win.webContents.executeJavaScript(src);
  const shot = async n => {
    for (let i = 0; i < 2; i++) {
      try { await win.webContents.capturePage(); } catch { /* the retry covers it */ }
      await sleep(1100);
    }
    for (let i = 1; i <= 4; i++) {
      try {
        fs.writeFileSync(path.join(OUT, `${n}.png`), (await win.webContents.capturePage()).toPNG());
        console.log(`shot ${n}`);
        return;
      } catch { await sleep(700); }
    }
    console.log(`GAVE UP ${n}`);
  };
  const stats = async () => JSON.parse(await js(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__stats > div')].map(d => d.textContent.trim()))`));
  const nodes = async () => JSON.parse(await js(
    `JSON.stringify([...document.querySelectorAll('.buildinggen__node')].map(b => b.textContent.trim()))`));

  console.log('styles:', await js(
    `JSON.stringify([...document.querySelectorAll('.bstyle__item')].map(b => b.textContent.trim()))`));

  await js(`document.querySelector('.buildinggen__tab:nth-child(2)')?.click()`);
  await sleep(600);

  for (const [file, name] of [
    ['1-medieval', 'Medieval Timber'],
    ['2-roman', 'Roman Villa'],
    ['3-cyberpunk', 'Cyberpunk Block'],
    ['4-egyptian', 'Egyptian Pylon'],
  ]) {
    await js(clickStyle(name));
    await sleep(1600);
    await shot(file);
    console.log(`${name}`);
    console.log('  nodes:', (await nodes()).join(' > '));
    console.log('  stats:', (await stats()).join(' / '));
  }

  app.quit();
}).catch(e => { console.error(e); app.quit(); });
