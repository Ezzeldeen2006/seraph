// Seraph's Flash host (2026-10-11): the real AQW game + Skua's skua.swf in Electron 8 + PepperFlash, for the Linux
// laptop's standby mode. The owner: "develop the flash player there and keep it on standby if the bots failed to login" - when
// Artix changes the game and nobody is around to fix the headless client, the real game still works.
// Runs as one Electron process (the Artix Games Launcher's Linux runtime, ~/seraph/flash/rt) on a virtual screen (Xvfb)
// holding one small window per character, so the browser, GPU and Flash processes are shared. The hub drives it over
// stdin/stdout, one JSON object per line (lib/flashhost.js):
//   in : {t:'open', id} {t:'close', id} {t:'call', i, id, fn, args} {t:'fps', id, n} {t:'shot', i, id, file}
//        {t:'metrics', i} {t:'quit'}
//   out: {t:'ready'} {t:'ev', id, kind, data} {t:'crash', id, what} {t:'r', i, ok, value?, error?} {t:'log', text}
// Env: FLASH_PROFILE (user data), FLASH_PLUGIN (libpepflashplayer.so), FLASH_W / FLASH_H (window size),
//      FLASH_SHARED=1 (all characters in one session: one Flash process instead of one each).
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROFILE = process.env.FLASH_PROFILE || path.join(require('os').homedir(), 'seraph', 'flash', 'profile');
const PLUGIN = process.env.FLASH_PLUGIN || path.join(__dirname, '..', 'plugins', 'libpepflashplayer.so');
const W = Number(process.env.FLASH_W) || 480;
const H = Number(process.env.FLASH_H) || 275;
const SHARED = process.env.FLASH_SHARED !== '0';
// FLASH_HIDDEN=1: windows never shown - Chromium paints nothing, the game logic and bridge calls run as before. The
// dashboard's live view (capturePage) is then blank. 3 games drew 116% of the laptop's 200% CPU shown (2026-10-11).
const SHOW = process.env.FLASH_HIDDEN !== '1';

app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('ppapi-flash-path', PLUGIN);
app.commandLine.appendSwitch('ppapi-flash-version', process.env.FLASH_VERSION || '32.0.0.344');
// A 2-core 1 GHz laptop with no GPU: software everything, nothing extra.
for (const s of ['no-sandbox', 'disable-gpu', 'disable-gpu-compositing', 'disable-software-rasterizer', 'disable-dev-shm-usage',
  'disable-background-networking', 'disable-component-update', 'disable-breakpad', 'disable-extensions', 'mute-audio',
  'disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(s);
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=96');
// All game pages in one renderer process (FLASH_RPL, default 1): ~100 MB saved per extra character.
if (Number(process.env.FLASH_RPL || 1) > 0) app.commandLine.appendSwitch('renderer-process-limit', String(process.env.FLASH_RPL || 1));
app.allowRendererProcessReuse = true;
app.disableHardwareAcceleration();
// Fold Chromium's helper processes into the browser process (network ~67 MB, GPU ~64 MB, audio ~52 MB measured).
if (process.env.FLASH_FOLD !== '0') {
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess');
  app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess,SpareRendererForSitePerProcess');
}

const out = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch (e) { /* hub gone */ } };
const wins = new Map();   // id -> BrowserWindow
const partitionOf = (id) => (SHARED ? 'persist:flash' : `persist:acct-${id}`);

// Flash lets a local skua.swf script the page and load game.aq.com only from a trusted folder.
function writeTrust(partition) {
  const bases = [PROFILE, path.join(PROFILE, 'Partitions', partition.replace(/^persist:/, ''))];
  for (const base of bases) {
    const d = path.join(base, 'Pepper Data', 'Shockwave Flash', 'WritableRoot', '#Security', 'FlashPlayerTrust');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'seraph.cfg'), __dirname + '\n');
  }
}

// FLASH_ONEPAGE (default): every character is an iframe of one page (multi.html) in one window, so all of them share one
// renderer process: three games measured 823 MB as three windows (100 MB renderer each) on the laptop.
const ONEPAGE = process.env.FLASH_ONEPAGE !== '0' && SHARED;
const games = new Set();   // ids open in the one page
let page = null;
let pageReady = null;
function hostPage() {
  if (page && !page.isDestroyed()) return pageReady;
  writeTrust(partitionOf(''));
  page = new BrowserWindow({
    width: W * 2, height: H * 3, x: 0, y: 0, show: SHOW, paintWhenInitiallyHidden: true, frame: false, resizable: false, backgroundColor: '#000000', title: 'Seraph Flash',
    webPreferences: { plugins: true, nodeIntegration: true, nodeIntegrationInSubFrames: true, contextIsolation: false, backgroundThrottling: false, partition: partitionOf(''), spellcheck: false },
  });
  page.setMenu(null);
  const wc = page.webContents;
  wc.on('render-process-gone', (_e, d) => { for (const id of games) out({ t: 'crash', id, what: `renderer ${JSON.stringify(d)}` }); setTimeout(() => reopenAll(), 5000); });
  wc.on('plugin-crashed', (_e, name) => { for (const id of games) out({ t: 'crash', id, what: `plugin ${name}` }); setTimeout(() => { for (const id of games) wc.executeJavaScript(`window.__reload(${JSON.stringify(id)})`).catch(() => null); }, 5000); });
  pageReady = new Promise((resolve) => wc.once('did-finish-load', resolve));
  wc.loadFile(path.join(__dirname, 'multi.html'));
  return pageReady;
}
function reopenAll() {
  const ids = [...games];
  games.clear();
  try { if (page && !page.isDestroyed()) page.destroy(); } catch (e) { /* gone */ }
  page = null;
  for (const id of ids) open(id);
}
const pageJs = async (js) => { await hostPage(); return page.webContents.executeJavaScript(js); };

