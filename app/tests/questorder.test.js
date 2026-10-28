// Quest requirement order (lib/questorder.js) and Seraph's fixed copies of broken Skua scripts (lib/scriptfix.js).
const fs = require('fs');
const path = require('path');
const protocol = require('../lib/net/protocol');
const { HeadlessClient } = require('../lib/net/headless');
const questorder = require('../lib/questorder');
const scriptfix = require('../lib/scriptfix');

const pkt = (o) => protocol.parse(JSON.stringify({ t: 'xt', b: { r: -1, o } }));

test('quest order: the index keeps only quests the real client lists out of item-ID order', async () => {
  const text = JSON.stringify([
    { ID: 9881, Slot: 1, Name: 'Fang Profile', AcceptRequirements: [], Requirements: [{ ItemID: 88249 }, { ItemID: 88250 }], Rewards: [] },
    { ID: 9882, Slot: 1, Name: 'Necro-Putrefaction', AcceptRequirements: [{ ItemID: 1 }], Requirements: [{ ItemID: 88252, sName: 'Lamprey Tentacle' }, { ItemID: 88251, sName: "Horde's Horn" }], Rewards: [{ ItemID: 5 }, { ItemID: 4 }] },
    { ID: 9883, Slot: 1, Name: 'Counterpirate', AcceptRequirements: [], Requirements: [{ ItemID: 88253 }], Rewards: [] },
  ], null, 2);
  eq(questorder.scan(text), { 9882: [88252, 88251] }, 'ascending and single-item quests need nothing; rewards are not requirements');
});

// Necro-Putrefaction (9882), 2026-09-21: Skua's KillQuest pairs requirements with its monster list by position. The
// headless world handed Skua the requirements sorted by ID, so Horde's Horn went to the Vampiric Lamprey and never
// dropped; Nova7 and Oren7 hunted it for hours.
test('quest order: world.questTree reaches Skua in the real client\'s order, other reads are untouched', async () => {
  questorder.setIndex({ 9882: [88252, 88251] });
  const c = new HeadlessClient({ id: 'qotest', label: 'qotest', username: 'Tester' });
  c.write = (m) => c.swf.onOutgoing(m);
  c.sock = { destroyed: false };
  c.handle(pkt({ cmd: 'getQuests', quests: {
    9882: { QuestID: 9882, sName: 'Necro-Putrefaction', turnin: [{ ItemID: 88252, iQty: 12 }, { ItemID: 88251, iQty: 6 }],
      oItems: { 88251: { ItemID: 88251, sName: "Horde's Horn", iQty: 6 }, 88252: { ItemID: 88252, sName: 'Lamprey Tentacle', iQty: 12 } }, oRewards: {}, oReqd: {} },
    9881: { QuestID: 9881, sName: 'Fang Profile', turnin: [], oItems: { 88249: { ItemID: 88249, sName: "Horde's Gold Ring" }, 88250: { ItemID: 88250, sName: 'Follow Red Trail' } }, oRewards: {}, oReqd: {} },
  } }));
  const names = (json, id) => { const t = JSON.parse(json); const q = t[id] || t; return Object.values(q.oItems).map((i) => i.sName); };
  // JSON.parse would sort the keys again, so the order is checked on the raw text Skua receives.
  const tree = c.swf.call('getGameObject', ['world.questTree']);
  assert(tree.indexOf('Lamprey Tentacle') < tree.indexOf("Horde's Horn"), `9882 in the game's order: ${tree}`);
  assert(tree.indexOf("Horde's Gold Ring") < tree.indexOf('Follow Red Trail'), 'quests not in the index keep their order');
  const one = c.swf.call('getGameObjectKey', ['world.questTree', '9882']);
  assert(one.indexOf('Lamprey Tentacle') < one.indexOf("Horde's Horn"), `one quest too: ${one}`);
  eq(names(one, 9882).sort(), ["Horde's Horn", 'Lamprey Tentacle'], 'still valid JSON with both items');
  eq(JSON.parse(one).turnin, [{ ItemID: 88252, iQty: 12 }, { ItemID: 88251, iQty: 6 }]);
  // The world model itself is untouched: clones, Object.keys and plain JSON see nothing new.
  eq(Object.keys(JSON.parse(JSON.stringify(c.swf.w.questTree[9882].oItems))), ['88251', '88252']);
  const plain = { a: [1, { b: 2 }], s: 'x"', n: null, u: undefined, 7: { sName: 'not a quest' } };
  eq(questorder.json(plain), JSON.stringify(plain), 'anything that is not a reordered quest serializes exactly as JSON.stringify does');
});

test('script fixes: the fixed copy runs only while the library file is the version it was written for', async () => {
  const rel = 'Seasonal/TalkLikeaPirateDay/BlazeBeardStory.cs';
  const lib = path.join(process.env.SERAPH_ROOT, 'fixlib');
  const file = path.join(lib, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fixed = fs.readFileSync(path.join(scriptfix.DIR, ...rel.split('/')), 'utf8');
  assert(/SERAPH FIX/.test(fixed) && /case 4517:\s*\n\s*Core\.HuntMonster\("BlazeBeard", "Undead Pirate", "Darkness Energy", 8\)/.test(fixed), 'the fix farms Darkness Energy for 4517');
  const fixes = JSON.parse(fs.readFileSync(path.join(scriptfix.DIR, 'fixes.json'), 'utf8'));
  assert(fixes[rel] && /^[0-9a-f]{64}$/.test(fixes[rel].base), 'fixes.json knows the upstream hash');
  fs.writeFileSync(file, 'public class Changed {}\n');
  eq(Object.keys(scriptfix.resolve(rel, lib)), ['retired'], 'library changed upstream: the fix retires');
  eq(scriptfix.resolve('Other/Nothing.cs', lib), null);
  const orig = path.join(require('../lib/paths').P.SCRIPTS, ...rel.split('/'));
  if (fs.existsSync(orig) && scriptfix.hash(fs.readFileSync(orig, 'utf8')) === fixes[rel].base) {
    fs.writeFileSync(file, fs.readFileSync(orig, 'utf8').replace(/\r?\n/g, '\r\n'));
    const r = scriptfix.resolve(rel, lib);
    assert(r && r.path && r.path.endsWith('BlazeBeardStory.cs'), 'same file (even with CRLF): the fix runs');
  }
});
