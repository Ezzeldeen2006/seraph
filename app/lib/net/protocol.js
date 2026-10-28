// AQW wire protocol: the little that the game client and the server actually say to each other.
// Taken from the live game file (Game3098r27.swf, client version 4.372) rather than guessed:
//   HTTP  POST game.aq.com/game/api/login/now  {user, pass, option:1} -> {login:{sToken,...}, servers:[...]}
//   SOCK  <msg t='sys'><body action='verChk' r='0'><ver v='166'/></body></msg>        -> apiOK
//         <msg t='sys'><body action='login' r='0'><login z='zone_master'>
//           <nick><![CDATA[SPIDER#0001~<user>~4.372]]></nick><pword><![CDATA[<token>]]></pword></login></body></msg>
//         %xt%zm%firstJoin%1%%   then everything else as %xt%zm%<cmd>%<roomId>%<args...>%
// Messages are NUL-terminated. Server replies are either %xt%...% strings or {"t":"xt","b":{"o":{...}}} JSON.
// Since AQW 5.0 (Game4000r1.swf, client 5.01, 2026-10-10) bigger replies come compressed: "Z" + base64(zlib(text)).
'use strict';
const https = require('https');

const CLIENT_TOKEN = 'SPIDER#0001';
const ZONE = 'zone_master';
const CLIENT_VERSION = '5.01';   // must match the live SWF (Game4000r1, 2026-10-10): the server loads no character for an older one
// The live value: Game.as `vParam`, read from each new game SWF by the updater (Updater.clientVersionOf), so a client
// update does not silently stop every login. CLIENT_VERSION is only the fallback until the first check.
let clientVersion = CLIENT_VERSION;
function setClientVersion(v) { if (/^\d+\.\d+$/.test(String(v || ''))) clientVersion = String(v); return clientVersion; }
const API_VERSION = '166';

function httpPost(url, form, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const u = new URL(url);
    const req = https.request({
      host: u.host, path: u.pathname + u.search, method: 'POST', timeout: timeoutMs,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.163 Safari/537.36',
        'x-requested-with': 'ShockwaveFlash/32.0.0.371',
        referer: 'https://game.aq.com/game/gamefiles/',
      },
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`login returned ${res.statusCode}: ${b.slice(0, 200)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('login timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

// Returns { token, username, userId, level, upgradeDays, servers }.
async function login(username, password) {
  const j = await httpPost(`https://game.aq.com/game/api/login/now?ran=${Math.random()}`, { user: username, pass: password, option: 1 });
  const l = j.login || j;
  if (String(l.bSuccess) !== '1') throw new Error(`login failed: ${l.sMsg || l.message || 'unknown reason'}`);
  return {
    token: l.sToken, username: l.unm || username, userId: l.userid, level: l.iLevel,
    upgradeDays: l.iUpgDays, email: l.strEmail, servers: j.servers || l.servers || [],
  };
}

// The public server list (no account needed): who is online and how full. Shared by every character for 4 s, so the
// wait for a seat on a full Artix polls it every 5 s without logging in each time (hub.reconnect).
let serversCache = null;
function servers(timeoutMs = 10000) {
  if (serversCache && Date.now() - serversCache.at < 1500) return serversCache.p;
  const p = new Promise((resolve, reject) => {
    const req = https.get('https://game.aq.com/game/api/data/servers', { timeout: timeoutMs, headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://game.aq.com/game/gamefiles/' } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`server list returned ${res.statusCode}`)); } });
    });
    req.on('timeout', () => req.destroy(new Error('server list timed out')));
    req.on('error', reject);
  });
  serversCache = { at: Date.now(), p };
  p.catch(() => { serversCache = null; });
  return p;
}

const verChk = () => `<msg t='sys'><body action='verChk' r='0'><ver v='${API_VERSION}' /></body></msg>`;
const loginMsg = (username, token) => `<msg t='sys'><body action='login' r='0'><login z='${ZONE}'>`
  + `<nick><![CDATA[${CLIENT_TOKEN}~${username}~${clientVersion}]]></nick><pword><![CDATA[${token}]]></pword></login></body></msg>`;
const xt = (cmd, args, room) => `%xt%zm%${cmd}%${room}%${args.map((a) => (a === undefined || a === null ? '' : String(a))).join('%')}%`;

// AQW 5.0 compresses bigger server messages: "Z" + base64(zlib(utf8 text)). The game unpacks them before anything
// else reads them (SmartFoxClient.handleMessage -> unpack), so parse() does too. Every login stalled for a day
// (2026-10-10) because loadPrefs, moveToArea and loadInventoryBig came this way and parse() called them 'bad'.
// A message that does not inflate is passed on unchanged, as Skua 1.4.5.0's CaptureProxy does.
const UNPACK_MAX = 16 * 1024 * 1024;
function unpack(msg) {
  if (typeof msg !== 'string' || msg[0] !== 'Z' || msg.length < 9) return msg;
  try {
    return require('zlib').inflateSync(Buffer.from(msg.slice(1), 'base64'), { maxOutputLength: UNPACK_MAX }).toString('utf8');
  } catch (e) { return msg; }
}

// Splits a server message into something usable: {kind:'json'|'xt'|'sys', cmd, args, data}.
function parse(msg) {
  msg = unpack(msg);
  if (msg[0] === '{') {
    let o;
    try { o = JSON.parse(msg); } catch (e) { return { kind: 'bad', raw: msg }; }
    const data = o.b && o.b.o ? o.b.o : o;
    return { kind: 'json', cmd: data.cmd || null, data, room: o.b && o.b.r };
  }
  if (msg[0] === '%') {
    const p = msg.split('%').filter((x, i) => i > 0);   // ['xt', cmd, room, ...args, '']
    if (p[p.length - 1] === '') p.pop();
    return { kind: 'xt', cmd: p[1], room: Number(p[2]), args: p.slice(3) };
  }
  if (msg[0] === '<') {
    const action = /action='([^']+)'/.exec(msg);
    const room = /<body[^>]*r='(-?\d+)'/.exec(msg);
    return { kind: 'sys', cmd: action ? action[1] : null, room: room ? Number(room[1]) : null, raw: msg };
  }
  return { kind: 'bad', raw: msg };
}

module.exports = { login, servers, httpPost, verChk, loginMsg, xt, parse, unpack, CLIENT_VERSION, CLIENT_TOKEN, ZONE, setClientVersion, clientVersion: () => clientVersion };
