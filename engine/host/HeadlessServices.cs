using Newtonsoft.Json.Linq;
using Skua.Core.Interfaces;
using Skua.Core.Models;
using Skua.Core.Services;

namespace Seraph.Skua;

/// <summary>Skua's settings, stored the way Skua stores them, in this character's SKUA_DIR.</summary>
public sealed class HeadlessSettingsService : ISettingsService
{
    private readonly UnifiedSettingsService _unified = new();
    public HeadlessSettingsService() => _unified.Initialize(AppRole.Client);
    public T? Get<T>(string key) => _unified.Get<T>(key);
    public T Get<T>(string key, T defaultValue) => _unified.Get(key, defaultValue);
    public void Set<T>(string key, T value) => _unified.Set(key, value);
    public void Initialize(AppRole role) => _unified.Initialize(role);
    public SharedSettings GetShared() => _unified.GetShared();
    public ClientSettings GetClient() => _unified.GetClient();
    public ManagerSettings GetManager() => _unified.GetManager();
    public void SetApplicationVersion() => _unified.SetApplicationVersion();
}

/// <summary>
/// No one is watching the bot, so a script's message box goes to Seraph, which logs it and answers for the player
/// (lib/skua/engine.js decides; with no answer in time the safe default below is used).
/// </summary>
public sealed class HeadlessDialogService : IDialogService
{
    private readonly Ipc _ipc;
    public HeadlessDialogService(Ipc ipc) => _ipc = ipc;

    // Configuration dialogs (script options) are filled from the options file Seraph wrote before the start.
    public bool? ShowDialog<TViewModel>(TViewModel viewModel) where TViewModel : class => true;
    public bool? ShowDialog<TViewModel>(TViewModel viewModel, string Title) where TViewModel : class => true;
    public bool? ShowDialog<TViewModel>(TViewModel viewModel, Action<TViewModel> callback) where TViewModel : class
    {
        callback(viewModel);
        return true;
    }

    public void ShowMessageBox(string message, string caption)
    {
        _ipc.Send(new { t = "ask", kind = "notice", message, caption });
    }

    public bool? ShowMessageBox(string message, string caption, bool yesAndNo)
    {
        if (!yesAndNo)
        {
            ShowMessageBox(message, caption);
            return true;
        }
        JToken? v = _ipc.Request(new { t = "ask", kind = "yesno", message, caption }, 20000);
        return v?.Type == JTokenType.Boolean ? (bool)v : false;
    }

    public DialogResult ShowMessageBox(string message, string caption, params string[] buttons)
    {
        JToken? v = _ipc.Request(new { t = "ask", kind = "buttons", message, caption, buttons }, 20000);
        int index = v?.Type == JTokenType.Integer ? (int)v : -1;
        if (index < 0 || index >= buttons.Length)
            return DialogResult.Cancelled;
        return new DialogResult(buttons[index], index);
    }
}

/// <summary>Script and debug logs go to Seraph; the last lines are also kept here for Skua code that reads them.</summary>
public sealed class HeadlessLogService : ILogService
{
    private readonly Ipc _ipc;
    private readonly Dictionary<LogType, List<string>> _logs = new()
    {
        [LogType.Debug] = new(), [LogType.Script] = new(), [LogType.Flash] = new(),
    };

    public HeadlessLogService(Ipc ipc)
    {
        _ipc = ipc;
        System.Diagnostics.Trace.Listeners.Add(new TraceForward(this));
    }

    private void Add(LogType type, string message, string kind)
    {
        lock (_logs)
        {
            List<string> l = _logs[type];
            if (l.Count >= 2000)
                l.RemoveAt(0);
            l.Add(message);
        }
        _ipc.Log(kind, message);
    }

    public void DebugLog(string message) => Add(LogType.Debug, message, "debug");
    public void ScriptLog(string message) { if (message is not null) Add(LogType.Script, message, "script"); }
    public void FlashLog(string message) { if (message is not null) Add(LogType.Flash, message, "flash"); }
    public void ClearLog(LogType logType) { lock (_logs) _logs[logType].Clear(); }
    public List<string> GetLogs(LogType logType) { lock (_logs) return _logs[logType].ToList(); }

    private sealed class TraceForward : System.Diagnostics.TraceListener
    {
        private readonly HeadlessLogService _log;
        public TraceForward(HeadlessLogService log) => _log = log;
        public override void Write(string? message) { }
        public override void WriteLine(string? message) { if (!string.IsNullOrWhiteSpace(message)) _log.DebugLog(message); }
    }
}

public sealed class HeadlessDispatcher : IDispatcherService
{
    public void Invoke(Action action) => action();
}

public sealed class NoSound : ISoundService
{
    public void Beep() { }
    public void Beep(int frequency, int duration) { }
}

public sealed class NoWindows : IWindowService
{
    public void ShowWindow<TViewModel>(int width, int height) where TViewModel : class { }
    public void ShowWindow<TViewModel>() where TViewModel : class { }
    public void ShowWindow<TViewModel>(TViewModel viewModel) where TViewModel : class { }
    public void ShowManagedWindow(string key) { }
    public void RegisterManagedWindow<TViewModel>(string key, TViewModel viewModel) where TViewModel : class, IManagedWindow { }
}

public sealed class NoFileDialogs : IFileDialogService
{
    public string? OpenFile() => null;
    public string? OpenFile(string filters) => null;
    public string? OpenFile(string initialDirectory, string filters) => null;
    public string? OpenFolder() => null;
    public string? OpenFolder(string initialDirectory) => null;
    public IEnumerable<string>? OpenText() => null;
    public string? Save() => null;
    public string? Save(string filters) => null;
    public string? Save(string initialDirectory, string filters) => null;
    public void SaveText(string contents) { }
    public void SaveText(IEnumerable<string> contents) { }
}

public sealed class MemoryClipboard : IClipboardService
{
    private readonly Dictionary<string, object> _data = new();
    private string _text = string.Empty;
    public void SetText(string text) => _text = text;
    public void SetData(string format, object data) => _data[format] = data;
    public object GetData(string format) => _data.TryGetValue(format, out object? o) ? o : null!;
    public string GetText() => _text;
}

public sealed class NoHotKeys : IHotKeyService
{
    public void Reload() { }
    public List<T> GetHotKeys<T>() where T : IHotKey, new() => new();
    public HotKey? ParseToHotKey(string keyGesture) => null;
}