function open(id) {
  if (ONEPAGE) {
    if (games.has(id)) return;
    games.add(id);
    pageJs(`window.__add(${JSON.stringify(id)}, ${W}, ${H})`).catch((e) => out({ t: 'log', text: `open ${id}: ${e.message}` }));
    return;
  }
  if (wins.has(id)) return;
  const partition = partitionOf(id);
  writeTrust(partition);
  const w = new BrowserWindow({
    width: W, height: H, x: 0, y: 0, show: SHOW, paintWhenInitiallyHidden: true, frame: false, resizable: false, backgroundColor: '#000000', title: `Seraph ${id}`,
    webPreferences: { plugins: true, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, partition, spellcheck: false },
  });
  w.setMenu(null);
  const wc = w.webContents;
  wc.on('render-process-gone', (_e, d) => crash(id, `renderer ${JSON.stringify(d)}`));
  wc.on('plugin-crashed', (_e, name) => crash(id, `plugin ${name}`));
  w.on('closed', () => { if (wins.get(id) === w) wins.delete(id); });
  wc.loadFile(path.join(__dirname, 'game.html'), { query: { account: id } });
  wins.set(id, w);
}

function crash(id, what) {
  out({ t: 'crash', id, what });
  const w = wins.get(id);
  setTimeout(() => { try { if (w && !w.isDestroyed()) w.webContents.reload(); } catch (e) { /* gone */ } }, 5000);
}

function close(id) {
  if (ONEPAGE) {
    if (!games.delete(id)) return;
    if (page && !page.isDestroyed()) page.webContents.executeJavaScript(`window.__remove(${JSON.stringify(id)})`).catch(() => null);
    return;
  }
  const w = wins.get(id);
  wins.delete(id);
  try { if (w && !w.isDestroyed()) w.destroy(); } catch (e) { /* gone */ }
}

async function call(id, fn, args) {
  if (ONEPAGE) {
    if (!games.has(id)) return { ok: false, error: 'no game view' };
    return pageJs(`window.__callIn(${JSON.stringify(id)}, ${JSON.stringify(fn)}, ${JSON.stringify(args || [])})`);
  }
  const w = wins.get(id);
  if (!w || w.isDestroyed()) return { ok: false, error: 'no game view' };
  return w.webContents.executeJavaScript(`window.__call(${JSON.stringify(fn)}, ${JSON.stringify(args || [])})`);
}

function metrics() {
  const procs = app.getAppMetrics().map((p) => ({ pid: p.pid, type: p.type, name: p.name || '', mb: Math.round((p.memory.workingSetSize || 0) / 1024), cpu: p.cpu.percentCPUUsage }));
  return { windows: ONEPAGE ? [...games] : [...wins.keys()], onePage: ONEPAGE, procs, totalMb: procs.reduce((a, p) => a + p.mb, 0) };
}

ipcMain.on('flash', (_e, id, kind, data) => out({ t: 'ev', id, kind, data }));

app.on('window-all-closed', () => { /* stay up: the hub decides */ });
app.whenReady().then(() => {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let m;
    try { m = JSON.parse(line); } catch (e) { return; }
    const t0 = Date.now();
    try {
      switch (m.t) {
        case 'open': open(String(m.id)); return;
        case 'close': close(String(m.id)); return;
        case 'call': { const r = await call(String(m.id), m.fn, m.args); out({ t: 'r', i: m.i, ms: Date.now() - t0, ...(r || { ok: false, error: 'no answer' }) }); return; }
        case 'batch': {
          let r = null;
          if (ONEPAGE) r = games.has(String(m.id)) ? await pageJs(`window.__batchIn(${JSON.stringify(String(m.id))}, ${JSON.stringify(m.calls || [])})`) : null;
          else { const w = wins.get(String(m.id)); r = w && !w.isDestroyed() ? await w.webContents.executeJavaScript(`window.__batch(${JSON.stringify(m.calls || [])})`) : null; }
          out({ t: 'r', i: m.i, ms: Date.now() - t0, ok: Array.isArray(r), value: r, error: Array.isArray(r) ? undefined : 'no game view' });
          return;
        }
        case 'shot': {
          let img = null;
          if (ONEPAGE) {
            const r = games.has(String(m.id)) ? await pageJs(`window.__rect(${JSON.stringify(String(m.id))})`) : null;
            if (r) img = await page.webContents.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
          } else {
            const w = wins.get(String(m.id));
            img = w && !w.isDestroyed() ? await w.webContents.capturePage() : null;
          }
          if (img && !img.isEmpty()) { fs.mkdirSync(path.dirname(m.file), { recursive: true }); fs.writeFileSync(m.file, img.toPNG()); }
          out({ t: 'r', i: m.i, ok: !!(img && !img.isEmpty()), value: m.file });
          return;
        }
        case 'metrics': out({ t: 'r', i: m.i, ok: true, value: metrics() }); return;
        case 'quit': for (const id of [...wins.keys()]) close(id); app.quit(); return;
        default:
      }
    } catch (e) { if (m.i) out({ t: 'r', i: m.i, ok: false, error: String(e && e.message || e) }); }
  });
  rl.on('close', () => app.quit());   // the hub went away: so do we
  out({ t: 'ready', flash: PLUGIN, shared: SHARED, size: `${W}x${H}` });
});
