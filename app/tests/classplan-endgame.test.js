// Check-up 2026-10-05: owned endgame classes (often in the bank) beat the starter routes, for Skua (CBO) and Seraph.
const classplan = require('../lib/classplan');

test('classplan: an owned endgame class beats the starter route', async () => {
  eq(classplan.classFor('sable7', 'solo', ['dragonslayer', 'horc evader']).name, 'Dragonslayer', 'starters only: the route');
  eq(classplan.classFor('sable7', 'solo', ['dragonslayer', 'archpaladin']).name, 'ArchPaladin');
  eq(classplan.classFor('nova7', 'solo', ['horc evader', 'stonecrusher']).name, 'StoneCrusher');
  eq(classplan.classFor('valen7', 'farm', ['master ranger', 'archpaladin']).name, 'Master Ranger', 'AP is no farmer');
});

test('bot: banked classes count as owned and are never banked by the chore', async () => {
  const { Bot } = require('../lib/bot');
  const b = Object.create(Bot.prototype);
  b.items = async () => [{ sName: 'Dragonslayer', sType: 'Class', ItemID: 1, CharItemID: 11 }, { sName: 'Old Sword', sType: 'Sword', ItemID: 2, CharItemID: 12 }];
  b._bank = { t: Date.now(), items: [{ sName: 'ArchPaladin', sType: 'Class', ItemID: 3, CharItemID: 13 }] };
  b.playing = async () => true;
  eq((await b.ownedClasses()).sort(), ['ArchPaladin', 'Dragonslayer']);
  b.g = async (p, d) => (p === 'world.myAvatar.objData.iBankSlots' ? 50 : d);
  b.keepNames = () => new Set();
  b.bankItems = async () => [];
  eq((await b.bankableOther()).map((i) => i.sName), ['Old Sword'], 'classes stay in the backpack');
});
