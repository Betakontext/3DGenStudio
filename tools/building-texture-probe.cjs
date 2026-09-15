// Phase 6: the texture slots, end to end from the library to the building.
//
// The ComfyUI generation path needs a live ComfyUI and is not driven here. What
// IS driven is everything after it: picking an image from the library binds a
// reference, the reference reaches ir.materials, the viewport resolves the asset
// id to a URL, loads it and tiles it in metres. That chain is where the bugs
// live - the generation step is a copy of the VFX sprite panel's.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pickStyle } = require('./building-probe-style.cjs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-texture');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: true });
  win.webContents.on('console-message', (_e, l, m) => {
    if (/Uncaught|Maximum update|Building texture/.test(m)) {
      console.log(`CONSOLE ${String(m).slice(0, 220)}`);
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
    for (let i = 1; i <= 4; i++) {
      try {
        fs.writeFileSync(path.join(OUT, `${n}.png`), (await win.webContents.capturePage()).toPNG());
        console.log(`shot ${n}`);
        return;
      } catch { await sleep(700); }
    }
    console.log(`GAVE UP ${n}`);
  };

  console.log('slots:', await js(
    `JSON.stringify([...document.querySelectorAll('.btex__slot')].map(s => s.textContent.trim()))`));

  // A style first, so the building has something to texture.
  await js(`${pickStyle('Roman')}`);
  await sleep(1500);
  await js(`document.querySelector('.buildinggen__tab:nth-child(2)')?.click()`);
  await sleep(800);
  await shot('1-untextured');

  // The generate dialog: it needs ComfyUI to RUN, but it must open, read the
  // workflow library and say something sensible either way.
  await js(`document.querySelector('.btex__slot .btex__buttons button')?.click()`);
  await sleep(2500);
  console.log('dialog open:', await js(`!!document.querySelector('.bai')`));
  console.log('workflow options:', await js(
    `JSON.stringify([...document.querySelectorAll('.bai select option')].map(o => o.textContent.trim()).slice(0, 6))`));
  console.log('presets:', await js(
    `JSON.stringify([...document.querySelectorAll('.bai__presets button')].map(b => b.textContent.trim()))`));
  console.log('tile default:', await js(
    `document.querySelector('.bai input[type=number]')?.value`));
  await shot('2-generate-dialog');
  await js(`[...document.querySelectorAll('.bai__actions button')].find(b => /Close/.test(b.textContent))?.click()`);
  await sleep(600);

  // Bind a library image to the wall slot through the picker.
  await js(`[...document.querySelectorAll('.btex__slot')][0]
    ?.querySelectorAll('.btex__buttons button')[1]?.click()`);
  await sleep(2500);
  console.log('picker open:', await js(`!!document.querySelector('.asset-selector-modal')`));
  // The grid SELECTS on click; a footer button confirms. Two steps, not one -
  // clicking a card and expecting onSelect is how the first run of this probe
  // ended up pressing Close.
  const picked = await js(`(() => {
    const card = document.querySelector('.asset-selector-card');
    if (!card) return 'no card found';
    card.click();
    return card.textContent.trim().slice(0, 40);
  })()`);
  console.log('selected card:', picked);
  await sleep(800);
  console.log('confirmed:', await js(`(() => {
    const confirm = [...document.querySelectorAll('.asset-selector-footer button')]
      .find(b => !/cancel|close/i.test(b.textContent));
    if (!confirm) return 'no confirm button';
    if (confirm.disabled) return 'confirm is disabled';
    confirm.click();
    return confirm.textContent.trim();
  })()`));
  await sleep(3000);

  console.log('slots after:', await js(
    `JSON.stringify([...document.querySelectorAll('.btex__slot')].map(s => s.textContent.trim()))`));
  await shot('3-textured');

  app.quit();
}).catch(e => { console.error(e); app.quit(); });
