// Seraph — multi-account AQW client. One dashboard window; each account is an isolated game view (own session,
// Flash, bot). Built on the Artix launcher's Electron 8 + PepperFlash and Skua's AS3 bridge (skua.swf).
const electron = require('electron');
const { app, BrowserWindow, BrowserView, ipcMain, Menu } = electron;
const path = require('path');
const fs = require('fs');
const { P, ensureDirs } = require('./lib/paths');

ensureDirs();

// One Seraph at a time: a second launch just brings the dashboard forward (no crash dialog).
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.setPath('userData', P.PROFILE);
  app.setPath('temp', P.TMP);
  app.setPath('logs', P.LOGS);
  app.commandLine.appendSwitch('ppapi-flash-path', path.join(P.APP, '..', 'plugins', 'pepflashplayer.dll'));
  app.commandLine.appendSwitch('ppapi-flash-version', '32.0.0.371');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  // Black window fix (2026-09-17): Chromium's GPU compositor loses the window surface after minimize/restore with several
  // BrowserViews (dashboard + Flash games) -> everything black until a resize. Flash renders in software anyway, so
  // compositing on the CPU costs little. <seraph>\display.json {"gpuCompositing": true} turns it back on.
  const display = (() => { try { return JSON.parse(fs.readFileSync(path.join(P.ROOT, 'display.json'), 'utf8')); } catch { return {}; } })();
  if (!display.gpuCompositing) app.commandLine.appendSwitch('disable-gpu-compositing');

  process.on('uncaughtException', (e) => { try { fs.appendFileSync(path.join(P.LOGS, 'crash.log'), `${new Date().toISOString()} ${e.stack}\n`); } catch { /* */ } });
  process.on('unhandledRejection', (e) => { try { fs.appendFileSync(path.join(P.LOGS, 'crash.log'), `${new Date().toISOString()} rejection ${e && e.stack}\n`); } catch { /* */ } });

  const { Hub } = require('./lib/hub');
  const api = require('./lib/api');
  const hub = new Hub(electron);
  let win = null;

  // Seraph PC (SERAPH_PC=1, "Seraph.bat"): the window is the laptop dashboard (party bots live, orders, logs), and
  // The owner's main plays HERE in a real game (mainpanel.html: game screen + Skua scripts). The main is taken from the
  // laptop only when he opens it, and handed back when this app closes. SERAPH_ROOT holds just that one account.
  const PC = process.env.SERAPH_PC === '1';
  const PC_DASH = process.env.SERAPH_PC_DASHBOARD || 'http://192.168.1.100:47180/';
  const PC_MAIN = process.env.SERAPH_PC_MAIN || 'grail26';
  const PC_RAIL = 268;            // the dashboard's left rail (admin/public/app.css .rail)
  let panel = null;
  let mainOpen = false;
  let mainTaken = false;
  let gameRect = null;
  function pcLayout() {
    if (!win || !mainOpen || !panel) return;
    const [w, h] = size();
    panel.setBounds({ x: PC_RAIL, y: 0, width: Math.max(300, w - PC_RAIL), height: h });
    const c = hub.clients.get(PC_MAIN);
    if (c && c.view && gameRect) c.view.setBounds({ x: PC_RAIL + gameRect.x, y: gameRect.y, width: gameRect.width, height: gameRect.height });
  }
  function pcShow(on) {
    if (!win) return;
    const c = hub.clients.get(PC_MAIN);
    if (on) {
      if (!panel) {
        panel = new BrowserView({ webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
        panel.webContents.loadFile(path.join(P.APP, 'ui', 'mainpanel.html'));
      }
      win.addBrowserView(panel);
      if (c && c.view) win.addBrowserView(c.view);   // added after the panel, so the game is drawn on top of it
    } else {
      try { if (panel) win.removeBrowserView(panel); } catch { /* not attached */ }
      try { if (c && c.view) win.removeBrowserView(c.view); } catch { /* not attached */ }
    }
    mainOpen = on;
    selected = on ? PC_MAIN : null;
    applyFps();
    pcLayout();
  }
  // Ask the laptop to let go of the main (goOffline) or take it back (start). One ssh, never retried in a loop.
  function laptop(op) {
    return new Promise((resolve) => {
      const cmd = `curl -s -m 10 -X POST -H 'content-type: application/json' -d '{"op":"${op}"}' http://127.0.0.1:47101/a/${PC_MAIN}/bot`;
      require('child_process').execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', 'server', cmd], { windowsHide: true, timeout: 25000 }, (err, out) => {
        hub.info(`laptop ${op} ${PC_MAIN}: ${err ? err.message : String(out).trim()}`);
        resolve(!err);
      });
    });
  }
  async function openMain() {
    if (!mainTaken) {
      mainTaken = true;
      try { fs.writeFileSync(TAKEN_FILE, PC_MAIN); } catch { /* the launcher then can't hand it back by itself */ }
      await laptop('goOffline');
      hub.start();
    }
    pcShow(true);
    // The game view appears once the hub has opened the account: attach it as soon as it exists.
    for (let i = 0; i < 40 && mainOpen; i++) {
      const c = hub.clients.get(PC_MAIN);
      if (c && c.view) { pcShow(true); break; }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (PC) {
    ipcMain.on('pc', (_e, kind, data) => {
      if (kind === 'openMain') openMain();
      if (kind === 'closeMain') pcShow(false);
      if (kind === 'gameRect') { gameRect = data; pcLayout(); }
    });
    ipcMain.on('pc-sync', (e) => { e.returnValue = mainOpen; });
  }
  // Closing the app hands the main back to the laptop: Seraph.bat waits for seraph.exe to exit and, if this file says the
  // main was taken, tells the laptop to start it (an ssh from will-quit never finished before the process exited).
  const TAKEN_FILE = path.join(P.ROOT, 'MAIN_TAKEN');
  let selected = null;
  let grid = false;          // Live page: every account's game on screen at once
  const SIDEBAR = 232;
  const TOPBAR = 56;         // game bar above the watched character (ui/shell.css --top)
  const GRID_TOP = 132;      // top bar + Live page header
  const GRID_LABEL = 30;     // name strip above each live screen
  const GRID_GAP = 10;

  // Flash frame rate per screen (see GameClient.wantFps): the watched game at full speed, the Live grid lighter, games
  // nobody sees lighter still. The bots don't need frames; four full-speed games starved the CPU compositor.
  const FPS = { watched: 24, grid: 12, hidden: 8 };
  function views() { return [...hub.clients.values()].filter((c) => c.view); }
  function applyFps() {
    for (const c of hub.clients.values()) if (c.wantFps) c.wantFps(grid ? FPS.grid : c.id === selected ? FPS.watched : FPS.hidden);
  }
  let gridIds = '';
  function detachAll() {
    if (!win) return;
    win.setBrowserView(null);
    for (const c of views()) { try { win.removeBrowserView(c.view); } catch { /* not attached */ } }
  }

  // Game screens keep AQW's 960x550 shape inside their grid cell.
  function size() {
    // Minimized windows report a tiny size; lay out for the size the window has when the owner opens it.
    if (win.isMinimized()) { const b = win.getNormalBounds(); return [b.width - 16, b.height - 39]; }
    return win.getContentSize();
  }
  function layout() {
    if (!win) return;
    if (PC) return pcLayout();
    const [w, h] = size();
    if (grid) {
      const list = views();
      const n = list.length;
      if (!n) { win.webContents.send('grid', []); return; }
      const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
      const rows = Math.ceil(n / cols);
      const cellW = (w - SIDEBAR - GRID_GAP * (cols + 1)) / cols;
      const cellH = (h - GRID_TOP - GRID_GAP * (rows + 1)) / rows;
      const rects = [];
      list.forEach((c, i) => {
        const x = SIDEBAR + GRID_GAP + (i % cols) * (cellW + GRID_GAP);
        const y = GRID_TOP + GRID_GAP + Math.floor(i / cols) * (cellH + GRID_GAP);
        let gw = cellW; let gh = gw * 550 / 960;
        if (gh > cellH - GRID_LABEL) { gh = cellH - GRID_LABEL; gw = gh * 960 / 550; }
        const gx = x + (cellW - gw) / 2;
        c.view.setBounds({ x: Math.round(gx), y: Math.round(y + GRID_LABEL), width: Math.max(80, Math.round(gw)), height: Math.max(50, Math.round(gh)) });
        rects.push({ id: c.id, x: Math.round(gx - SIDEBAR), y: Math.round(y), width: Math.round(gw), height: Math.round(gh + GRID_LABEL) });
      });
      win.webContents.send('grid', rects);
      return;
    }
    if (!selected) return;
    const client = hub.clients.get(selected);
    if (!client || !client.view) return;
    client.view.setBounds({ x: SIDEBAR, y: TOPBAR, width: Math.max(200, w - SIDEBAR), height: Math.max(200, h - TOPBAR) });
  }

  const ui = {
    selected: () => selected,
    grid: () => grid,
    select(id) {
      if (!win) return;
      const client = id ? hub.clients.get(id) : null;
      detachAll();
      grid = false;
      selected = client ? id : null;
      if (client) win.addBrowserView(client.view);
      applyFps();
      layout();
      win.webContents.send('selected', selected);
    },
    setGrid(on) {
      if (!win) return false;
      detachAll();
      selected = null;
      grid = !!on;
      if (grid) for (const c of views()) win.addBrowserView(c.view);
      gridIds = grid ? views().map((c) => c.id).join(',') : '';
      applyFps();
      layout();
      win.webContents.send('selected', null);
      if (!grid) win.webContents.send('grid', []);
      return grid;
    },
    // Only for the owner re-launching Seraph (second instance): bring the dashboard up.
    show() { if (win) { if (win.isMinimized()) win.restore(); win.show(); } },
    // For Claude/tests: capture the dashboard and the selected game without touching window focus or state.
    async capture(dir) {
      const out = {};
      if (!win) return out;
      fs.mkdirSync(dir, { recursive: true });
      const shell = await win.webContents.capturePage();
      if (!shell.isEmpty()) { out.shell = path.join(dir, 'dashboard.png'); fs.writeFileSync(out.shell, shell.toPNG()); }
      for (const [id, client] of hub.clients) {
        const img = await Promise.race([client.view.webContents.capturePage(), new Promise((r) => setTimeout(r, 3000, null))]).catch(() => null);
        if (img && !img.isEmpty()) { out[id] = path.join(dir, `game-${id}.png`); fs.writeFileSync(out[id], img.toPNG()); }
      }
      return out;
    },
    reload() { if (win) win.webContents.reload(); },
    view(v) { if (win) win.webContents.send('view', v); },
    repaint() { repaint('api', true); },
    quit() { hub.stopAll(); setTimeout(() => app.quit(), 1500); },
  };

  // Redraw every surface. Soft (automatic, on restore/focus/...): invalidate and re-apply the layout. Hard (F9, the Fix
  // display button, /ui/repaint): also re-attach the game views and nudge the window size by 1 px, which is what
  // minimize/maximize did by hand. The old code nudged on every focus too, so each click into the window resized four
  // Flash views twice.
  let repaintTimer = null;
  function repaint(why, hard = false) {
    if (!win || win.isMinimized()) return;
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => {
      if (!win || win.isMinimized()) return;
      try {
        if (hard) {
          if (PC) { if (mainOpen) { pcShow(false); pcShow(true); } }
          else if (grid) ui.setGrid(true);
          else if (selected) ui.select(selected);
          if (!win.isMaximized() && !win.isFullScreen()) {
            const b = win.getBounds();
            win.setBounds({ ...b, width: b.width + 1 });
            setTimeout(() => { if (win) { win.setBounds(b); layout(); } }, 60);
          }
        }
        win.webContents.invalidate();
        for (const c of hub.clients.values()) if (c.view) c.view.webContents.invalidate();
        layout();
      } catch (e) { hub.info(`repaint failed (${why}): ${e.message}`); }
    }, 150);
  }

  // Main-process stalls freeze the whole window (no paint, no clicks). Log any over 1 s so the cause can be found.
  let lastBeat = Date.now();
  setInterval(() => {
    const now = Date.now(); const lag = now - lastBeat - 500; lastBeat = now;
    if (lag > 1000) try { fs.appendFileSync(path.join(P.LOGS, 'stall.log'), `${new Date().toISOString()} main process stalled ${lag} ms (${grid ? 'live grid' : selected ? `watching ${selected}` : 'dashboard'})\n`); } catch { /* */ }
  }, 500);

  function createWindow() {
    Menu.setApplicationMenu(null);
    win = new BrowserWindow({
      width: 1600, height: 900, show: false, title: 'Seraph', backgroundColor: '#08080f',
      icon: path.join(P.APP, '..', 'icons', 'icon.png'),
      webPreferences: PC
        ? { nodeIntegration: false, contextIsolation: false, backgroundThrottling: false, preload: path.join(P.APP, 'ui', 'pc-preload.js') }
        : { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
    });
    if (PC) win.loadURL(PC_DASH); else win.loadFile(path.join(P.APP, 'ui', 'shell.html'));
    if (PC) win.webContents.on('did-fail-load', () => setTimeout(() => win && win.loadURL(PC_DASH), 5000));   // laptop asleep / Wi-Fi: keep trying
    // Never steal the owner's focus - unless he opened it himself (Seraph PC).
    win.once('ready-to-show', () => { if (PC || process.env.SERAPH_SHOW === '1') { win.show(); win.maximize(); } else { win.showInactive(); win.minimize(); } });
    win.on('resize', layout);
    for (const ev of ['maximize', 'unmaximize', 'restore', 'show', 'focus', 'enter-full-screen', 'leave-full-screen']) win.on(ev, () => { layout(); repaint(ev); });
    win.webContents.on('crashed', () => { hub.info('dashboard renderer crashed - reloading'); setTimeout(() => win && win.webContents.reload(), 1000); });
    win.on('closed', () => { win = null; app.quit(); });
  }

  ipcMain.on('repaint', (_e, hard) => repaint('dashboard', !!hard));
  // F9 works wherever the focus is, including inside a game screen (the dashboard's own key handler never saw it there).
  app.on('web-contents-created', (_e, wc) => wc.on('before-input-event', (ev, input) => {
    if (input.type === 'keyDown' && input.key === 'F9') { ev.preventDefault(); repaint('F9', true); }
  }));
  app.on('gpu-process-crashed', (_e, killed) => { hub.info(`GPU process crashed (killed=${killed}) - repainting`); setTimeout(() => repaint('gpu-crash'), 1500); });

  ipcMain.on('flash', (_e, account, kind, data) => {
    const client = hub.clients.get(account);
    if (client) client.onIpc(kind, data);
  });

  app.on('second-instance', () => ui.show());
  app.whenReady().then(() => {
    createWindow();
    api.start(hub, ui);
    if (!PC) hub.start();   // Seraph PC starts the hub when the main is opened (openMain)
    // Re-attach the grid only when the set of games changed: re-attaching on every accounts event made the Live page
    // drop its game surfaces again and again.
    hub.on('accounts', () => { if (grid && views().map((c) => c.id).join(',') !== gridIds) ui.setGrid(true); else applyFps(); });
    applyFps();
  });
  app.on('before-quit', () => hub.dispose());
  app.on('window-all-closed', () => app.quit());
}
