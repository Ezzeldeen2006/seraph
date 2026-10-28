// Vendors the Ultras v3 scripts of noelrohi/Scripts (branch Skua) into app/ultras/SeraphUltras (2026-10-18, the owner:
// "do whatever you recommend" after the ultra research, vault STRATEGY/Ultra-Research-2026-10-18). That fork is 167
// commits ahead of auqw/Scripts on Ultras v3: Comps, party layouts, a kill counting for the whole party, same-room
// checks, attempt reports. Seraph installs the copy into the Skua library as Scripts/SeraphUltras (lib/ultras.js).
//
//   node tools/vendor-ultras.js <checkout of noelrohi/Scripts>/Ultrasv3
//
// Changes on the way in:
//  - includes Scripts/Ultrasv3/... -> Scripts/SeraphUltras/... (upstream's Ultrasv3 stays untouched beside it)
//  - Bot.Report (needs noelrohi/Skua#213, not in Seraph's engine) -> a "[UltraAttempt] {json}" log line Seraph reads
//  - Seraph's own Comps from lib/ultras-comps.json, appended to the Comps array of the bosses they name
'use strict';
const fs = require('fs');
const path = require('path');

//   node tools/vendor-ultras.js --fixes   re-applies only FIXES to the vendored copy (no checkout needed)
const src = process.argv[2];
const fixesOnly = src === '--fixes';
if (require.main === module && !fixesOnly && (!src || !fs.existsSync(src))) { console.error('usage: node tools/vendor-ultras.js <noelrohi/Scripts>/Ultrasv3 | --fixes'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'ultras', 'SeraphUltras');
const COMPS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'ultras-comps.json'), 'utf8'));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.cs')) out.push(p);
  }
  return out;
}

const REPORT = /Bot\.Report\(ReportName, report\);/;
const REPORT_NEW = 'try { CoreBots.Instance.Logger("[UltraAttempt] " + System.Text.Json.JsonSerializer.Serialize(report)); } catch { }   // Seraph: no Bot.Report in its engine';

// A Comp in C#, from ultras-comps.json: { name, entries: [{ class, role, potions?, scroll?, taunt? }] }. Every entry
// keeps its own gear (Enhancement null): Seraph's kits enhance the party, and nothing touches the owner's account.
function compCs(c) {
  const taunt = (t) => (!t || t === 'never' ? 'UltraTaunt.Never' : t.every ? `UltraTaunt.Every(${t.every}, atSec: ${t.atSec || 0})` : t.raw);
  const entry = (e) => [
    '            new UltraCompEntry',
    '            {',
    `                Class = ${JSON.stringify(e.class)},`,
    `                Role = ${e.role},`,
    '                Loadout = new UltraLoadout',
    '                {',
    ...(e.potions && e.potions.length ? [`                    Potions = new[] { ${e.potions.map((p) => (p === 'HonorOrMalice' ? 'UltraPotions.HonorOrMalice' : JSON.stringify(p))).join(', ')} },`] : []),
    ...(e.scroll ? [`                    Scroll = UltraLoadout.${e.scroll},`] : []),
    '                },',
    `                Taunt = ${taunt(e.taunt)},`,
    '            }',
  ].join('\n');
  return `        // Seraph Comp (lib/ultras-comps.json): ${c.why || ''}\n        new(${JSON.stringify(c.name)},\n${c.entries.map(entry).join(',\n')}),\n`;
}

// The class line-up of a script whose roles follow the seats file (SeraphSeatOr): rebuilt on every use, see below.
const SEAT_ROLES_FROM = '    private static readonly string[][] UltraClassesByRole =\n    {\n';
const SEAT_ROLES_TO = '    private static string[][] UltraClassesByRole => new[]   // Seraph: read per run (SeraphSeatOr)\n    {\n';

