using System.Globalization;
using CommunityToolkit.Mvvm.DependencyInjection;
using CommunityToolkit.Mvvm.Messaging;
using Microsoft.Extensions.DependencyInjection;
using Newtonsoft.Json.Linq;
using Skua.Core.AppStartup;
using Skua.Core.Interfaces;
using Skua.Core.Messaging;
using Skua.Core.Models;

namespace Seraph.Skua;

/// <summary>
/// Seraph's Skua engine: one process per character, started by lib/skua/engine.js.
/// It builds the same service container as Skua.App.WPF, minus the windows, and runs scripts with
/// Skua's own ScriptManager, compiler and ScriptInterface. Environment:
///   SKUA_DIR          this character's Skua folder (settings, options, cache)
///   SKUA_SCRIPTS_DIR  the shared auqw/Scripts checkout
/// </summary>
public static class Program
{
    private static Ipc _ipc = null!;
    private static IServiceProvider _services = null!;

    public static int Main(string[] args)
    {
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;
        Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;

        Stream stdout = Console.OpenStandardOutput();
        Console.SetOut(Console.Error);   // stdout is the IPC channel and nothing else
        _ipc = new Ipc(Console.OpenStandardInput(), stdout);

        AppDomain.CurrentDomain.UnhandledException += (_, e) => _ipc.Log("debug", $"unhandled: {e.ExceptionObject}");
        TaskScheduler.UnobservedTaskException += (_, e) => { e.SetObserved(); };

        try
        {
            _services = ConfigureServices();
            Ioc.Default.ConfigureServices(_services);
            _services.GetRequiredService<ISettingsService>().SetApplicationVersion();
            IClientFilesService files = _services.GetRequiredService<IClientFilesService>();
            files.CreateDirectories();
            SeedSkuaFiles();
            files.CreateFiles();

            IScriptInterface bot = _services.GetRequiredService<IScriptInterface>();
            HookScriptEvents();
            _ipc.Command += OnCommand;
            _ipc.Event("ready", new { version = typeof(IScriptInterface).Assembly.GetName().Version?.ToString(), pid = Environment.ProcessId });
        }
        catch (Exception e)
        {
            _ipc.Event("fatal", e.ToString());
            return 2;
        }

        // Live until Seraph closes the pipe or asks us to exit.
        while (!_ipc.Closed && !_exit.IsSet)
            _exit.Wait(1000);
        Shutdown();
        return 0;
    }

    private static readonly ManualResetEventSlim _exit = new(false);

    // Skua's ClientFilesService.CreateFiles() makes a missing AdvancedSkills.json / QuestData.json with File.Create and
    // never closes the handle; the skill container then opens the same file. Windows let that pass, Linux refused
    // ("being used by another process") and the host died on every character's first start. Seed both files first,
    // from the script library's own copies, so Skua never takes that path (and starts with the real skill sets).
    static void SeedSkuaFiles()
    {
        (string target, string source)[] seeds =
        {
            (ClientFileSources.SkuaAdvancedSkillsFile, Path.Combine(ClientFileSources.SkuaScriptsDIR, "Skills", "AdvancedSkills.json")),
            (ClientFileSources.SkuaQuestsFile, Path.Combine(ClientFileSources.SkuaScriptsDIR, "QuestData.json")),
        };
        foreach ((string target, string source) in seeds)
        {
            if (File.Exists(target)) continue;
            try
            {
                if (File.Exists(source)) File.Copy(source, target);
                else File.WriteAllText(target, "[]");
            }
            catch (IOException) { /* another engine seeded it first */ }
        }
    }

    private static IServiceProvider ConfigureServices()
    {
        ServiceCollection services = new();
        services.AddSingleton(_ipc);
        services.AddSingleton<ISettingsService, HeadlessSettingsService>();
        services.AddSingleton<IFlashUtil, IpcFlashUtil>();
        services.AddSingleton<IDispatcherService, HeadlessDispatcher>();
        services.AddSingleton<IClipboardService, MemoryClipboard>();
        services.AddSingleton<IDialogService, HeadlessDialogService>();
        services.AddSingleton<IWindowService, NoWindows>();
        services.AddSingleton<IFileDialogService, NoFileDialogs>();
        services.AddSingleton<IHotKeyService, NoHotKeys>();
        services.AddSingleton<ISoundService, NoSound>();

        services.AddCommonServices();
        services.AddScriptableObjects();
        services.AddCompiler();

        // Last registration wins: logs go to Seraph instead of Skua's log window.
        services.AddSingleton<ILogService, HeadlessLogService>();
        return services.BuildServiceProvider();
    }

    private static void HookScriptEvents()
    {
        StrongReferenceMessenger m = StrongReferenceMessenger.Default;
        object token = new();
        int ch = (int)MessageChannels.ScriptStatus;
        m.Register<object, ScriptStartedMessage, int>(token, ch, (_, _) => _ipc.Event("started", Loaded()));
        m.Register<object, ScriptStoppedMessage, int>(token, ch, (_, _) => _ipc.Event("stopped", Loaded()));
        m.Register<object, ScriptErrorMessage, int>(token, ch, (_, msg) =>
        {
            Exception e = msg.Exception is System.Reflection.TargetInvocationException { InnerException: not null } t ? t.InnerException! : msg.Exception;
            _ipc.Event("error", new { message = e.Message, type = e.GetType().Name, stack = e.StackTrace });
        });
        m.Register<object, ScriptStoppingRequestMessage, int>(token, ch, (_, msg) => msg.Reply(Task.FromResult<bool?>(msg.Exception is null)));

        // Game events Skua raises from packets, useful to Seraph for stats and for the dashboard.
        int ge = (int)MessageChannels.GameEvents;
        m.Register<object, ReloginTriggeredMessage, int>(token, ge, (_, msg) => _ipc.Event("relogin", new { kicked = msg.WasKicked }));
    }

