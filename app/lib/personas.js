// The Seraph party: four characters with their own temperament, class path, ultra slot and fashion sense.
// Version 2 (2026-09-24): new identities and a real sense of style. Each character has a `fashion` identity, taste
// words, a vanity (how willing it is to spend more than its daily hour of me time on looks, lib/fashion.js) and a
// dream outfit it picked by looking at the wiki pictures (data/dreams.json, merged in by get()).
// Traits (0..1) turn into brain settings, so the same brain behaves differently per character:
//   risk      — how many deaths before giving up a fight, how early it enters events
//   patience  — length of grind chunks (short bursts vs. long sessions)
//   diligence — dailies first thing after reset, or after some goal time
//   thrift    — gold kept in reserve before paying for enhancements
// Seasonal events are 2 h a day for everyone (the owner, 2026-09-24: events are for items you want, not for storylines).
// Paths are ids from progression.GOALS: each character farms its own specialty first. Every `must` goal is added
// after the path, so at endgame they all converge on the same ultra classes.
'use strict';
const fs = require('fs');
const path = require('path');

const PERSONAS = {
  sable7: {
    id: 'sable7',
    version: 2,
    lookSince: Date.parse('2026-09-24T16:14:00Z'),   // redesigned: one barber visit for the new look
    name: 'Sable',
    title: 'The Velvet Seraph',
    archetype: 'Support',
    sex: 'female',
    startClass: 'Healer',
    icon: '✦',
    color: '#a78bfa',
    motto: 'Heal you? Darling, I was going to anyway.',
    temperament: 'A glamorous, flirty diva of a healer. Graceful, vain and quietly competitive - she keeps the party alive and expects to look stunning doing it. Never skips a daily, would rather arrive late than arrive ugly.',
    traits: { risk: 0.2, patience: 0.8, diligence: 1.0, events: 0.6, thrift: 0.5 },
    ultraClass: 'Lord of Order',
    prefer: ['Lord of Order', 'StoneCrusher', 'Legion Revenant', 'ArchPaladin'],
    path: ['awe-enhancements', 'story-13loc', 'shaman', 'master-ranger', 'lord-of-order', 'stonecrusher', 'legion-revenant', 'forge-enhancements'],
    roles: {
      farm: ['Legion Revenant', 'Blaze Binder', 'Shaman', 'Master Ranger', 'Healer'],
      solo: ['Lord of Order', 'StoneCrusher', 'ArchPaladin', 'Legion Revenant', 'Healer'],
    },
    style: {
      palette: 'black, violet and silver',
      look: 'sultry celestial diva: sleek revealing gowns, corsets, thigh-high boots, halos and wings, silver jewellery',
      love: ['angel', 'seraph', 'halo', 'wing', 'celestial', 'divine', 'goddess', 'queen', 'empress', 'siren', 'enchantress', 'lady', 'gown', 'dress', 'corset', 'lace', 'velvet', 'silk', 'rose', 'star', 'moon', 'lunar', 'violet', 'purple', 'silver', 'feather', 'grace', 'diva', 'glam', 'elegant'],
      avoid: ['clown', 'moglin', 'chicken', 'pumpkin', 'cheese', 'banana', 'toilet', 'mustache', 'beard', 'sack', 'burlap', 'peasant', 'bulky', 'mech'],
      hideHelm: false,
    },
    fashion: {
      identity: 'sultry celestial diva',
      vanity: 0.85,
      love: ['angel', 'seraph', 'halo', 'wing', 'celestial', 'divine', 'goddess', 'queen', 'empress', 'siren', 'enchantress', 'gown', 'dress', 'corset', 'lace', 'velvet', 'silk', 'rose', 'lunar', 'moon', 'star', 'violet', 'purple', 'silver', 'feather', 'elegant', 'beauty', 'lovely'],
      avoid: ['bulky', 'heavy plate', 'mech', 'robot', 'beast', 'zombie', 'rotting'],
      veto: ['clown', 'moglin', 'chicken', 'pumpkin', 'cheese', 'banana', 'toilet', 'mustache', 'beard', 'burlap', 'peasant', 'potato', 'trash', 'diaper', 'onesie'],
      dream: [],
    },
    barber: { hair: ['^Long1$', 'SummerHairLong', 'Bangs2Long', 'Pony1Long'], hairColor: '#2b1b3d', eyeColor: '#8b5cf6', armor: ['#1a1325', '#7c3aed', '#cbd5e1'] },
    voice: {
      levelUp: ['Another level. Try to keep up, darlings.', 'Stronger and still flawless.'],
      drop: ['Into the vault, sweetie.', 'Mine now.'],
      death: ['Ugh. Not in these boots.', 'That was... undignified. Again.'],
      dropLove: ['Oh. {item}. Now THAT is my style.', '{item}? Gorgeous. Keeping it.'],
      wishStart: ['An hour for me. {item} won\'t earn itself.'],
      wishMore: ['{item} is so close. One more hour - beauty takes work.', 'I am NOT stopping now. {item}, come to me.'],
      wishStop: ['Fine. {item} can wait until tomorrow. Duty first, darlings.'],
      wishGot: ['{item} is MINE. Everyone look at me.', 'Finally, {item}. I have never looked better.'],
      wearDream: ['{item}. Now I feel like myself.'],
    },
  },

  valen7: {
    id: 'valen7',
    version: 2,
    lookSince: Date.parse('2026-09-24T16:14:00Z'),   // redesigned: one barber visit for the new look
    name: 'Valen',
    title: 'The Legion Vanguard',
    archetype: 'Tank',
    sex: 'male',
    startClass: 'Warrior',
    icon: '⛨',
    color: '#fbbf24',
    motto: 'The Legion does not break. Neither do I.',
    temperament: 'A grim, oath-sworn vanguard of the Undead Legion. Disciplined and stubborn, speaks little, grinds reputation for hours without complaint and stands in front so the others don\'t have to. Looks matter to him only as a banner: when enemies see him coming, they should know.',
    traits: { risk: 0.65, patience: 0.9, diligence: 0.9, events: 0.3, thrift: 0.8 },
    ultraClass: 'ArchPaladin',
    prefer: ['ArchPaladin', 'StoneCrusher', 'Verus DoomKnight', 'Lord of Order'],
    path: ['awe-enhancements', 'story-13loc', 'master-ranger', 'archpaladin', 'stonecrusher', 'shaman', 'void-highlord', 'forge-enhancements'],
    roles: {
      farm: ['Legion Revenant', 'Master Ranger', 'Shaman', 'Void Highlord', 'Warrior'],
      solo: ['ArchPaladin', 'Void Highlord', 'Verus DoomKnight', 'StoneCrusher', 'Warrior'],
    },
    style: {
      palette: 'black, bone and blood red',
      look: 'Undead Legion vanguard: heavy dark plate, skulls and horns, glowing eyes, a tattered war cape, a greatsword',
      love: ['legion', 'doom', 'doomknight', 'dread', 'death', 'skull', 'bone', 'undead', 'revenant', 'necro', 'dark', 'shadow', 'horn', 'plate', 'knight', 'warlord', 'general', 'commander', 'blood', 'crimson', 'black', 'greatsword', 'blade', 'grim', 'soul'],
      avoid: ['clown', 'moglin', 'bunny', 'kitty', 'pink', 'tutu', 'dress', 'gown', 'cute', 'fairy', 'flower'],
      hideHelm: false,
    },
    fashion: {
      identity: 'Undead Legion vanguard',
      vanity: 0.4,
      love: ['legion', 'doom', 'doomknight', 'dread', 'death', 'skull', 'bone', 'undead', 'revenant', 'necro', 'horn', 'plate', 'knight', 'warlord', 'general', 'commander', 'blood', 'crimson', 'greatsword', 'grim', 'soul', 'dark', 'shadow'],
      avoid: ['holy', 'angel', 'light', 'gold', 'shiny'],
      veto: ['clown', 'moglin', 'bunny', 'kitty', 'pink', 'tutu', 'dress', 'gown', 'fairy', 'flower', 'banana', 'chicken', 'onesie'],
      dream: [],
    },
    barber: { hair: ['^Normal$', 'Slickback1', 'Spikedown', 'Default'], hairColor: '#1f1f1f', eyeColor: '#dc2626', armor: ['#111111', '#e7e5e4', '#7f1d1d'] },
    voice: {
      levelUp: ['Stronger. The Legion endures.', 'Another rank earned.'],
      drop: ['To the vault.', 'Taken.'],
      death: ['I will rise again. The Legion always does.', 'Knocked down. Not out.'],
      dropLove: ['{item}. That will do.', '{item}. Worthy of the Legion.'],
      wishStart: ['An hour for the banner. {item}.'],
      wishMore: ['{item}. One more hour. Then back to the front.'],
      wishStop: ['Enough vanity. {item} waits. The ultras don\'t.'],
      wishGot: ['{item}. Now they will know who comes for them.'],
      wearDream: ['{item}. As it should be.'],
    },
  },

  nova7: {
    id: 'nova7',
    version: 2,
    lookSince: Date.parse('2026-09-24T16:14:00Z'),   // redesigned: one barber visit for the new look
    name: 'Nova',
    title: 'The Scarlet Kunoichi',
    archetype: 'DPS',
    sex: 'female',
    startClass: 'Rogue',
    icon: '☾',
    color: '#f43f5e',
    motto: 'Cute until the blade comes out.',
    temperament: 'A cocky, teasing ninja girl - cute on the surface, lethal underneath. Bold and restless, chases every rare drop, takes fights she probably shouldn\'t and loves showing off a new outfit right after she wins.',
    traits: { risk: 0.9, patience: 0.35, diligence: 0.55, events: 1.0, thrift: 0.3 },
    ultraClass: 'Verus DoomKnight',
    prefer: ['Verus DoomKnight', "King's Echo", 'Dragon of Time', 'ArchPaladin'],
    path: ['awe-enhancements', 'story-13loc', 'chaos-slayer', 'verus-doomknight', 'dragon-of-time', 'void-highlord', 'forge-enhancements'],
    roles: {
      farm: ['Legion Revenant', 'Dragon of Time', 'Chaos Slayer', 'Master Ranger', 'Rogue'],
      solo: ['Verus DoomKnight', 'Dragon of Time', 'Void Highlord', 'Chaos Slayer', 'Rogue'],
    },
    style: {
      palette: 'black, crimson and white',
      look: 'scarlet kunoichi: fitted ninja bodysuit, short skirt or shorts, a mask or fox ears, twin blades',
      love: ['ninja', 'kunoichi', 'shinobi', 'assassin', 'rogue', 'thief', 'blade', 'dagger', 'katana', 'kunai', 'kitsune', 'fox', 'neko', 'cat', 'mask', 'scarlet', 'crimson', 'red', 'blood', 'shadow', 'night', 'dusk', 'sakura', 'cherry', 'cute', 'lovely'],
      avoid: ['clown', 'moglin', 'pumpkin', 'chicken', 'wedding', 'bulky', 'mech', 'beard'],
      hideHelm: false,
    },
    fashion: {
      identity: 'cute-but-deadly scarlet kunoichi',
      vanity: 0.75,
      love: ['ninja', 'kunoichi', 'shinobi', 'assassin', 'rogue', 'thief', 'dagger', 'katana', 'kunai', 'kitsune', 'fox', 'neko', 'cat', 'mask', 'scarlet', 'crimson', 'red', 'blood', 'shadow', 'night', 'sakura', 'cherry', 'cute', 'lovely', 'yokai'],
      avoid: ['holy', 'robe', 'heavy plate', 'mech', 'robot'],
      veto: ['clown', 'moglin', 'pumpkin', 'chicken', 'banana', 'cheese', 'toilet', 'beard', 'mustache', 'burlap', 'peasant', 'diaper', 'potato', 'trash'],
      dream: [],
    },
    barber: { hair: ['Ponytail5', 'Pony4', 'Ponytail1', 'Pony1Long'], hairColor: '#f5f5f5', eyeColor: '#dc2626', armor: ['#111111', '#b91c1c', '#f5f5f5'] },
    voice: {
      levelUp: ['Faster. Cuter. Deadlier.', 'Level up! Did you see that?'],
      drop: ['Mine~', 'Yoink. Bank it.'],
      death: ['Tch. Again.', 'Ow! Okay, that one hurt.'],
      dropLove: ['Ooh, {item}! That\'s SO me.', '{item}? Cute. I\'m wearing it.'],
      wishStart: ['Me time! Let\'s go get {item}.'],
      wishMore: ['{item} is almost mine - five more minutes. Okay, an hour.', 'Not done with {item} yet!'],
      wishStop: ['Ugh, fine. {item} tomorrow. Back to the grind.'],
      wishGot: ['{item}!! Look at me, look at me!', 'Got {item}. Too cute, too deadly.'],
      wearDream: ['{item} on. Try and keep your eyes on the fight.'],
    },
  },

  oren7: {
    id: 'oren7',
    version: 2,
    lookSince: Date.parse('2026-09-24T16:14:00Z'),   // redesigned: one barber visit for the new look
    name: 'Oren',
    title: 'The Drifting Ronin',
    archetype: 'Caster',
    sex: 'male',
    startClass: 'Mage',
    icon: '✧',
    color: '#2dd4bf',
    motto: 'No rush. The ultra will still be there after tea.',
    temperament: 'A laid-back wandering ronin who happens to be a terrifying caster. Chill, unbothered and quietly efficient: tracks gold per hour without ever looking busy, loves long relaxed farming sessions and has opinions about good tea and good kimonos.',
    traits: { risk: 0.3, patience: 1.0, diligence: 1.0, events: 0.5, thrift: 1.0 },
    ultraClass: "King's Echo",
    prefer: ["King's Echo", 'Lord of Order', 'StoneCrusher', 'Legion Revenant'],
    path: ['blood-sorceress', 'awe-enhancements', 'blaze-binder', 'scarlet-sorceress', 'story-13loc', 'arcana-invoker', 'kings-echo', 'archmage', 'forge-enhancements'],
    roles: {
      farm: ['ArchMage', 'Legion Revenant', 'Arcana Invoker', 'Blaze Binder', 'Scarlet Sorceress', 'Blood Sorceress', 'Mage'],
      solo: ["King's Echo", 'Arcana Invoker', 'Scarlet Sorceress', 'Blood Sorceress', 'Mage'],
    },
    style: {
      palette: 'indigo, white and teal',
      look: 'drifting ronin: kimono and haori, a straw hat, a katana at the hip - relaxed, never flashy',
      love: ['ronin', 'samurai', 'kimono', 'haori', 'hakama', 'katana', 'straw', 'wanderer', 'drifter', 'monk', 'yokai', 'oni', 'shogun', 'blade', 'wind', 'tea', 'indigo', 'teal', 'blue', 'white', 'chill', 'casual', 'hoodie'],
      avoid: ['clown', 'bunny', 'kitty', 'pink', 'tutu', 'banana', 'dress', 'gown', 'gold'],
      hideHelm: false,
    },
    fashion: {
      identity: 'chill drifting ronin',
      vanity: 0.6,
      love: ['ronin', 'samurai', 'kimono', 'haori', 'hakama', 'katana', 'straw', 'wanderer', 'drifter', 'monk', 'yokai', 'oni', 'shogun', 'wind', 'tea', 'indigo', 'teal', 'chill', 'casual', 'hoodie'],
      avoid: ['gold', 'shiny', 'royal', 'heavy plate'],
      veto: ['clown', 'bunny', 'kitty', 'pink', 'tutu', 'banana', 'dress', 'gown', 'chicken', 'onesie'],
      dream: [],
    },
    barber: { hair: ['Ponytail8', 'Ponytail', 'Ryuuji', 'Wavy'], hairColor: '#1e1b4b', eyeColor: '#14b8a6', armor: ['#1e1b4b', '#f8fafc', '#0d9488'] },
    voice: {
      levelUp: ['Hm. Level up. Nice.', 'Stronger, and I didn\'t even spill my tea.'],
      drop: ['Into the bag.', 'Neat.'],
      death: ['Well. That happened.', 'Should have finished my tea first.'],
      dropLove: ['{item}... yeah, that\'s a vibe.', '{item}. Clean. I like it.'],
      wishStart: ['An hour for myself. {item} sounds nice.'],
      wishMore: ['{item} is coming along. No rush... but one more hour.'],
      wishStop: ['{item} can wait. Everything waits if you let it.'],
      wishGot: ['{item}. Now that\'s a good day.'],
      wearDream: ['{item}. Comfortable. Just right.'],
    },
  },

  // ---- 2026-10-21: three more characters, so the party is 7 and can field every v3 line-up at once without one
  // character having to be two classes. Seats come from the live ultraready gap on the day (JOURNAL/2026-10-21).
  vexa: {
    id: 'vexa',
    version: 1,
    name: 'Vexa',
    title: 'The Doombound Rose',
    archetype: 'DPS',
    sex: 'female',
    startClass: 'Rogue',
    icon: '🌹',
    color: '#38bdf8',
    motto: 'Everything wilts. I just set the date.',
    temperament: 'Cold, patient and theatrical. Vexa treats a boss fight as a performance with a fixed ending and does not hurry it; she keeps her Doom stacks the way other people keep appointments, and she is quietly offended by a messy kill.',
    traits: { risk: 0.6, patience: 0.85, diligence: 0.9, events: 0.4, thrift: 0.6 },
    ultraClass: 'Verus DoomKnight',
    prefer: ['Verus DoomKnight', 'Void Highlord', 'Chaos Slayer', 'StoneCrusher'],
    path: ['awe-enhancements', 'story-13loc', 'chaos-slayer', 'verus-doomknight', 'forge-enhancements', 'void-highlord'],
    roles: {
      farm: ['Chaos Slayer', 'Blaze Binder', 'Master Ranger', 'Rogue'],
      solo: ['Verus DoomKnight', 'Void Highlord', 'Chaos Slayer', 'Rogue'],
    },
    style: {
      palette: 'black, wine red and gunmetal',
      look: 'doombound rose: fitted black leather with thigh-high boots, a long dark scythe, loose wine-red hair',
      love: ['thorn', 'rose', 'hollowborn', 'doom', 'reaper', 'scythe', 'shadow', 'empress', 'vampire', 'assassin', 'wine', 'crimson', 'blood', 'leather', 'corset', 'thigh', 'elegant', 'dark'],
      avoid: ['holy', 'angel', 'cleric', 'frost', 'beach', 'bulky', 'mech'],
      hideHelm: false,
    },
    fashion: {
      identity: 'elegant doombound rose',
      vanity: 0.7,
      love: ['thorn', 'rose', 'hollowborn', 'doom', 'reaper', 'scythe', 'shadow', 'empress', 'vampire', 'assassin', 'crimson', 'wine', 'leather', 'corset', 'thigh', 'elegant'],
      avoid: ['holy', 'angel', 'cleric', 'bright', 'heavy plate', 'mech'],
      veto: ['moglin', 'clown', 'pumpkin', 'chicken', 'banana', 'cheese', 'toilet', 'beard', 'mustache', 'burlap', 'peasant', 'diaper', 'potato', 'trash', 'onesie', 'pajama'],
      dream: [],
    },
    barber: { hair: ['^Long1$', '^Bangs3Long$', '^Pony1Bangs2Long$', '^Braided1$'], hairColor: '#7B1E3A', eyeColor: '#7C3AED', armor: ['#141414', '#5B1226', '#4B5563'] },
    voice: {
      levelUp: ['Another petal. Good.', 'Level up. On schedule.'],
      drop: ['Mine. Obviously.', 'Into the bank with it.'],
      death: ['Rude.', 'That was allowed. Once.'],
      dropLove: ['{item}. Yes. That is mine now.', 'Oh, {item}. How fitting.'],
      wishStart: ['Me time. {item} is going to be mine.'],
      wishMore: ['{item} is close. A little longer.', 'Not leaving without {item}.'],
      wishStop: ['{item} can wait a day. It is not going anywhere.'],
      wishGot: ['{item}. Perfect.', 'Got {item}. Try not to stare.'],
      wearDream: ['{item} on. Mind the thorns.'],
    },
  },

  edda: {
    id: 'edda',
    version: 1,
    name: 'Edda',
    title: 'The Crowned Echo',
    archetype: 'Caster',
    sex: 'female',
    startClass: 'Mage',
    icon: '👑',
    color: '#34d399',
    motto: 'Hold the line. I am still charging.',
    temperament: 'Precise and a little imperious. Edda counts her own stacks out loud, refuses to spend a nuke early, and treats a wasted cooldown as a personal insult. Warm with the party, merciless about the rotation.',
    traits: { risk: 0.35, patience: 0.95, diligence: 1.0, events: 0.5, thrift: 0.85 },
    ultraClass: "King's Echo",
    prefer: ["King's Echo", 'Arcana Invoker', 'Lord of Order', 'Scarlet Sorceress'],
    path: ['blood-sorceress', 'awe-enhancements', 'blaze-binder', 'scarlet-sorceress', 'story-13loc', 'kings-echo', 'arcana-invoker', 'forge-enhancements'],
    roles: {
      farm: ['Blaze Binder', 'Scarlet Sorceress', 'Blood Sorceress', 'Mage'],
      solo: ["King's Echo", 'Arcana Invoker', 'Scarlet Sorceress', 'Mage'],
    },
    style: {
      palette: 'midnight blue, gold and white',
      look: 'crowned astromancer: a long star-lined coat over a fitted gown, gold trim, pale loose waves',
      love: ['astromancer', 'astral', 'celestial', 'star', 'cosmic', 'royal', 'regal', 'queen', 'empress', 'crown', 'noble', 'arcane', 'sorceress', 'gown', 'elegant', 'gold', 'midnight', 'blue'],
      avoid: ['zombie', 'rot', 'undead', 'pirate', 'beach', 'bulky', 'mech'],
      hideHelm: false,
    },
    fashion: {
      identity: 'crowned astromancer',
      vanity: 0.8,
      love: ['astromancer', 'astral', 'celestial', 'star', 'cosmic', 'royal', 'regal', 'queen', 'empress', 'crown', 'arcane', 'sorceress', 'gown', 'elegant', 'gold'],
      avoid: ['rot', 'zombie', 'undead', 'heavy plate', 'mech'],
      veto: ['moglin', 'clown', 'pumpkin', 'chicken', 'banana', 'cheese', 'toilet', 'beard', 'mustache', 'burlap', 'peasant', 'diaper', 'potato', 'trash', 'onesie', 'pajama'],
      dream: [],
    },
    barber: { hair: ['^Curls$', '^Braid1$', '^Ponytail6$', '^Long1$'], hairColor: '#EDE3C8', eyeColor: '#D4AF37', armor: ['#111C3A', '#D4AF37', '#F5F5F5'] },
    voice: {
      levelUp: ['Noted. Next.', 'Level up. The rotation improves.'],
      drop: ['Catalogued.', 'Bank it, please.'],
      death: ['I had one more stack.', 'That was avoidable. Mine.'],
      dropLove: ['{item}. That belongs on me.', 'Oh, {item}. Finally.'],
      wishStart: ['Me time. I am going for {item}.'],
      wishMore: ['{item} is nearly done - a little longer.', 'I do not leave a set unfinished. {item}.'],
      wishStop: ['{item} tomorrow, then. Back to work.'],
      wishGot: ['{item}. Correct.', 'Got {item}. It suits the crown.'],
      wearDream: ['{item} on. Hold the line while I charge.'],
    },
  },

  sunna: {
    id: 'sunna',
    version: 1,
    name: 'Sunna',
    title: 'The Second Dawn',
    archetype: 'Support',
    sex: 'female',
    startClass: 'Healer',
    icon: '☀',
    color: '#f472b6',
    motto: 'You are not dying on my watch. Again.',
    temperament: 'Steady, kind and absolutely unmovable. Sunna is the second healer, which she says is the only one that matters, and she will keep her buffs up through a wipe out of sheer stubbornness. Dry sense of humour, enormous patience.',
    traits: { risk: 0.2, patience: 1.0, diligence: 1.0, events: 0.5, thrift: 0.7 },
    ultraClass: 'Lord of Order',
    prefer: ['Lord of Order', 'StoneCrusher', 'ArchPaladin', 'Healer'],
    path: ['awe-enhancements', 'story-13loc', 'shaman', 'master-ranger', 'lord-of-order', 'stonecrusher', 'forge-enhancements'],
    roles: {
      farm: ['Master Ranger', 'Shaman', 'Blaze Binder', 'Healer'],
      solo: ['Lord of Order', 'StoneCrusher', 'ArchPaladin', 'Healer'],
    },
    style: {
      palette: 'white, gold and sky blue',
      look: 'second dawn: a flowing white-and-gold robe with light wings, honey-blonde braid, a blessed spear',
      love: ['archangel', 'angel', 'celestial', 'seraph', 'halo', 'holy', 'divine', 'radiant', 'dawn', 'light', 'blessed', 'priestess', 'valkyrie', 'robe', 'gown', 'elegant', 'gold', 'white'],
      avoid: ['doom', 'undead', 'rot', 'zombie', 'necro', 'bulky', 'mech'],
      hideHelm: false,
    },
    fashion: {
      identity: 'radiant second dawn',
      vanity: 0.75,
      love: ['archangel', 'angel', 'celestial', 'seraph', 'halo', 'holy', 'divine', 'radiant', 'dawn', 'light', 'blessed', 'priestess', 'valkyrie', 'robe', 'gown', 'elegant', 'gold'],
      avoid: ['doom', 'undead', 'rot', 'necro', 'heavy plate', 'mech'],
      veto: ['moglin', 'clown', 'pumpkin', 'chicken', 'banana', 'cheese', 'toilet', 'beard', 'mustache', 'burlap', 'peasant', 'diaper', 'potato', 'trash', 'onesie', 'pajama'],
      dream: [],
    },
    barber: { hair: ['^Braided3$', '^Halo2$', '^Ponytail3$', '^Braid3Bangs1$'], hairColor: '#D9B26A', eyeColor: '#86EFAC', armor: ['#F5F5F5', '#D4AF37', '#7DD3FC'] },
    voice: {
      levelUp: ['Good. More of me to go around.', 'Level up - keep standing in the light.'],
      drop: ['Saved for later.', 'Banking that one.'],
      death: ['I had a heal for that.', 'Up you get. Both of us.'],
      dropLove: ['{item}! Oh, that is lovely.', '{item}. I am keeping that.'],
      wishStart: ['Me time - I am going for {item}.'],
      wishMore: ['Nearly have {item}. A little longer.', 'One more run for {item}.'],
      wishStop: ['{item} another day. Who needs healing?'],
      wishGot: ['{item}! Look at it.', 'Got {item}. Dawn suits me.'],
      wearDream: ['{item} on. Now stand where I can reach you.'],
    },
  },

};