// Seraph's rotation/seat fixes from the community research (vault STRATEGY/Research-2026-10-20): [file, from, to]. A
// `from` that no longer matches stops the vendoring, so an upstream change gets a look instead of losing the fix.
const FIXES = [
  // Nightmare Carnax (the owner 2026-10-28, "go with the party army"): the army stood still and took every Nightmare
  // Deathray (zoneSet A/B, ~40-49 k magic, Prismatic Burn -30 % defence stacking to 20). Walk into the named zone like
  // CoreArchMage.MoveNightmareCarnax - and again after a respawn, where the old script thought it was still there.
  // Nightmare Carnax potions (2026-10-28): drink what each character owns, never buy - EnsureRecommendedPotions crafts with
  // Dragon Runestones (100 k gold vouchers each). Same rule as the Drakath/Gramiel fixes.
  ['ChallengeBosses/NightmareCarnaxv3.cs', `            Pots.EnsureRecommendedPotions(potionQuant, skipThird: false);
`,
    `            // Seraph: owned potions only - nothing bought (EnsureRecommendedPotions crafts with 100 k vouchers).
`],
  ['ChallengeBosses/NightmareCarnaxv3.cs', `        Bot.Player.SetSpawnPoint();

        C.Logger("Fight start synced.");
`,
    `        Bot.Player.SetSpawnPoint();
        Bot.Events.RunToArea += SeraphCarnaxMove;   // Seraph: dodge the laser

        C.Logger("Fight start synced.");
`],
  ['ChallengeBosses/NightmareCarnaxv3.cs', `    void DoEnhs() => Enh.Apply();
`,
    `    void DoEnhs() => Enh.Apply();

    // Seraph: walk into the zone the laser spares (x ranges from CoreArchMage.MoveNightmareCarnax).
    private string _seraphZone = "";
    private DateTime _seraphMoveAt = DateTime.MinValue;
    private void SeraphCarnaxMove(string zone)
    {
        string z = (zone ?? "").ToLowerInvariant();
        if (z == _seraphZone && DateTime.Now - _seraphMoveAt < TimeSpan.FromSeconds(6))
            return;
        _seraphZone = z;
        _seraphMoveAt = DateTime.Now;
        System.Threading.Tasks.Task.Run(() =>
        {
            System.Threading.Thread.Sleep(300);
            int y = Bot.Random.Next(380, 475);
            int x = z switch { "a" => Bot.Random.Next(600, 931), "b" => Bot.Random.Next(25, 326), _ => Bot.Random.Next(325, 601) };
            Bot.Player.WalkTo(x, y);
        });
    }
`],
  // King's Echo: Residual Energy stacks to 8 (aqwwiki), so ">= 22" never fired and CORVAK only came on empty mana. The
  // community line: CORVAK on 8 stacks, or 6 with mana under 40 (the mana < 26 refill above it stays).
  ['DependenciesUltras/CoreEnginev3.cs', '        if (energyStacks >= 22)',
    '        if (energyStacks >= 8 || (energyStacks >= 6 && Bot.Player.Mana < 40))   // Seraph: max 8 stacks (was >= 22)'],
  // Ultra Dage: King's Echo is 1★ there; ArchFiend / Chrono ShadowHunter 5★, Chaos Avenger, Void Highlord 4★ take the
  // DPS seat (lib/ultraready.js DAGE_DPS), KE stays as the last resort.
  ['IndividualUltras/9UltraDagev3.cs', '        new[] { Dps1 }',
    '        new[] { "ArchFiend", "Chrono ShadowHunter", "Chrono ShadowSlayer", "Chaos Avenger", "Void Highlord", Dps1 }   // Seraph: KE is 1★ at Dage'],
  // Potions per boss (the owner 2026-10-20: "if there is a way that can defeat ultras without potions its preferably, if
  // there is no way without potions then so be it buy potions"). The hub writes raid-potions.txt next to the seats file
  // (SERAPH_SEATS_FILE) at every raid: "<username>=on|off". With the file there, only "on" accounts buy or drink; no
  // file (a plain Skua run) keeps v3's behaviour.
  ['DependenciesUltras/UltraPotions.cs', '    public void UsePotions(string[] potions)\n    {\n',
    [
      '    // Seraph: is this account allowed potions in this raid? (lib/hub.js raidPotionsWrite)',
      '    public static bool SeraphPotionsAllowed()',
      '    {',
      '        try',
      '        {',
      '            string? seats = System.Environment.GetEnvironmentVariable("SERAPH_SEATS_FILE");',
      '            if (string.IsNullOrEmpty(seats))',
      '                return true;',
      '            string file = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(seats) ?? "", "raid-potions.txt");',
      '            if (!System.IO.File.Exists(file))',
      '                return true;',
      '            string me = (IScriptInterface.Instance.Player.Username ?? "").Trim();',
      '            foreach (string raw in System.IO.File.ReadAllLines(file))',
      '            {',
      "                int eq = raw.IndexOf('=');",
      '                if (eq > 0 && string.Equals(raw[..eq].Trim(), me, StringComparison.OrdinalIgnoreCase))',
      '                    return string.Equals(raw[(eq + 1)..].Trim(), "on", StringComparison.OrdinalIgnoreCase);',
      '            }',
      '            return false;',
      '        }',
      '        catch { return true; }',
      '    }',
      '',
      '    public void UsePotions(string[] potions)',
      '    {',
      '        if (!SeraphPotionsAllowed()) { Core.Logger("Seraph: no potions for this boss (it has been beaten without them, or not tried 3 times yet)."); return; }',
      '',
    ].join('\n')],
  // A full backpack can't take the reagents, and CoreFarms.AlchemyPacket then stops the whole raid script
  // ("you do not own Arashtite Ore", stopBot: true): 2026-10-22 the main's Warden seat ended at 2 min and the raid was
  // called off. Short of room: no buying, fight with what is in stock (Seraph also makes room before a raid seat).
  ['DependenciesUltras/UltraPotions.cs', '        Pots.INeedYourStrongestPotions(\n            Potions: missing.ToArray(),\n',
    '        if (Bot.Inventory.FreeSlots < 5)\n        {\n            Core.Logger($"Only {Bot.Inventory.FreeSlots} free backpack slots: not buying {string.Join(", ", missing)}; fighting with what is in stock.", "Warning");\n            return;   // Seraph: a full bag stops the raid script in CoreFarms.AlchemyPacket\n        }\n\n        Pots.INeedYourStrongestPotions(\n            Potions: missing.ToArray(),\n'],
  ['DependenciesUltras/UltraPotions.cs', '    public void EnsurePotions(string[] potions, int desiredQuant = 10)\n    {\n',
    '    public void EnsurePotions(string[] potions, int desiredQuant = 10)\n    {\n        if (!SeraphPotionsAllowed())\n            return;   // Seraph: no potion buying for this boss\n'],
  // The owner's main in the Legion Revenant seat (the owner 2026-10-22: "if the bots cant do it without LR then make my main
  // help them"). The Simplified bosses guide puts LR in the group for Tyndarius, Drakath, Nulgath, Drago, Darkon,
  // Gramiel and Speaker. A role's class becomes Legion Revenant only when the hub's seats file seats one, so every
  // other raid runs exactly as before. The roles are properties read on every use, never static readonly fields: the
  // engine keeps a compiled script loaded across runs (Skua's Cached-Scripts, Assembly.LoadFrom), so a field would
  // keep the first raid's seat for the next one. The file is re-read only when it changes.
  ['DependenciesUltras/UltraPotions.cs', '    // Seraph: is this account allowed potions in this raid? (lib/hub.js raidPotionsWrite)\n',
    [
      '    // Seraph: the class for a role - `alt` when the raid\'s seats file (SERAPH_SEATS_FILE, "user=Class" lines)',
      '    // seats one, else the script\'s own `cls`.',
      '    public static string SeraphSeatOr(string cls, string alt)',
      '    {',
      '        foreach (string seat in SeraphSeatClasses())',
      '            if (string.Equals(seat, alt, StringComparison.OrdinalIgnoreCase))',
      '                return alt;',
      '        return cls;',
      '    }',
      '',
      '    private static string[] _seraphSeats = Array.Empty<string>();',
      '    private static DateTime _seraphSeatsAt = DateTime.MinValue;',
      '',
      '    private static string[] SeraphSeatClasses()',
      '    {',
      '        try',
      '        {',
      '            string? seats = System.Environment.GetEnvironmentVariable("SERAPH_SEATS_FILE");',
      '            if (string.IsNullOrEmpty(seats) || !System.IO.File.Exists(seats))',
      '                return Array.Empty<string>();',
      '            DateTime at = System.IO.File.GetLastWriteTimeUtc(seats);',
      '            if (at != _seraphSeatsAt)',
      '            {',
      '                _seraphSeats = System.IO.File.ReadAllLines(seats).Where(l => l.IndexOf(\'=\') > 0).Select(l => l[(l.IndexOf(\'=\') + 1)..].Trim()).ToArray();',
      '                _seraphSeatsAt = at;',
      '            }',
      '            return _seraphSeats;',
      '        }',
      '        catch { return Array.Empty<string>(); }',
      '    }',
      '',
      '    // Seraph: is this account allowed potions in this raid? (lib/hub.js raidPotionsWrite)',
      '',
    ].join('\n')],
  // Never enhance on the owner's account (2026-10-17 rule): the CoreBots option SeraphNeverEnhance (lib/skua/cbo.js, his
  // account only) makes every Loadout "keep its own gear": upstream's Comps force e.g. a Lucky or Wizard build on the
  // Legion Revenant seat (EnhanceWhenAutoEnhanceIsOff), and with auto enhance off FitOwnedGear still re-enhances the
  // class and RaiseMaxHealth enhances spares. He fights in his own LR outfit (Seraph equips it before the script).
  ['DependenciesUltras/UltraComp.cs', '        _aimed = null;\n        if (Enhancement == null)\n',
    '        _aimed = null;\n        if (Enhancement == null || SeraphNeverEnhance)   // Seraph: the owner\'s account keeps its own enhancements\n'],
  ['DependenciesUltras/UltraComp.cs', '        List<string> done = new();\n        if (Enhancement == null)\n',
    '        List<string> done = new();\n        if (Enhancement == null || SeraphNeverEnhance)   // Seraph: the owner\'s account keeps its own enhancements\n'],
  // The scripts without Comps (Drakath, Drago, Darkon, Gramiel...) enhance through UltraEnhancements; SmartEnhance
  // there ignores DisableAutoEnhance for unenhanced pieces.
  ['DependenciesUltras/UltraEnhancements.cs', '    public void Apply()\n    {\n',
    '    public void Apply()\n    {\n        if (C.CBOBool("SeraphNeverEnhance", out bool seraphNever) && seraphNever)\n            return;   // Seraph: the owner\'s account keeps its own enhancements\n'],
  ['DependenciesUltras/UltraEnhancements.cs', '    public void ApplyDage()\n    {\n',
    '    public void ApplyDage()\n    {\n        if (C.CBOBool("SeraphNeverEnhance", out bool seraphNever) && seraphNever)\n            return;   // Seraph: the owner\'s account keeps its own enhancements\n'],
  ['DependenciesUltras/UltraComp.cs', '    private bool CanEnhance =>\n        EnhanceWhenAutoEnhanceIsOff || !(C.CBOBool("DisableAutoEnhance", out bool off) && off);',
    '    private static bool SeraphNeverEnhance => C.CBOBool("SeraphNeverEnhance", out bool never) && never;\n\n    private bool CanEnhance =>\n        !SeraphNeverEnhance && (EnhanceWhenAutoEnhanceIsOff || !(C.CBOBool("DisableAutoEnhance", out bool off) && off));'],
  // Champion Drakath (sheet: "a healer, or Legion Revenant, should taunt Drakath on every 2 M HP lost"): LR takes the
  // third taunter's turn (Shaman's).
  ['IndividualUltras/5ChampionDrakathv3.cs', '    private const string Taunter3 = "Shaman";',
    '    private static string Taunter3 => UltraPotions.SeraphSeatOr("Shaman", "Legion Revenant");   // Seraph: LR seat'],
  ['IndividualUltras/5ChampionDrakathv3.cs', SEAT_ROLES_FROM, SEAT_ROLES_TO],
  // Ultra Darkon (sheet: "Lord of Order and Legion Revenant should Taunt on Darkon for the entire fight"): LR takes the
  // first taunter (VDK); the second DPS seat takes what the party owns when there is no King's Echo.
  ['IndividualUltras/8UltraDarkonv3.cs', '    private const string Taunter1 = "Verus DoomKnight";',
    '    private static string Taunter1 => UltraPotions.SeraphSeatOr("Verus DoomKnight", "Legion Revenant");   // Seraph: LR seat'],
  ['IndividualUltras/8UltraDarkonv3.cs', SEAT_ROLES_FROM, SEAT_ROLES_TO],
  ['IndividualUltras/8UltraDarkonv3.cs', '        new[] { Dps2 }\n',
    '        new[] { Dps2, "Void Highlord", "Chrono ShadowHunter", "ArchFiend", "ArchPaladin", "Verus DoomKnight" }   // Seraph: no KE in the party\n'],
  // Ultra Gramiel (sheet: "DPS and Lord of Order focus a Crystal ... Legion Revenant and Healer focus the other"): LR
  // pairs with ArchPaladin on the right crystal, in ArchFiend's place.
  ['IndividualUltras/11UltraGramielv3.cs', '    private const string RightCrystalT2 = "ArchFiend";',
    '    private static string RightCrystalT2 => UltraPotions.SeraphSeatOr("ArchFiend", "Legion Revenant");   // Seraph: LR seat'],
  ['IndividualUltras/11UltraGramielv3.cs', SEAT_ROLES_FROM, SEAT_ROLES_TO],
  // Ultra Drago (sheet: Legion Revenant taunts the Bowmaster): LR takes the second taunter (VDK); the second DPS seat
  // takes what the party owns when there is no King's Echo.
  ['IndividualUltras/7UltraDragov3.cs', '    private const string Taunter2AttackRightSummon2 = "Verus DoomKnight";',
    '    private static string Taunter2AttackRightSummon2 => UltraPotions.SeraphSeatOr("Verus DoomKnight", "Legion Revenant");   // Seraph: LR seat'],
  ['IndividualUltras/7UltraDragov3.cs', SEAT_ROLES_FROM, SEAT_ROLES_TO],
  ['IndividualUltras/7UltraDragov3.cs', '        new[] { DPSAttackRightSummon2 }\n',
    '        new[] { DPSAttackRightSummon2, "Void Highlord", "Chrono ShadowHunter", "ArchFiend", "ArchPaladin" }   // Seraph: no KE in the party\n'],
  // ---- Ultra Speaker (2026-10-24, killed 11:11 UTC; vault STRATEGY/Ultra-Research-2026-10-24) ----------------------------
  // Equalize ("All stand equal beneath the eyes of the Eternal."): 2,411-2,946 true damage to the first player in the
  // zone and +100 % for each one after (AQW Wiki); its Sanctity clears Corruption / Somber. v3 sends in everyone eligible
  // with 5,100+ HP and nobody in the party has that (3,000-4,600), so nobody ever went in. One player per Equalize: the
  // eligible wait 0/300/600/900 ms in the order the community sheet gives the zone (SC, LR, AP, LoO) and the first to
  // claim the shared sync file walks in (a claim lives 5 s).
  ['IndividualUltras/10UltraSpeakerv3.cs', '                            bool hasLowHp = health < 5100f;',
    '                            bool hasLowHp = health < SeraphEqualizeMinHp;   // Seraph: one player per Equalize (was 5100f)'],
  ['IndividualUltras/10UltraSpeakerv3.cs', '                            _ = Task.Run(() =>\n                            {\n                                Bot.Player.WalkTo(EqualizeX, EqualizeY);',
    '                            _ = Task.Run(() =>\n                            {\n                                if (!SeraphClaimEqualize()) { _movingToEqualize = false; return; }   // Seraph: one player per Equalize\n                                Bot.Player.WalkTo(EqualizeX, EqualizeY);'],
  // The taunts follow the community "Ultra Speaker sheet" (Skardyy/Aqw-UltraSpeaker-Visualizer block.py, 4-man LR · LoO ·
  // AP · SC; Seraph's VDK takes the LR column): the fight runs in blocks between Equalizes, every Truth and Listen has
  // its taker, a Listen and the Truth 3 s after it go to the same player (the taunt's Focus lasts 6 s), and the Listens
  // rotate instead of stunning v3's single Listen taunter (AP) every 12 s - the Listen taunters died 10-16x a fight and
  // their Stasis then stunned the VDK, whose Decay is all that stops Power Split's heal. Live trace 2026-10-24: Decay
  // landed on 4 / 10 Power Splits at first. v3's own counters take over when the lines leave the sheet's pattern.
  ['IndividualUltras/10UltraSpeakerv3.cs', '            _lines.Add(line);\n',
    '            _lines.Add(line);\n            SeraphSheetNote(line);   // Seraph: the Ultra Speaker sheet\n'],
  ['IndividualUltras/10UltraSpeakerv3.cs', '            if (_entry?.Role != TruthTaunter3 || _lines.Count < 3)\n                return;\n\n            string last = new(_lines.ToArray());\n',
    '            if (_lines.Count < 3)\n                return;\n\n            string last = new(_lines.ToArray());\n            SeraphHoldForTaunt(last);   // Seraph: the next taunter keeps its GCD free\n            if (_entry?.Role != TruthTaunter3)\n                return;\n'],
  ['IndividualUltras/10UltraSpeakerv3.cs', '        if (!Bot.Player.Alive || !Bot.Player.HasTarget || !IsListenTaunter())\n            return;\n',
    '        if (!Bot.Player.Alive || !Bot.Player.HasTarget)\n            return;\n        bool sheet = _sheetOk && _sheetTaunter != null;   // Seraph: the sheet; the others back it up (out of step: all of them)\n        if (!sheet || _sheetTaunter != SeraphSheetRole())\n        {\n            await SeraphBackupListenAsync(listenTauntTurn, sheet);\n            return;\n        }\n'],
  ['IndividualUltras/10UltraSpeakerv3.cs', '        int myIndex = MyTruthIndex();\n        if (myIndex < 0 || !Bot.Player.Alive || !Bot.Player.HasTarget)\n            return;\n\n        // Guard: only act if this turn is ours (3-way rotation) and we haven\'t acted yet\n        if (truthTauntTurn % 3 != myIndex || truthTauntTurn <= lastTruthTauntActedTurn)\n            return;\n',
    '        if (!Bot.Player.Alive || !Bot.Player.HasTarget)\n            return;\n\n        // Seraph: the sheet names this Truth\'s taker (the AP takes Truths too) - when it can take it safely. Otherwise\n        // (stunned, Magia Burn at the burst, low HP) or out of step the others back it up: an untaunted Truth wipes.\n        bool sheet = _sheetOk && _sheetTaunter != null;\n        if (!sheet || _sheetTaunter != SeraphSheetRole() || !SeraphCanTakeTruth(SeraphTruthMinHp))\n        {\n            await SeraphBackupTruthAsync(truthTauntTurn, sheet);\n            return;\n        }\n        if (truthTauntTurn <= lastTruthTauntActedTurn)\n            return;\n'],
  // Decay: a cast the server refused ("Please slow down", handed back by swfworld actionRefused) is not a Decay - keep
  // casting until the boss shows it.
  ['IndividualUltras/10UltraSpeakerv3.cs', '                if (Engine.Cast(4))\n                    break;\n                await Task.Delay(50);\n',
    '                if (Engine.HasAura("Decay"))   // Seraph: done when the boss has it, not when a cast went out\n                    break;\n                Engine.Cast(4);\n                await Task.Delay(50);\n'],
  // Everything Seraph adds as members, in one block on an upstream line (a fix anchored inside another fix's text makes
  // --fixes insert that one twice).
  ['IndividualUltras/10UltraSpeakerv3.cs', '    private static string _fbsMuteFile = "";\n', String.raw`    // ---- Seraph (2026-10-24) ----
    // One player per Equalize. The first player takes at most 2,946 true damage (AQW Wiki).
    private const float SeraphEqualizeMinHp = 3200f;
    private const string SeraphEqualizeSyncFile = "UltraSpeakerEqualize.sync";

    // The sheet's zone order per Equalize (1st SC, 2nd LR, 3rd AP, 4th LoO, then again): that player waits 0 ms.
    private bool SeraphClaimEqualize()
    {
        int pos = Array.IndexOf(new[] { "SC", "LR", "AP", "LOO" }, SeraphSheetRole());
        int holder = Math.Max(0, equalizeCount - 1) % 4;
        Bot.Sleep((((pos < 0 ? 3 : pos) - holder + 4) % 4) * 300);
        // Magia Burn, Stasis or Sanctity in the zone = Shattered Will / Soul / Heart, a lethal DoT (AQW Wiki).
        if (!Bot.Player.Alive || Bot.Player.Health < SeraphEqualizeMinHp || Engine.HasAura("Stasis", true) || Engine.HasAura("Magia Burn", true) || Engine.HasAura("Sanctity", true))
            return false;
        string path = Ultra.ResolveSyncPath(SeraphEqualizeSyncFile);
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        string me = (Bot.Player.Username ?? "me").Replace(":", "-").Replace("|", "-");
        foreach (string line in Ultra.ReadLines(path))
        {
            string[] p = line.Split(':');
            if (p.Length < 2 || p[0] != "claim")
                continue;
            string[] c = p[1].Split('|');
            if (c.Length == 2 && long.TryParse(c[1], out long at) && now - at < 5000 && !c[0].Equals(me, StringComparison.OrdinalIgnoreCase))
            {
                C.Logger($"[UltraSpeaker-v3] [Seraph] {c[0]} takes this Equalize - staying out.");
                return false;
            }
        }
        Ultra.UpdateEntry(path, "claim", $"{me}|{now}");
        C.Logger($"[UltraSpeaker-v3] [Seraph] I take this Equalize (count {equalizeCount}).");
        return true;
    }

    // The community sheet in Seraph's seats: LR = the VDK (TruthTaunter3), LOO = TruthTaunter1, SC = TruthTaunter2, AP.
    private string SeraphSheetRole() => _entry?.Role switch
    {
        ListenTaunter => "AP",
        TruthTaunter1 => "LOO",
        TruthTaunter2 => "SC",
        TruthTaunter3 => "LR",
        _ => "",
    };

    // Block 0 (before the first Equalize) = Truth, Listen. Then odd blocks Truth, Listen, Truth and even blocks Listen,
    // Truth, Truth, Listen, alternating for the whole fight (the boss's line cycle T L E T L T E L T).
    private static string SeraphSheetPattern(int k) => k <= 0 ? "TL" : (k - 1) % 2 == 0 ? "TLT" : "LTTL";

    private static string? SeraphSheetAt(int k, int pos)
    {
        string[] who = k <= 0 ? new[] { "LR", "LOO" } : (k - 1) % 2 == 0 ? new[] { "AP", "SC", "SC" } : new[] { "LR", "LR", "LOO", "LOO" };
        return pos >= 0 && pos < who.Length ? who[pos] : null;
    }

    private int _sheetK;
    private int _sheetPos;
    private bool _sheetOk = true;
    private string? _sheetTaunter;
    private const string SeraphSheetSyncFile = "UltraSpeakerSheet.sync";

    private void SeraphSheetNote(char line)
    {
        if (line == 'E')
        {
            _sheetK++;
            // A member that missed an Equalize (joined late) takes the party's count.
            try
            {
                string path = Ultra.ResolveSyncPath(SeraphSheetSyncFile);
                string me = (Bot.Player.Username ?? "me").Replace(":", "-").Replace("|", "-");
                Ultra.UpdateEntry(path, me, _sheetK.ToString());
                long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                foreach (string l in Ultra.ReadLines(path))
                {
                    string[] p = l.Split(':');
                    if (p.Length >= 3 && int.TryParse(p[1], out int k) && long.TryParse(p[2], out long at) && now - at < 15 && k > _sheetK)
                        _sheetK = k;
                }
            }
            catch { }
            _sheetPos = 0;
            _sheetTaunter = null;
            _sheetOk = true;
            _seraphLastE = DateTime.UtcNow;
            return;
        }
        // One block off (an Equalize missed): odd blocks open with a Truth, even ones with a Listen.
        if (_sheetPos == 0 && _sheetK > 0 && SeraphSheetPattern(_sheetK)[0] != line)
            _sheetK++;
        string pat = SeraphSheetPattern(_sheetK);
        _sheetOk = _sheetOk && _sheetPos < pat.Length && pat[_sheetPos] == line;
        _sheetTaunter = _sheetOk ? SeraphSheetAt(_sheetK, _sheetPos) : null;
        _sheetPos++;
        if (!_sheetOk)
            C.Logger($"[UltraSpeaker-v3] [Seraph] sheet out of step at block {_sheetK} (line {line}) - v3's own taunt order until the next Equalize.");
    }

    // Backups. Live trace 2026-10-24 15:39: the sheet went out of step, v3's order had the AP take LoO's Listen, his
    // Stasis kept him from taunting his own Truth 5 s later, and the untaunted burst killed three at once - the wipe
    // reset the boss from 6.3 M to 10 M (and its Vindication, +30% defense per player it kills). The sheet's taker that
    // can't take a line safely leaves it, and the others take it in a fixed order, each a little later, only while no
    // fresh Focus is on the boss (sim-dynamic.js: 0 hazards over the measured cycle, the sheet alone 88 stunned Truths).
    private const float SeraphTruthMinHp = 2400f;
    private DateTime _seraphLastE = DateTime.MinValue;

    // Seconds until the earliest next "All stand equal" (19.2 s after the last; negative = late, it can come any time).
    private double SeraphToNextE() => 19.2 - (DateTime.UtcNow - _seraphLastE).TotalSeconds;

    private static string SeraphNextZone(int count) => new[] { "SC", "LR", "AP", "LOO" }[Math.Max(0, count) % 4];

    // A Truth taker presses its taunt (not stunned) and has no Magia Burn left at the burst (+300% per stack).
    private bool SeraphCanTakeTruth(float minHp) =>
        Bot.Player.Alive && !Engine.HasAura("Stasis", true) && Engine.GetAuraSecondsRemaining("Magia Burn", true) <= 1 && Bot.Player.Health >= minHp;

    // The VDK's 6 s Stasis must be over before the next "All stand equal" (its Decay); a Focus it holds 3 s before a
    // Listen carries the Listen to it.
    private bool SeraphVdkStunSafe(double inSec) => SeraphToNextE() > inSec + 8.3;

    private async Task SeraphBackupTruthAsync(int turn, bool sheet)
    {
        string me = SeraphSheetRole();
        string zone = SeraphNextZone(equalizeCount);
        // VDK first (the most HP), then LoO, AP, SC; the next Equalize's zone holder last (its Magia Burn would meet it).
        List<string> order = new[] { "LR", "LOO", "AP", "SC" }.Where(r => !sheet || r != _sheetTaunter).OrderBy(r => r == zone ? 1 : 0).ToList();
        int rank = order.IndexOf(me);
        if (rank < 0)
            return;
        if (me == "LR")
        {
            string last;
            lock (_lines)
                last = new(_lines.ToArray());
            if (SeraphNextLine.TryGetValue(last, out var p) && p.next == 'L' && p.inSec < 3.5 && !SeraphVdkStunSafe(p.inSec))
                rank = order.Count;   // its Focus would carry the next Listen into the Decay
        }
        bool healthy = SeraphCanTakeTruth(SeraphTruthMinHp);
        await Task.Delay((sheet ? 500 : 0) + rank * 180 + (healthy ? 0 : 500));
        if (truthTauntTurn != turn || !Bot.Player.HasTarget || !SeraphCanTakeTruth(0) || Engine.GetAuraSecondsRemaining("Focus") >= 4)
            return;
        C.Logger($"[UltraSpeaker-v3] [Seraph] nobody can take this Truth ({(sheet ? _sheetTaunter + "'s" : "out of step")}) - taunting it ({me}, {rank + 1}.).");
        await SeraphTauntNowAsync();
    }

    // A Listen nobody holds stuns several players for 6 s, and the one before "All stand equal" stuns the VDK through its
    // Decay (the boss then heals almost to full). The seat the sheet leaves free in that block backs it up first: LoO in
    // Truth-first blocks (the SC's Listen), the SC in Listen-first blocks and the opening (the VDK's and LoO's); then
    // the AP, SC, LoO; the VDK only when its stun ends before the next Equalize.
    private string SeraphSheetBackup() => _sheetK > 0 && (_sheetK - 1) % 2 == 0 ? "LOO" : "SC";

    private async Task SeraphBackupListenAsync(int turn, bool sheet)
    {
        string me = SeraphSheetRole();
        string free = SeraphSheetBackup();
        List<string> order = (sheet ? new[] { free, "AP", "SC", "LOO", "LR" } : new[] { "AP", "SC", "LOO", "LR" })
            .Distinct().Where(r => !sheet || r != _sheetTaunter).ToList();
        int rank = order.IndexOf(me);
        if (rank < 0 || (me == "LR" && !SeraphVdkStunSafe(0)))
            return;
        // The next zone holder stunned when its Equalize lands takes Shattered Soul: last, when it would be.
        if (me == SeraphNextZone(equalizeCount) && SeraphToNextE() < 5.3)
            rank = order.Count;
        await Task.Delay((sheet ? 600 : 0) + rank * 200);
        if (!Bot.Player.Alive || !Bot.Player.HasTarget || listenTauntTurn != turn || Engine.HasAura("Stasis", true))
            return;
        // A Focus that lasts past the burst (+2 s) holds it - also the one carried from the taker's Truth 3 s before.
        if ((sheet || rank > 0) && Engine.GetAuraSecondsRemaining("Focus") >= 2)
            return;
        C.Logger($"[UltraSpeaker-v3] [Seraph] nobody holds this Listen ({(sheet ? _sheetTaunter + "'s" : "out of step")}) - taunting it ({me}, {rank + 1}.).");
        await SeraphTauntNowAsync();
    }

    // The taunt (scroll, key 5) until a fresh Focus shows on the boss, with the rotation off the global cooldown.
    private async Task SeraphTauntNowAsync()
    {
        DateTime until = DateTime.UtcNow.AddSeconds(1.6);
        if (until > Engine.HoldSkillsUntil)
            Engine.HoldSkillsUntil = until;
        for (int i = 0; i < 28 && Bot.Player.Alive; i++)
        {
            if (Engine.GetAuraSecondsRemaining("Focus") >= 4)
                break;
            Engine.Cast(5);
            await Task.Delay(50);
        }
    }

    // The last three Speaker lines and what comes next, with the gap measured live (seconds).
    private static readonly Dictionary<string, (char next, double inSec)> SeraphNextLine = new()
    {
        ["LTT"] = ('L', 3.0), ["TTL"] = ('E', 3.1), ["TLE"] = ('T', 4.1), ["LET"] = ('L', 5.1), ["ETL"] = ('T', 3.0),
        ["TLT"] = ('E', 7.1), ["LTE"] = ('L', 4.1), ["TEL"] = ('T', 3.0), ["ELT"] = ('T', 7.2),
    };

    // The taker of the next Truth / Listen keeps its rotation off the global cooldown from 0.8 s before the line, so the
    // taunt goes out the moment the line comes (it used to wait for the GCD and land after the 2 s charge).
    private void SeraphHoldForTaunt(string last)
    {
        if (!SeraphNextLine.TryGetValue(last, out var p) || p.next == 'E')
            return;
        // Out of step nobody is the taker ahead of time (the backups decide on the line).
        string? next = _sheetOk ? SeraphSheetAt(_sheetK, _sheetPos) : null;
        if (next == null || next != SeraphSheetRole())
            return;
        _ = Task.Run(async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(Math.Max(0, p.inSec - 0.8)));
            if (!Bot.Player.Alive)
                return;
            DateTime until = DateTime.UtcNow.AddSeconds(2.6);
            if (until > Engine.HoldSkillsUntil)
                Engine.HoldSkillsUntil = until;
        });
    }
    // ---- end Seraph ----

    private static string _fbsMuteFile = "";
`],
  // Ultra Dage: Decay on his line "I possess the power of the legion at my disposal" (AQW Hub guide: the VDK's 5th
  // skill then, LoO's Scroll of Decay to help - his heal is what the Decay stops; every player he kills heals him 500 k
  // too). v3 only cast the LoO's scroll (60 s cooldown) off the Legionnaire aura timer. The owner 2026-10-24: "when
  // fighting dage we apply decay at the right time".
  ['IndividualUltras/9UltraDagev3.cs', '        if (data?.cmd?.ToString() != "event")\n            return;\n',
    '        // Seraph: the legion line (a "ct" animation message) = Decay now.\n        if (data?.cmd?.ToString() == "ct" && data?.anims != null)\n        {\n            foreach (dynamic a in data.anims)\n            {\n                string? msg = a?.msg?.ToString();\n                if (msg != null && msg.IndexOf("power of the legion", StringComparison.OrdinalIgnoreCase) >= 0)\n                    _ = SeraphLegionDecayAsync();\n            }\n            return;\n        }\n\n        if (data?.cmd?.ToString() != "event")\n            return;\n'],
  ['IndividualUltras/9UltraDagev3.cs', '    private async Task DecayAsync(string bossName)\n', String.raw`    // Seraph: the VDK casts Unleash Doom (key 5 = skill 4, the Decay) at once; the LoO's Scroll of Decay follows 1.2 s
    // later only when the boss still shows no Decay. Both keep casting until it shows (a refused cast is no Decay).
    private async Task SeraphLegionDecayAsync()
    {
        bool vdk = Bot.Player.CurrentClass?.Name == "Verus DoomKnight";
        if (!vdk && !IsDecayer())
            return;
        C.Logger($"[UltraDage-v3] [Seraph] the legion line - {(vdk ? "Decay (Unleash Doom)" : "Scroll of Decay if the VDK's misses")}.");
        if (!vdk)
            await Task.Delay(1200);
        DateTime until = DateTime.UtcNow.AddSeconds(2.5);
        if (until > Engine.HoldSkillsUntil)
            Engine.HoldSkillsUntil = until;
        for (int i = 0; i < 50 && Bot.Player.Alive; i++)
        {
            if (Engine.HasAura("Decay"))
                break;
            if (!Bot.Player.HasTarget)
                Bot.Combat.Attack("Dage the Dark Lord");
            Engine.Cast(vdk ? 4 : 5);
            await Task.Delay(50);
        }
    }

    private async Task DecayAsync(string bossName)
`],
  // Ultra Drago (vault KNOWLEDGE/Ultra-Playbooks: "AP and LoO loop-taunt the Executioner (left); LR spam-taunts the
  // Bowmaster (right) until it dies; DPS kills Bowmaster, then Executioner"). v3 had LoO + the LR seat alternate on the
  // Executioner and nobody on the Bowmaster: 2026-10-24 18:09 its "Try not to Bleed Out!" attack (102 x) killed the
  // party ~350 times in 40 min and Drago was never touched. Now LoO + StoneCrusher alternate on the Executioner and
  // the LR seat keeps the Bowmaster taunted.
  ['IndividualUltras/7UltraDragov3.cs', '        return className == Taunter1AttackRightSummon1 || className == Taunter2AttackRightSummon2;\n',
    '        return className == Taunter1AttackRightSummon1 || className == Taunter2AttackRightSummon2 || className == DPSAttackRightSummon1;   // Seraph: SC taunts the Executioner too\n'],
  ['IndividualUltras/7UltraDragov3.cs', '        else if (_role == "Taunter2AttackRightSummon2")\n        {\n            C.Logger("[UltraDrago-v3] Taunter2AttackRightSummon2 — reading fight start time.");\n            fightStartTime = UltraAsync.GetFightTime(Ultra, C, fightTimeSyncPath);\n            UltraAsync.StartTauntLoop(Bot, C, Engine, fightStartTime, 1, cancellationToken: _tauntCts.Token);\n        }\n',
    '        else if (_role == "Taunter2AttackRightSummon2")\n        {\n            // Seraph: the LR seat keeps the Bowmaster taunted until it dies (playbook).\n            C.Logger("[UltraDrago-v3] [Seraph] Taunter2 on the Bowmaster - taunting it whenever its Focus runs out.");\n            fightStartTime = UltraAsync.GetFightTime(Ultra, C, fightTimeSyncPath);\n            _ = SeraphBowTauntLoop(rightSummon, _tauntCts.Token);\n        }\n        else if (_role == "DPSAttackRightSummon1")\n        {\n            // Seraph: StoneCrusher takes the Executioner\'s second taunt slot (the playbook\'s AP).\n            C.Logger("[UltraDrago-v3] [Seraph] StoneCrusher - second Executioner taunter.");\n            fightStartTime = UltraAsync.GetFightTime(Ultra, C, fightTimeSyncPath);\n            UltraAsync.StartTauntLoop(Bot, C, Engine, fightStartTime, 1, cancellationToken: _tauntCts.Token);\n        }\n'],
  ['IndividualUltras/7UltraDragov3.cs', '                if (_role == "Taunter1AttackRightSummon1")\n',
    '                if (_role == "Taunter2AttackRightSummon2")\n                    targetLeftSummon = false;   // Seraph: stays on the Bowmaster\n                else if (_role == "Taunter1AttackRightSummon1")\n'],
  ['IndividualUltras/7UltraDragov3.cs', '    private void EquipPresetClasses()\n', String.raw`    // Seraph: on the Bowmaster while it lives - taunt (scroll, key 5) whenever no Focus lasts past the next 2 s.
    private async Task SeraphBowTauntLoop(string bow, CancellationToken token)
    {
        while (!token.IsCancellationRequested && !Bot.ShouldExit)
        {
            await Task.Delay(200);
            if (!Bot.Player.Alive || !Ultra.MonsterAlive(bow))
                continue;
            if (Bot.Player.Target?.Name != bow || Engine.GetAuraSecondsRemaining("Focus") >= 2)
                continue;
            for (int i = 0; i < 20 && Bot.Player.Alive && Bot.Player.Target?.Name == bow; i++)
            {
                if (Engine.GetAuraSecondsRemaining("Focus") >= 4)
                    break;
                Engine.Cast(5);
                await Task.Delay(50);
            }
        }
    }

    private void EquipPresetClasses()
`],
  // Ultra Darkon (vault playbook: "LoO saves key 5 until Darkon is at ~4.6-4.5 M (the nuke), then spams it"; the owner
  // 2026-10-24: "loo need to time his 5th"): the LoO rotation leaves Order (key 5) alone while Darkon is above 4.65 M.
  ['IndividualUltras/8UltraDarkonv3.cs', '            Bot.Combat.Attack(boss);\n            Pots.ActivateEquippedPotion();\n\n            Bot.Sleep(500);\n',
    '            Bot.Combat.Attack(boss);\n            Pots.ActivateEquippedPotion();\n            if (Bot.Player.CurrentClass?.Name == "Lord of Order")   // Seraph: Order kept for the nuke\n                SeraphHoldOrder(boss);\n\n            Bot.Sleep(500);\n'],
  ['IndividualUltras/8UltraDarkonv3.cs', '                C.Logger(killed ? "Darkon the Conductor defeated. Finishing quest." : "Nothing to gain from Darkon the Conductor: leaving without a fight.");\n',
    '                C.Logger(killed ? "Darkon the Conductor defeated. Finishing quest." : "Nothing to gain from Darkon the Conductor: leaving without a fight.");\n                Engine.LordOfOrderHoldsOrder = false;   // Seraph\n'],
  ['IndividualUltras/8UltraDarkonv3.cs', '    private bool IsTaunter()\n', String.raw`    // Seraph: Order on cooldown, except from 5.4 M down to the nuke at ~4.6 M (Darkon has 22.2 M: holding it from the
    // pull, 2026-10-24 19:44, left the party without Order for the whole fight), so it is ready for the nuke.
    private const int SeraphOrderAtHp = 4_650_000;
    private const int SeraphOrderSaveFromHp = 5_400_000;
    private bool _seraphOrderLogged;
    private void SeraphHoldOrder(string boss)
    {
        var m = Bot.Monsters.CurrentAvailableMonsters.FirstOrDefault(x => x != null && x.Name == boss);
        bool hold = m != null && m.HP > SeraphOrderAtHp && m.HP <= SeraphOrderSaveFromHp;
        if (hold != Engine.LordOfOrderHoldsOrder)
        {
            Engine.LordOfOrderHoldsOrder = hold;
            if (!hold || !_seraphOrderLogged)
                C.Logger($"[UltraDarkon-v3] [Seraph] Order (key 5) {(hold ? "saved for the nuke" : "on cooldown")} - Darkon at {(m?.HP ?? 0):N0} / {(m?.MaxHP ?? 0):N0}.");
            _seraphOrderLogged = true;
        }
    }

    private bool IsTaunter()
`],
  // The Raid Planner (dashboard, the owner 2026-10-24: "decide which characters take which role and how they act and what
  // potions they use"). The hub sets a boss's Comp option to "seraph-plan" and writes raid-plan.txt next to the seats
  // file: "boss=<Boss>" then "Class|Role|potion, potion|scroll" per seat. Each seat plays the script's own code and
  // taunt timing for that role (copied from the script's entry with that role, the same class first), with the class,
  // potions and scroll the owner picked, in its own gear (like every Seraph Comp). Any other Comp name: v3 as before.
  ['DependenciesUltras/UltraComp.cs',
    '    public static UltraComp? Read(string boss, IEnumerable<UltraComp> comps)\n    {\n        string name = UltraPartyLayout.ReadOption(OptionName(boss)).Trim();\n        if (name.Length == 0)\n            name = Default;\n',
    `    // Seraph: the Raid Planner's line-up (lib/ultras.js writePlan), or null with the reason.
    public const string SeraphPlanComp = "seraph-plan";
    public static UltraComp? SeraphPlan(string boss, IEnumerable<UltraComp> comps, out string why)
    {
        why = "";
        try
        {
            string? seats = System.Environment.GetEnvironmentVariable("SERAPH_SEATS_FILE");
            string file = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(seats ?? "") ?? "", "raid-plan.txt");
            if (string.IsNullOrEmpty(seats) || !System.IO.File.Exists(file))
            {
                why = "no raid-plan.txt next to the seats file";
                return null;
            }
            string[] lines = System.IO.File.ReadAllLines(file);
            if (lines.Length == 0 || !lines[0].Trim().Equals("boss=" + boss, StringComparison.OrdinalIgnoreCase))
            {
                why = $"the plan is for another boss ({(lines.Length > 0 ? lines[0] : "empty file")})";
                return null;
            }
            List<UltraCompEntry> entries = new();
            List<UltraCompEntry> known = comps.SelectMany(c => c.Entries).ToList();
            foreach (string raw in lines.Skip(1))
            {
                if (string.IsNullOrWhiteSpace(raw))
                    continue;
                string[] p = raw.Split('|');
                string cls = p[0].Trim();
                string role = p.Length > 1 ? p[1].Trim() : "";
                UltraCompEntry? t = known.FirstOrDefault(e => e.Role.Equals(role, StringComparison.OrdinalIgnoreCase) && e.Class.Equals(cls, StringComparison.OrdinalIgnoreCase))
                    ?? known.FirstOrDefault(e => e.Role.Equals(role, StringComparison.OrdinalIgnoreCase));
                if (t == null)
                {
                    why = $"{boss} has no role {role}";
                    return null;
                }
                string[] pots = p.Length > 2 ? p[2].Split(',').Select(x => x.Trim()).Where(x => x.Length > 0).ToArray() : Array.Empty<string>();
                string scroll = p.Length > 3 ? p[3].Trim() : "";
                entries.Add(new UltraCompEntry
                {
                    Class = cls,
                    Role = t.Role,
                    Taunt = p.Length > 4 && int.TryParse(p[4].Trim(), out int tauntAt) ? UltraTaunt.Every(t.Taunt.CycleSec > 0 ? t.Taunt.CycleSec : 12, tauntAt, t.Taunt.SkipWhileAura, t.Taunt.BeforeTaunt) : t.Taunt,   // Seraph: plan line field 5
                    MinMaxHealth = t.MinMaxHealth,
                    Loadout = new UltraLoadout
                    {
                        Potions = pots,
                        ClickPotionInFight = t.Loadout.ClickPotionInFight,
                        Scroll = scroll.Length > 0 ? scroll : null,
                    },
                });
            }
            if (entries.Count == 0)
            {
                why = "the plan has no seats";
                return null;
            }
            return new UltraComp(SeraphPlanComp, entries.ToArray());
        }
        catch (Exception e)
        {
            why = e.Message;
            return null;
        }
    }

    public static UltraComp? Read(string boss, IEnumerable<UltraComp> comps)
    {
        string name = UltraPartyLayout.ReadOption(OptionName(boss)).Trim();
        if (name.Length == 0)
            name = Default;
        if (name.Equals(SeraphPlanComp, StringComparison.OrdinalIgnoreCase))   // Seraph: the dashboard's Raid Planner
        {
            UltraComp? plan = SeraphPlan(boss, comps, out string why);
            if (plan == null)
            {
                Stop(boss, $"Seraph raid plan: {why}");
                return null;
            }
            C.Logger($"[Comp:{boss}] {plan.Name} (Raid Planner): {string.Join("; ", plan.Entries.Select(e => $"{e.Class} as {e.Role}, potions {(e.Loadout.Potions.Length > 0 ? string.Join(", ", e.Loadout.Potions) : "none")}, scroll {e.Loadout.Scroll ?? "none"}"))}.");
            return plan;
        }
`],
  // ---- Flibbitiestgibbet (NSoD daily's last boss; the owner 2026-10-25: "just go any comp but make my main use LR ... at least one
  // VHL, SC, LoO ... before starting the fight make sure LR buffs, LoO buffs and SC buffs"). The crew (lib/crewdaily.js) runs
  // this army script for the stage; the class line-up comes from its options. Upstream gaps fixed here:
  //  - it read Config "Item"/"Quantity" options it never declares: the army is done when everyone holds Flibbitigiblets
  //  - it finished with EnsureComplete(8547) (Ultra Dage's quest); Seraph's daily turns 8653 in
  //  - buffs first: each Legion Revenant / Lord of Order / StoneCrusher casts its party buffs, then the army starts together
  ['ChallengeBosses/Flibbitiestgibbetv3.cs', `    bool InventoryHasItems()
    {
`,
    `    // Seraph: the party buffs, cast before the fight starts (skill ids: Legion Revenant 3 Depraved Empowerment; Lord of Order 1
    // Empowerment + 3 Clarity, never 4 Order; StoneCrusher 3, 2, 4). The engine's rotation keeps them up afterwards.
    void PreFightBuffs()
    {
        string cls = (Core.GetCurrentClassName() ?? "").ToLowerInvariant();
        int[] ids = cls switch
        {
            "legion revenant" => new[] { 3 },
            "lord of order" => new[] { 1, 3 },
            "stonecrusher" or "infinity titan" => new[] { 3, 2, 4 },
            _ => System.Array.Empty<int>(),
        };
        foreach (int id in ids)
        {
            for (int i = 0; i < 24 && !Core.Cast(id); i++)
                Bot.Sleep(250);
            Bot.Sleep(1300);
        }
        C.Logger($"Pre-fight buffs cast ({cls}: {string.Join(",", ids)}).");
    }

    bool InventoryHasItems()
    {
        if (Bot != null)   // Seraph: the NSoD daily's drop; the Item/Quantity options do not exist
            return Bot.Inventory.Contains((int)ItemToFarm.Flibbitigiblets, 1);
`],
  ['ChallengeBosses/Flibbitiestgibbetv3.cs', `                C.EnsureComplete(8547);
`, `                // Seraph: the daily turns 8653 in (upstream completed 8547 here)
`],
  // The NSoD daily's own drop was never in the list: the server offered Flibbitigiblets after every kill and nobody took it.
  ['ChallengeBosses/Flibbitiestgibbetv3.cs', `C.AddDrop("Flibbitiestgibbet's ??? Essence", "Insatiable Hunger",`, `C.AddDrop("Flibbitigiblets", "Flibbitiestgibbet's ??? Essence", "Insatiable Hunger",`],
  ['ChallengeBosses/Flibbitiestgibbetv3.cs', `        Core.EnableSkills();

        C.Logger("Fight start synced.");`,
    `        PreFightBuffs();   // Seraph: LR / LoO / SC buffs up first
        Ultra.WaitForArmy(armySize - 1, "FlibbitiestgibbetBuffs.sync");   // Seraph: everyone has buffed - start together
        Core.EnableSkills();

        C.Logger("Fight start synced.");`],
  // Ultra Avatar Tyndarius, the owner 2026-10-26: buffs (Legion Revenant, Lord of Order) before the fight, the ArchPaladin enters first and
  // targets Tyndarius, the rest join at once (barriers on sync files, each with a timeout).
  ["IndividualUltras/4UltraAvatarTyndariusv3.cs", "    private static bool IsAlive(int mapId) =>", "    // Seraph: the owner's opening for Ultra Avatar Tyndarius (2026-10-26): the party gathers in the first room, Legion Revenant and\n    // Lord of Order cast their party buffs, then the ArchPaladin walks in alone and targets Tyndarius and the rest follow at once.\n    // Skill ids are 0-based: Legion Revenant 3 Depraved Empowerment; Lord of Order 1 Empowerment + 3 Clarity (4 Order is held back).\n    private int _seraphAttempt;\n\n    private void PreFightBuffs()\n    {\n        string cls = (Bot.Player.CurrentClass?.Name ?? \"\").ToLowerInvariant();\n        int[] ids = cls switch\n        {\n            \"legion revenant\" => new[] { 3 },\n            \"lord of order\" => new[] { 1, 3 },\n            _ => Array.Empty<int>(),\n        };\n        foreach (int id in ids)\n        {\n            for (int i = 0; i < 24 && !Engine.Cast(id); i++)\n                Bot.Sleep(250);\n            Bot.Sleep(1300);\n        }\n        C.Logger($\"Pre-fight buffs cast ({cls}: {string.Join(\",\", ids)}).\");\n    }\n\n    // A barrier on a sync file: \"<user>|<attempt>|<unix time>\" lines, one per client per Attempt. Waiting never lasts longer than the timeout.\n    private void SeraphMark(string file)\n    {\n        try\n        {\n            using var fs = new System.IO.FileStream(Ultra.ResolveSyncPath(file), System.IO.FileMode.Append, System.IO.FileAccess.Write, System.IO.FileShare.ReadWrite);\n            using var sw = new System.IO.StreamWriter(fs);\n            sw.WriteLine($\"{Bot.Player.Username}|{_seraphAttempt}|{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}\");\n        }\n        catch { }\n    }\n\n    private bool SeraphWait(string file, int need, int timeoutSec)\n    {\n        string path = Ultra.ResolveSyncPath(file);\n        long since = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 120;\n        DateTime end = DateTime.UtcNow.AddSeconds(timeoutSec);\n        while (DateTime.UtcNow < end && !Bot.ShouldExit && !_wipeCts.IsCancellationRequested)\n        {\n            int n = 0;\n            try\n            {\n                using var fs = new System.IO.FileStream(path, System.IO.FileMode.OpenOrCreate, System.IO.FileAccess.Read, System.IO.FileShare.ReadWrite | System.IO.FileShare.Delete);\n                using var sr = new System.IO.StreamReader(fs);\n                n = sr.ReadToEnd().Split('\\n', StringSplitOptions.RemoveEmptyEntries)\n                    .Select(l => l.Trim().Split('|'))\n                    .Where(p => p.Length == 3 && p[1] == _seraphAttempt.ToString() && long.TryParse(p[2], out long ts) && ts >= since)\n                    .Select(p => p[0]).Distinct().Count();\n            }\n            catch { }\n            if (n >= need)\n                return true;\n            Bot.Sleep(250);\n        }\n        return false;\n    }\n\n    private static bool IsAlive(int mapId) =>"],
  ["IndividualUltras/4UltraAvatarTyndariusv3.cs", "        UltraAttempt attempt = _attempt = UltraAttempt.Begin(heldAtStart,", "        // Seraph: the owner's opening - buffs first, then the ArchPaladin alone on Tyndarius, then everybody at once.\n        PreFightBuffs();\n        SeraphMark(\"TyndariusBuffed.sync\");\n        SeraphWait(\"TyndariusBuffed.sync\", armySize, 40);\n        if (_comp.Entries.Any(e => e.Class == \"ArchPaladin\"))\n        {\n            if (_entry.Class == \"ArchPaladin\")\n            {\n                if (!string.IsNullOrEmpty(bestCell) && Bot.Player.Cell != bestCell)\n                {\n                    C.Jump(bestCell, bestPad ?? \"Left\");\n                    Bot.Wait.ForCellChange(bestCell);\n                }\n                Bot.Combat.Attack(Tyndarius);\n                SealUp();   // the guide: the AP goes in first and puts Righteous Seal up at once\n                Bot.Sleep(500);\n                SeraphMark(\"TyndariusApIn.sync\");\n            }\n            else\n            {\n                SeraphWait(\"TyndariusApIn.sync\", 1, 30);\n                Bot.Sleep(500);\n            }\n        }\n\n        UltraAttempt attempt = _attempt = UltraAttempt.Begin(heldAtStart,"],
  ["IndividualUltras/4UltraAvatarTyndariusv3.cs", "        const string map = \"ultratyndarius\";", "        _seraphAttempt++;   // Seraph: the opening barriers count Attempts\n        const string map = \"ultratyndarius\";"],
];
function applyFixes(rel, text) {
  const crlf = text.includes('\r\n');
  for (let [file, from, to] of FIXES) {
    if (!rel.replace(/\\/g, '/').endsWith(file)) continue;
    if (crlf) { from = from.replace(/\r?\n/g, '\r\n'); to = to.replace(/\r?\n/g, '\r\n'); }   // fixes are written with \n
    if (text.includes(to)) continue;
    if (!text.includes(from)) throw new Error(`${rel}: Seraph fix no longer matches: ${from.trim()}`);
    text = text.split(from).join(to);
  }
  return text;
}
module.exports = { FIXES, applyFixes };

