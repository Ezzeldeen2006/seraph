const path = require('path');
process.env.SERAPH_ROOT = path.join(__dirname, '..', 'work', 'root');
process.env.SERAPH_ENGINE = path.join(__dirname, '..', 'bin', 'win-x64');
const APP = path.join(__dirname, '..', '..', 'runtime', 'resources', 'app');
const fake = require(path.join(APP, 'tests', 'fakeaqw'));
const { HeadlessClient } = require(path.join(APP, 'lib', 'net', 'headless'));
const { SkuaEngine } = require(path.join(APP, 'lib', 'skua', 'engine'));
(async () => {
  const srv = await fake.start();
  const c = new HeadlessClient({ id: 'faketest', label: 'faketest', username: 'Tester' });
  const info = { username: 'Tester', token: 'tok', userId: 1, level: 30, upgradeDays: -1, servers: [srv.server] };
  c.login = info; c.swf.setLogin(info, 'x'); c.swf.setServer(srv.server);
  await c.connect(srv.server, info);
  const eng = new SkuaEngine(c);
  await eng.run(path.join(APP, 'tests', 'skua', 'EngineSmoke.cs'));
  setTimeout(() => { console.log('killing engine pid', eng.proc.pid); eng.proc.kill('SIGKILL'); }, 6000);
  const r = await eng.waitDone(60000);
  console.log('after kill:', JSON.stringify(r), 'running', eng.running);
  eng.send({ t: 'cmd', op: 'status' });            // must not crash
  // A fresh start works after a crash.
  await eng.run(path.join(APP, 'tests', 'skua', 'EngineSmoke.cs'));
  const r2 = await eng.waitDone(120000);
  console.log('second run:', JSON.stringify(r2), eng.logs.filter((l) => /FAIL|SMOKE DONE/.test(l.msg)).map((l) => l.msg).join(' | '));
  eng.dispose(); c.disconnect(); srv.close();
  setTimeout(() => process.exit(0), 1000);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
