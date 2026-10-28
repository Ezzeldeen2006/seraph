/*
name: CoreBots smoke test
description: CoreBots start-up, quest, hunt and turn-in against the fake server
tags: test
*/
//cs_include Scripts/CoreBots.cs
using Skua.Core.Interfaces;

public class CoreBotsSmoke
{
    public IScriptInterface Bot => IScriptInterface.Instance;
    public CoreBots Core => CoreBots.Instance;

    public void ScriptMain(IScriptInterface bot)
    {
        Core.SetOptions();
        Core.Logger("CoreBots started");
        Core.EnsureAccept(1000);
        Core.HuntMonster("testmap", "Pixie", "Pixie Dust", 3, isTemp: true);
        Core.EnsureComplete(1000);
        Core.Logger($"Pixie Crown: {Core.CheckInventory("Pixie Crown")}");
        Core.SetOptions(false);
    }
}