if (require.main === module && fixesOnly) {
  for (const [file] of FIXES) {
    const f = path.join(OUT, file);
    fs.writeFileSync(f, applyFixes(file, fs.readFileSync(f, 'utf8')));
    console.log(`fixed ${file}`);
  }
  process.exit(0);
}
if (require.main !== module) return;

let n = 0;
let comps = 0;
// Seraph's own scripts in the folder (Seraph*.cs, e.g. ChallengeBosses/SeraphCarnaxSolo.cs, 2026-10-27) are not in the
// fork: keep them across a re-vendor.
const KEEP = fs.existsSync(OUT) ? walk(OUT).filter((f) => /^Seraph[A-Z].*\.cs$/.test(path.basename(f))).map((f) => [path.relative(OUT, f), fs.readFileSync(f)]) : [];
fs.rmSync(OUT, { recursive: true, force: true });
process.on('exit', () => { for (const [rel, body] of KEEP) { fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true }); fs.writeFileSync(path.join(OUT, rel), body); } });
for (const file of walk(src)) {
  const rel = path.relative(src, file);
  let text = fs.readFileSync(file, 'utf8').replace(/Scripts\/Ultrasv3\//g, 'Scripts/SeraphUltras/');
  if (REPORT.test(text)) text = text.replace(REPORT, REPORT_NEW);
  // A member on another server relogs into the party room (Sable from her Artix gold farm, 2026-10-19: ~25 s plus
  // a slower join) and v3 gave up after 60 s - Ultra Engineer was called off twice that day. 4 min for the party.
  text = text.replace('WaitForPartyInRoom(ClassByUser.Keys);', 'WaitForPartyInRoom(ClassByUser.Keys, timeoutSec: 240);');
  text = applyFixes(rel, text);
  const boss = (/public const string Boss = "([^"]+)";/.exec(text) || [])[1];
  const mine = boss ? COMPS.filter((c) => c.boss === boss) : [];
  if (mine.length) {
    const i = text.indexOf('public static readonly UltraComp[] Comps =');
    const end = i >= 0 ? text.indexOf('\n    };', i) : -1;
    if (end < 0) throw new Error(`${rel}: no Comps array for ${boss}`);
    text = text.slice(0, end + 1) + mine.map(compCs).join('') + text.slice(end + 1);
    comps += mine.length;
  }
  const to = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, text);
  n++;
}
fs.writeFileSync(path.join(OUT, 'SERAPH.md'), `Vendored from noelrohi/Scripts (branch Skua) Ultrasv3 by tools/vendor-ultras.js on ${new Date().toISOString()}.\nDo not edit here: change lib/ultras-comps.json or the tool and vendor again.\n`);
console.log(`vendored ${n} files to ${OUT}, ${comps} Seraph comps added`);
