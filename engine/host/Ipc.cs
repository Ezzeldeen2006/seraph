using System.Collections.Concurrent;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Seraph.Skua;

/// <summary>
/// One JSON object per line over stdin/stdout, to and from Seraph (Node).
///   host -> seraph   {"t":"c","i":7,"f":"getGameObject","a":["world.strFrame"]}   a Flash call, answered by
///   seraph -> host   {"t":"r","i":7,"v":"\"Enter\""}                               ...the string skua.swf would return
///   seraph -> host   {"t":"f","f":"pext","a":["{...}"]}                            a Flash callback (packets, loaded, ...)
///   seraph -> host   {"t":"cmd","op":"start","path":"...","options":{...}}        commands
///   host -> seraph   {"t":"log",...} / {"t":"ev",...}                              logs and script events
/// stdout carries nothing else: Console.Out is redirected to stderr so a stray Console.WriteLine in a
/// script can never corrupt the channel.
/// </summary>
public sealed class Ipc
{
    private readonly Stream _out;
    private readonly object _writeLock = new();
    private readonly ConcurrentDictionary<long, Pending> _pending = new();
    private long _nextId;
    private readonly BlockingCollection<JObject> _events = new(new ConcurrentQueue<JObject>(), 20000);
    private static readonly UTF8Encoding Utf8 = new(false);

    public event Action<string, object?[]>? FlashEvent;
    public event Action<JObject>? Command;
    public bool Closed { get; private set; }
    public long Calls;
    /// <summary>Packets that may change the backpack, bank or quests (all but combat, tagged k:"c" by Seraph).
    /// Counted on the reader thread, so it moves before any answer Seraph sent after that packet arrives.</summary>
    public long PacketGen;
    /// <summary>{"t":"v","r":{"items":3,"bank":7,...}}: the headless model's revision of each big structure (swfworld.js
    /// REV_OF). A cached read stays good until its own revision moves. Seraph sends a change before the packet or
    /// answer that follows it, and this reader applies it in that order, so an answer never finds an older revision.</summary>
    public readonly ConcurrentDictionary<string, long> Revs = new(StringComparer.Ordinal);
    public volatile bool RevsOn;
    /// <summary>{"t":"m","v":{"getGameObject|world.strFrame":"\"Enter\"",...}}: the values Skua polls, pushed whenever one
    /// changes (swfworld.js MIRROR), answered here without a round trip.</summary>
    public readonly ConcurrentDictionary<string, string?> Mirror = new(StringComparer.Ordinal);
    public volatile bool MirrorOn;

    private sealed class Pending
    {
        public readonly ManualResetEventSlim Done = new(false);
        public JToken? Value;
    }

    public Ipc(Stream stdin, Stream stdout)
    {
        _out = stdout;
        new Thread(() => ReadLoop(stdin)) { IsBackground = true, Name = "IPC reader" }.Start();
        // Callbacks run on their own thread: a handler that makes a Flash call of its own (Skua's do) would
        // otherwise wait for an answer the reader thread can never deliver.
        new Thread(DispatchLoop) { IsBackground = true, Name = "IPC events" }.Start();
    }

    private void ReadLoop(Stream stdin)
    {
        using StreamReader reader = new(stdin, Utf8);
        try
        {
            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Length == 0)
                    continue;
                JObject msg;
                try { msg = JObject.Parse(line); }
                catch (Exception e) { Log("debug", $"bad IPC line: {e.Message}"); continue; }

                string t = (string?)msg["t"] ?? "";
                if (t == "v")
                {
                    if (msg["r"] is JObject revs)
                        foreach (JProperty p in revs.Properties())
                            Revs[p.Name] = (long)p.Value;
                    RevsOn = true;
                }
                else if (t == "m")
                {
                    if (msg["v"] is JObject vals)
                        foreach (JProperty p in vals.Properties())
                            Mirror[p.Name] = p.Value.Type == JTokenType.Null ? null : (string?)p.Value;
                    // The Flash standby's game is reloading: these values are unknown, so ask the game again.
                    if (msg["unset"] is JArray unset)
                        foreach (JToken k in unset)
                            Mirror.TryRemove((string)k!, out _);
                    MirrorOn = true;
                }
                else if (t == "r")
                {
                    if (_pending.TryRemove((long)msg["i"]!, out Pending? p))
                    {
                        p.Value = msg["v"];
                        p.Done.Set();
                    }
                }
                else
                {
                    if (t == "f" && (string?)msg["k"] != "c")
                        Interlocked.Increment(ref PacketGen);
                    _events.TryAdd(msg);
                }
            }
        }
        catch { /* stdin closed */ }
        Closed = true;
        foreach (Pending p in _pending.Values)
            p.Done.Set();
        _events.CompleteAdding();
    }

    private void DispatchLoop()
    {
        foreach (JObject msg in _events.GetConsumingEnumerable())
        {
            try
            {
                string t = (string?)msg["t"] ?? "";
                if (t == "f")
                {
                    string name = (string?)msg["f"] ?? "";
                    object?[] args = (msg["a"] as JArray)?.Select(ToPlain).ToArray() ?? Array.Empty<object?>();
                    FlashEvent?.Invoke(name, args);
                }
                else if (t == "cmd")
                {
                    Command?.Invoke(msg);
                }
            }
            catch (Exception e)
            {
                Log("debug", $"event handler failed: {e}");
            }
        }
    }

    private static object? ToPlain(JToken t) => t.Type switch
    {
        JTokenType.String => (string?)t,
        JTokenType.Integer => (long)t switch { var v when v is >= int.MinValue and <= int.MaxValue => (object)(int)v, var v => v },
        JTokenType.Float => (double)t,
        JTokenType.Boolean => (bool)t,
        JTokenType.Null or JTokenType.Undefined => null,
        _ => t.ToString(Formatting.None),
    };

    public void Send(object msg)
    {
        if (Closed)
            return;
        byte[] bytes = Utf8.GetBytes(JsonConvert.SerializeObject(msg, Formatting.None) + "\n");
        lock (_writeLock)
        {
            try
            {
                _out.Write(bytes);
                _out.Flush();
            }
            catch { Closed = true; }
        }
    }

    /// <summary>A blocking request to Seraph. Returns null on timeout or when Seraph has gone away.</summary>
    public JToken? Request(object body, int timeoutMs = 15000)
    {
        if (Closed)
            return null;
        long id = Interlocked.Increment(ref _nextId);
        Pending p = new();
        _pending[id] = p;
        JObject msg = JObject.FromObject(body);
        msg["i"] = id;
        Send(msg);
        Interlocked.Increment(ref Calls);
        if (!p.Done.Wait(timeoutMs))
        {
            _pending.TryRemove(id, out _);
            return null;
        }
        return p.Value;
    }

    public void Log(string kind, string message) => Send(new { t = "log", k = kind, m = message });

    public void Event(string name, object? data = null) => Send(new { t = "ev", e = name, d = data });
}
