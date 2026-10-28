// Log housekeeping for each character (accounts/<id>/). The system logrotate rotates each dated session log once and
// then keeps it for ever (97 files on 2026-09-28), and it never touched journal.log (Sable's was 48 MB, 666k
// lines). So Seraph keeps its own: dated session logs and quest-loop dumps older than KEEP_DAYS go, and a journal over
// JOURNAL_MAX is moved to journal-<date>.log.gz (the last JOURNAL_KEEP of those stay). history.jsonl is kept whole:
// it is small (~0.2 MB a day) and it is the characters' memory.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const KEEP_DAYS = 14;
const JOURNAL_MAX = 16 * 1024 * 1024;
const JOURNAL_KEEP = 4;

function prune(accountsDir, now = Date.now(), opts = {}) {
  const keepMs = (opts.keepDays || KEEP_DAYS) * 86400000;
  const out = { removed: 0, rotated: 0 };
  let ids = [];
  try { ids = fs.readdirSync(accountsDir); } catch (e) { return out; }
  for (const id of ids) {
    const dir = path.join(accountsDir, id);
    const logs = path.join(dir, 'logs');
    let files = [];
    try { files = fs.readdirSync(logs); } catch (e) { files = []; }
    for (const f of files) {
      // session-2026-09-21.log(.1.gz) by the date in its name; quest-loop dumps and anything else by mtime.
      const m = /^session-(\d{4}-\d\d-\d\d)\.log/.exec(f);
      let t = m ? Date.parse(`${m[1]}T23:59:59Z`) : null;
      if (t === null) {
        if (!/^questloop-/.test(f)) continue;
        try { t = fs.statSync(path.join(logs, f)).mtimeMs; } catch (e) { continue; }
      }
      if (now - t > keepMs) { try { fs.unlinkSync(path.join(logs, f)); out.removed++; } catch (e) { /* in use */ } }
    }
    const journal = path.join(dir, 'journal.log');
    let size = 0;
    try { size = fs.statSync(journal).size; } catch (e) { size = 0; }
    if (size > (opts.journalMax || JOURNAL_MAX)) {
      // Rename first (the bot's next append starts a fresh file), then compress the old one.
      const stamp = new Date(now).toISOString().slice(0, 10);
      const moved = path.join(dir, `journal-${stamp}.log`);
      try {
        fs.renameSync(journal, moved);
        out.rotated++;
        // Streamed: a 48 MB journal must not land in the bots' 256 MB heap at once.
        fs.createReadStream(moved).pipe(zlib.createGzip()).pipe(fs.createWriteStream(`${moved}.gz`))
          .on('finish', () => { try { fs.unlinkSync(moved); } catch (e) { /* */ } })
          .on('error', () => null);
      } catch (e) { /* try again tomorrow */ }
      const old = fs.readdirSync(dir).filter((f) => /^journal-\d{4}-\d\d-\d\d\.log\.gz$/.test(f)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - JOURNAL_KEEP))) { try { fs.unlinkSync(path.join(dir, f)); out.removed++; } catch (e) { /* */ } }
    }
    if (archiveHistory(dir, now, opts)) out.rotated++;
  }
  return out;
}

// history.jsonl grows ~0.1 MB a day and is read whole (report.js hourly, eta.js, ask.js) by a process with a 320 MB
// heap: a year of it would be ~40 MB a character. Over HISTORY_MAX, lines older than HISTORY_KEEP_DAYS move to
// history-<date>.jsonl.gz (kept: it is the characters' memory) and history.jsonl keeps the recent ones.
const HISTORY_MAX = 8 * 1024 * 1024;
const HISTORY_KEEP_DAYS = 60;
function archiveHistory(dir, now = Date.now(), opts = {}) {
  const file = path.join(dir, 'history.jsonl');
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) { return false; }
  if (size <= (opts.historyMax || HISTORY_MAX)) return false;
  const cut = now - (opts.historyKeepDays || HISTORY_KEEP_DAYS) * 86400000;
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (e) { return false; }
  // Lines are appended in time order; the first one inside the window splits them.
  let i = lines.findIndex((l) => { const m = /^\{"t":(\d+)/.exec(l); return m && Number(m[1]) >= cut; });
  if (i < 0) i = lines.length;
  if (i === 0) return false;
  const stamp = new Date(now).toISOString().slice(0, 10);
  try {
    const head = lines.slice(0, i).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, `history-${stamp}.jsonl.gz`), zlib.gzipSync(head));
    // Lines the bot appended since the read above stay: only the archived head is cut off.
    const fresh = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(`${file}.tmp`, fresh.startsWith(head) ? fresh.slice(head.length) : lines.slice(i).join('\n') + '\n');
    fs.renameSync(`${file}.tmp`, file);
    return true;
  } catch (e) { return false; }
}

module.exports = { prune, archiveHistory, KEEP_DAYS, JOURNAL_MAX, HISTORY_MAX };
