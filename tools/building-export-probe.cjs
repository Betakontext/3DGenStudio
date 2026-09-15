// Phase 7: export. Opens the dialog, reads the LOD triangle counts back, and
// saves the chain to the mesh library.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pickStyle } = require('./building-probe-style.cjs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-export');
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

  await js(`${pickStyle('Roman')}`);
  await sleep(1500);

  const before = await js(`fetch('/api/assets/library').then(r => r.json()).then(d => (d.meshes || []).length)`);
  console.log('meshes in library before:', before);

  console.log('export button:', await js(`(() => {
    const button = [...document.querySelectorAll('.buildinggen__btn')].find(b => /^Export$/.test(b.textContent.trim()));
    if (!button) return 'missing';
    if (button.disabled) return 'disabled';
    button.click();
    return 'clicked';
  })()`));
  await sleep(6000);

  console.log('levels:', await js(
    `JSON.stringify([...document.querySelectorAll('.bexport__level')].map(l => l.textContent.trim()))`));
  await shot('1-export-dialog');

  // Tick every LOD level, then save.
  console.log('ticked:', await js(`(() => {
    const boxes = [...document.querySelectorAll('.bexport__level input[type=checkbox]')];
    let n = 0;
    for (const box of boxes) { if (!box.checked && !box.disabled) { box.click(); n++; } }
    return n;
  })()`));
  await sleep(800);

  await js(`[...document.querySelectorAll('.bexport__actions button')]
    .find(b => /Save to library/.test(b.textContent))?.click()`);

  let outcome = 'timed out';
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const state = await js(`(() => {
      const ok = document.querySelector('.bexport__message.is-success');
      const bad = document.querySelector('.bexport__message.is-error');
      if (ok) return 'SUCCESS: ' + ok.textContent.trim();
      if (bad) return 'ERROR: ' + bad.textContent.trim();
      return 'working';
    })()`);
    if (state !== 'working') { outcome = state; break; }
  }
  console.log('outcome:', outcome);
  await shot('2-saved');

  // The point of this change: ONE library entry with the LODs as its versions,
  // not four meshes with a naming convention as the only thing relating them.
  console.log('library rows (name | isChild | parentId):', await js(
    `fetch('/api/assets/library').then(r => r.json()).then(d =>
      JSON.stringify((d.meshes || []).slice(0, 3).map(m =>
        [m.name, !!m.isChild, m.parentId ?? null])))`));
  console.log('versions of the saved building:', await js(
    `fetch('/api/assets/library').then(r => r.json()).then(d => {
      const parent = (d.meshes || []).find(m => /^Untitled Building$/.test(m.name));
      if (!parent) return 'parent not found';
      const id = String(parent.id).replace('library:', '');
      return fetch('/api/assets/library/versions?assetIds=' + id)
        .then(r => r.json())
        .then(v => JSON.stringify(v).slice(0, 400));
    })`));

  app.quit();
}).catch(e => { console.error(e); app.quit(); });
