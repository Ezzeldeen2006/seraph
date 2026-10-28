/*
name: Seraph Nightmare Carnax Solo
description: the owner's main solos Nightmare Carnax (darkcarnax) for Calamitous Ruin - Dragon of Time in his own DoT outfit, Sage Tonic + Potent Malevolence Elixir + Potent Honor Potion from his bank (never bought), dodges the laser, never enhances.
tags: Seraph, Carnax, Nightmare Carnax, ArchMage, Dragon of Time, solo
*/
// Seraph (2026-10-27, the owner: "solo dark carnax ... using Dragon of Time with potions"). Not part of the Ultras v3 fork:
// tools/vendor-ultras.js must keep this file when it re-vendors. Setup from the solo videos (DoT, Valiance/Elysium,
// healer gear, Sage Tonic / Potent Malevolence Elixir / Potent Honor Potion). The main's CBO never enhances, so his
// outfit's own enhancements are used as they are.

//cs_include Scripts/CoreBots.cs
using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Skua.Core.Interfaces;
using Skua.Core.Models.Skills;

public class SeraphCarnaxSolo
{
    private IScriptInterface Bot => IScriptInterface.Instance;
    private CoreBots Core => CoreBots.Instance;

    private static readonly string[] Outfit = { "Dragon of Time", "Empowered Dual Caladbolgs", "Fragmented Astral Helm", "Atlas Stone" };
    private static readonly string[] Buffs = { "Sage Tonic", "Potent Malevolence Elixir" };
    private const string Potion = "Potent Honor Potion";
    private const int MaxDeaths = 40;

    private string currentZone = "";
    private DateTime lastMove = DateTime.MinValue;
    private int deaths;

    public void ScriptMain(IScriptInterface bot)
    {
        Core.SetOptions();
        Fight();
        Core.SetOptions(false);
    }

    private void Drink()
    {
        foreach (string p in Buffs.Append(Potion))
        {
            // A buff still on (tonics and elixirs outlast a death) is not drunk again: re-drinking after every death
            // used all 11 Sage Tonics and 12 Potent Malevolence Elixirs in 12 minutes (2026-10-27).
            if (p != Potion && HasAura(p))
                continue;
            if (!Core.CheckInventory(p))
            {
                Core.Logger($"[Seraph] no {p} left");
                continue;
            }
            for (int i = 0; i < 2 && !Bot.Inventory.IsEquipped(p); i++)
            {
                Bot.Inventory.EquipUsableItem(p);
                Bot.Sleep(500);
                Bot.Wait.ForItemEquip(p);
            }
            // The last one equipped (the Honor potion) stays in the item slot and is used again on its cooldown.
            if (p != Potion && Bot.Inventory.IsEquipped(p))
            {
                Core.UsePotion();
                Bot.Sleep(700);
            }
        }
    }

    private bool HasAura(string name)
    {
        try { return Bot.Self.Auras.Any(a => a != null && a.Name != null && a.Name.Equals(name, StringComparison.OrdinalIgnoreCase)); }
        catch { return false; }
    }

    private void Move(string zone)
    {
        string z = (zone ?? "").ToLower();
        Core.Logger($"[Seraph] laser zone '{z}'");
        if (z == currentZone || DateTime.Now - lastMove < TimeSpan.FromSeconds(1))
            return;
        currentZone = z;
        lastMove = DateTime.Now;
        Task.Run(() =>
        {
            Thread.Sleep(200);
            int y = Bot.Random.Next(380, 475);
            int x = z switch
            {
                "a" => Bot.Random.Next(600, 931),
                "b" => Bot.Random.Next(25, 326),
                _ => Bot.Random.Next(325, 601),
            };
            Bot.Player.WalkTo(x, y);
        });
    }

    private void Fight()
    {
        if (Core.CheckInventory("Calamitous Ruin"))
        {
            Core.Logger("[Seraph] Calamitous Ruin already owned");
            return;
        }
        Core.Unbank(Buffs.Append(Potion).Concat(Outfit).ToArray());
        foreach (string piece in Outfit)
            if (Core.CheckInventory(piece))
                Core.Equip(piece);

        Drink();   // out of combat, before the boss
        Core.AddDrop("Calamitous Ruin", "Synthetic Viscera");
        Core.RegisterQuests(8872);
        Core.Join("DarkCarnax", "Boss", "Right");
        Bot.Player.SetSpawnPoint();
        Bot.Options.AttackWithoutTarget = true;
        Bot.Events.RunToArea += Move;
        Bot.Events.PlayerDeath += OnDeath;
        Bot.Events.ExtensionPacketReceived += OnPacket;

        Bot.Skills.StartAdvanced("3|2|4|2|1|2", 250, SkillUseMode.WaitForCooldown);

        try
        {
            while (!Bot.ShouldExit && !Core.CheckInventory("Calamitous Ruin"))
            {
                if (deaths >= MaxDeaths)
                {
                    Core.Logger($"[Seraph] {deaths} deaths without the kill - stopping", stopBot: true);
                    return;
                }
                if (!Bot.Player.Alive)
                {
                    Bot.Wait.ForTrue(() => Bot.Player.Alive, 30);
                    currentZone = "";
                    Bot.Sleep(1500);
                    Drink();
                    Bot.Skills.StartAdvanced("3|2|4|2|1|2", 250, SkillUseMode.WaitForCooldown);
                    continue;
                }
                if (Bot.Map.Name?.ToLower() != "darkcarnax")
                    Core.Join("DarkCarnax", "Boss", "Right");
                if (Bot.Player.Cell != "Boss")
                    Core.Jump("Boss", "Right");
                if (!Bot.Player.HasTarget)
                    Bot.Combat.Attack("Nightmare Carnax");
                if (Bot.Inventory.IsEquipped(Potion) && Bot.Skills.CanUseSkill(5) && Bot.Player.Health < Bot.Player.MaxHealth * 0.6)
                    Core.UsePotion();
                Bot.Sleep(300);
            }
            Core.Logger($"[Seraph] Calamitous Ruin: {(Core.CheckInventory("Calamitous Ruin") ? "got it" : "not yet")} ({deaths} deaths)");
        }
        finally
        {
            Bot.Events.RunToArea -= Move;
            Bot.Events.PlayerDeath -= OnDeath;
            Bot.Events.ExtensionPacketReceived -= OnPacket;
            Bot.Options.AttackWithoutTarget = false;
            Core.CancelRegisteredQuests();
        }
    }

    private void OnDeath()
    {
        deaths++;
        Core.Logger($"[Seraph] died ({deaths}) - HP max {Bot.Player.MaxHealth}");
    }

    // The laser warning, for the record: if no zoneSet ever comes, the journal shows whether the warning itself does.
    private void OnPacket(dynamic packet)
    {
        try
        {
            string s = Convert.ToString(packet);
            if (s != null && s.IndexOf("laser", StringComparison.OrdinalIgnoreCase) >= 0)
                Core.Logger("[Seraph] laser warning seen");
        }
        catch { }
    }
}
