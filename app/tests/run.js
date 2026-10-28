// Seraph unit tests. Run:  node tests/run.js [part of a test name]
// Uses a throwaway data root (the system temp folder) and a fast clock; never touches real accounts.
const path = require('path');
const fs = require('fs');

// On the Linux server there is no D: drive, so the throwaway root goes to the temp folder there.
process.env.SERAPH_ROOT = path.join(require('os').tmpdir(), 'seraph-test-data');
process.env.SERAPH_TIME_SCALE = process.env.SERAPH_TIME_SCALE || '0.02';
process.env.SERAPH_PORT = '47191';
// Many tests read the real Skua script library (auqw/Scripts): SERAPH_SCRIPTS, or the README's ~/seraph/Scripts.
process.env.SERAPH_SCRIPTS = process.env.SERAPH_SCRIPTS || path.join(require('os').homedir(), 'seraph', 'Scripts');
if (!fs.existsSync(path.join(process.env.SERAPH_SCRIPTS, 'CoreAdvanced.cs'))) {
  console.log(`The tests need the Skua script library: git clone https://github.com/auqw/Scripts.git ${process.env.SERAPH_SCRIPTS}\n`
    + '(or set SERAPH_SCRIPTS to your checkout).');
  process.exit(1);
}
// The brain's rank-up and Farmer Joe steps come before goals and leveling; the older brain tests check what follows
// them, so they run without those two steps. tests/progress.test.js turns them back on.
process.env.SERAPH_TEST_SKIP_FJ = '1';
// Me time (lib/fashion.js) comes before goals too: off for the older tests, on in tests/fashion.test.js.
process.env.SERAPH_TEST_NO_STYLE = '1';
process.env.SERAPH_TEST_NO_RECIPES = '1';   // proven raid recipes only where a test turns them on (h._recipesForTest)
// The daily wardrobe tidy (lib/wardrobe.js) also comes first: off for the older tests, on in tests/wardrobe.test.js.
process.env.SERAPH_TEST_NO_TIDY = '1';
process.env.SERAPH_VAULT = path.join(process.env.SERAPH_ROOT, 'vault');
fs.rmSync ? fs.rmSync(process.env.SERAPH_ROOT, { recursive: true, force: true }) : fs.rmdirSync(process.env.SERAPH_ROOT, { recursive: true });
fs.mkdirSync(process.env.SERAPH_ROOT, { recursive: true });

const tests = [];
// Tests that need what this repository does not ship are skipped, with the reason, instead of failing: the vendored
// Ultras v3 scripts (node tools/vendor-ultras.js <noelrohi/Scripts>/Ultrasv3), look data (app/data) and the community
// forge sheet (lib/forge-sheet.json).
const has = (p) => fs.existsSync(path.join(__dirname, '..', p));
const NEEDS = [
  [/^(ultras|raid plan|vendor fixes|proven)\b/i,'ultras/SeraphUltras/IndividualUltras', 'the vendored Ultras v3 scripts (node tools/vendor-ultras.js)'],
  [/^(stylist|priority look)\b/i,'data/dreams.json', 'look data in app/data'],
  [/^enhance plan: the community sheet/i, 'lib/forge-sheet.json', 'the community forge sheet (lib/forge-sheet.json)'],
];
global.test = (name, fn, timeout = 20000) => tests.push({ name, fn, timeout });
global.assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
global.eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

const filter = process.argv[2] || '';
for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.test.js')).sort()) require(path.join(__dirname, f));

(async () => {
  let pass = 0; let fail = 0; let skip = 0;
  const started = Date.now();
  for (const t of tests.filter((x) => x.name.includes(filter))) {
    const need = NEEDS.find(([rx, p]) => rx.test(t.name) && !has(p));
    if (need) { skip++; console.log(`  - ${t.name} (skipped: needs ${need[2]})`); continue; }
    const t0 = Date.now();
    try {
      await Promise.race([t.fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${t.timeout}ms`)), t.timeout))]);
      pass++;
      console.log(`  \u2714 ${t.name} (${Date.now() - t0} ms)`);
    } catch (e) {
      fail++;
      console.log(`  \u2718 ${t.name}\n      ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  // On the laptop the literal Windows path became a file named "<seraph>\logs\last-test.txt" in the app folder.
  const last = path.join(require('os').tmpdir(), 'seraph-last-test.txt');
  try { fs.writeFileSync(last, `${new Date().toISOString()} ${pass} passed, ${fail} failed\n`); } catch (e) { /* no logs folder */ }
  process.exit(fail ? 1 : 0);
})();
