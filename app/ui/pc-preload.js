// Seraph PC (SERAPH_PC=1): the laptop dashboard runs as this window's page. This preload gives it `window.seraphPC`,
// the way into the PC side (the owner's main with a real, playable game), and patches CSS that Electron 8's Chromium 80
// lacks: flex `gap` (Chromium 84) and `inset` (87).
const { ipcRenderer } = require('electron');

window.seraphPC = {
  mainId: process.env.SERAPH_PC_MAIN || 'grail26',
  openMain: () => ipcRenderer.send('pc', 'openMain'),
  closeMain: () => ipcRenderer.send('pc', 'closeMain'),
  isOpen: () => ipcRenderer.sendSync('pc-sync', 'isOpen'),
};

function shimGap() {
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display !== 'flex' && cs.display !== 'inline-flex') continue;
    const col = parseFloat(cs.columnGap) || 0;
    const row = parseFloat(cs.rowGap) || 0;
    if (!col && !row) continue;
    const vertical = cs.flexDirection.startsWith('column');
    const kids = [...el.children].filter((k) => getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).display !== 'none');
    kids.forEach((k, i) => {
      if (k.dataset.gapShim === '1') return;
      k.dataset.gapShim = '1';
      if (vertical) { if (i < kids.length - 1) k.style.marginBottom = `${row}px`; }
      else {
        if (i < kids.length - 1) k.style.marginRight = `${col}px`;
        if (cs.flexWrap === 'wrap' && row) k.style.marginBottom = `${row}px`;
      }
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const css = document.createElement('style');
  // Chromium 80 can't make a <button> a grid/flex container (83+): float the roster crest instead.
  css.textContent = '.veil, .gate { top: 0; right: 0; bottom: 0; left: 0; }'
    + ' .member { display: block !important; text-align: left; } .member .crest { float: left; margin: 2px 11px 0 0; }'
    + ' .member .who { display: block; overflow: hidden; } .member::after { content: ""; display: block; clear: both; }';
  document.head.appendChild(css);
  let queued = false;
  const run = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; shimGap(); }); };
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
  run();
});
