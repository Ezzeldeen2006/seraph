#!/usr/bin/env node
// Seraph Admin: the dashboard the owner uses to watch and command the bots on the laptop (2026-09-19).
// A separate service (seraph-admin): the bots never depend on it, and it keeps working when the bots' process is down
// (it shows that, and can restart it). It serves the page in admin/public and forwards /api/* to the bots' own API,
// which stays on 127.0.0.1:47101.
//
// Safety: home network / Tailscale addresses only, a password (stored as a scrypt hash), a signed session cookie
// (HttpOnly, SameSite=Strict), and every POST needs the X-Seraph header (a cross-site page can't send it).
// Config: $SERAPH_ROOT/admin.json (created on first start; the first password is written to admin-password.txt).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = process.env.SERAPH_ROOT || path.join(require('os').homedir(), 'seraph');
const CONFIG = path.join(ROOT, 'admin.json');
const PUBLIC = path.join(__dirname, 'public');
const BOTS = { host: '127.0.0.1', port: Number(process.env.SERAPH_PORT || 47101) };
const SERVICE = process.env.SERAPH_SERVICE || 'seraph-bots';
const LOG = path.join(ROOT, 'logs', 'bots.log');
const HEALTH = path.join(ROOT, 'logs', 'health.log');
const SCRIPTS = process.env.SERAPH_SCRIPTS || path.join(ROOT, 'Scripts');
const DAY = 86400000;

// ---------------- config + password ----------------
function hash(password, salt) { return crypto.scryptSync(String(password), salt, 32).toString('hex'); }
function loadConfig() {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { /* first start */ }
  if (!cfg || !cfg.hash) {
    const password = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
    const salt = crypto.randomBytes(16).toString('hex');
    cfg = Object.assign({ port: 47180 }, cfg || {}, { salt, hash: hash(password, salt), secret: crypto.randomBytes(32).toString('hex') });
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 1), { mode: 0o600 });
    fs.writeFileSync(path.join(ROOT, 'admin-password.txt'), `${password}\n`, { mode: 0o600 });
    console.log(`seraph-admin: first start - password written to ${path.join(ROOT, 'admin-password.txt')}`);
  }
  return cfg;
}
let cfg = loadConfig();
function saveConfig() { fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 1), { mode: 0o600 }); }

// ---------------- sessions ----------------
function sign(v) { return crypto.createHmac('sha256', cfg.secret).update(v).digest('hex'); }
function newSession() { const exp = String(Date.now() + 30 * DAY); return `${exp}.${sign(exp)}`; }
function validSession(req) {
  const m = /(?:^|;\s*)seraph_admin=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, mac] = m[1].split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const want = sign(exp);
  return want.length === mac.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac));
}

// Home network, Tailscale and this machine only.
function allowedIp(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => Number.isNaN(x))) return /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a);   // IPv6 private / link-local
  return p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

const fails = new Map();   // ip -> [times]
function tooManyFails(ip) { const f = (fails.get(ip) || []).filter((t) => Date.now() - t < 10 * 60000); fails.set(ip, f); return f.length >= 5; }

// ---------------- helpers ----------------
function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
  res.end(data);
}
function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > max) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 4e6 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() })));
}
function tail(file, n, filter) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 4e6);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    let lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (filter) lines = lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()));
    return lines.slice(-n);
  } catch (e) { return []; }
}

// Forward /api/<path> to the bots' API.
function proxy(req, res, body) {
  const target = req.url.replace(/^\/api/, '') || '/';
  const r = http.request({ ...BOTS, path: target, method: req.method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body || '') }, timeout: 120000 }, (up) => {
    // Pictures (the Flash standby's live game view) go through as bytes.
    if (/^image\//.test(String(up.headers['content-type'] || ''))) {
      res.writeHead(up.statusCode || 200, { 'content-type': up.headers['content-type'], 'cache-control': 'no-store' });
      return up.pipe(res);
    }
    let b = '';
    up.setEncoding('utf8');
    up.on('data', (c) => { b += c; });
    up.on('end', () => send(res, up.statusCode || 502, b || '{}'));
  });
  r.on('timeout', () => r.destroy(new Error('the bots took too long to answer')));
  r.on('error', (e) => send(res, 502, { error: `bots not reachable: ${e.message}`, botsDown: true }));
  r.end(body || undefined);
}

