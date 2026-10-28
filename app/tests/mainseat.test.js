// The owner 2026-10-22: "if the bots cant do it without LR then make my main help them and make sure that everyone gets the
// quest done." A boss the bots can't do alone (no line-up, or lost this period) runs with the main in one seat
// (ultraready.WITH_MAIN, mostly Legion Revenant) and the three bots who still need the turn-in, again and again until
// none does.
const { Hub } = require('../lib/hub');
const ultraready = require('../lib/ultraready');
const cbo = require('../lib/skua/cbo');

const R10 = 302500;
const vet = (id, classes) => ({ id, level: 100, classes, enhancements: [], weapon: { value: 0.4 } });
// The party on 2026-10-22: no Verus DoomKnight, no King's Echo.
const FOUR = [
  vet('sable7', ['Lord of Order', 'StoneCrusher']),
  vet('valen7', ['StoneCrusher', 'ArchPaladin', 'Void Highlord', 'Shaman']),
  vet('nova7', ['Void Highlord', 'StoneCrusher', 'ArchFiend', 'Shaman']),
  vet('oren7', ['ArchPaladin', 'Arcana Invoker']),
];
const MAIN_CLASSES = ['Legion Revenant', 'Verus DoomKnight', "King's Echo", 'ArchPaladin', 'Lord of Order', 'StoneCrusher'];

test('ultraready: the bots alone lack Tyndarius, beside the main they have it (LoO, SC, AP + his KE: loo-sc-ap-ke)', () => {
  const r = ultraready.check(FOUR);
  const t = r.bosses['ultra-tyndarius'];
  eq(t.ready, false);
  eq(t.withMain.ready, true, t.withMain.missing.join('; '));
  eq(t.withMain.main, ['Legion Revenant', "King's Echo"]);   // The owner 2026-10-26: his main is Legion Revenant (left orb), KE the fallback
  eq(t.withMain.seats.map((s) => s.cls).sort(), ['ArchPaladin', 'Lord of Order', 'StoneCrusher']);
  for (const id of ['ultra-drago', 'ultra-darkon', 'ultra-speaker', 'ultra-dage']) eq(r.bosses[id].withMain.ready, true, `${id}: ${r.bosses[id].withMain.missing.join('; ')}`);
  eq(r.bosses['ultra-dage'].withMain.main, ['Verus DoomKnight']);
});

test('ultraready: beside the main, the bots who still need the turn-in are seated first', () => {
  const b = ultraready.BOSSES.find((x) => x.id === 'ultra-warden');
  const all = ultraready.withMain(b, FOUR, {}, null);
  const left = FOUR.find((m) => !all.seats.some((s) => s.id === m.id)).id;
  const again = ultraready.withMain(b, FOUR, {}, [left]);
  assert(again.seats.some((s) => s.id === left), `${left} left out first, seated once only she needs it: ${JSON.stringify(again.seats)}`);
  eq(again.ready, true);
});

test("ultraready: Ultra Speaker's AP Listen seat goes to a planned AP, not to the one who needs the turn-in (2026-10-24)", () => {
  const b = ultraready.BOSSES.find((x) => x.id === 'ultra-speaker');
  // The 2026-10-24 party: Nova (planned VDK) owns ArchPaladin too and still needs the quest.
  const party = FOUR.map((m) => (m.id === 'nova7' ? { ...m, classes: [...m.classes, 'ArchPaladin'] } : m));
  const r = ultraready.withMain(b, party, {}, ['nova7']);
  eq(r.ready, true, r.missing.join('; '));
  const ap = r.seats.find((s) => s.cls === 'ArchPaladin');
  assert(r.seats.some((s) => s.id === 'nova7'), 'she still gets a seat for her turn-in');
  assert(ap && ap.id !== 'nova7', `the Listen taunter is a planned AP (Valen or Oren), not Nova: ${JSON.stringify(r.seats)}`);
  eq(r.seats.find((s) => s.id === 'nova7').cls, 'StoneCrusher', 'Nova takes the StoneCrusher seat');
});

