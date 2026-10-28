// Upkeep (audit 2026-09-28): one git puller for the Skua library, and log housekeeping.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('zlib');
const { Updater } = require('../lib/updater');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function repos() {
  const root = path.join(process.env.SERAPH_ROOT, `git-${Math.random().toString(36).slice(2, 7)}`);
  const origin = path.join(root, 'origin.git'); const up = path.join(root, 'up'); const clone = path.join(root, 'clone');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'Skua', origin);
  git(root, 'clone', '-q', origin, up);
  git(up, 'checkout', '-q', '-b', 'Skua');
  const commit = (dir, file, text) => { fs.writeFileSync(path.join(dir, file), text); git(dir, 'add', file); git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', file); };
  commit(up, 'a.cs', 'one');
  git(up, 'push', '-q', 'origin', 'Skua');
  // A second branch on the remote: "git pull" fetching every branch at once is what left several merge heads.
  git(up, 'checkout', '-q', '-b', 'Other'); commit(up, 'b.cs', 'other'); git(up, 'push', '-q', 'origin', 'Other'); git(up, 'checkout', '-q', 'Skua');
  git(root, 'clone', '-q', '-b', 'Skua', origin, clone);
  return { up, clone, commit };
}

test('upkeep: two library pulls at once take turns and both fast-forward', async () => {
  let gitOk = true;
  try { git(process.cwd(), '--version'); } catch (e) { gitOk = false; }
  if (!gitOk) return;
  const { up, clone, commit } = repos();
  commit(up, 'a.cs', 'two');
  git(up, 'push', '-q', 'origin', 'Skua');
  const logs = [];
  const u = new Updater((m) => logs.push(m));
  const [r1, r2] = await Promise.all([u.pull(clone, 'Scripts'), u.pull(clone, 'Scripts')]);
  assert(r1.ok && r2.ok, `both ok: ${logs.join(' | ')}`);
  eq([r1.changed || r2.changed, r1.changed && r2.changed], [true, false], 'one of them did the work');
  eq(fs.readFileSync(path.join(clone, 'a.cs'), 'utf8'), 'two');
  // A clone that cannot fast-forward (a local commit) is reset to the remote when allowed (the Scripts library).
  commit(clone, 'local.cs', 'mine');
  commit(up, 'a.cs', 'three');
  git(up, 'push', '-q', 'origin', 'Skua');
  const plain = await u.pull(clone, 'Scripts');
  eq(plain.ok, false, 'no reset without permission');
  const reset = await u.pull(clone, 'Scripts', { reset: true });
  assert(reset.ok && reset.changed, logs.join(' | '));
  eq(fs.readFileSync(path.join(clone, 'a.cs'), 'utf8'), 'three');
  assert(logs.some((l) => /resetting to origin\/Skua/.test(l)));
}, 60000);

// Skua's "Reset Scripts" (2026-10-10): the library back to the remote, local edits and untracked files - the compile
// cache Cached-Scripts included - gone; and a new Skua release does it by itself.
test('upkeep: Reset Scripts restores the library and clears the compile cache; a new Skua release triggers it', async () => {
  let gitOk = true;
  try { git(process.cwd(), '--version'); } catch (e) { gitOk = false; }
  if (!gitOk) return;
  const { P } = require('../lib/paths');
  const { up, clone, commit } = repos();
  const logs = [];
  const u = new Updater((m) => logs.push(m));
  u.afterScripts = (r) => r;   // the knowledge rebuild reads the real library layout; not this test's business
  u.save = () => {};
  const keep = P.SCRIPTS;
  P.SCRIPTS = clone;
  try {
    fs.writeFileSync(path.join(clone, 'a.cs'), 'edited by hand');
    fs.mkdirSync(path.join(clone, 'Cached-Scripts'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'Cached-Scripts', '123-CoreBots.dll'), 'half written');
    commit(up, 'a.cs', 'upstream');
    git(up, 'push', '-q', 'origin', 'Skua');
    const r = await u.resetScripts('test');
    assert(r.ok, logs.join(' | '));
    eq(fs.readFileSync(path.join(clone, 'a.cs'), 'utf8'), 'upstream');
    assert(!fs.existsSync(path.join(clone, 'Cached-Scripts')), 'compile cache cleared');
    assert(logs.some((l) => /Scripts reset \(test\).*compile cache cleared/.test(l)), logs.join(' | '));
    // The release watch: the first look only records; a new tag resets and tells the hub.
    let resets = 0; const told = [];
    u.resetScripts = async (why) => { resets++; return { ok: true, why }; };
    u.onSkuaRelease = (tag, was) => told.push(`${was}->${tag}`);
    u.state = {};
    await u.skuaReleaseWatch(async () => ({ tag_name: '1.4.5.0' }));
    eq(resets, 0, 'first sighting: nothing to reset');
    await u.skuaReleaseWatch(async () => ({ tag_name: '1.4.5.0' }));
    eq(resets, 0);
    await u.skuaReleaseWatch(async () => ({ tag_name: '1.4.6.0' }));
    eq([resets, told], [1, ['1.4.5.0->1.4.6.0']]);
  } finally { P.SCRIPTS = keep; }
}, 60000);

test('upkeep: the hub no longer pulls the library itself (the updater is the only puller)', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'hub.js'), 'utf8');
  assert(!/'pull', '--ff-only'/.test(src), 'no git pull in hub.js');
});

test('upkeep: old session logs and quest-loop dumps go, and an overgrown journal is rotated', async () => {
  const { prune } = require('../lib/logs');
  const root = path.join(process.env.SERAPH_ROOT, `logs-${Math.random().toString(36).slice(2, 7)}`);
  const logs = path.join(root, 'bot1', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const now = Date.UTC(2026, 8, 28, 12);
  for (const f of ['session-2026-09-01.log', 'session-2026-09-01.log.1.gz', 'session-2026-09-20.log.1.gz', 'session-2026-09-28.log', 'questloop-old.log', 'other.txt']) fs.writeFileSync(path.join(logs, f), 'x');
  const old = new Date(now - 20 * 86400000);
  fs.utimesSync(path.join(logs, 'questloop-old.log'), old, old);
  fs.writeFileSync(path.join(root, 'bot1', 'journal.log'), 'line\n'.repeat(2000));
  const r = prune(root, now, { journalMax: 1000 });
  eq(fs.readdirSync(logs).sort(), ['other.txt', 'session-2026-09-20.log.1.gz', 'session-2026-09-28.log'], 'kept the last 14 days and unknown files');
  eq([r.removed, r.rotated], [3, 1]);
  assert(!fs.existsSync(path.join(root, 'bot1', 'journal.log')), 'journal moved away; the next line starts a new one');
  await new Promise((res) => setTimeout(res, 200));
  const gz = fs.readdirSync(path.join(root, 'bot1')).find((f) => /^journal-2026-09-28\.log\.gz$/.test(f));
  assert(gz, 'compressed');
  eq(zlib.gunzipSync(fs.readFileSync(path.join(root, 'bot1', gz))).toString().split('\n').length, 2001);
});
