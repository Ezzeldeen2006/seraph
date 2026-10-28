// Run a Skua script with the real engine on a headless client connected to tests/fakeaqw.js.
//   node fakerun.js <script.cs> [seconds]
const path = require('path');
process.env.SERAPH_ROOT = process.env.SERAPH_ROOT || path.join(__dirname, '..', 'work', 'root');
process.env.SERAPH_ENGINE = process.env.SERAPH_ENGINE || path.join(__dirname, '..', 'host', 'bin', 'Release', 'net10.0');
const APP = path.join(__dirname, '..', '..', 'runtime', 'resources', 'app');
const fake = require(path.join(APP, 'tests', 'fakeaqw'));
const { HeadlessClient } = require(path.join(APP, 'lib', 'net', 'headless'));
const { SkuaEngine } = require(path.join(APP, 'lib', 'skua', 'engine'));

(async () => {
  const srv = await fake.start();
  const client = new HeadlessClient({ id: 'faketest', label: 'faketest', username: 'Tester' });
  client.credentials = () => ({ username: 'Tester', password: 'x' });
  const info = { username: 'Tester', token: 'tok', userId: 1, level: 30, upgradeDays: -1, servers: [srv.server] };
  client.login = info;
  client.swf.setLogin(info, 'x');
  client.swf.setServer(srv.server);
  await client.connect(srv.server, info);
  console.log('client loaded:', client.w.strMapName, client.w.myAvatar.items.length, 'items');
  client.scriptLogin = async () => { client.login = info; client.swf.setLogin(info, 'x'); return info; };
  const eng = new SkuaEngine(client, { answers: { yesno: false } });
  eng.on('log', (l) => { if (l.kind !== 'debug' || process.env.VERBOSE) console.log(`[${l.kind}] ${l.msg}`); });
  const t0 = Date.now();
  await eng.run(path.resolve(process.argv[2]));
  const r = await eng.waitDone(Number(process.argv[3] || 180) * 1000);
  console.log('done', JSON.stringify(r), `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log('status', JSON.stringify(await eng.status()));
  if (process.env.PACKETS) console.log(srv.sessions[0].log.join('\n'));
  eng.dispose();
  client.disconnect();
  srv.close();
  setTimeout(() => process.exit(0), 1500);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
