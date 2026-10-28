/*
name: Blaze Beard Story
description: This will finish the Blaze Beard Story Quest.
tags: story, quest, blaze-beard, pirate
*/
// SERAPH FIX (2026-09-21) of auqw/Scripts Seasonal/TalkLikeaPirateDay/BlazeBeardStory.cs (last changed upstream
// 2025-11-13). Upstream, cases 4514-4517, 4519 and 4521 farm the item of the quest BEFORE them, 4513 has no case, and
// nothing farms 4517's Darkness Energy - so "Shadow Shroud Potion" hunted No Explosion (4516's item) forever.
// Every case below now farms what the game's own quest data (Scripts/QuestData.json) and the AQW Wiki
// (Kervaal's Quests) list for that quest. Seraph runs this copy only while the library file is unchanged.
//cs_include Scripts/CoreBots.cs
//cs_include Scripts/CoreStory.cs
using Skua.Core.Interfaces;

public class BlazeBeard
{
    public IScriptInterface Bot => IScriptInterface.Instance;
    public CoreBots Core => CoreBots.Instance;
    private static CoreStory Story
    {
        get => _Story ??= new CoreStory();
        set => _Story = value;
    }
    private static CoreStory _Story;

    public void ScriptMain(IScriptInterface bot)
    {
        // Core.BankingBlackList.AddRange(RequiredItems);
        Core.SetOptions();

        TokenQuests();

        Core.SetOptions(false);
    }

    // string[] RequiredItems = { "Pirate Booty I", "Pirate Booty II", "Pirate Booty III", "Pirate Booty IV", "Pirate Booty V", "Pirate Booty VI", "Pirate Booty VII", "Pirate Booty VIII", "Pirate Booty IX", "Pirate Booty X", "Pirate Booty XI", "Pirate Booty XII", "Pirate Booty XIII", "Pirate Booty XIV", "Pirate Booty XV" };

    public void TokenQuests()
    {
        if (Core.CheckInventory("Pirate Booty XV") || !Core.isSeasonalMapActive("BlazeBeard"))
            return;

        Story.PreLoad(this);

        Story.LegacyQuestManager(
            QuestLogic,
            4513,
            4514,
            4515,
            4516,
            4517,
            4518,
            4519,
            4520,
            4521,
            4522,
            4523,
            4524,
            4525,
            4526,
            4527
        );

        void QuestLogic()
        {
            switch (Story.LegacyQuestID)
            {
                case 4513:
                    Core.HuntMonster("CrashSite", "Barrier Bot", "Dwakel Scrap Metal", 10);
                    break;

                case 4514:
                    Core.HuntMonster("Mafic", "Living Fire", "Mysterious Molten Metal", 12);
                    break;

                case 4515:
                    Core.HuntMonster("Elemental", "Mana Falcon", "Mana Droplets", 12);
                    break;

                case 4516:
                    Core.HuntMonster("EarthStorm", "Earth Elemental", "No Explosion", 15);
                    break;

                case 4517:
                    Core.HuntMonster("BlazeBeard", "Undead Pirate", "Darkness Energy", 8);
                    break;

                case 4518:
                    Core.GetMapItem(3725, 12, "BlazeBeard");
                    break;

                case 4519:
                    Core.HuntMonster("BlazeBeard", "Pirate Crew", "Pirate Crew Defeated", 15);
                    break;

                case 4520:
                    Core.HuntMonster("BlazeBeard", "Pirate Plunderer", "Blazebeard's Plans", 5);
                    break;

                case 4521:
                {
                    // The wiki says 10 Plunderer Defeated, the game's quest data 5: ask the quest itself.
                    int plunderers = 5;
                    var keepOnBattling = Core.EnsureLoad(4521);
                    if (keepOnBattling != null)
                        foreach (var r in keepOnBattling.Requirements)
                            if (r.Name == "Plunderer Defeated")
                                plunderers = r.Quantity;
                    Core.HuntMonster("BlazeBeard", "Pirate Crew", "Pirate Crew Defeated", 10);
                    Core.HuntMonster("BlazeBeard", "Pirate Plunderer", "Plunderer Defeated", plunderers);
                    break;
                }

                case 4522:
                    Core.HuntMonster("BlazeBeard", "Pirate Captain", "Captain Defeated");
                    break;

                case 4523:
                    Core.HuntMonster("ManaCannon", "Pirate Gunner", "Hand Cannons", 6);
                    break;

                case 4524:
                    Core.HuntMonster("ManaCannon", "Pirate Plunderer", "Location Researched", 10);
                    break;

                case 4525:
                    Core.HuntMonster("ManaCannon", "Pirate Crew", "Crew Defeated", 15);
                    break;

                case 4526:
                    Core.HuntMonster("ManaCannon", "Pirate Caster", "Pirate Caster Defeated", 15);
                    break;

                case 4527:
                    Core.HuntMonster("ManaCannon", "Blazebeard", "Blazebeard Doused");
                    break;
            }
        }
    }
}
