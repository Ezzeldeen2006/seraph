using Skua.Core.Interfaces;

public class ReloginSmoke
{
    public IScriptInterface Bot => IScriptInterface.Instance;

    public void ScriptMain(IScriptInterface bot)
    {
        Bot.Log($"before: playing {Bot.Player.Playing} on {Bot.Map.Name}, user {Bot.Player.Username}");
        bool ok = Bot.Servers.Relogin("Sandbox");
        Bot.Wait.ForTrue(() => Bot.Player.Playing && Bot.Player.Loaded, 30);
        Bot.Log((ok && Bot.Player.Playing ? "PASS" : "FAIL") + $" relogin: playing {Bot.Player.Playing} loaded {Bot.Player.Loaded} map {Bot.Map.Name} relogins {Bot.Stats.Relogins}");
        Bot.Map.Jump("r2", "Left");
        Bot.Log((Bot.Player.Cell == "r2" ? "PASS" : "FAIL") + " still controls the character after the relogin");
    }
}