function mainHub({ need, botReady = false, tries = null, mainFree = true }) {
  const h = Object.create(Hub.prototype);
  h.settings = { raids: { done: {}, tries: tries || {} }, levelParty: { room: 13579 } };
  h.infos = []; h.info = (t) => h.infos.push(t); h.notify = () => {}; h.saveSettings = () => {};
  h.raidPotionsWrite = () => false;
  h.raidSeats = (s) => { h.seatsWritten = s; return s; };
  h.partyRoom = (b) => (Hub.isGuest(b) ? null : 13579);
  h.bots = new Map();
  for (const m of FOUR) {
    h.bots.set(m.id, { id: m.id, running: true, paused: false, serverName: 'Swordhaven', queue: [], settings: {}, restarts: 0,
      account: { label: m.id, username: m.id, kind: 'party' }, current: { type: 'script', brain: true }, journal() {}, restart() { this.restarts++; },
      questAvailable: async () => need.has(m.id) });
  }
  h.bots.set('grail26', { id: 'grail26', running: true, paused: false, serverName: 'Swordhaven', queue: [], settings: { privateRoom: 24680 }, restarts: 0,
    account: { label: 'GRAIL26', username: 'GRAIL26', kind: 'guest', helper: true }, client: { state: { loaded: true } },
    current: mainFree === 'order' ? { type: 'script', path: 'Enhancement/UnlockForgeEnhancements.cs', entry: 'Elysium' } : mainFree ? { type: 'script', path: 'Other/Classes/ArcanaInvoker.cs', brain: true } : { type: 'assist', main: 'x' }, journal() {}, restart() { this.restarts++; },
    classPoints: async () => MAIN_CLASSES.map((name) => ({ name, cp: R10 })), questAvailable: async () => true });
  h.bot = (id) => h.bots.get(id);
  h._ultraMembers = FOUR;
  const check = ultraready.check(FOUR);
  // Only Ultra Warden is in play here.
  for (const [id, b] of Object.entries(check.bosses)) if (id !== 'ultra-warden') { b.ready = false; b.withMain = null; }
  check.bosses['ultra-warden'].ready = botReady;
  h._ultra = check;
  return h;
}

test('raids: a boss the bots have no line-up for runs with the main in his seat and three bots who need it', async () => {
  const need = new Set(['sable7', 'valen7', 'nova7', 'oren7']);
  const h = mainHub({ need });
  const r = await h.raidTick();
  assert(r, h.infos.join(' | '));
  eq(r.boss, 'ultra-warden');
  eq(r.withMain, 'grail26');
  eq(r.members.length, 4);
  assert(r.members.includes('grail26'));
  eq(r.seats.find((s) => s.id === 'grail26').cls, 'Legion Revenant');
  eq(r.room, 13579, "the party's room, not his private 24680");
  assert(r.gain.includes('grail26'), 'his own turn-in counts too');
});

test('raids: after a kill the bot left out comes in next; when nobody needs it the boss is booked', async () => {
  const need = new Set(['sable7', 'valen7', 'nova7', 'oren7']);
  const h = mainHub({ need });
  let r = await h.raidTick();
  const out = FOUR.map((m) => m.id).find((id) => !r.members.includes(id));
  // The three turn it in, so does the main, and the raid closes as a kill.
  for (const id of r.members) if (id !== 'grail26') need.delete(id);
  h.bot('grail26').turnedIn = new Map([[8153, Date.now()]]);
  h.raidClose(true);
  eq(h.raid, null);
  eq(h.settings.raids.done['ultra-warden'], undefined, `not booked while ${out} still needs it`);
  r = await h.raidTick();
  assert(r && r.members.includes(out), `${out} is seated in the rerun: ${r && r.members}`);
  need.delete(out);
  h.raidClose(true);
  eq(await h.raidTick(), null);
  assert(h.settings.raids.done['ultra-warden'], 'booked once every bot has it');
});

