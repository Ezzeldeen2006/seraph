// Seraph's fixes for broken Skua scripts (lib/scriptfix.js): patches re-applied to whatever the library is today, and
// a loud report when one stops applying. 2026-09-26: an unrelated upstream edit retired the full-copy Core13LoC fix
// silently, and three characters farmed Ryoku for a medal that can't drop.
const fs = require('fs');
const path = require('path');
const scriptfix = require('../lib/scriptfix');
const { P } = require('../lib/paths');

function tmpdirs() {
  const root = path.join(process.env.SERAPH_ROOT, `fix-${Math.random().toString(36).slice(2, 7)}`);
  const lib = path.join(root, 'lib'); const out = path.join(root, 'live');
  fs.mkdirSync(path.join(lib, 'Story'), { recursive: true });
  return { lib, out };
}

test('script fixes: a patch follows the library through unrelated upstream changes and fails loudly when its anchor goes', async () => {
  const { lib, out } = tmpdirs();
  const rel = 'Story/Core.cs';
  const file = path.join(lib, 'Story', 'Core.cs');
  scriptfix.reload({ [rel]: { why: 'boss never drops', patches: [{ find: '        Story.KillQuest(382);\n', replace: '        return; // fixed\n' }] } });
  try {
    fs.writeFileSync(file, 'class A {\r\n    void K() {\r\n        Story.KillQuest(382);\r\n    }\r\n}\r\n');
    let r = scriptfix.refresh({ scriptsDir: lib, out });
    eq(r.map((x) => x.status), ['applied'], 'CRLF library, LF patch');
    const live = JSON.parse(fs.readFileSync(path.join(out, 'fixes.json'), 'utf8'));
    eq(live[rel].base, scriptfix.hash(fs.readFileSync(file, 'utf8')), 'the engine sees today\'s library hash');
    assert(/return; \/\/ fixed/.test(fs.readFileSync(path.join(out, 'Story', 'Core.cs'), 'utf8')), 'the fixed text is next to it');
    // Upstream edits something else (what happened on 2026-09-26): the fix keeps working.
    fs.writeFileSync(file, 'class A {\n    // upstream edit\n    void K() {\n        Story.KillQuest(382);\n    }\n}\n');
    r = scriptfix.refresh({ scriptsDir: lib, out });
    eq(r[0].status, 'applied');
    eq(scriptfix.problems(r, out), [], 'nothing to report');
    // Upstream changes the line itself: failed, not in the live set, reported once.
    fs.writeFileSync(file, 'class A {\n    void K() {\n        Story.KillQuest(382, "dragonkoi");\n    }\n}\n');
    r = scriptfix.refresh({ scriptsDir: lib, out });
    eq(r[0].status, 'failed');
    assert(/anchor found 0x/.test(r[0].detail), r[0].detail);
    eq(Object.keys(JSON.parse(fs.readFileSync(path.join(out, 'fixes.json'), 'utf8'))), [], 'the engine runs the library version');
    eq(scriptfix.problems(r, out).length, 1, 'reported');
    eq(scriptfix.problems(r, out).length, 0, 'once per library version');
    // A copy fix retires (and is reported) when its file changes.
    scriptfix.reload({ [rel]: { why: 'old copy', base: 'f'.repeat(64) } });
    r = scriptfix.refresh({ scriptsDir: lib, out });
    eq(r[0].status, 'retired');
  } finally { scriptfix.reload(null); }
});

test('script fixes: every shipped fix applies to the current Skua library', async () => {
  if (!fs.existsSync(path.join(P.SCRIPTS, 'CoreBots.cs'))) return;   // no library on this machine
  const out = path.join(process.env.SERAPH_ROOT, 'fix-live-current');
  const r = scriptfix.refresh({ out });
  for (const x of r) assert(x.status === 'applied', `${x.rel}: ${x.status} ${x.detail || ''} - re-base it (git pull the library first)`);
  const core = fs.readFileSync(path.join(out, 'Story', 'LordsofChaos', 'Core13LoC.cs'), 'utf8');
  assert(/Skipping the rest of the Kitsune chapter/.test(core) && /MapItemQuest\(2918, "overworld", 1804\)/.test(core), 'both Core13LoC fixes are in');
});
