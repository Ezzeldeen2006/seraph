// The cells of a map, which the game reads from the map file's frame labels (world.map.currentScene.labels).
// Skua scripts use them (Bot.Map.Cells) to check a cell exists before jumping. The headless client loads no
// map file, so the labels are read straight from the SWF: download it once, inflate it, and pull the labels
// out of DefineSceneAndFrameLabelData (tag 86) or the main timeline's FrameLabel tags (tag 43).
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { P } = require('../paths');

const CACHE = path.join(P.KNOWLEDGE, 'mapcells.json');
let cache = null;
const pending = new Map();

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { cache = {}; }
  return cache;
}
function save() {
  try { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch (e) { /* cache only */ }
}

function download(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://game.aq.com/game/gamefiles/' }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); resolve(download(new URL(res.headers.location, url).toString(), redirects - 1)); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`map file ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('map download timed out')); });
  });
}

// SWF -> frame labels of the main timeline.
function parse(buf) {
  const sig = buf.toString('latin1', 0, 3);
  let body;
  if (sig === 'FWS') body = buf.subarray(8);
  else if (sig === 'CWS') body = zlib.inflateSync(buf.subarray(8));
  else return null;                       // ZWS (LZMA) is not used by map files
  let pos = 0;
  const nbits = body[0] >> 3;
  pos = Math.ceil((5 + nbits * 4) / 8) + 4;   // RECT, frame rate, frame count
  const labels43 = [];
  let labels86 = null;
  const readU32e = () => {                     // EncodedU32
    let v = 0;
    for (let i = 0; i < 5; i++) { const b = body[pos++]; v |= (b & 0x7f) << (7 * i); if (!(b & 0x80)) break; }
    return v >>> 0;
  };
  const readStr = (end) => { const s = pos; while (pos < end && body[pos] !== 0) pos++; const out = body.toString('utf8', s, pos); pos++; return out; };
  while (pos + 2 <= body.length) {
    const head = body.readUInt16LE(pos); pos += 2;
    const code = head >> 6;
    let len = head & 0x3f;
    if (len === 0x3f) { len = body.readUInt32LE(pos); pos += 4; }
    const start = pos;
    const end = start + len;
    if (code === 0) break;
    if (code === 43) { labels43.push(readStr(end)); }
    else if (code === 86) {
      const scenes = readU32e();
      for (let i = 0; i < scenes; i++) { readU32e(); readStr(end); }
      const n = readU32e();
      labels86 = [];
      for (let i = 0; i < n; i++) { readU32e(); labels86.push(readStr(end)); }
    }
    pos = end;
  }
  const list = labels86 && labels86.length ? labels86 : labels43;
  return [...new Set(list.filter(Boolean))];
}

// Promise of the labels for a map file ("Battleon/town-Battleon-7Nov23.swf"). Cached on disk for good.
function labels(mapFile) {
  if (!mapFile) return Promise.resolve([]);
  const key = String(mapFile).split('?')[0];
  const c = load();
  if (c[key]) return Promise.resolve(c[key]);
  if (pending.has(key)) return pending.get(key);
  const job = download(`https://game.aq.com/game/gamefiles/maps/${key}`)
    .then((buf) => {
      const l = parse(buf) || [];
      if (l.length) { c[key] = l; save(); }
      return l;
    })
    .finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

module.exports = { labels, parse };
