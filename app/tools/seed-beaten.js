// Seeds each character's soloBosses.json ("beaten before", lib/manners.js rule 1) from its own history: the monsters
// of every daily it has turned in before. soloBosses.json only started with the manners change (2026-09-26 22:00), so
// the bots "forgot" they had done NCS Gem (Shadow Lord) alone every day and waited for strangers instead (the owner
// 2026-09-27: "if the bots can already defeat this thing without needing an outside help make them do it by
// themselves"). Safe to run again: existing entries are kept.
// Usage (service stopped or not, it only touches soloBosses.json):  node tools/seed-beaten.js [--dry]
'use strict';
const fs = require('fs');
const path = require('path');
const { P } = require('../lib/paths');
const knowledge = require('../lib/knowledge');
const { readJson, writeJson } = require('../lib/util');

const dry = process.argv.includes('--dry');
const dailies = knowledge.dailies();
for (const id of fs.readdirSync(P.ACCOUNTS_DIR)) {
  const dir = P.account(id);
  const jf = path.join(dir, 'journal.log');
  if (!fs.existsSync(jf)) continue;
  const turned = new Set();
  const text = fs.readFileSync(jf, 'utf8');
  for (const m of text.matchAll(/turned in (\d+)/g)) turned.add(Number(m[1]));
  const file = path.join(dir, 'soloBosses.json');
  const solo = readJson(file, {}) || {};
  const added = [];
  for (const d of dailies) {
    if (!d.quests.some((q) => turned.has(q))) continue;
    for (const s of d.steps) {
      if (s.kind !== 'hunt') continue;
      for (const mon of s.monsters || []) {
        if (!mon || mon === '*' || solo[mon]) continue;
        solo[mon] = `seeded: daily ${d.name} turned in before`;
        added.push(`${mon} (${d.name})`);
      }
    }
  }
  console.log(`${id}: +${added.length} ${added.join(', ')}`);
  if (!dry && added.length) writeJson(file, solo);
}
