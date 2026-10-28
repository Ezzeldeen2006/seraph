//cs_include Scripts/CoreBots.cs
using Skua.Core.Interfaces;
using Skua.Core.Models.Items;

// Engine smoke test against tests/fakeaqw.js: plain Skua API, no CoreBots logic.
public class EngineSmoke
{
    public IScriptInterface Bot => IScriptInterface.Instance;

    public void ScriptMain(IScriptInterface bot)
    {
        void Check(bool ok, string what) { Bot.Log((ok ? "PASS " : "FAIL ") + what); }

        Check(Bot.Player.Playing, $"playing as {Bot.Player.Username} lvl {Bot.Player.Level} hp {Bot.Player.Health}/{Bot.Player.MaxHealth}");
        Check(Bot.Map.Name == "testmap", $"on map {Bot.Map.Name} room {Bot.Map.RoomID} cell {Bot.Player.Cell}");
        Check(Bot.Inventory.Contains("Default Sword"), $"inventory {Bot.Inventory.Items.Count} items, gold {Bot.Player.Gold}");
        Check(Bot.Player.CurrentClass?.Name == "Healer", $"class {Bot.Player.CurrentClass?.Name} rank {Bot.Player.CurrentClassRank}");
        Check(Bot.Player.Skills.Length >= 5, $"skills {Bot.Player.Skills.Length}");

        Bot.Map.Jump("r2", "Left");
        Check(Bot.Player.Cell == "r2", $"jumped to {Bot.Player.Cell}");
        Check(Bot.Monsters.CurrentAvailableMonsters.Count == 2, $"monsters here: {string.Join(",", Bot.Monsters.CurrentAvailableMonsters.Select(m => m.Name + ":" + m.HP))}");

        Bot.Quests.Load(1000);
        Bot.Wait.ForQuestLoad(1000);
        Bot.Quests.EnsureAccept(1000);
        Check(Bot.Quests.IsInProgress(1000), "quest 1000 accepted");

        Bot.Drops.Add("Pixie Wing");
        Bot.Drops.Start();
        Bot.Skills.StartAdvanced("Healer", true);
        Bot.Hunt.ForItem("Pixie", "Pixie Dust", 3, true);
        Check(Bot.TempInv.Contains("Pixie Dust", 3), $"hunted: Pixie Dust x{Bot.TempInv.GetQuantity("Pixie Dust")}, kills {Bot.Stats.Kills}");
        Check(Bot.Quests.CanComplete(1000), "quest 1000 can be completed");
        Bot.Quests.EnsureComplete(1000);
        Bot.Wait.ForTrue(() => Bot.Inventory.Contains("Pixie Crown"), 20);
        Check(!Bot.Quests.IsInProgress(1000) && Bot.Inventory.Contains("Pixie Crown"), $"quest 1000 turned in, reward in bag, quests done {Bot.Stats.QuestsCompleted}");
        Bot.Wait.ForTrue(() => Bot.Inventory.Contains("Pixie Wing"), 20);
        Check(Bot.Inventory.Contains("Pixie Wing"), $"picked up Pixie Wing x{Bot.Inventory.GetQuantity("Pixie Wing")}");
        Bot.Skills.Stop();
        Bot.Drops.Stop();

        Bot.Quests.EnsureAccept(1001);
        Bot.Map.GetMapItem(50);
        Bot.Wait.ForTrue(() => Bot.TempInv.Contains("Lost Ring"), 20);
        Bot.Quests.EnsureComplete(1001);
        Check(!Bot.Quests.IsInProgress(1001), "map item quest done");

        Bot.Map.Join("shopmap");
        Check(Bot.Map.Name == "shopmap", $"joined {Bot.Map.Name}");
        int gold = Bot.Player.Gold;
        Bot.Shops.Load(100);
        Bot.Wait.ForTrue(() => Bot.Shops.IsLoaded && Bot.Shops.ID == 100, 20);
        Check(Bot.Shops.Items.Count == 2, $"shop {Bot.Shops.Name}: {string.Join(",", Bot.Shops.Items.Select(i => i.Name))}");
        Bot.Shops.BuyItem("Health Potion", 3);
        Bot.Wait.ForTrue(() => Bot.Inventory.GetQuantity("Health Potion") >= 3, 20);
        Check(Bot.Inventory.GetQuantity("Health Potion") == 3 && Bot.Player.Gold == gold - 15, $"bought 3 potions, gold {gold} -> {Bot.Player.Gold}");
        Bot.Shops.SellItem("Old Boots");
        Bot.Wait.ForTrue(() => !Bot.Inventory.Contains("Old Boots"), 20);
        Check(!Bot.Inventory.Contains("Old Boots"), "sold Old Boots");

        Bot.Bank.Load();
        Check(Bot.Bank.Contains("Pixie Wing"), $"bank loaded: {string.Join(",", Bot.Bank.Items.Select(i => i.Name))}");
        Bot.Inventory.EquipItem("Pixie Crown");
        Bot.Wait.ForItemEquip("Pixie Crown", 20);
        Check(Bot.Inventory.IsEquipped("Pixie Crown"), "equipped Pixie Crown");
        Bot.Log("SMOKE DONE");
    }
}
