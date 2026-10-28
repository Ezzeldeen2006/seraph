/*
name: Entry target
description: a script whose one method Seraph calls through lib/skua/entry.js
tags: test
*/
//cs_include Scripts/CoreBots.cs
using Skua.Core.Interfaces;

public class EntryTarget
{
    public IScriptInterface Bot => IScriptInterface.Instance;
    public CoreBots Core => CoreBots.Instance;

    public void ScriptMain(IScriptInterface bot)
    {
        Core.Logger("ScriptMain should not run when an entry is given");
    }

    public void GetRing(int times = 1, string note = "none")
    {
        Core.Logger($"GetRing called with times={times} note={note}");
        Core.EnsureAccept(1001);
        Bot.Map.GetMapItem(50);
        Bot.Wait.ForTrue(() => Bot.TempInv.Contains("Lost Ring"), 20);
        Core.EnsureComplete(1001);
        Core.Logger("ENTRY DONE");
    }
}