// POST to the bots' API; the parsed answer, or null when the bots are not running.
function botsPost(route, timeout = 60000) {
  return new Promise((resolve) => {
    const r = http.request({ ...BOTS, path: route, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 2 }, timeout }, (up) => {
      let b = '';
      up.setEncoding('utf8');
      up.on('data', (c) => { b += c; });
      up.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false, error: b.slice(0, 200) }); } });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', () => resolve(null));
    r.end('{}');
  });
}

// ---------------- system (service, logs, updates) ----------------
// /sys/status spawns systemctl and df: answered from a 10 s cache (the page polls it with every refresh).
let statusCache = null;
async function system(req, res, route, body) {
  if (route === '/sys/status' && statusCache && Date.now() - statusCache.at < 10000) return send(res, 200, statusCache.body);
  if (route === '/sys/status') {
    const show = await run('systemctl', ['show', SERVICE, '--timestamp=unix', '-p', 'ActiveState', '-p', 'SubState', '-p', 'ActiveEnterTimestamp', '-p', 'MemoryCurrent', '-p', 'MemoryMax', '-p', 'NRestarts', '-p', 'CPUUsageNSec']);
    const s = Object.fromEntries(show.out.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    let mem = {};
    try { const t = fs.readFileSync('/proc/meminfo', 'utf8'); mem = { totalMb: Math.round(+/MemTotal:\s+(\d+)/.exec(t)[1] / 1024), availableMb: Math.round(+/MemAvailable:\s+(\d+)/.exec(t)[1] / 1024) }; } catch (e) { /* not Linux */ }
    const os = require('os');
    const df = await run('df', ['-m', '--output=avail,size', ROOT]);
    const disk = (df.out.split('\n')[1] || '').trim().split(/\s+/).map(Number);
    const out = {
      service: SERVICE, active: s.ActiveState, sub: s.SubState, since: /^@\d+/.test(s.ActiveEnterTimestamp || '') ? new Date(Number(s.ActiveEnterTimestamp.slice(1)) * 1000).toISOString() : null, restarts: Number(s.NRestarts || 0),
      memoryMb: s.MemoryCurrent && /^\d+$/.test(s.MemoryCurrent) ? Math.round(s.MemoryCurrent / 1048576) : null,
      memoryMaxMb: s.MemoryMax && /^\d+$/.test(s.MemoryMax) ? Math.round(s.MemoryMax / 1048576) : null,
      host: os.hostname(), uptimeH: Math.round(os.uptime() / 360) / 10, load: os.loadavg().map((x) => Math.round(x * 100) / 100), cpus: os.cpus().length,
      ...mem, diskFreeMb: disk[0] || null, diskMb: disk[1] || null, adminPid: process.pid,
    };
    statusCache = { at: Date.now(), body: out };
    return send(res, 200, out);
  }
  if (route === '/sys/service') statusCache = null;   // a start/stop/restart shows at once
  if (route === '/sys/service' && req.method === 'POST') {
    const op = JSON.parse(body || '{}').op;
    if (!['start', 'stop', 'restart'].includes(op)) return send(res, 400, { error: 'op must be start, stop or restart' });
    const r = await run('sudo', ['-n', 'systemctl', op, SERVICE], 60000);
    return send(res, r.ok ? 200 : 500, { ok: r.ok, error: r.ok ? undefined : r.err || 'failed (does this user have sudo for systemctl?)' });
  }
  if (route.startsWith('/sys/log')) {
    const u = new URL(req.url, 'http://x');
    return send(res, 200, tail(LOG, Math.min(2000, Number(u.searchParams.get('n') || 300)), u.searchParams.get('q') || ''));
  }
  if (route === '/sys/health') return send(res, 200, tail(HEALTH, 200));
  if (route === '/sys/scripts/update' && req.method === 'POST') {
    // Ask the bots to pull (their updater is the only puller: two gits at once broke the pulls on 09-25/26). Only when
    // the bots are down does this server fetch + fast-forward itself.
    let r = await botsPost('/scripts/pull', 300000);
    if (r === null) {
      const branch = (await run('git', ['-C', SCRIPTS, 'rev-parse', '--abbrev-ref', 'HEAD'])).out || 'Skua';
      const f = await run('git', ['-C', SCRIPTS, 'fetch', '--quiet', 'origin', branch], 300000);
      const m = f.ok ? await run('git', ['-C', SCRIPTS, 'merge', '--ff-only', '--quiet', 'FETCH_HEAD']) : f;
      r = { ok: m.ok, out: m.out || m.err };
    }
    const head = await run('git', ['-C', SCRIPTS, 'log', '-1', '--format=%h %cd', '--date=format:%Y-%m-%d %H:%M']);
    return send(res, r.ok ? 200 : 500, { ok: r.ok, out: r.out || r.error || '', head: head.out });
  }
  if (route === '/sys/scripts/head') { const head = await run('git', ['-C', SCRIPTS, 'log', '-1', '--format=%h %cd', '--date=format:%Y-%m-%d %H:%M']); return send(res, 200, { head: head.out }); }
  if (route === '/sys/password' && req.method === 'POST') {
    const b = JSON.parse(body || '{}');
    if (hash(b.current || '', cfg.salt) !== cfg.hash) return send(res, 403, { error: 'current password is wrong' });
    if (String(b.next || '').length < 8) return send(res, 400, { error: 'use at least 8 characters' });
    cfg.salt = crypto.randomBytes(16).toString('hex');
    cfg.hash = hash(b.next, cfg.salt);
    cfg.secret = crypto.randomBytes(32).toString('hex');   // signs everyone else out
    saveConfig();
    try { fs.unlinkSync(path.join(ROOT, 'admin-password.txt')); } catch (e) { /* already gone */ }
    res.setHeader('set-cookie', `seraph_admin=${newSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'unknown' });
}

// ---------------- server ----------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

async function handle(req, res) {
  const ip = req.socket.remoteAddress;
  if (!allowedIp(ip)) return send(res, 403, 'Seraph Admin is only reachable from the home network or Tailscale.', 'text/plain');
  const route = req.url.split('?')[0];
  try {
    if (route === '/login' && req.method === 'POST') {
      if (tooManyFails(ip)) return send(res, 429, { error: 'too many tries - wait 10 minutes' });
      const b = JSON.parse((await readBody(req, 4096)) || '{}');
      if (hash(b.password || '', cfg.salt) !== cfg.hash) { fails.get(ip).push(Date.now()); return send(res, 403, { error: 'wrong password' }); }
      res.setHeader('set-cookie', `seraph_admin=${newSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`);
      return send(res, 200, { ok: true });
    }
    if (route === '/logout') { res.setHeader('set-cookie', 'seraph_admin=; Path=/; Max-Age=0'); return send(res, 200, { ok: true }); }
    if (route === '/session') return send(res, 200, { ok: validSession(req) });
    if (route.startsWith('/api/') || route.startsWith('/sys/')) {
      if (!validSession(req)) return send(res, 401, { error: 'sign in' });
      if (req.method !== 'GET' && req.headers['x-seraph'] !== '1') return send(res, 403, { error: 'missing X-Seraph header' });
      const body = req.method === 'GET' ? '' : await readBody(req);
      return route.startsWith('/api/') ? proxy(req, res, body) : system(req, res, route, body);
    }
    // Static files (the login screen is part of the same page).
    const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
}

if (require.main === module) {
  const port = Number(process.env.SERAPH_ADMIN_PORT || cfg.port || 47180);
  http.createServer((req, res) => { handle(req, res); }).listen(port, process.env.SERAPH_ADMIN_HOST || '0.0.0.0', () => console.log(`seraph-admin on :${port}`));
  // The bots watchdog (admin/watchdog.js): crash loops, a failed service or a hung bots process reach the owner on Discord.
  if (process.env.SERAPH_WATCHDOG !== '0') new (require('./watchdog').Watchdog)({ service: SERVICE, bots: BOTS }).start();
}

module.exports = { handle, allowedIp, validSession, newSession, hash, BOTS, loadConfig: () => cfg };