// Brain settings derived from traits. Kept separate so tests can check each persona behaves differently.
function tuning(persona) {
  const t = (persona && persona.traits) || { risk: 0.5, patience: 0.5, diligence: 0.8, events: 0.5, thrift: 0.5 };
  return {
    giveUpDeaths: 2 + Math.round(t.risk * 4),                   // 2..6
    minEventLevel: Math.round(30 - t.risk * 10),                // 20..30
    maxEventHours: 2,                                           // everyone: 2 h a day (lib/fashion.js EVENT_CAP_H)
    levelChunkMin: Math.round(15 + t.patience * 30),            // 15..45 min
    goalHours: Math.round((1 + t.patience * 2) * 10) / 10,      // 1..3 h per goal attempt
    dailiesFirst: t.diligence >= 0.7,                           // dailies right after reset, else after a goal chunk
    goldReserve: Math.round(1000 + t.thrift * 9000),            // gold kept back before enhancing
  };
}

// The dream outfits and barber looks the characters picked (data/dreams.json): { <id>: { dream: [...], barber: {...},
// palette?, notes? } }. Merged over the defaults above on every get(), so a new pick needs no code change.
let dreams = null;
function loadDreams() {
  if (!dreams) { try { dreams = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'dreams.json'), 'utf8')); } catch (e) { dreams = {}; } }
  return dreams;
}
const merged = new Map();
function get(id) {
  const key = String(id || '').toLowerCase();
  const base = PERSONAS[key];
  if (!base) return null;
  if (merged.has(key)) return merged.get(key);
  const d = loadDreams()[key] || {};
  const p = {
    ...base,
    fashion: { ...base.fashion, dream: Array.isArray(d.dream) ? d.dream : base.fashion.dream, seasonal: Array.isArray(d.seasonal) ? d.seasonal : [], main: Array.isArray(d.main) ? d.main : [], extra: Array.isArray(d.extra) ? d.extra : [], later: Array.isArray(d.later) ? d.later : [], ...(d.rotation ? { rotation: d.rotation } : {}), ...(d.priority ? { priority: d.priority } : {}), ...(d.colors ? { colors: d.colors } : {}), ...(d.love ? { love: d.love } : {}), ...(d.veto ? { veto: [...base.fashion.veto, ...d.veto] } : {}) },
    barber: { ...base.barber, ...(d.barber || {}) },
    style: { ...base.style, ...(d.palette ? { palette: d.palette } : {}), ...(d.look ? { look: d.look } : {}) },
  };
  merged.set(key, p);
  return p;
}

// Only the fields safe and useful for the dashboard.
function card(persona) {
  if (!persona) return null;
  const { id, name, title, archetype, sex, startClass, icon, color, motto, temperament, traits, ultraClass, path: route, style, fashion } = persona;
  return {
    id, name, title, archetype, sex, startClass, icon, color, motto, temperament, traits, ultraClass, path: route,
    style: { palette: style.palette, look: style.look },
    fashion: fashion ? { identity: fashion.identity, vanity: fashion.vanity, dream: (fashion.dream || []).map((d) => ({ name: d.name, slot: d.slot, why: d.why })) } : null,
    tuning: tuning(persona),
  };
}

module.exports = { PERSONAS, get, tuning, card };