    private static string Loaded() => _services.GetRequiredService<IScriptManager>().LoadedScript;

    private static void OnCommand(JObject cmd)
    {
        string op = (string?)cmd["op"] ?? "";
        long? id = (long?)cmd["i"];
        try
        {
            object? result = op switch
            {
                "start" => Start(cmd),
                "stop" => Stop(),
                "compile" => Compile(cmd),
                "status" => Status(),
                "loaded" => Initialize(),
                "option" => SetOption(cmd),
                "exit" => Exit(),
                _ => new { error = $"unknown op '{op}'" },
            };
            if (id is not null)
                _ipc.Send(new { t = "r", i = id, v = result });
        }
        catch (Exception e)
        {
            if (id is not null)
                _ipc.Send(new { t = "r", i = id, v = new { error = e.Message } });
            else
                _ipc.Log("debug", $"{op} failed: {e}");
        }
    }

    // The game is already running when Seraph starts us: this is Skua's "loaded" callback.
    private static object Initialize()
    {
        ((IScriptInterfaceManager)_services.GetRequiredService<IScriptInterface>()).Initialize();
        return new { ok = true };
    }

    private static object Start(JObject cmd)
    {
        string path = Path.GetFullPath((string)cmd["path"]!);
        if (!File.Exists(path))
            return new { error = $"no script at {path}" };
        IScriptManager manager = _services.GetRequiredService<IScriptManager>();
        if (manager.ScriptRunning)
            return new { error = "a script is already running" };
        Initialize();
        manager.SetLoadedScript(path);
        Exception? e = manager.StartScript().GetAwaiter().GetResult();
        if (e is not null)
        {
            string detail = e is ScriptCompileException ce ? $"{ce.Message}" : e.Message;
            _ipc.Event("error", new { message = detail, type = e.GetType().Name, compile = e is ScriptCompileException });
            return new { error = detail };
        }
        return new { ok = true, path };
    }

    private static object Stop()
    {
        IScriptManager manager = _services.GetRequiredService<IScriptManager>();
        manager.StopScript().AsTask().Wait(TimeSpan.FromSeconds(20));
        return new { ok = true, running = manager.ScriptRunning };
    }

    // Compile without running: used by the tests and to pre-warm the cache for a script.
    private static object Compile(JObject cmd)
    {
        string path = Path.GetFullPath((string)cmd["path"]!);
        IScriptManager manager = _services.GetRequiredService<IScriptManager>();
        manager.SetLoadedScript(path);
        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            object? script = manager.Compile(File.ReadAllText(path));
            return new { ok = script is not null, ms = sw.ElapsedMilliseconds, type = script?.GetType().FullName };
        }
        catch (ScriptCompileException e)
        {
            return new { ok = false, ms = sw.ElapsedMilliseconds, error = e.Message };
        }
    }

    private static object Status()
    {
        IScriptManager manager = _services.GetRequiredService<IScriptManager>();
        IScriptInterface bot = _services.GetRequiredService<IScriptInterface>();
        return new
        {
            running = manager.ScriptRunning,
            script = manager.LoadedScript,
            calls = _ipc.Calls,
            flash = (_services.GetRequiredService<IFlashUtil>() as IpcFlashUtil)?.Stats(),
            memoryMb = Environment.WorkingSet / 1048576,
            gcHeapMb = GC.GetGCMemoryInfo().HeapSizeBytes / 1048576,
            privateMb = System.Diagnostics.Process.GetCurrentProcess().PrivateMemorySize64 / 1048576,
            cpuSeconds = Math.Round(System.Diagnostics.Process.GetCurrentProcess().TotalProcessorTime.TotalSeconds, 1),
            stats = new { bot.Stats.Kills, bot.Stats.Deaths, bot.Stats.QuestsAccepted, bot.Stats.QuestsCompleted, bot.Stats.Drops, bot.Stats.Relogins },
        };
    }

    // Skua application options (Bot.Options.*) that Seraph controls, e.g. {"name":"AutoRelogin","value":false}.
    private static object SetOption(JObject cmd)
    {
        IScriptOption options = _services.GetRequiredService<IScriptInterface>().Options;
        string name = (string)cmd["name"]!;
        System.Reflection.PropertyInfo? p = options.GetType().GetProperty(name);
        if (p is null || !p.CanWrite)
            return new { error = $"no option '{name}'" };
        p.SetValue(options, cmd["value"]!.ToObject(p.PropertyType));
        return new { ok = true };
    }

    private static object Exit()
    {
        _exit.Set();
        return new { ok = true };
    }

    private static void Shutdown()
    {
        try
        {
            IScriptManager manager = _services.GetRequiredService<IScriptManager>();
            if (manager.ScriptRunning)
                manager.StopScript().AsTask().Wait(TimeSpan.FromSeconds(10));
        }
        catch { /* going away */ }
    }
}