test('raids: the bots try their own line-up first; after a lost try the main joins', async () => {
  const need = new Set(['sable7', 'valen7', 'nova7', 'oren7']);
  let h = mainHub({ need, botReady: true });
  h.raidDue = () => [];   // the bots' own path is not under test here
  eq(await h.raidTick(), null, 'no main while the bots have not tried');
  const key = require('../lib/schedule').periodKey('day', new Date());
  h = mainHub({ need, botReady: true, tries: { 'ultra-warden': { key, n: 1 } } });
  const r = await h.raidTick();
  assert(r && r.withMain, h.infos.join(' | '));
});

test('raids: the main on one of the owner orders still takes his seat; the order waits for the raid', async () => {
  const h = mainHub({ need: new Set(['sable7', 'valen7', 'nova7', 'oren7']), mainFree: 'order' });
  h.bot('grail26').queue = [{ type: 'script', path: 'Other/Classes/ArchMage/0ArchMage.cs' }];
  h.raidDue = () => [];
  const r = await h.raidTick();
  assert(r && r.withMain === 'grail26', h.infos.join(' | '));
  eq(h.bot('grail26').restarts, 1, 'his order is paused (the restart puts it back in front of the queue)');
  eq(h.raidTask(h.bot('grail26')).type, 'script', 'the raid comes before his orders');
});

test('raids: the main busy helping elsewhere - no main raid', async () => {
  const h = mainHub({ need: new Set(['sable7', 'valen7', 'nova7', 'oren7']), mainFree: false });
  h.raidDue = () => [];
  eq(await h.raidTick(), null);
  assert(h.infos.some((t) => /needs the main in a seat - he is not free/.test(t)), h.infos.join(' | '));
});

test('raids: two lost fights with the main end his period; a partial kill is not one of them', async () => {
  const need = new Set(['sable7', 'valen7', 'nova7', 'oren7']);
  const h = mainHub({ need });
  h.raidDue = () => [];
  let r = await h.raidTick();
  r.partial = { died: ['nova7'], done: [] };
  h.raidClose(false);
  eq(h.settings.raids.mainTries, {}, 'a partial kill is no lost fight');
  r = await h.raidTick();
  h.raidClose(false);
  r = await h.raidTick();
  h.raidClose(false);
  eq(await h.raidTick(), null, 'two lost fights: done for the period');
});

test('cbo: in a raid the main gets the raid room and SeraphNeverEnhance; bots get it off', async () => {
  const hub = { raid: { id: 'raid-1', room: 13579 }, settings: {}, partyRoom: () => null };
  const main = { account: { kind: 'guest' }, settings: { privateRoom: 24680 }, current: { raid: 'raid-1' }, hub };
  const k = await cbo.keysFor(main);
  eq(k.PrivateRoomNr, '13579');
  eq(k.SeraphNeverEnhance, 'True');
  eq(k.DisableAutoEnhance, 'True');
  const out = await cbo.keysFor({ ...main, current: { type: 'script' } });
  eq(out.PrivateRoomNr, '24680', 'his own room outside raids');
  const bot = { account: { kind: 'party' }, settings: {}, current: { raid: 'raid-1' }, hub, ownedClasses: async () => [] };
  eq((await cbo.keysFor(bot)).SeraphNeverEnhance, 'False');
});

