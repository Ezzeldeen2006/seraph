// The owner 2026-10-06: "use the daily boosts they get". bot.useBoosts at task start.
const { Bot } = require('../lib/bot');

function fakeBot({ lvl = 96, items = [], bank = [], objData = {}, rank = 10 }) {
  const b = Object.create(Bot.prototype);
  const inv = items.map((x) => ({ ...x }));
  const bk = bank.map((x) => ({ ...x }));
  b.level = async () => lvl;
  b.items = async () => inv.filter((i) => i.iQty > 0);
  b.bankItems = async () => bk.filter((i) => i.iQty > 0);
  b.freeSlots = async () => 10;
  b.room = async () => 1;
  b.wait = async () => {};
  b.waitFor = async (fn) => fn();
  b.lines = []; b.journal = (t) => b.lines.push(t);
  b.sent = [];
  b.unbank = async (name) => { const i = bk.findIndex((x) => x.sName === name); if (i < 0) return false; inv.push(bk[i]); bk.splice(i, 1); return true; };
  b.client = { swf: { w: { myAvatar: { objData } } }, send: async (p) => { b.sent.push(p); const id = Number(p.split('%')[6]); const it = inv.find((i) => i.ItemID === id); if (it) it.iQty--; } };
  b.hub = { constructor: { classRank: () => rank } };
  return b;
}
const login = () => [
  { ItemID: 1, sName: 'Daily Login XP Boost! (20 min)', sType: 'ServerUse', iQty: 4 },
  { ItemID: 2, sName: 'Daily Login Class Boost  (20 min)', sType: 'ServerUse', iQty: 4 },
  { ItemID: 3, sName: 'Daily Login Rep Boost! (20 min)', sType: 'ServerUse', iQty: 4 },
  { ItemID: 4, sName: 'Daily Login Gold Boost! (20 min)', sType: 'ServerUse', iQty: 4 },
];

test('boosts: XP below 100, class below rank 10, gold and rep always; from the bank too; never on chores or over a running one', async () => {
  let b = fakeBot({ bank: login() });
  eq(await b.useBoosts({ type: 'farmLevel', why: 'grinding XP' }), 3, 'level 96, rank 10 class: XP + rep + gold (out of the bank)');
  assert(b.sent.some((p) => p.includes('%serverUseItem%1%+%1%')), b.sent.join(' '));
  assert(!b.sent.some((p) => p.endsWith('%+%2%')), 'no class boost on a rank 10 class');
  b = fakeBot({ items: login() });
  eq(await b.useBoosts({ type: 'bankAc' }), 0, 'chores use nothing');
  b = fakeBot({ items: login(), objData: { iBoostXP: 600, iBoostG: 30, iBoostRep: 10 } });
  eq(await b.useBoosts({ type: 'farmLevel' }), 0, 'all three still running');
  b = fakeBot({ lvl: 100, items: login(), rank: 4 });
  eq(await b.useBoosts({ type: 'script', path: 'Other/X.cs', why: 'x' }), 3, 'level 100: class (rank 4) + rep + gold, no XP');
  assert(!b.sent.some((p) => p.endsWith('%+%1%')), 'no XP boost at 100');
});

test('bot: boosts are never banked by the chore', async () => {
  const b = Object.create(Bot.prototype);
  b.items = async () => [{ sName: 'Daily Login XP Boost! (20 min)', sType: 'ServerUse', ItemID: 1, CharItemID: 11, iQty: 4 }, { sName: 'Old Sword', sType: 'Sword', ItemID: 2, CharItemID: 12 }];
  b.g = async (p, d) => (p === 'world.myAvatar.objData.iBankSlots' ? 50 : d);
  b.keepNames = () => new Set();
  b.bankItems = async () => [];
  eq((await b.bankableOther()).map((i) => i.sName), ['Old Sword']);
});
