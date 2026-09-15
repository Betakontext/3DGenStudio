// Phase 4's demo: one graph, four genuinely different buildings.
//
// The headless gate (tools/check-building-presets.mjs) already proves the four
// packs validate, compile and differ numerically. What it cannot show is whether
// they LOOK like four different styles, which is the only claim that actually
// matters here - so this drives the real style panel in a real browser and reads
// the pictures back.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-style');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const styleRows = `[...document.querySelectorAll('.bstyle__item')]`;
const clickStyle = name => `${styleRows}
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
    // capturePage returns the last COMPOSITED frame, so one taken straight after
    // a React commit shows the previous state. Throw the first one away.
    // R3F draws on demand and capturePage hands back whatever the compositor
    // last composited, so one throwaway capture is not always enough: take two,
    // with a real pause between, or the picture is a style behind.
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

  const listed = JSON.parse(await js(`JSON.stringify(${styleRows}.map(b => b.textContent.trim()))`));
  console.log('styles listed:', listed.join(' | ') || 'NONE - the route or the panel is broken');

  await js(`document.querySelector('.buildinggen__tab:nth-child(2)')?.click()`);
  await sleep(600);
  await shot('0-default');

  for (const [file, name] of [
    ['1-roman', 'Roman Villa'],
    ['2-cyberpunk', 'Cyberpunk Block'],
    ['3-egyptian', 'Egyptian Pylon'],
    ['4-mayan', 'Mayan Temple'],
  ]) {
    console.log(`${name}: clicked=`, await js(clickStyle(name)));
    await sleep(1600);
    await shot(file);
    console.log('  nodes:', (await nodes()).join(' > '));
    console.log('  stats:', (await stats()).join(' / '));
  }

  // Undo must take the whole style back in one step - it is one edit.
  await js(`[...document.querySelectorAll('button')].find(b => /undo/i.test(b.title || ''))?.click()`);
  await sleep(1200);
  console.log('after undo:', (await nodes()).join(' > '));

  app.quit();
}).catch(e => { console.error(e); app.quit(); });