test('vendor fixes: role classes follow the seats file on every use (no static readonly)', () => {
  const { FIXES } = require('../tools/vendor-ultras');
  const seat = FIXES.filter(([, , to]) => /SeraphSeatOr\(/.test(to) && /IndividualUltras/.test(to) === false);
  assert(seat.length >= 4, 'four role fixes');
  for (const [file, , to] of seat) assert(!/static readonly string \w+ = UltraPotions/.test(to), `${file}: a field would keep the first raid's seat`);
  for (const f of ['5ChampionDrakathv3', '7UltraDragov3', '8UltraDarkonv3', '11UltraGramielv3']) {
    const text = require('fs').readFileSync(require('path').join(__dirname, '..', 'ultras', 'SeraphUltras', 'IndividualUltras', `${f}.cs`), 'utf8');
    assert(/UltraClassesByRole => new\[\]/.test(text), `${f}: line-up rebuilt per use`);
    assert(/=> UltraPotions\.SeraphSeatOr\(/.test(text), `${f}: role read per use`);
  }
});


// 2026-10-22: Ezrajal and Engineer were called off ~10 times without potions and the policy never noticed - a
// called-off fight has no Attempt reports, only the hub's own boss-HP readings.
test('potions: a fight called off mid-way counts as lost without potions; 3 of them turn potions on', () => {
  const h = Object.create(Hub.prototype);
  h.settings = {}; h.infos = []; h.info = (t) => h.infos.push(t); h.notify = () => {};
  for (let i = 0; i < 3; i++) h.raidPotionsLearn({ boss: 'ultra-ezrajal', name: 'Ultra Ezrajal', potions: false, fight: { startAt: 1, samples: [] } }, false);
  eq(h.settings.potionPolicy['ultra-ezrajal'].offFails, 3);
  eq(h.settings.potionPolicy['ultra-ezrajal'].on, true);
  h.raidPotionsLearn({ boss: 'ultra-engineer', name: 'Ultra Engineer', potions: false }, false);
  eq(h.settings.potionPolicy['ultra-engineer'], undefined, 'never reached the boss: no verdict');
});

// 2026-10-22: the proven Tyndarius kill is upstream's loo-sc-ap-ke - Seraph only ever picked its own Comps or the default.
test('ultras: the raid picks the script own Comp whose classes are the seats (Tyndarius loo-sc-ap-ke)', () => {
  const ultras = require('../lib/ultras');
  const t = ultraready.BOSSES.find((b) => b.id === 'ultra-tyndarius');
  eq(ultras.compFor(t, ['Lord of Order', 'StoneCrusher', 'ArchPaladin', "King's Echo"]), 'loo-sc-ap-ke');
  eq(ultras.compFor(t, ["King's Echo", 'Legion Revenant', 'ArchPaladin', 'Lord of Order']), 'seraph-loo-ap-lr-ke', 'the owner recipe: AP + LoO hold Tyndarius, LR the left orb, KE the right');
  eq(ultras.compFor(t, ['Lord of Order', 'StoneCrusher', 'ArchPaladin', 'Legion Revenant']), 'seraph-loo-sc-ap-lr', 'the main as LR: SC takes the right orb');
  eq(ultras.compFor(t, ['Lord of Order', 'Void Highlord', 'ArchPaladin', 'Legion Revenant']), 'seraph-loo-ap-lr-vhl');
  eq(ultras.compFor(ultraready.BOSSES.find((b) => b.id === 'ultra-ezrajal'), ['Lord of Order', 'StoneCrusher', 'ArchPaladin', 'Void Highlord']), 'seraph-loo-sc-ap-vhl', 'Seraph Comps first');
});

// The owner 2026-10-22: "give my main potions and make sure he also grabs the quests".
test('raids: the bots booked a boss but the main has not turned it in - it runs once more for him', async () => {
  const need = new Set();
  const h = mainHub({ need, botReady: true });
  h.raidDue = () => [];
  h.settings.raids.done['ultra-warden'] = require('../lib/schedule').periodKey('day', new Date());
  const r = await h.raidTick();
  assert(r && r.withMain === 'grail26', h.infos.join(' | '));
  eq(r.gain, ['grail26']);
  assert(h.infos.some((x) => /for the main.s own turn-in/.test(x)), h.infos.join(' | '));
  // He turns it in: nothing more to do.
  h.bot('grail26').turnedIn = new Map([[8153, Date.now()]]);
  h.raidClose(true);
  eq(await h.raidTick(), null);
});

test('raids: the main drinks potions in his seat, the bots follow the potion policy', () => {
  const h = Object.create(Hub.prototype);
  h.settings = { potionPolicy: {} }; h.info = () => {};
  const fs = require('fs'); const path = require('path'); const { P } = require('../lib/paths');
  const mk = (id, guest) => ({ id, account: { username: id, kind: guest ? 'guest' : 'party' } });
  h.raidPotionsWrite({ id: 'ultra-warden' }, [mk('sable7'), mk('GRAIL26', true)]);
  const lines = fs.readFileSync(path.join(P.ROOT, 'raid-potions.txt'), 'utf8').trim().split(/\r?\n/);
  eq(lines, ['sable7=off', 'GRAIL26=on']);
  h.settings.mainPotions = false;
  h.raidPotionsWrite({ id: 'ultra-warden' }, [mk('GRAIL26', true)]);
  eq(fs.readFileSync(path.join(P.ROOT, 'raid-potions.txt'), 'utf8').trim(), 'GRAIL26=off');
});

// 2026-10-22: a full bag stopped the main's Warden script while it bought potion reagents.
test('raid room: a raid seat banks for room when fewer than 10 backpack slots are free, else leaves the bag alone', async () => {
  const { Bot } = require('../lib/bot');
  const mk = (free) => { const b = Object.create(Bot.prototype); b.banked = []; b.journal = () => {}; b.freeSlots = async () => free; b.bankAc = async (max, target) => { b.banked.push(target); return 3; }; return b; };
  const full = mk(2);
  eq(await full.raidRoom(), 3);
  eq(full.banked, [10]);
  const roomy = mk(25);
  eq(await roomy.raidRoom(), 0);
  eq(roomy.banked, []);
  assert(Bot.prototype.makeRoomFor.toString().includes('inventory full'), '"Inventory full, cannot buy items." is caught too');
});

test('main seat: the proven line-up first - a bot who needs the kill takes a non-critical seat of its class (2026-10-24)', () => {
  const { Hub } = require('../lib/hub');
  const recipes = require('../lib/recipes');
  const was = recipes.active;
  recipes.active = (id) => (id === 'ultra-speaker' ? { seats: [
    { id: 'sable7', cls: 'Lord of Order' }, { id: 'valen7', cls: 'StoneCrusher' }, { id: 'oren7', cls: 'ArchPaladin' }, { id: 'grail26', cls: 'Verus DoomKnight' }] } : null);
  try {
    const h = Object.create(Hub.prototype);
    const pool = [
      { id: 'sable7', classes: ['Lord of Order'] }, { id: 'valen7', classes: ['StoneCrusher', 'ArchPaladin'] },
      { id: 'oren7', classes: ['ArchPaladin'] }, { id: 'nova7', classes: ['StoneCrusher', 'Lord of Order', 'ArchPaladin'] }];
    const b = { id: 'ultra-speaker', name: 'Ultra Speaker' };
    const r = h.recipeSeats(b, pool, ['nova7'], 'grail26');
    eq(r.seats.map((s) => `${s.id}=${s.cls}`).join(' '), 'sable7=Lord of Order nova7=StoneCrusher oren7=ArchPaladin', 'Nova takes the SC seat, not the healer or the AP');
    eq(h.recipeSeats(b, pool, [], 'grail26'), null, 'nobody needs it: the usual pick decides');
    eq(h.recipeSeats(b, pool.filter((m) => m.id !== 'oren7'), ['nova7'], 'grail26'), null, 'a recipe member offline: the usual pick');
    eq(h.recipeSeats({ id: 'ultra-dage', name: 'Ultra Dage' }, pool, ['nova7'], 'grail26'), null, 'no recipe');
  } finally { recipes.active = was; }
});
