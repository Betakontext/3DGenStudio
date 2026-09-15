// Phase 6, the part the texture probe could not do: an actual ComfyUI run.
//
// Drives the real Generate dialog against a live ComfyUI, then checks the whole
// chain the run feeds: the image is uploaded to the library, bound to the slot
// as an 'asset:<id>' reference, resolved back to a URL and tiled onto the walls.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3001';
const OUT = process.env.PROBE_OUT || path.join(process.cwd(), 'probe-generate');
const WORKFLOW = process.env.PROBE_WORKFLOW || 'Turbo';
const BUDGET_MS = Number(process.env.PROBE_BUDGET || 300000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: true });
  win.webContents.on('console-message', (_e, l, m) => {
    if (/Uncaught|Building texture|comfy|Comfy/i.test(m)) {
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

  // A style first, so there is a building to texture.
  await js(`[...document.querySelectorAll('.bstyle__item')].find(b => /Roman/.test(b.textContent))?.click()`);
  await sleep(1500);
  await js(`document.querySelector('.buildinggen__tab:nth-child(2)')?.click()`);
  await sleep(800);

  // Open Generate on the Wall slot.
  await js(`document.querySelector('.btex__slot .btex__buttons button')?.click()`);
  await sleep(2500);
  if (!await js(`!!document.querySelector('.bai')`)) {
    console.log('FAIL: the dialog did not open');
    app.quit();
    return;
  }

  // Pick the named workflow - a turbo model, so this finishes in a probe's
  // lifetime rather than a coffee break.
  console.log('workflow:', await js(`(() => {
    const select = document.querySelector('.bai select');
    const option = [...select.options].find(o => /${WORKFLOW}/i.test(o.textContent));
    if (!option) return 'no match for ${WORKFLOW}: ' + [...select.options].map(o => o.textContent).join(', ');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return option.textContent;
  })()`));
  await sleep(1200);

  console.log('prompt:', await js(
    `document.querySelector('.bai textarea')?.value?.slice(0, 90)`));

  const started = Date.now();
  console.log('clicking Generate...');
  await js(`[...document.querySelectorAll('.bai__actions button')]
    .find(b => /Generate/.test(b.textContent))?.click()`);

  // Poll for the outcome rather than sleeping blind: a turbo run can be 8
  // seconds or 90 depending on what else the GPU is doing.
  let outcome = 'timed out';
  while (Date.now() - started < BUDGET_MS) {
    await sleep(4000);
    const state = await js(`(() => {
      const ok = document.querySelector('.bai__message.is-success');
      const bad = document.querySelector('.bai__message.is-error');
      const button = [...document.querySelectorAll('.bai__actions button')]
        .find(b => /Generat/.test(b.textContent));
      if (ok) return 'SUCCESS: ' + ok.textContent.trim();
      if (bad) return 'ERROR: ' + bad.textContent.trim();
      return 'running: ' + (button ? button.textContent.trim() : '?');
    })()`);
    console.log(`  ${Math.round((Date.now() - started) / 1000)}s ${state}`);
    if (state.startsWith('SUCCESS') || state.startsWith('ERROR')) { outcome = state; break; }
  }
  console.log('outcome:', outcome);
  await shot('1-dialog-result');

  await js(`[...document.querySelectorAll('.bai__actions button')].find(b => /Close/.test(b.textContent))?.click()`);
  await sleep(1500);

  console.log('wall slot:', await js(
    `document.querySelector('.btex__slot')?.textContent?.trim()`));
  await shot('2-textured-building');

  app.quit();
}).catch(e => { console.error(e); app.quit(); });
