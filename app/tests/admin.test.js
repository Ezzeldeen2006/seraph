// Seraph Admin (admin/server.js): the laptop dashboard's server. Home network only, password, session cookie, the
// X-Seraph header on writes, and /api/* forwarded to the bots' own API.
const http = require('http');
const fs = require('fs');
const path = require('path');

function start(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}
function call(port, route, { method = 'GET', body, cookie, headers = {}, ip } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(cookie ? { cookie } : {}), ...(ip ? { 'x-test-ip': ip } : {}), ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* text */ } resolve({ status: res.statusCode, body: j, text: b, cookie: (res.headers['set-cookie'] || [])[0] }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('admin: sign-in, session, write header, forwarding to the bots, and a clear answer when they are down', async () => {
  try { fs.unlinkSync(path.join(process.env.SERAPH_ROOT, 'admin.json')); } catch (e) { /* none yet */ }
  delete require.cache[require.resolve('../admin/server')];
  const admin = require('../admin/server');
  const password = fs.readFileSync(path.join(process.env.SERAPH_ROOT, 'admin-password.txt'), 'utf8').trim();
  assert(password.length >= 10, 'a first password was generated');
  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.SERAPH_ROOT, 'admin.json'), 'utf8'));
  assert(cfg.hash && !JSON.stringify(cfg).includes(password), 'only a hash is stored');

  const seen = [];
  const bots = await start((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { seen.push([req.method, req.url, b]); res.end(JSON.stringify([{ id: 'nova7' }])); }); });
  admin.BOTS.port = bots.address().port;
  const srv = await start((req, res) => admin.handle(req, res));
  const port = srv.address().port;
  try {
    eq((await call(port, '/api/accounts')).status, 401, 'signed out');
    eq((await call(port, '/login', { method: 'POST', body: { password: 'nope' } })).status, 403, 'wrong password');
    const ok = await call(port, '/login', { method: 'POST', body: { password } });
    eq(ok.status, 200);
    const cookie = ok.cookie.split(';')[0];
    assert(/HttpOnly/.test(ok.cookie) && /SameSite=Strict/.test(ok.cookie), ok.cookie);
    const list = await call(port, '/api/accounts', { cookie });
    eq([list.status, list.body[0].id], [200, 'nova7'], 'forwarded to the bots');
    eq((await call(port, '/api/a/nova7/bot', { method: 'POST', cookie, body: { op: 'pause' } })).status, 403, 'a write needs X-Seraph');
    eq((await call(port, '/api/a/nova7/bot', { method: 'POST', cookie, body: { op: 'pause' }, headers: { 'x-seraph': '1' } })).status, 200);
    eq(seen[seen.length - 1], ['POST', '/a/nova7/bot', '{"op":"pause"}'], 'method, path and body reach the bots');
    eq((await call(port, '/api/accounts', { cookie: 'seraph_admin=9999999999999.forged' })).status, 401, 'a forged cookie');
    const page = await call(port, '/');
    assert(page.status === 200 && /id="gate"/.test(page.text) && /id="app"/.test(page.text), 'the shell is served without signing in (the gate asks for the password)');
    eq((await call(port, '/../server.js')).status, 404, 'no files outside public/');
    bots.close();
    await new Promise((r) => setTimeout(r, 50));
    const down = await call(port, '/api/accounts', { cookie });
    eq([down.status, down.body.botsDown], [502, true], 'bots down');
  } finally { srv.close(); bots.close(); }
  // Home network and Tailscale only.
  for (const ip of ['127.0.0.1', '192.168.1.100', '10.0.0.5', '100.64.0.1', '::ffff:192.168.1.100']) assert(admin.allowedIp(ip), ip);
  for (const ip of ['8.8.8.8', '100.200.0.1', '172.40.1.1', '::ffff:1.2.3.4']) assert(!admin.allowedIp(ip), ip);
});

test('admin: five wrong passwords lock the login for this address', async () => {
  const admin = require('../admin/server');
  const srv = await start((req, res) => admin.handle(req, res));
  const port = srv.address().port;
  try {
    for (let i = 0; i < 5; i++) await call(port, '/login', { method: 'POST', body: { password: `bad${i}` } });
    const password = fs.readFileSync(path.join(process.env.SERAPH_ROOT, 'admin-password.txt'), 'utf8').trim();
    eq((await call(port, '/login', { method: 'POST', body: { password } })).status, 429, 'even the right password waits 10 min');
  } finally { srv.close(); }
});
